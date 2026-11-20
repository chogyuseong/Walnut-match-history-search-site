// 모임 자체: 계정당 모임 수 한도(만들기·백업으로 새 모임·넘겨받기·공동 운영자 수락이 함께 지킨다), 이름 검증,
// 모임 만들기·목록·이름 바꾸기, 조회 토큰 다시 만들기. 참가자·설정·시즌·백업·넘기기는 같은 이름 접두의 다른 파일에 있다.
import { MAX_NAME_LENGTH, cleanName } from "../shared/names";
import { DEFAULT_SETTINGS } from "../shared/types";
import { newViewToken } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireRequestId } from "./http";
import { runMutation, sha256Hex } from "./mutation";


/** 한 계정이 맡을 수 있는 모임 수(대표 + 공동 운영 합계). 만들기·백업으로 새 모임·넘겨받기·공동 운영자 수락이 함께 지킨다. */
export const MAX_GROUPS_PER_ACCOUNT = 5;
/**
 * 한 모임의 참가자 상한(보관된 사람 포함, 행 수 기준). 백업 복원(restoreChecks.ts)도 같은 값으로 파일을 거절하므로
 * 둘이 어긋나면 자기 모임의 백업을 복원하지 못한다. 바꿀 때는 이 상수 하나만 고친다.
 */
export const MAX_PARTICIPANTS_PER_GROUP = 200;

type Body = Record<string, unknown>;

/** 이 계정이 대표 또는 공동 운영자로 맡은 모임 수. */
export async function accountGroupCount(env: Env, accountId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM group_operators WHERE account_id = ?1)
          + (SELECT COUNT(*) FROM group_co_operators WHERE account_id = ?1) AS n`,
  )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 계정당 모임 수를 넘었을 때의 오류. */
export function tooManyGroupsError(): ApiError {
  return new ApiError(
    409,
    "TOO_MANY_GROUPS",
    `한 계정은 대표·공동 운영을 합쳐 모임 ${MAX_GROUPS_PER_ACCOUNT}개까지 맡을 수 있어요. 쓰지 않는 모임을 넘기거나 삭제하거나, 공동 운영에서 나간 뒤 다시 해 주세요.`,
  );
}

/** 이름 검증(참가자·모임·시즌 이름 공통). 참가 신청의 새 이름도 같은 규칙을 쓴다(src/server/join.ts). */
export function parseName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "INVALID_NAME", "이름이 올바르지 않습니다.");
  }
  const name = cleanName(value);
  if (name === "" || [...name].length > MAX_NAME_LENGTH) {
    throw new ApiError(400, "INVALID_NAME", `이름은 1~${MAX_NAME_LENGTH}자여야 합니다.`, {
      name,
    });
  }
  return name;
}

/**
 * 계정당 모임 수 한도를 batch 안에서 다시 확인하는 보호 문장(migrations/0021 guard_group_limit).
 * "개수 확인 → 넣기" 사이에 같은 계정의 다른 요청이 끼어 한도를 넘기는 것을 막는다. 반드시 넣는 문장보다 앞에 둔다.
 * exceptCoGroupId: 이 모임의 공동 운영자 행은 세지 않는다(넘겨받기: 공동 운영자 행이 지워지고 대표가 된다).
 */
export function groupLimitGuard(env: Env, accountId: string, exceptCoGroupId: string | null = null): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (group_limit)
     SELECT 1 WHERE (SELECT COUNT(*) FROM group_operators WHERE account_id = ?1)
       + (SELECT COUNT(*) FROM group_co_operators WHERE account_id = ?1 AND group_id IS NOT ?3) >= ?2`,
  ).bind(accountId, MAX_GROUPS_PER_ACCOUNT, exceptCoGroupId);
}

/** batch 실패가 모임 수 한도 보호 문장(groupLimitGuard)에 걸린 것인지. */
export function isGroupLimitError(error: unknown): boolean {
  return String(error instanceof Error ? error.message : error).includes("guard_group_limit");
}

