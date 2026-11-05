/**
 * 모임 삭제와 계정 삭제(탈퇴). 개인정보 처리방침의 "삭제" 항목을 운영자가 직접 할 수 있게 한다.
 *
 * 모임 삭제(되돌릴 수 없음):
 * - 확인 문구를 받아야 한다. 화면은 실행 직전에 백업 파일을 먼저 내려받는다(실패하면 삭제하지 않는다).
 * - 모임의 모든 행(경기·명단·이력·순환·시즌·참가자·합치기 기록·설정 버전·요청 기록·인수 링크·복원 작업·운영자)과
 *   모임 행 자체를 지운다. 조회 토큰은 모임 행에 있으므로 함께 사라져 조회 링크가 즉시 열리지 않는다.
 * - 보통은 한 batch(한 트랜잭션)로 지운다: 통째로 지워지거나 아무것도 안 지워진다.
 * - 행이 아주 많으면(GROUP_DELETE_BATCH_ROWS, 기본 2만 행) 백업 복원과 같은 단계 방식으로 나눈다:
 *   첫 batch가 모임을 점검 상태로 바꾸고 조회 토큰을 새 무작위 값으로 바꿔(링크 즉시 무효) 다른 쓰기를 막은 뒤,
 *   표마다 정해진 수만큼 지우고, 마지막 batch가 운영자와 모임 행을 지운다. 중간에 끊기면 점검 상태로 남고
 *   같은 삭제를 다시 실행하면 남은 행부터 이어서 지운다.
 * - 요청 기록(requests)도 지우므로 runMutation의 요청 ID 재전송 경로를 쓰지 않는다. 다시 보내면 모임이 없어
 *   "찾을 수 없음"이 돌아온다(화면은 이것을 "이미 삭제됨"으로 안내한다).
 *
 * 계정 삭제(탈퇴):
 * - 운영 중인 모임이 있으면 거절하고 그 모임 목록을 돌려준다(먼저 넘기거나 삭제).
 * - 계정 행과 그 계정의 요청 수 제한 기록을 지운다. 세션 쿠키는 계정 행을 확인하므로 모든 기기의 세션이 바로 무효다.
 *   같은 카카오·Google 계정으로 다시 로그인하면 새 계정 번호로 처음부터 시작한다.
 */
import { newViewToken } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys } from "./http";
import { DELETE_JOB, GROUP_DATA_TABLES, NOW_MS_SQL } from "./restore";
import { failureKeysFor, LOCAL_PROVIDER } from "./local";

export const GROUP_DELETE_CONFIRM_TEXT = "삭제";
export const ACCOUNT_DELETE_CONFIRM_TEXT = "탈퇴";
const DEFAULT_DELETE_BATCH_ROWS = 20_000;

/** 테스트 전용: 단계 사이에 끼어들어 "중간에 끊긴 삭제"를 만든다. */
export const deletionHooks: { afterStage: ((index: number) => void | Promise<void>) | null } = {
  afterStage: null,
};

type Body = Record<string, unknown>;

/** 모임 행을 지우기 전에 지울 표(외래 키 순서). 데이터 표 다음에 인수 링크·복원 작업·운영자. */
const GROUP_TABLES = [
  ...GROUP_DATA_TABLES,
  "operator_transfers",
  "restore_jobs",
  "group_operators",
] as const;

