/**
 * 끝난 경기를 기록에서 빼고 되돌리는 쓰기 요청: 전적 제외와 복구, 경기 삭제와 되살리기(migrations/0026).
 * 경기 상세·기록 화면이 부른다(경로는 index.ts).
 * 복구·되살리기는 그 사이 같은 내용의 경기가 다시 들어왔을 수 있어 지문 중복과 결과 미입력 상한을 다시 잰다
 * (matchChecks.ts의 가드). 묶음 단위 제외·복구는 matchImport.ts의 setImportBatchExcluded다.
 */
import type { MatchView } from "../shared/types";
import { operatorRole } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, nowIso, requireInt, requireRequestId } from "./http";
import { insertRevision, matchGuard, runMutation } from "./mutation";
import { seriesRestoreGuards, seriesUndeleteGuards } from "./series";
import {
  MAX_AWAITING,
  assertMatchVersion,
  assertState,
  awaitingLimitGuard,
  countAwaiting,
  fingerprintOverlaps,
  fingerprintScopeGuard,
  fingerprintScopeStamp,
  matchConflictDetails,
  storedFingerprintRestoreGuard,
  type Body,
} from "./matchChecks";
import { loadMatch } from "./snapshot";

/** 화면의 "삭제"는 전적 제외다. 복구할 수 있고 서포터 차례는 그대로 둔다. */
export async function excludeMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "exclude",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["awaiting_result", "confirmed"]);
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
          env.DB.prepare(
            `UPDATE matches SET state = 'excluded', prev_state = ?1, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(match.state, matchId, groupId),
          insertRevision(
            env,
            groupId,
            matchId,
            "exclude",
            { state: { from: match.state, to: "excluded" } },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/**
 * 전적 제외한 경기를 되살린다.
 * 일괄 입력·지난 경기 입력 경기는 같은 내용(지문)의 경기가 이미 기록에 있으면 거절한다.
 * 제외한 뒤 같은 시트를 다시 가져온 경우처럼 같은 경기가 두 번 세지는 것을 막는다.
 */
export async function restoreMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "restore",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["excluded"]);
      const prev = await env.DB.prepare("SELECT prev_state FROM matches WHERE id = ?1")
        .bind(matchId)
        .first<{ prev_state: string | null }>();
      const target = prev?.prev_state ?? "confirmed";
      const guards: D1PreparedStatement[] = [];
      if (match.source === "import" || match.source === "backfill") {
        const stamp = await fingerprintScopeStamp(env, groupId);
        const overlaps = await fingerprintOverlaps(env, groupId, [matchId]);
        if (overlaps.length > 0) {
          const nos = overlaps[0]!.with;
          throw new ApiError(
            409,
            "RESTORE_DUPLICATE",
            `같은 내용의 경기가 이미 기록에 있어요(${nos.map((n) => `${n}번`).join(", ")} 경기). 두 번 세지 않도록 복구하지 않았어요. 그 경기가 잘못 들어간 것이면 먼저 전적 제외한 뒤 복구하세요.`,
            { matchNos: nos },
          );
        }
        guards.push(fingerprintScopeGuard(env, groupId, stamp), storedFingerprintRestoreGuard(env, groupId, [matchId]));
      }
      // 시리즈: 제외한 사이 판을 더 넣어 승부가 났으면 복구로 승부 뒤에 판이 붙는다(거절).
      guards.push(...(await seriesRestoreGuards(env, groupId, match, target as MatchView["state"])));
      // 결과 미입력이던 경기를 복구하면 미입력으로 돌아간다. 제외한 사이 새 경기가 쌓였으면 상한을 넘을 수 있다.
      const backToAwaiting = target === "awaiting_result";
      if (backToAwaiting && (await countAwaiting(env, groupId)) + 1 > MAX_AWAITING) {
        throw new ApiError(
          409,
          "TOO_MANY_AWAITING",
          `결과를 입력하지 않은 경기가 이미 ${MAX_AWAITING}개라 복구할 수 없어요. 다른 경기의 결과를 먼저 입력한 뒤 복구하세요.`,
        );
      }
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, "excluded"),
          ...guards,
          env.DB.prepare(
            `UPDATE matches SET state = ?1, prev_state = NULL, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(target, matchId, groupId),
          // 바꾼 뒤의 개수로 센다. 그래서 UPDATE 다음에 둔다.
          ...(backToAwaiting ? [awaitingLimitGuard(env, groupId)] : []),
          insertRevision(
            env,
            groupId,
            matchId,
            "restore",
            { state: { from: "excluded", to: target } },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 경기 삭제·되살리기(migrations/0026)                                   */
/* ------------------------------------------------------------------ */

/**
 * 지울 수 있는 상태. 진행 중 경기는 "경기 취소"로 끝내고, 취소된 경기는 이미 통계에 없어 지울 까닭이 없다.
 * state는 지울 때 바꾸지 않으므로 되살리면 이 셋 가운데 지우기 전 상태로 그대로 돌아온다.
 */
const DELETABLE_STATES = ["confirmed", "excluded", "awaiting_result"] as const;

/**
 * 삭제·되살리기 이력. match_revisions.kind CHECK에 새 종류를 넣으려면 표를 새로 만들어야 해서(migrations/0026 머리말)
 * kind 'correction'에 changes.deleted로 남긴다. 화면(Records.tsx)과 스냅숏(snapshot.ts revisionStatements)이
 * 이 키로 삭제 줄을 알아본다. by는 누가 했는지(대표·공동 운영자). 계정 ID는 남기지 않는다.
 */
function deletionRevision(env: Env, groupId: string, matchId: string, deleted: boolean, by: string, at: string) {
  return insertRevision(
    env,
    groupId,
    matchId,
    "correction",
    { deleted: { from: !deleted, to: deleted }, by: { from: null, to: by } },
    at,
  );
}

/**
 * 잘못 넣었거나 두 번 넣은 경기를 지운다(휴지통 방식). deleted_at만 채우고 행·명단·시리즈 소속·서포터 차례 기록은 그대로
 * 둔다. 경기 번호는 당기지 않는다. 지운 경기는 스냅숏·조회 링크·계산에서 빠지고(snapshot.ts ALIVE), 변경 내역의 삭제
 * 줄에서 되살린다. 전적 제외와 달리 목록에 흔적이 남지 않는다.
 * 서포터 차례 기록을 무효로 하지 않는 이유: 되살렸을 때 지우기 전과 똑같아야 하고, 이미 지난 내전의 차례는 다시 쓰지 않는다.
 */
export async function deleteMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
  accountId: string,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "delete",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      // 이미 지운 경기는 loadMatch가 찾지 못해 404다(지운 경기는 없는 경기로 다룬다).
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, DELETABLE_STATES);
      const by = (await operatorRole(env, groupId, accountId)) ?? "owner";
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          // 버전이 같으면 그 사이 지워지지도 않았다(지우기·되살리기도 버전을 올린다).
          matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
          env.DB.prepare(
            "UPDATE matches SET deleted_at = ?1, version = version + 1 WHERE id = ?2 AND group_id = ?3",
          ).bind(now, matchId, groupId),
          deletionRevision(env, groupId, matchId, true, by, now),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId, true);
}

