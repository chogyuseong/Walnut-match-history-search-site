/**
 * 경기 진행 흐름의 쓰기 요청: 이 팀으로 시작, 결과는 나중에, 결과 확정, 진행 중 사람 교체, 메모, 챔피언, 미진행 취소.
 * 준비·진행·결과 입력 화면이 부른다(경로는 matchRoutes.ts). 끝난 경기를 다루는 요청은 다른 파일에 있다:
 * 전적 제외·삭제와 되살리기는 matchRemoval.ts, 정정은 matchCorrection.ts, 지난 경기 입력·가져오기는 matchImport.ts.
 * 여러 요청이 함께 쓰는 검증·가드는 matchChecks.ts.
 */
import { isChampionKey } from "../shared/champions";
import { MEMO_MAX, memoLength, normalizeMemo } from "../shared/memo";
import { SIDES, TEAMS, teamASideFromWinner, type MatchView, type Side, type Team } from "../shared/types";
import { clearHandoffOnStart } from "./draftHandoff";
import type { Env } from "./env";
import {
  ApiError,
  assertOnlyKeys,
  newId,
  nowIso,
  requireInt,
  requireOneOf,
  requireRequestId,
  requireString,
} from "./http";
import {
  bumpLiveVersion,
  insertRevision,
  liveVersionGuard,
  matchGuard,
  runMutation,
  type Plan,
} from "./mutation";
import { parseSeriesContinue, seriesContinuePlan, type SeriesContinue } from "./series";
import {
  MAX_AWAITING,
  assertActiveParticipants,
  assertMatchVersion,
  assertState,
  awaitingLimitGuard,
  countAwaiting,
  insertRoster,
  matchConflictDetails,
  parseRoster,
  type Body,
} from "./matchChecks";
import { loadGroup, loadMatch, loadOpenSession, loadSettings, ROSTER_IN_GROUP } from "./snapshot";

/* ------------------------------------------------------------------ */
/* 이 팀으로 시작                                                       */
/* ------------------------------------------------------------------ */

/**
 * 한 요청·한 트랜잭션으로 처리한다(docs/P2 P2-2).
 * 명단 검증, 확정 명단 저장, 진행 중 전환, 서포터 차례 소비, 적용 설정 버전 기록.
 * 실패하면 어느 것도 남지 않는다.
 */
