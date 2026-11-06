/**
 * 공동 운영자(migrations/0011). 운영자 넘기기(groups.ts의 createTransfer·acceptTransfer)를 본떴다.
 *
 * - 대표 운영자가 1회용 초대 링크를 만든다: 24시간, 토큰은 해시만 저장, 새로 만들면 쓰지 않은 이전 링크는 지운다.
 * - 로그인한 다른 계정이 수락하면 공동 운영자가 된다. 모임당 최대 MAX_CO_OPERATORS명.
 * - 이미 다른 모임이 있는 계정도 수락할 수 있다(화면의 "모임 고르기"로 바꿔 연다). 단 계정당 모임 수
 *   (대표 + 공동 운영 합계 MAX_GROUPS_PER_ACCOUNT)를 넘으면 거절한다(2026-11-06, 예전에는 HAS_GROUP으로 거절).
 * - 대표 운영자는 목록을 보고 내보낼 수 있고, 공동 운영자는 스스로 나갈 수 있다.
 * - 권한 확인은 요청마다 표를 다시 읽으므로(auth.ts operatorRole) 내보낸 계정의 다음 요청은 바로 거절된다.
 */
import { newViewToken } from "./auth";
import type { Env } from "./env";
import { accountGroupCount, MAX_GROUPS_PER_ACCOUNT, tooManyGroupsError } from "./groups";
import { ApiError, nowIso } from "./http";
import { sha256Hex } from "./mutation";

export const MAX_CO_OPERATORS = 5;
const INVITE_HOURS = 24;

const INVITE_INVALID_MESSAGE = "이 초대 링크는 이미 썼거나 만료됐어요. 대표 운영자에게 새 링크를 요청해 주세요.";

function fullError(): ApiError {
  return new ApiError(
    409,
    "CO_OPERATORS_FULL",
    `공동 운영자는 한 모임에 ${MAX_CO_OPERATORS}명까지예요. 먼저 한 명을 내보내 주세요.`,
  );
}