/**
 * 지운 경기를 되살린다. 상태는 지우기 전 그대로다(삭제가 state를 바꾸지 않는다).
 * 일괄 입력·지난 경기 입력 경기는 전적 복구(restoreMatch)와 같은 기준으로, 같은 내용의 경기가 이미 기록에 있으면
 * 거절한다: 지운 뒤 같은 시트를 다시 가져온 경우 두 번 세지 않게. 전적 제외 상태로 지웠던 경기는 통계에 들지 않으므로 보지 않는다.
 */
export async function undeleteMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
  accountId: string,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "undelete",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId, true);
      assertMatchVersion(match, baseMatchVersion);
      if (match.deletedAt === undefined) {
        throw new ApiError(409, "STATE_CONFLICT", "지운 경기가 아니에요. 화면을 새로 고쳐 확인해 주세요.", {
          match: { version: match.version, state: match.state },
        });
      }
      const guards: D1PreparedStatement[] = [];
      // 결과 미입력 경기를 지운 사이 새 경기가 쌓였으면, 되살리는 순간 상한(MAX_AWAITING)을 넘을 수 있다.
      // 경기 시작과 같은 상한을 여기서도 지킨다. 저장 batch 안의 awaitingLimitGuard가 동시에 들어온 시작까지 막는다.
      if (match.state === "awaiting_result") {
        const awaiting = await countAwaiting(env, groupId);
        if (awaiting + 1 > MAX_AWAITING) {
          throw new ApiError(
            409,
            "TOO_MANY_AWAITING",
            `결과를 입력하지 않은 경기가 이미 ${awaiting}개라 되살리면 ${MAX_AWAITING}개를 넘어요. 다른 경기의 결과를 먼저 입력한 뒤 되살리세요.`,
          );
        }
      }
      if ((match.source === "import" || match.source === "backfill") && match.state !== "excluded") {
        const stamp = await fingerprintScopeStamp(env, groupId);
        const overlaps = await fingerprintOverlaps(env, groupId, [matchId]);
        if (overlaps.length > 0) {
          const nos = overlaps[0]!.with;
          throw new ApiError(
            409,
            "RESTORE_DUPLICATE",
            `같은 내용의 경기가 이미 기록에 있어요(${nos.map((n) => `${n}번`).join(", ")} 경기). 두 번 세지 않도록 되살리지 않았어요. 그 경기를 먼저 지우거나 전적 제외한 뒤 되살리세요.`,
            { matchNos: nos },
          );
        }
        guards.push(fingerprintScopeGuard(env, groupId, stamp), storedFingerprintRestoreGuard(env, groupId, [matchId]));
      }
      // 시리즈 판 수: 지운 사이 새 판을 넣었으면 되살렸을 때 형식보다 길어진다(거절).
      guards.push(...(await seriesUndeleteGuards(env, groupId, match)));
      const by = (await operatorRole(env, groupId, accountId)) ?? "owner";
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
          ...guards,
          env.DB.prepare(
            "UPDATE matches SET deleted_at = NULL, version = version + 1 WHERE id = ?1 AND group_id = ?2",
          ).bind(matchId, groupId),
          // 되살린 뒤의 개수로 센다. 그래서 UPDATE 다음에 둔다.
          ...(match.state === "awaiting_result" ? [awaitingLimitGuard(env, groupId)] : []),
          deletionRevision(env, groupId, matchId, false, by, now),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}
