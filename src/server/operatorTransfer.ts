// 운영자 넘기기: 1회용·24시간 인수 링크 만들기, 링크 정보, 수락(받는 계정이 대표 운영자가 된다).
import { newViewToken } from "./auth";
import type { Env } from "./env";
import { ApiError, nowIso } from "./http";
import { sha256Hex } from "./mutation";
import { MAX_GROUPS_PER_ACCOUNT, accountGroupCount, tooManyGroupsError, groupLimitGuard, isGroupLimitError } from "./groups";

const TRANSFER_HOURS = 24;

/**
 * 운영자 인수 링크를 만든다. 1회용이고 24시간 뒤 만료된다.
 * 새로 만들면 이 모임의 쓰지 않은 이전 링크는 무효가 된다.
 */
export async function createTransfer(
  env: Env,
  groupId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = newViewToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + TRANSFER_HOURS * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM operator_transfers WHERE group_id = ?1 AND used_at IS NULL").bind(
      groupId,
    ),
    env.DB.prepare(
      `INSERT INTO operator_transfers (token_hash, group_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4)`,
    ).bind(await sha256Hex(token), groupId, now, expiresAt),
  ]);
  return { token, expiresAt };
}

async function findTransfer(
  env: Env,
  token: string,
): Promise<{ token_hash: string; group_id: string; expires_at: string; name: string }> {
  const row = await env.DB.prepare(
    `SELECT t.token_hash, t.group_id, t.expires_at, g.name
     FROM operator_transfers t JOIN groups g ON g.id = t.group_id
     WHERE t.token_hash = ?1 AND t.used_at IS NULL AND t.expires_at > ?2`,
  )
    .bind(await sha256Hex(token), nowIso())
    .first<{ token_hash: string; group_id: string; expires_at: string; name: string }>();
  // 없는 링크, 이미 쓴 링크, 만료된 링크에 같은 답을 준다.
  if (!row) {
    throw new ApiError(404, "TRANSFER_INVALID", "이 링크는 이미 썼거나 만료됐습니다.");
  }
  return row;
}

export async function transferInfo(
  env: Env,
  token: string,
): Promise<{ groupName: string; expiresAt: string }> {
  const row = await findTransfer(env, token);
  return { groupName: row.name, expiresAt: row.expires_at };
}

/**
 * 인수 링크를 수락한다. 수락한 계정이 이 모임의 대표 운영자가 되고
 * 이전 운영자는 더 이상 수정할 수 없다. 경기·참가자·조회 링크는 바뀌지 않는다.
 * 받는 계정이 이 모임의 공동 운영자였으면 공동 운영자 행을 지운다(대표와 공동을 겸하지 않는다).
 * 이전 대표가 만든 쓰지 않은 공동 운영자 초대 링크와 참가자 연결 링크도 지운다(권한을 잃은 사람의 링크가 남지 않게).
 * 다른 공동 운영자는 그대로 남는다.
 */
export async function acceptTransfer(
  env: Env,
  accountId: string,
  token: string,
): Promise<{ groupId: string }> {
  const row = await findTransfer(env, token);
  const current = await env.DB.prepare(
    "SELECT account_id FROM group_operators WHERE group_id = ?1",
  )
    .bind(row.group_id)
    .first<{ account_id: string }>();
  if (current?.account_id === accountId) {
    throw new ApiError(409, "ALREADY_OPERATOR", "이미 이 모임의 운영자입니다.");
  }
  // 이 모임의 공동 운영자였으면 그 행이 지워지므로 맡은 모임 수는 그대로다.
  const coHere = await env.DB.prepare(
    "SELECT 1 AS ok FROM group_co_operators WHERE group_id = ?1 AND account_id = ?2",
  )
    .bind(row.group_id, accountId)
    .first<{ ok: number }>();
  if ((await accountGroupCount(env, accountId)) - (coHere ? 1 : 0) >= MAX_GROUPS_PER_ACCOUNT) {
    throw tooManyGroupsError();
  }
  const now = nowIso();
  try {
    await env.DB.batch([
      // 확인과 교체 사이에 같은 계정이 다른 모임을 맡아 한도를 넘으면 막는다(이 모임의 공동 운영자 행은 빼고 센다).
      groupLimitGuard(env, accountId, row.group_id),
      // 확인과 교체 사이에 다른 사람이 같은 링크를 쓰면 여기서 막힌다.
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM operator_transfers
           WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2
         )`,
      ).bind(row.token_hash, now),
      env.DB.prepare(
        "UPDATE group_operators SET account_id = ?1, created_at = ?2 WHERE group_id = ?3",
      ).bind(accountId, now, row.group_id),
      env.DB.prepare("UPDATE operator_transfers SET used_at = ?1 WHERE token_hash = ?2").bind(
        now,
        row.token_hash,
      ),
      env.DB.prepare("DELETE FROM group_co_operators WHERE group_id = ?1 AND account_id = ?2").bind(
        row.group_id,
        accountId,
      ),
      env.DB.prepare("DELETE FROM co_operator_invites WHERE group_id = ?1 AND used_at IS NULL").bind(
        row.group_id,
      ),
      // 이전 대표가 미리 만든 쓰지 않은 참가자 연결 링크도 지운다(만든 사람을 기록하지 않아 모임 전체, 2026-11-08 보안 점검).
      env.DB.prepare("DELETE FROM participant_claims WHERE group_id = ?1 AND used_at IS NULL").bind(row.group_id),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict")) {
      throw new ApiError(404, "TRANSFER_INVALID", "이 링크는 이미 썼거나 만료됐습니다.");
    }
    if (isGroupLimitError(error)) throw tooManyGroupsError();
    throw error;
  }
  return { groupId: row.group_id };
}