async function coCount(env: Env, groupId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_co_operators WHERE group_id = ?1")
    .bind(groupId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 초대 링크를 만든다. 대표 운영자 확인은 앞단(index.ts requireOwner)에서 끝났다. */
export async function createCoInvite(env: Env, groupId: string): Promise<{ token: string; expiresAt: string }> {
  if ((await coCount(env, groupId)) >= MAX_CO_OPERATORS) throw fullError();
  const token = newViewToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + INVITE_HOURS * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM co_operator_invites WHERE group_id = ?1 AND used_at IS NULL").bind(groupId),
    env.DB.prepare(
      `INSERT INTO co_operator_invites (token_hash, group_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(await sha256Hex(token), groupId, now, expiresAt),
  ]);
  return { token, expiresAt };
}

async function findInvite(
  env: Env,
  token: string,
): Promise<{ token_hash: string; group_id: string; expires_at: string; name: string }> {
  const row = await env.DB.prepare(
    `SELECT i.token_hash, i.group_id, i.expires_at, g.name
     FROM co_operator_invites i JOIN groups g ON g.id = i.group_id
     WHERE i.token_hash = ?1 AND i.used_at IS NULL AND i.expires_at > ?2`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<{ token_hash: string; group_id: string; expires_at: string; name: string }>();
  // 없는 링크, 이미 쓴 링크, 만료된 링크에 같은 답을 준다.
  if (!row) throw new ApiError(404, "INVITE_INVALID", INVITE_INVALID_MESSAGE);
  return row;
}

export async function coInviteInfo(env: Env, token: string): Promise<{ groupName: string; expiresAt: string }> {
  const row = await findInvite(env, token);
  return { groupName: row.name, expiresAt: row.expires_at };
}

/**
 * 초대를 수락한다. 확인(링크 유효, 인원, 계정의 모임 수 한도)과 저장을 한 batch로 실행해
 * 사이에 다른 수락·인원 변경이 끼어들어도 규칙이 깨지지 않게 한다.
 */
export async function acceptCoInvite(env: Env, accountId: string, token: string): Promise<{ groupId: string }> {
  const row = await findInvite(env, token);
  const owner = await env.DB.prepare("SELECT account_id FROM group_operators WHERE group_id = ?1")
    .bind(row.group_id)
    .first<{ account_id: string }>();
  if (owner?.account_id === accountId) {
    throw new ApiError(409, "ALREADY_OPERATOR", "이미 이 모임의 대표 운영자예요.");
  }
  const already = await env.DB.prepare(
    "SELECT 1 AS ok FROM group_co_operators WHERE group_id = ?1 AND account_id = ?2",
  )
    .bind(row.group_id, accountId)
    .first<{ ok: number }>();
  if (already) throw new ApiError(409, "ALREADY_OPERATOR", "이미 이 모임의 공동 운영자예요.");
  if ((await accountGroupCount(env, accountId)) >= MAX_GROUPS_PER_ACCOUNT) throw tooManyGroupsError();
  if ((await coCount(env, row.group_id)) >= MAX_CO_OPERATORS) throw fullError();

  const now = nowIso();
  try {
    await env.DB.batch([
      // 확인과 저장 사이에 같은 링크가 쓰였거나 만료됐으면 막는다.
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM co_operator_invites WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         )`,
      ).bind(row.token_hash, now),
      // 그 사이 인원이 찼거나 이 계정의 모임 수가 한도에 닿았으면 막는다.
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE (SELECT COUNT(*) FROM group_co_operators WHERE group_id = ?1) >= ?3
           OR (SELECT COUNT(*) FROM group_operators WHERE account_id = ?2)
              + (SELECT COUNT(*) FROM group_co_operators WHERE account_id = ?2) >= ?4`,
      ).bind(row.group_id, accountId, MAX_CO_OPERATORS, MAX_GROUPS_PER_ACCOUNT),
      env.DB.prepare(
        "INSERT INTO group_co_operators (group_id, account_id, created_at) VALUES (?1, ?2, ?3)",
      ).bind(row.group_id, accountId, now),
      env.DB.prepare("UPDATE co_operator_invites SET used_at = ?1 WHERE token_hash = ?2").bind(now, row.token_hash),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict")) throw new ApiError(404, "INVITE_INVALID", INVITE_INVALID_MESSAGE);
    if (message.includes("guard_version_conflict")) {
      if ((await coCount(env, row.group_id)) >= MAX_CO_OPERATORS) throw fullError();
      throw tooManyGroupsError();
    }
    throw error;
  }
  return { groupId: row.group_id };
}

export interface CoOperatorView {
  accountId: string;
  /** 로그인 수단: local(자체 계정) | kakao | google | fake(로컬 개발). */
  provider: string;
  /** 자체 계정이면 아이디. 다른 로그인 수단은 식별자를 보여주지 않는다(null). */
  loginId: string | null;
  /** 계정을 만든 날(로그인 수단의 첫 로그인). */
  accountCreatedAt: string;
  /** 공동 운영자가 된 시각. */
  joinedAt: string;
}

/**
 * 공동 운영자 목록(대표 운영자용). 계정에 이미 저장된 값만 보여준다: 로그인 수단, 자체 계정 아이디, 계정 등록일.
 * 카카오·Google의 회원번호(subject)는 내보내지 않는다.
 */
export async function listCoOperators(env: Env, groupId: string): Promise<{ coOperators: CoOperatorView[]; max: number }> {
  const rows = await env.DB.prepare(
    `SELECT c.account_id, c.created_at AS joined_at, a.provider, a.subject, a.created_at AS account_created_at
     FROM group_co_operators c JOIN accounts a ON a.id = c.account_id
     WHERE c.group_id = ?1 ORDER BY c.created_at, c.account_id`,
  )
    .bind(groupId)
    .all<{ account_id: string; joined_at: string; provider: string; subject: string; account_created_at: string }>();
  return {
    max: MAX_CO_OPERATORS,
    coOperators: rows.results.map((r) => ({
      accountId: r.account_id,
      provider: r.provider,
      loginId: r.provider === "local" ? r.subject : null,
      accountCreatedAt: r.account_created_at,
      joinedAt: r.joined_at,
    })),
  };
}

/** 공동 운영자를 내보낸다(대표) 또는 스스로 나간다(본인). 다음 요청부터 바로 권한이 없다. */
export async function removeCoOperator(env: Env, groupId: string, accountId: string): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM group_co_operators WHERE group_id = ?1 AND account_id = ?2")
    .bind(groupId, accountId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new ApiError(404, "NOT_FOUND", "공동 운영자를 찾을 수 없어요. 이미 나갔을 수 있어요.");
  }
}