/** (계정, 요청 ID)에서 정해지는 모임 ID. 같은 요청을 다시 보내면 같은 모임이 된다(백업으로 새 모임과 같은 방식). */
async function groupIdFor(kind: string, accountId: string, requestId: string): Promise<string> {
  const hex = await sha256Hex(`${kind}\n${accountId}\n${requestId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 모임을 만들고 만든 계정을 운영자로 등록한다.
 * - 모임 수 한도는 미리 한 번 보고(빠른 거절), batch 안의 보호 문장으로 다시 확인한다(동시 요청 대비).
 * - requestId(필수, 2026-11-08)로 모임 ID를 (계정, 요청 ID)에서 정한다. 응답을 못 받아 다시 보내도 모임이 두 개
 *   생기지 않고 처음 만든 모임을 그대로 돌려준다. 모임이 아직 없으니 요청 기록 표(requests, 모임별)를 쓰는
 *   runMutation 대신 모임 ID의 기본 키가 중복을 막는다.
 */
export async function createGroup(
  env: Env,
  accountId: string,
  body: Body,
): Promise<{ id: string; name: string }> {
  assertOnlyKeys(body, ["name", "requestId"]);
  const name = body.name === undefined ? "내 내전 모임" : parseName(body.name);
  const requestId = requireRequestId(body);
  const id = await groupIdFor("create-group", accountId, requestId);
  const replay = async (): Promise<{ id: string; name: string } | null> => {
    const row = await env.DB.prepare(
      `SELECT g.id, g.name, o.account_id FROM groups g LEFT JOIN group_operators o ON o.group_id = g.id WHERE g.id = ?1`,
    )
      .bind(id)
      .first<{ id: string; name: string; account_id: string | null }>();
    if (!row) return null;
    // 그 사이 넘겨준 모임이면 같은 요청 ID를 다시 쓸 수 없다.
    if (row.account_id !== accountId) {
      throw new ApiError(409, "REQUEST_ID_REUSED", "같은 요청 ID로 다른 내용을 보낼 수 없습니다.");
    }
    return { id: row.id, name: row.name };
  };
  const done = await replay();
  if (done) return done;
  if ((await accountGroupCount(env, accountId)) >= MAX_GROUPS_PER_ACCOUNT) throw tooManyGroupsError();
  const settingsId = newId();
  const now = nowIso();
  try {
    await env.DB.batch([
      groupLimitGuard(env, accountId),
      env.DB.prepare(
        "INSERT INTO groups (id, name, view_token, created_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(id, name, newViewToken(), now),
      env.DB.prepare(
        `INSERT INTO settings_versions (id, group_id, version_no, payload, created_at)
         VALUES (?1, ?2, 1, ?3, ?4)`,
      ).bind(settingsId, id, JSON.stringify(DEFAULT_SETTINGS), now),
      env.DB.prepare("UPDATE groups SET settings_version_id = ?1 WHERE id = ?2").bind(settingsId, id),
      env.DB.prepare(
        "INSERT INTO group_operators (group_id, account_id, created_at) VALUES (?1, ?2, ?3)",
      ).bind(id, accountId, now),
    ]);
  } catch (error) {
    // 같은 요청이 동시에 먼저 처리됐을 수 있다(같은 모임 ID).
    const again = await replay();
    if (again) return again;
    if (isGroupLimitError(error)) throw tooManyGroupsError();
    throw error;
  }
  return { id, name };
}

/**
 * 이 계정이 운영하는 모임. role: owner = 대표 운영자, co = 공동 운영자(migrations/0011).
 * 대표로 맡은 모임을 먼저, 그 안에서는 만든 순서.
 */
export async function listGroups(
  env: Env,
  accountId: string,
): Promise<{ id: string; name: string; role: "owner" | "co" }[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name, 'owner' AS role, 0 AS ord, g.created_at AS made FROM groups g
     JOIN group_operators o ON o.group_id = g.id WHERE o.account_id = ?1
     UNION ALL
     SELECT g.id, g.name, 'co' AS role, 1 AS ord, g.created_at AS made FROM groups g
     JOIN group_co_operators c ON c.group_id = g.id WHERE c.account_id = ?1
     ORDER BY ord, made`,
  )
    .bind(accountId)
    .all<{ id: string; name: string; role: "owner" | "co" }>();
  return rows.results.map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

/** 모임 이름 바꾸기. 공통 경로(runMutation: 요청 ID 중복 방지·점검 확인·batch). */
export async function renameGroup(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["name", "requestId"]);
  const name = parseName(body.name);
  await runMutation(env, {
    groupId,
    requestId: requireRequestId(body),
    op: "rename-group",
    payload: { name },
    build: async () => ({
      stored: {},
      statements: [env.DB.prepare("UPDATE groups SET name = ?1 WHERE id = ?2").bind(name, groupId)],
    }),
  });
}

/**
 * 조회 토큰을 새로 만든다. 이전 링크는 더 이상 열리지 않는다.
 * 같은 요청 ID로 다시 보내면 같은 토큰을 돌려준다(요청 기록에 새 토큰이 14일 남는다. 토큰은 groups 표에도
 * 원문으로 있으므로 노출 범위가 넓어지지는 않는다).
 */
export async function regenerateViewToken(env: Env, groupId: string, body: Body = {}): Promise<string> {
  assertOnlyKeys(body, ["requestId"]);
  const { stored } = await runMutation(env, {
    groupId,
    requestId: requireRequestId(body),
    op: "view-token",
    payload: {},
    build: async () => {
      const token = newViewToken();
      return {
        stored: { viewToken: token },
        statements: [env.DB.prepare("UPDATE groups SET view_token = ?1 WHERE id = ?2").bind(token, groupId)],
      };
    },
  });
  return stored.viewToken as string;
}