export async function startMatch(env: Env, groupId: string, body: Body): Promise<MatchView> {
  assertOnlyKeys(body, [
    "requestId",
    "baseLiveVersion",
    "roster",
    "ackRepeat",
    "moveCurrentToAwaiting",
    "newSession",
    "teamASide",
    "series",
  ]);
  const requestId = requireRequestId(body);
  const baseLiveVersion = requireInt(body.baseLiveVersion, "baseLiveVersion");
  const roster = parseRoster(body.roster, true);
  // 준비 화면에서 고른 팀 A의 진영(선택). 블루·레드만 받는다("나중에"는 보내지 않는다).
  // 결과 입력 창이 이 값을 미리 골라 두고, 결과를 저장할 때 확인한 값이 최종이다.
  const teamASide =
    body.teamASide === undefined || body.teamASide === null
      ? null
      : requireOneOf<"blue" | "red">(body.teamASide, ["blue", "red"], "teamASide");
  const ackRepeat = Array.isArray(body.ackRepeat)
    ? body.ackRepeat.map((id) => requireString(id, "ackRepeat", 1, 64))
    : [];
  const moveCurrent =
    body.moveCurrentToAwaiting === undefined || body.moveCurrentToAwaiting === null
      ? null
      : requireString(body.moveCurrentToAwaiting, "moveCurrentToAwaiting", 1, 64);
  const newSession = body.newSession === true;
  // 시리즈로 이어가기(선택, migrations/0017): 직전 경기와 같은 시리즈에 넣는다. 직전 경기가 시리즈에 없으면 새로 만든다.
  const series: SeriesContinue | null = parseSeriesContinue(body.series);
  // 진영을 고르지 않은 요청은 예전과 같은 내용으로 해시한다. 시리즈도 고른 요청만 해시에 넣는다.
  const base =
    teamASide === null
      ? { baseLiveVersion, roster, ackRepeat, moveCurrent, newSession }
      : { baseLiveVersion, roster, ackRepeat, moveCurrent, newSession, teamASide };
  const payload = series === null ? base : { ...base, series };

  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "start",
    payload,
    conflictDetails: async () => ({ liveVersion: (await loadGroup(env, groupId)).live_version }),
    build: async (): Promise<Plan> => {
      const group = await loadGroup(env, groupId);
      if (group.live_version !== baseLiveVersion) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "그 사이 경기 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.",
          { liveVersion: group.live_version },
        );
      }
      await assertActiveParticipants(
        env,
        groupId,
        roster.map((r) => r.participantId),
      );

      const now = nowIso();
      const statements: D1PreparedStatement[] = [liveVersionGuard(env, groupId, baseLiveVersion)];

      // 진행 중 경기: 명시적으로 "결과는 나중에"를 고른 경우에만 대기로 옮긴다.
      const current = await env.DB.prepare(
        "SELECT id, version FROM matches WHERE group_id = ?1 AND state = 'in_progress'",
      )
        .bind(groupId)
        .first<{ id: string; version: number }>();
      if (current) {
        if (moveCurrent !== current.id) {
          throw new ApiError(409, "MATCH_IN_PROGRESS", "진행 중인 경기가 있습니다.", {
            matchId: current.id,
          });
        }
        statements.push(
          env.DB.prepare(
            `UPDATE matches SET state = 'awaiting_result', ended_at = ?1, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(now, current.id, groupId),
          // 아래 확인은 batch 밖이라 동시에 들어온 되살리기·결과는 나중에와 겹치면 넘을 수 있다. 옮긴 뒤 다시 센다.
          awaitingLimitGuard(env, groupId),
          insertRevision(env, groupId, current.id, "end", {}, now),
        );
      }

      if ((await countAwaiting(env, groupId)) + (current ? 1 : 0) > MAX_AWAITING) {
        throw new ApiError(
          409,
          "TOO_MANY_AWAITING",
          `결과를 입력하지 않은 경기가 ${MAX_AWAITING}개를 넘습니다. 먼저 결과를 입력해 주세요.`,
        );
      }

      // 세션: 없거나 새 내전을 고르면 새로 연다. 새 세션은 새 순환 주기로 시작한다.
      const open = await loadOpenSession(env, groupId);
      let sessionId: string;
      let cycleId: string | null = null;
      if (!open || newSession) {
        if (open) {
          statements.push(
            env.DB.prepare(
              "UPDATE rotation_cycles SET status = 'closed', closed_at = ?1 WHERE session_id = ?2 AND status = 'active'",
            ).bind(now, open.id),
            env.DB.prepare("UPDATE sessions SET closed_at = ?1 WHERE id = ?2").bind(now, open.id),
          );
        }
        sessionId = newId();
        statements.push(
          env.DB.prepare(
            `INSERT INTO sessions (id, group_id, started_at, last_activity_at)
             VALUES (?1, ?2, ?3, ?3)`,
          ).bind(sessionId, groupId, now),
        );
      } else {
        sessionId = open.id;
        statements.push(
          env.DB.prepare("UPDATE sessions SET last_activity_at = ?1 WHERE id = ?2").bind(
            now,
            sessionId,
          ),
        );
        const cycle = await env.DB.prepare(
          "SELECT id FROM rotation_cycles WHERE session_id = ?1 AND status = 'active'",
        )
          .bind(sessionId)
          .first<{ id: string }>();
        cycleId = cycle?.id ?? null;
      }

      const matchId = newId();
      statements.push(
        env.DB.prepare(
          `INSERT INTO matches (id, group_id, match_no, session_id, state, source,
             started_at, played_at, settings_version_id, team_a_side)
           SELECT ?1, id, next_match_no, ?3, 'in_progress', 'live', ?4, ?4, settings_version_id, ?5
           FROM groups WHERE id = ?2`,
        ).bind(matchId, groupId, sessionId, now, teamASide),
        env.DB.prepare(
          `UPDATE groups SET next_match_no = next_match_no + 1, live_version = live_version + 1
           WHERE id = ?1`,
        ).bind(groupId),
        ...insertRoster(env, groupId, matchId, roster),
        insertRevision(env, groupId, matchId, "start", {}, now),
        clearHandoffOnStart(env, groupId),
      );
      if (series !== null) {
        statements.push(...(await seriesContinuePlan(env, groupId, series, matchId, roster, now)));
      }

      // 서포터 순환: 차례 소비는 여기서만 일어난다. 기기의 추첨 기록을 믿지 않고 다시 검사한다.
      const settings = await loadSettings(env, group.settings_version_id);
      if (settings.rotationEnabled) {
        let used = new Set<string>();
        if (cycleId) {
          const rows = await env.DB.prepare(
            `SELECT participant_id FROM rotation_events
             WHERE cycle_id = ?1 AND kind = 'used' AND voided = 0`,
          )
            .bind(cycleId)
            .all<{ participant_id: string }>();
          used = new Set(rows.results.map((r) => r.participant_id));
        } else {
          cycleId = newId();
          statements.push(
            env.DB.prepare(
              `INSERT INTO rotation_cycles (id, group_id, session_id, status, created_at)
               VALUES (?1, ?2, ?3, 'active', ?4)`,
            ).bind(cycleId, groupId, sessionId, now),
            // 주기가 없을 때(첫 경기 전) 미리 넣어 둔 서포터 횟수는 새로 연 주기가 물려받는다(migrations/0012).
            env.DB.prepare(
              "UPDATE support_adjustments SET cycle_id = ?1 WHERE group_id = ?2 AND cycle_id IS NULL",
            ).bind(cycleId, groupId),
          );
        }
        const supporters = roster.filter((r) => r.position === "support");
        const repeats = supporters.filter((s) => used.has(s.participantId));
        const unacked = repeats.filter((s) => !ackRepeat.includes(s.participantId));
        if (unacked.length > 0) {
          throw new ApiError(
            409,
            "SUPPORT_REPEAT",
            "이번 순환에서 이미 서포터를 한 사람이 서포터 자리에 있습니다.",
            { participantIds: unacked.map((s) => s.participantId) },
          );
        }
        for (const supporter of supporters) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO rotation_events (id, group_id, cycle_id, match_id, participant_id, kind, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
            ).bind(
              newId(),
              groupId,
              cycleId,
              matchId,
              supporter.participantId,
              used.has(supporter.participantId) ? "repeat" : "used",
              now,
            ),
          );
        }
      }

      return { statements, stored: { matchId } };
    },
  });
  return loadMatch(env, groupId, stored.matchId as string);
}

/* ------------------------------------------------------------------ */
/* 종료·결과 나중에 / 결과 확정                                         */
/* ------------------------------------------------------------------ */

export async function endLater(
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
    op: "end-later",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["in_progress"]);
      // 경기 시작의 "결과는 나중에"와 같은 상한. 이 경로만 빠져 있어 미입력 경기가 끝없이 쌓일 수 있었다.
      if ((await countAwaiting(env, groupId)) + 1 > MAX_AWAITING) {
        throw new ApiError(
          409,
          "TOO_MANY_AWAITING",
          `결과를 입력하지 않은 경기가 이미 ${MAX_AWAITING}개예요. 이 경기 결과를 바로 입력하거나 다른 경기의 결과를 먼저 입력해 주세요.`,
        );
      }
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, "in_progress"),
          env.DB.prepare(
            `UPDATE matches SET state = 'awaiting_result', ended_at = ?1, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(now, matchId, groupId),
          // 바꾼 뒤의 개수로 센다. 그래서 UPDATE 다음에 둔다.
          awaitingLimitGuard(env, groupId),
          bumpLiveVersion(env, groupId),
          insertRevision(env, groupId, matchId, "end", {}, now),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

export async function confirmResult(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion", "winnerTeam", "winnerSide", "memo", "champions"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const winnerTeam = requireOneOf<Team>(body.winnerTeam, TEAMS, "winnerTeam");
  const winnerSide = requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide");
  const teamASide = teamASideFromWinner(winnerTeam, winnerSide);
  // 메모·챔피언(선택). 보낸 요청만 그 값을 바꾼다. 보내지 않은 요청은 예전과 같은 내용으로 해시한다
  // (기능이 생기기 전에 보낸 요청을 같은 요청 ID로 다시 보내도 같은 요청으로 본다).
  const memo = body.memo === undefined ? undefined : parseMemo(body.memo);
  const champions = body.champions === undefined ? undefined : parseChampions(body.champions);
  const payload: Record<string, unknown> = { matchId, baseMatchVersion, winnerTeam, winnerSide };
  if (memo !== undefined) payload.memo = memo;
  if (champions !== undefined) payload.champions = champions;
  await runMutation(env, {
    groupId,
    requestId,
    op: "result",
    payload,
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["in_progress", "awaiting_result"]);
      if (champions !== undefined) assertChampionsInRoster(match, champions);
      const now = nowIso();
      const statements = [
        matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
        env.DB.prepare(
          `UPDATE matches SET state = 'confirmed', winner_team = ?1, team_a_side = ?2,
             confirmed_at = ?3, ended_at = COALESCE(ended_at, ?3), version = version + 1
           WHERE id = ?4 AND group_id = ?5`,
        ).bind(winnerTeam, teamASide, now, matchId, groupId),
        insertRevision(
          env,
          groupId,
          matchId,
          "result",
          {
            winnerTeam: { from: null, to: winnerTeam },
            // 시작할 때 진영을 골라 두었으면 그 값에서 바뀐 것으로 남긴다.
            teamASide: { from: match.teamASide, to: teamASide },
          },
          now,
        ),
      ];
      // 메모는 정정 이력에 남기지 않는다(migrations/0016).
      if (memo !== undefined) {
        statements.push(
          env.DB.prepare("UPDATE matches SET memo = ?1 WHERE id = ?2 AND group_id = ?3").bind(memo, matchId, groupId),
        );
      }
      if (champions !== undefined) statements.push(setChampions(env, groupId, matchId, champions));
      // 진행 중이던 경기가 끝나면 "진행 중 1개" 자리가 비므로 진행 상태가 바뀐다.
      if (match.state === "in_progress") statements.push(bumpLiveVersion(env, groupId));
      return { stored: { matchId }, statements };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 진행 중 경기의 사람 교체(2026-11-07)                                   */
/* ------------------------------------------------------------------ */

/**
 * 진행 중 경기의 한 사람을 같은 모임의 다른 활성 참가자로 바꾼다(운영자·공동 운영자).
 * - 바뀐 사람은 나간 사람의 팀·포지션을 그대로 물려받는다. 경기 ID·번호·시작 시각은 그대로다.
 * - 나간 사람이 이 경기에서 서포터 차례 사건을 가졌으면(서포터 자리) 그 사건도 들어온 사람에게 옮긴다.
 *   들어온 사람이 이번 순환에서 이미 서포터를 했으면 사건은 "반복"이 되고, 시작 때처럼 확인(ackRepeat)을 받아야 한다.
 *   차례를 아직 안 쓴 사람이면 "사용"이 된다(나간 사람의 반복 사건이었어도). 서포터 횟수 보정값은 건드리지 않는다.
 * - 경기 버전·진행 상태 버전을 올리고 정정 이력(kind correction, participant 항목)을 남긴다.
 * 결과가 정해진 경기의 사람 바꾸기는 기존 항목별 정정(correctMatch field "participant")을 쓴다.
 */
export async function replaceLiveParticipant(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion", "outParticipantId", "inParticipantId", "ackRepeat"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const outId = requireString(body.outParticipantId, "outParticipantId", 1, 64);
  const inId = requireString(body.inParticipantId, "inParticipantId", 1, 64);
  const ackRepeat = body.ackRepeat === true;
  if (outId === inId) {
    throw new ApiError(400, "INVALID_PARTICIPANT", "같은 사람으로는 바꿀 수 없습니다.", { participantIds: [inId] });
  }
  // 반복 확인을 보내지 않은 요청은 확인 없는 내용으로 해시한다(확인 뒤 다시 보낼 때는 새 요청 ID를 쓴다).
  const base = { matchId, baseMatchVersion, outId, inId };
  await runMutation(env, {
    groupId,
    requestId,
    op: "live-roster",
    payload: ackRepeat ? { ...base, ackRepeat } : base,
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["in_progress"]);
      if (!match.roster.some((r) => r.participantId === outId)) {
        throw new ApiError(400, "INVALID_PARTICIPANT", "이 경기의 참가자가 아닙니다.", { participantIds: [outId] });
      }
      if (match.roster.some((r) => r.participantId === inId)) {
        throw new ApiError(400, "INVALID_PARTICIPANT", "이미 이 경기에 있는 참가자입니다.", { participantIds: [inId] });
      }
      // 다른 모임·보관·합쳐진 참가자는 여기서 거절된다.
      await assertActiveParticipants(env, groupId, [inId]);

      const now = nowIso();
      const statements: D1PreparedStatement[] = [
        matchGuard(env, groupId, matchId, baseMatchVersion, "in_progress"),
        env.DB.prepare(
          "UPDATE match_roster SET participant_id = ?1 WHERE match_id = ?2 AND group_id = ?3 AND participant_id = ?4",
        ).bind(inId, matchId, groupId, outId),
      ];
      const changes: Record<string, { from: unknown; to: unknown }> = {
        participant: { from: outId, to: inId },
      };

      const event = await env.DB.prepare(
        `SELECT id, cycle_id FROM rotation_events
         WHERE match_id = ?1 AND participant_id = ?2 AND voided = 0`,
      )
        .bind(matchId, outId)
        .first<{ id: string; cycle_id: string }>();
      if (event) {
        const already = await env.DB.prepare(
          `SELECT 1 AS ok FROM rotation_events
           WHERE cycle_id = ?1 AND participant_id = ?2 AND kind = 'used' AND voided = 0`,
        )
          .bind(event.cycle_id, inId)
          .first<{ ok: number }>();
        if (already && !ackRepeat) {
          throw new ApiError(
            409,
            "SUPPORT_REPEAT",
            "이번 순환에서 이미 서포터를 한 사람이 서포터 자리에 들어갑니다.",
            { participantIds: [inId] },
          );
        }
        statements.push(
          env.DB.prepare("UPDATE rotation_events SET participant_id = ?1, kind = ?2 WHERE id = ?3").bind(
            inId,
            already ? "repeat" : "used",
            event.id,
          ),
        );
        const team = match.roster.find((r) => r.participantId === outId)!.team;
        changes[`rotation:${team}`] = { from: outId, to: inId };
      }

      statements.push(
        env.DB.prepare("UPDATE matches SET version = version + 1 WHERE id = ?1 AND group_id = ?2").bind(
          matchId,
          groupId,
        ),
        bumpLiveVersion(env, groupId),
        insertRevision(env, groupId, matchId, "correction", changes, now),
      );
      return { stored: { matchId }, statements };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 경기 메모                                                            */
/* ------------------------------------------------------------------ */

/** 메모 입력을 검증하고 저장할 모양으로 바꾼다. 빈 글·null은 null(지우기). */
function parseMemo(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > MEMO_MAX * 4) {
    throw new ApiError(400, "INVALID_FIELD", "memo 값이 올바르지 않습니다.");
  }
  const memo = normalizeMemo(value);
  if (memo !== null && memoLength(memo) > MEMO_MAX) {
    throw new ApiError(400, "MEMO_TOO_LONG", `메모는 ${MEMO_MAX}자까지 쓸 수 있어요.`);
  }
  return memo;
}

/** 메모를 쓰고 고칠 수 있는 경기 상태. 미진행 취소·전적 제외 경기는 막는다. */
const MEMO_STATES = ["in_progress", "awaiting_result", "confirmed"] as const;

/**
 * 경기 메모를 쓰거나 고친다(비우면 지운다). 운영자·공동 운영자.
 * - 승패 정정 이력에 남기지 않고 경기 버전도 올리지 않는다(migrations/0016). 그래서 다른 기기에서 열어 둔
 *   결과 입력·정정 창이 메모 때문에 충돌하지 않는다.
 * - 대신 화면이 본 메모(baseMemo)와 지금 메모가 다르면 거절한다(다른 기기에서 먼저 고친 메모를 덮어쓰지 않게).
 */
export async function saveMemo(env: Env, groupId: string, matchId: string, body: Body): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "memo", "baseMemo"]);
  const requestId = requireRequestId(body);
  const memo = parseMemo(body.memo);
  if (body.baseMemo !== null && typeof body.baseMemo !== "string") {
    throw new ApiError(400, "INVALID_FIELD", "baseMemo 값이 올바르지 않습니다.");
  }
  const baseMemo = body.baseMemo === null ? null : normalizeMemo(body.baseMemo);
  await runMutation(env, {
    groupId,
    requestId,
    op: "memo",
    payload: { matchId, memo, baseMemo },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertState(match, MEMO_STATES);
      if ((match.memo ?? null) !== baseMemo) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "그 사이 다른 기기에서 메모가 바뀌었어요. 최신 메모를 확인한 뒤 다시 저장해 주세요.",
          { memo: match.memo ?? null },
        );
      }
      return {
        stored: { matchId },
        statements: [
          // 확인과 저장 사이에 메모·상태가 바뀌었거나 경기가 지워졌으면 batch 전체를 실패시킨다. 메모는 경기 버전을 올리지
          // 않아 삭제와의 겹침을 버전으로 막지 못하므로 deleted_at을 직접 본다(지운 경기의 메모가 바뀌지 않게).
          env.DB.prepare(
            `INSERT INTO guard (version_conflict)
             SELECT 1 WHERE NOT EXISTS (
               SELECT 1 FROM matches WHERE id = ?1 AND group_id = ?2 AND memo IS ?3
                 AND state IN ('in_progress', 'awaiting_result', 'confirmed') AND deleted_at IS NULL
             )`,
          ).bind(matchId, groupId, baseMemo),
          env.DB.prepare("UPDATE matches SET memo = ?1 WHERE id = ?2 AND group_id = ?3").bind(memo, matchId, groupId),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 챔피언 기록(migrations/0025)                                          */
/* ------------------------------------------------------------------ */

/**
 * 챔피언 입력 { 참가자 ID: 챔피언 키 }를 검사한다. 이 경기에서 쓴 챔피언 전체이고, 빠진 사람은 "기록 없음"이 된다
 * (일부만 채워도 저장된다). 같은 챔피언을 두 사람이 고른 것은 막지 않는다(화면이 흐리게 알려 주기만 한다).
 * 명단에 있는 사람인지는 경기를 읽은 뒤 assertChampionsInRoster가 본다.
 */
function parseChampions(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length > 10) {
    throw new ApiError(400, "INVALID_FIELD", "champions 값이 올바르지 않습니다.");
  }
  for (const key of Object.values(value)) {
    if (!isChampionKey(key)) {
      throw new ApiError(400, "INVALID_CHAMPION", "목록에 없는 챔피언이 있습니다. 화면을 새로 고친 뒤 다시 골라 주세요.");
    }
  }
  return value as Record<string, string>;
}

function assertChampionsInRoster(match: MatchView, champions: Record<string, string>): void {
  const outside = Object.keys(champions).filter((id) => !match.roster.some((r) => r.participantId === id));
  if (outside.length > 0) {
    throw new ApiError(400, "INVALID_PARTICIPANT", "이 경기의 참가자가 아닙니다.", { participantIds: outside });
  }
}

/** 명단 10행의 챔피언을 한 문장으로 바꾼다(입력에 없는 사람은 NULL). 경기 버전은 부르는 쪽이 올린다. */
function setChampions(
  env: Env,
  groupId: string,
  matchId: string,
  champions: Record<string, string>,
): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE match_roster SET champion = (SELECT value FROM json_each(?1) WHERE key = match_roster.participant_id)
     WHERE match_id = ?2 AND ${ROSTER_IN_GROUP} = ?3`,
  ).bind(JSON.stringify(champions), matchId, groupId);
}

/**
 * 확정 경기의 챔피언을 넣거나 고치거나 지운다(운영자·공동 운영자). 보낸 값이 그 경기 챔피언 전체가 된다.
 * 메모와 달리 경기 버전을 올리고 baseMatchVersion으로 충돌을 막는다. 명단 표에는 data_version 트리거가 없어
 * (migrations/0021) matches 행을 바꿔야 조회 응답의 ETag가 바뀌기 때문이다. 대신 그 사이 다른 기기에서 열어 둔
 * 정정 창은 충돌로 한 번 막힌다(새로 읽고 다시 하면 된다). 승패가 아니라서 변경 이력에는 남기지 않는다.
 */
export async function saveChampions(env: Env, groupId: string, matchId: string, body: Body): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion", "champions"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const champions = parseChampions(body.champions);
  await runMutation(env, {
    groupId,
    requestId,
    op: "champions",
    payload: { matchId, baseMatchVersion, champions },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["confirmed"]);
      assertChampionsInRoster(match, champions);
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, "confirmed"),
          setChampions(env, groupId, matchId, champions),
          env.DB.prepare("UPDATE matches SET version = version + 1 WHERE id = ?1 AND group_id = ?2").bind(
            matchId,
            groupId,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 미진행 취소 */
/* ------------------------------------------------------------------ */

/**
 * 하지 않은 경기를 취소한다. 그 경기의 서포터 차례 사건을 무효로 돌린다.
 * 차례를 돌려받은 사람이 같은 주기의 뒤 경기에서 "반복 허용"으로 서포터를 했다면
 * 그 사건을 일반 사용으로 바꿀지 묻는다.
 */
export async function cancelMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion", "convertRepeats"]);
  const requestId = requireRequestId(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const convertRepeats = typeof body.convertRepeats === "boolean" ? body.convertRepeats : null;
  await runMutation(env, {
    groupId,
    requestId,
    op: "cancel",
    payload: { matchId, baseMatchVersion, convertRepeats },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["in_progress", "awaiting_result"]);
      const now = nowIso();

      // 이 경기의 사용 사건(idx_rotation_match)에서 출발해 같은 주기·같은 사람의 반복 사건을 idx_rotation_cycle
      // (migrations/0027)로 찾는다. 반복 사건 쪽에서 출발하면 그 조건을 받을 색인이 없어 모든 모임의 차례 기록을 훑는다.
      // CROSS JOIN은 이 순서를 고정한다. 유효한 사용 사건은 (주기, 사람)마다 하나뿐이라(uq_rotation_used) 줄이 겹치지 않는다.
      const later = await env.DB.prepare(
        `SELECT r.id, r.participant_id FROM rotation_events u
         CROSS JOIN rotation_events r ON r.cycle_id = u.cycle_id AND r.participant_id = u.participant_id
         WHERE u.match_id = ?1 AND u.kind = 'used' AND u.voided = 0
           AND r.kind = 'repeat' AND r.voided = 0 AND r.match_id <> ?1
         ORDER BY r.created_at, r.id`,
      )
        .bind(matchId)
        .all<{ id: string; participant_id: string }>();
      if (later.results.length > 0 && convertRepeats === null) {
        throw new ApiError(
          409,
          "ROTATION_DECISION_REQUIRED",
          "이 경기에서 차례를 쓴 사람이 뒤 경기에서 반복 허용으로 서포터를 했습니다.",
          { participantIds: [...new Set(later.results.map((r) => r.participant_id))] },
        );
      }

      const statements = [
        matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
        env.DB.prepare(
          `UPDATE matches SET state = 'canceled', ended_at = COALESCE(ended_at, ?1), version = version + 1
           WHERE id = ?2 AND group_id = ?3`,
        ).bind(now, matchId, groupId),
        env.DB.prepare("UPDATE rotation_events SET voided = 1 WHERE match_id = ?1").bind(matchId),
        bumpLiveVersion(env, groupId),
        insertRevision(
          env,
          groupId,
          matchId,
          "cancel",
          { state: { from: match.state, to: "canceled" } },
          now,
        ),
      ];
      if (convertRepeats === true) {
        const converted = new Set<string>();
        for (const row of later.results) {
          // 사람당 가장 이른 반복 사건 하나만 일반 사용으로 바꾼다.
          if (converted.has(row.participant_id)) continue;
          converted.add(row.participant_id);
          statements.push(
            env.DB.prepare("UPDATE rotation_events SET kind = 'used' WHERE id = ?1").bind(row.id),
          );
        }
      }
      return { stored: { matchId }, statements };
    },
  });
  return loadMatch(env, groupId, matchId);
}