function batchRowsOf(env: Env): number {
  const n = Number(env.GROUP_DELETE_BATCH_ROWS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DELETE_BATCH_ROWS;
}

async function countRows(env: Env, groupId: string): Promise<Record<string, number>> {
  const select = GROUP_TABLES.map(
    (t) => `(SELECT COUNT(*) FROM ${t} WHERE group_id = ?1) AS ${t}`,
  ).join(", ");
  const row = await env.DB.prepare(`SELECT ${select}`).bind(groupId).first<Record<string, number>>();
  return row ?? {};
}

export interface GroupDeleteResult {
  deleted: true;
  /** 지운 경기·참가자 수(안내용). */
  matches: number;
  participants: number;
}

/** 모임 삭제. 운영자 확인은 앞단(index.ts)에서 끝났다. */
export async function deleteGroup(env: Env, groupId: string, body: Body): Promise<GroupDeleteResult> {
  assertOnlyKeys(body, ["confirm"]);
  if (body.confirm !== GROUP_DELETE_CONFIRM_TEXT) {
    throw new ApiError(
      400,
      "CONFIRM_REQUIRED",
      `확인 문구 '${GROUP_DELETE_CONFIRM_TEXT}'를 입력해 주세요.`,
    );
  }
  const counts = await countRows(env, groupId);
  const result: GroupDeleteResult = {
    deleted: true,
    matches: counts.matches ?? 0,
    participants: counts.participants ?? 0,
  };
  const byGroup = (t: string) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE group_id = ?1`).bind(groupId);
  const dropGroup = env.DB.prepare("DELETE FROM groups WHERE id = ?1").bind(groupId);
  const limit = batchRowsOf(env);
  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  if (total <= limit) {
    await env.DB.batch([...GROUP_TABLES.map(byGroup), dropGroup]);
    return result;
  }

  // 여러 단계: 점검 + 조회 링크 무효 + 작업 행을 삭제 표시로 → 표마다 limit 행씩 → 운영자·모임 행.
  // 작업 행(restore_jobs)을 삭제 표시로 덮어쓰면(migrations/0008)
  // - 진행 중이던 복원은 다음 단계의 주인 확인에서 멈춰 지우는 사이에 행을 다시 넣지 못하고,
  // - 복원은 삭제 표시의 작업 행을 이어받지 않으므로, 삭제가 중간에 멈춘 모임은 삭제를 다시 실행해서만 끝낸다.
  // 삭제끼리는 잠그지 않는다: 같은 행을 지우는 것뿐이라 겹쳐도 결과가 같다(멱등).
  const stages: D1PreparedStatement[][] = [
    [
      env.DB.prepare("UPDATE groups SET maintenance = 1, view_token = ?2 WHERE id = ?1").bind(
        groupId,
        newViewToken(),
      ),
      env.DB.prepare(
        `INSERT INTO restore_jobs (group_id, started_at, request_id, run_token, heartbeat_ms)
         VALUES (?1, ?2, ?3, ?4, ${NOW_MS_SQL})
         ON CONFLICT (group_id) DO UPDATE SET
           started_at = excluded.started_at, request_id = excluded.request_id,
           run_token = excluded.run_token, heartbeat_ms = excluded.heartbeat_ms`,
      ).bind(groupId, new Date().toISOString(), DELETE_JOB, crypto.randomUUID()),
    ],
  ];
  let current: D1PreparedStatement[] = [];
  let size = 0;
  for (const table of GROUP_TABLES) {
    // 운영자와 작업 행(삭제 표시)은 마지막 batch에서 모임 행과 함께 지운다.
    if (table === "group_operators" || table === "restore_jobs") continue;
    let remaining = counts[table] ?? 0;
    while (remaining > 0) {
      const take = Math.min(remaining, limit - size);
      current.push(
        env.DB.prepare(
          `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE group_id = ?1 LIMIT ?2)`,
        ).bind(groupId, take),
      );
      remaining -= take;
      size += take;
      if (size >= limit) {
        stages.push(current);
        current = [];
        size = 0;
      }
    }
  }
  // 마지막 batch: 남은 행을 모두(세는 사이에 늘었을 수도 있다) 지우고 운영자와 모임 행을 지운다.
  const final = [...current, ...GROUP_TABLES.map(byGroup), dropGroup];
  for (let i = 0; i < stages.length; i++) {
    try {
      await env.DB.batch(stages[i]!);
      await deletionHooks.afterStage?.(i);
    } catch (error) {
      if (i === 0) throw error;
      throw incomplete();
    }
  }
  try {
    await env.DB.batch(final);
  } catch {
    throw incomplete();
  }
  return result;
}

function incomplete(): ApiError {
  return new ApiError(
    503,
    "DELETE_INCOMPLETE",
    "모임 삭제가 중간에 멈췄습니다. 조회 링크는 이미 막혔고 모임은 점검 상태입니다. 삭제를 다시 실행하면 남은 기록을 지웁니다.",
  );
}

/** 계정 삭제(탈퇴). 운영 중인 모임이 있으면 거절한다. */
export async function deleteAccount(env: Env, accountId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["confirm"]);
  if (body.confirm !== ACCOUNT_DELETE_CONFIRM_TEXT) {
    throw new ApiError(
      400,
      "CONFIRM_REQUIRED",
      `확인 문구 '${ACCOUNT_DELETE_CONFIRM_TEXT}'를 입력해 주세요.`,
    );
  }
  const groups = await env.DB.prepare(
    `SELECT g.id, g.name FROM groups g JOIN group_operators o ON o.group_id = g.id
     WHERE o.account_id = ?1 ORDER BY g.created_at`,
  )
    .bind(accountId)
    .all<{ id: string; name: string }>();
  if (groups.results.length > 0) {
    throw new ApiError(
      409,
      "HAS_GROUPS",
      "운영 중인 모임이 있어 탈퇴할 수 없어요. 먼저 모임을 다른 사람에게 넘기거나 삭제해 주세요.",
      { groups: groups.results },
    );
  }
  // 자체 계정이면 비밀번호·복구 코드 행과 아이디별 실패 기록도 함께 지운다(src/server/local.ts).
  const account = await env.DB.prepare("SELECT provider, subject FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first<{ provider: string; subject: string }>();
  const failureKeys =
    account?.provider === LOCAL_PROVIDER ? await failureKeysFor(env, account.subject, accountId) : [`password:${accountId}`];
  try {
    await env.DB.batch([
      // 확인과 삭제 사이에 운영자 인수를 수락했으면 막는다.
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE EXISTS (SELECT 1 FROM group_operators WHERE account_id = ?1)`,
      ).bind(accountId),
      env.DB.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(`write-account:${accountId}`),
      ...failureKeys.map((key) => env.DB.prepare("DELETE FROM auth_failures WHERE key = ?1").bind(key)),
      env.DB.prepare("DELETE FROM local_credentials WHERE account_id = ?1").bind(accountId),
      env.DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(accountId),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict") || message.includes("FOREIGN KEY")) {
      throw new ApiError(
        409,
        "HAS_GROUPS",
        "그 사이 이 계정이 모임의 운영자가 됐어요. 화면을 새로 고친 뒤 다시 확인해 주세요.",
      );
    }
    throw error;
  }
}
