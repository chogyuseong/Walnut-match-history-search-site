import { encodeAvoid, MAX_AVOID, normalizeAvoidPositions } from "../shared/avoid";
import { parseLegacyChoice, type LegacyChoice } from "../shared/legacy";
import { MAX_NAME_LENGTH, cleanName, nameKey } from "../shared/names";
import { RATING_SETTING_KEYS, RATING_SETTING_RANGES } from "../shared/rating";
import { parseTitleBands } from "../shared/titles";
import {
  DEFAULT_SETTINGS,
  MAX_SKILL_GROUP,
  upgradeGroupWeights,
  type ParticipantView,
  type Settings,
} from "../shared/types";
import { newViewToken } from "./auth";
import type { Env } from "./env";
import {
  ApiError,
  assertOnlyKeys,
  newId,
  nowIso,
  requireInt,
  requireString,
} from "./http";
import { bumpLiveVersion, liveVersionGuard, runMutation, sha256Hex, type Plan } from "./mutation";
import { loadGroup, loadOpenSession, parseSnapshot, snapshotStatements } from "./snapshot";

/** 한 계정이 맡을 수 있는 모임 수(대표 + 공동 운영 합계). 만들기·백업으로 새 모임·넘겨받기·공동 운영자 수락이 함께 지킨다. */
export const MAX_GROUPS_PER_ACCOUNT = 5;
/**
 * 한 모임의 참가자 상한(보관된 사람 포함, 행 수 기준). 백업 복원(restore.ts)도 같은 값으로 파일을 거절하므로
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

/**
 * 요청 ID(필수). runMutation이 같은 요청 ID를 한 번만 처리한다(재전송 안전).
 * 2026-11-07에는 선택이었고(없으면 서버가 만듦), 웹이 모든 운영자 쓰기에서 보내게 된 2026-11-08에 필수로 바꿨다
 * (docs/개선-서버-2026-11-08.md). 없거나 모양이 틀리면 400 INVALID_FIELD.
 */
export function requireRequestId(body: Body): string {
  return requireString(body.requestId, "requestId", 8, 64);
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
 * 이름 목록에 해당하는 활성 참가자를 돌려준다. 없는 이름은 새로 만든다.
 * 같은 이름으로 여러 번 불러도 결과가 같다(새 요청 ID로 다시 보내도 같은 사람을 돌려준다).
 * 넣기는 공통 경로(runMutation)를 거치고, 돌려줄 목록은 넣은 뒤 이름으로 다시 읽는다.
 */
export async function ensureParticipants(
  env: Env,
  groupId: string,
  body: Body,
): Promise<ParticipantView[]> {
  assertOnlyKeys(body, ["names", "requestId"]);
  if (!Array.isArray(body.names) || body.names.length < 1 || body.names.length > 30) {
    throw new ApiError(400, "INVALID_FIELD", "names 값이 올바르지 않습니다.");
  }
  const names = body.names.map(parseName);
  const keys = names.map(nameKey);
  if (new Set(keys).size !== keys.length) {
    throw new ApiError(400, "DUPLICATE_NAME", "같은 이름이 두 번 들어 있습니다.");
  }
  const tooMany = () => new ApiError(409, "TOO_MANY_PARTICIPANTS", "참가자가 너무 많습니다.");
  try {
    await runMutation(env, {
      groupId,
      requestId: requireRequestId(body),
      op: "ensure-participants",
      payload: { names },
      build: async () => {
        // "지금 수 ≥ 상한"만 보면 199명에서 30명을 한 번에 넣어 229명이 될 수 있었다. 실제로 새로 생길 행 수를 더해 본다.
        // 이미 활성 참가자인 이름은 아래 INSERT가 건너뛰므로 세지 않는다(보관된 같은 이름은 새 행이 생기므로 센다).
        // 여기서는 빠른 거절만 한다. 확정은 batch 맨 앞의 보호 문장이 같은 계산으로 다시 한다.
        const count = await env.DB.prepare(
          `SELECT COUNT(*) AS n,
                  SUM(CASE WHEN status = 'active' AND name_key IN (SELECT value FROM json_each(?2)) THEN 1 ELSE 0 END) AS existing
           FROM participants WHERE group_id = ?1`,
        )
          .bind(groupId, JSON.stringify(keys))
          .first<{ n: number; existing: number | null }>();
        const adding = keys.length - (count?.existing ?? 0);
        if (adding > 0 && (count?.n ?? 0) + adding > MAX_PARTICIPANTS_PER_GROUP) throw tooMany();
        const now = nowIso();
        return {
          stored: {},
          statements: [
            // 위 확인은 batch 밖이라, 195명 모임에 두 기기가 5명씩 동시에 넣으면 둘 다 통과해 205명이 됐다(그 백업은
            // 복원이 거절한다). batch 안에서 같은 계산을 다시 해 넘으면 batch 전체를 되돌린다.
            env.DB.prepare(
              `INSERT INTO guard (state_conflict)
               SELECT 1 FROM (
                 SELECT COUNT(*) AS adding FROM json_each(?2)
                 WHERE value NOT IN (SELECT name_key FROM participants WHERE group_id = ?1 AND status = 'active')
               )
               WHERE adding > 0 AND (SELECT COUNT(*) FROM participants WHERE group_id = ?1) + adding > ?3`,
            ).bind(groupId, JSON.stringify(keys), MAX_PARTICIPANTS_PER_GROUP),
            ...names.map((name, i) =>
              env.DB.prepare(
                `INSERT INTO participants (id, group_id, name, name_key, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (group_id, name_key) WHERE status = 'active' DO NOTHING`,
              ).bind(newId(), groupId, name, keys[i], now),
            ),
          ],
        };
      },
    });
  } catch (error) {
    // 이 batch에서 VERSION_CONFLICT가 되는 것은 위 보호 문장(guard_state_conflict)뿐이다(runMutation이 바꿔 준다).
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") throw tooMany();
    throw error;
  }
  const placeholders = keys.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id, name, status, skill_group, name_key FROM participants
     WHERE group_id = ?1 AND status = 'active' AND name_key IN (${placeholders})`,
  )
    .bind(groupId, ...keys)
    .all<{
      id: string;
      name: string;
      status: "active";
      skill_group: number | null;
      name_key: string;
    }>();
  const byKey = new Map(rows.results.map((r) => [r.name_key, r]));
  return keys.map((key) => {
    const row = byKey.get(key)!;
    return { id: row.id, name: row.name, status: row.status, skillGroup: row.skill_group };
  });
}

/**
 * 참가자의 이름·실력 그룹·보관 상태·기피 라인을 바꾼다. 과거 경기의 소속과 승패는 바뀌지 않는다.
 * 공통 경로(runMutation)를 거친다. 읽고-고쳐-쓰기라 동시 수정을 막는다(migrations/0021 participants.version):
 * - batch 안의 보호 문장이 "읽은 뒤 그 사이 다른 수정이 없었는지"를 확인한다(서버 안의 경쟁, 화면 변경 없이 동작).
 * - 화면이 baseVersion(운영자 스냅숏의 participants[].version)을 보내면 화면이 본 값과도 비교한다
 *   (다른 기기에서 먼저 고친 것을 덮어쓰지 않는다). 다르면 409 VERSION_CONFLICT, details.version에 지금 버전.
 */
export async function updateParticipant(
  env: Env,
  groupId: string,
  participantId: string,
  body: Body,
): Promise<void> {
  assertOnlyKeys(body, ["name", "skillGroup", "status", "avoidPositions", "requestId", "baseVersion"]);
  const baseVersion = body.baseVersion === undefined ? null : requireInt(body.baseVersion, "baseVersion");
  const { requestId: _requestId, ...payload } = body;
  const currentVersion = async () =>
    (
      await env.DB.prepare("SELECT version FROM participants WHERE id = ?1 AND group_id = ?2")
        .bind(participantId, groupId)
        .first<{ version: number }>()
    )?.version;
  try {
    await runMutation(env, {
      groupId,
      requestId: requireRequestId(body),
      op: "update-participant",
      payload: { participantId, ...payload },
      conflictDetails: async () => ({ version: await currentVersion() }),
      build: () => participantPlan(env, groupId, participantId, body, baseVersion),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE")) {
      throw new ApiError(409, "NAME_TAKEN", "같은 이름의 참가자가 이미 있습니다.", {
        name: body.name === undefined ? undefined : parseName(body.name),
      });
    }
    throw error;
  }
}

/** 티어 일괄 저장의 본문 상한. 200명이면 약 15KB라 기본 16KB에 빠듯해서 이 경로만 넉넉히 받는다. */
export const SKILL_GROUPS_BODY_BYTES = 32 * 1024;

/**
 * 여러 참가자의 티어(skill_group)를 한 요청으로 바꾼다. 화면 "기록으로 제안받기 → 선택한 N명 적용"이 쓴다.
 * 예전에는 사람마다 PATCH를 차례로 보내 30명이면 요청 30번에 쓰기 요청 수 제한(분당 60)에도 걸릴 수 있었다.
 * 규칙은 updateParticipant와 같다: baseVersion을 보낸 사람은 화면이 본 버전과 비교하고(다르면 409, 아무것도
 * 저장하지 않음), batch 안의 보호 문장이 "읽은 뒤 그 사이 고친 사람이 없는지"를 다시 본다. 버전은 사람마다 1 오른다.
 * 질의 수는 인원과 상관없이 읽기 1회 + batch 1회다(json_each로 한꺼번에).
 */
export async function saveSkillGroups(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "changes"]);
  const requestId = requireRequestId(body);
  if (!Array.isArray(body.changes) || body.changes.length === 0 || body.changes.length > MAX_PARTICIPANTS_PER_GROUP) {
    throw new ApiError(400, "INVALID_FIELD", "changes 값이 올바르지 않습니다.");
  }
  const changes = body.changes.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ApiError(400, "INVALID_FIELD", "changes 값이 올바르지 않습니다.");
    }
    const e = entry as Body;
    assertOnlyKeys(e, ["participantId", "skillGroup", "baseVersion"]);
    let skillGroup: number | null = null;
    if (e.skillGroup !== null) {
      skillGroup = requireInt(e.skillGroup, "skillGroup");
      if (skillGroup < 1 || skillGroup > MAX_SKILL_GROUP) {
        throw new ApiError(400, "INVALID_FIELD", "skillGroup 값이 올바르지 않습니다.");
      }
    }
    return {
      participantId: requireString(e.participantId, "participantId", 1, 64),
      skillGroup,
      baseVersion: e.baseVersion === undefined ? null : requireInt(e.baseVersion, "baseVersion"),
    };
  });
  const ids = changes.map((c) => c.participantId);
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(400, "INVALID_FIELD", "같은 사람이 두 번 들어 있습니다.");
  }

  await runMutation(env, {
    groupId,
    requestId,
    op: "set-skill-groups",
    payload: { changes },
    build: async () => {
      const rows = await env.DB.prepare(
        `SELECT id, version FROM participants
         WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
      )
        .bind(groupId, JSON.stringify(ids))
        .all<{ id: string; version: number }>();
      const versionOf = new Map(rows.results.map((r) => [r.id, r.version]));
      for (const c of changes) {
        const version = versionOf.get(c.participantId);
        // 다른 모임의 참가자는 없는 것과 같은 답을 준다.
        if (version === undefined) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");
        if (c.baseVersion !== null && c.baseVersion !== version) {
          throw new ApiError(
            409,
            "VERSION_CONFLICT",
            "그 사이 다른 기기에서 참가자를 고쳤습니다. 최신 상태를 확인해 주세요.",
            { participantId: c.participantId, version },
          );
        }
      }
      // 보호 문장과 UPDATE가 같은 목록을 본다: id·읽은 버전(v)·새 티어(g).
      const plan = JSON.stringify(
        changes.map((c) => ({ id: c.participantId, v: versionOf.get(c.participantId), g: c.skillGroup })),
      );
      return {
        stored: {},
        statements: [
          env.DB.prepare(
            `INSERT INTO guard (version_conflict)
             SELECT 1 FROM json_each(?2) AS j
             WHERE NOT EXISTS (
               SELECT 1 FROM participants p
               WHERE p.group_id = ?1 AND p.id = json_extract(j.value, '$.id') AND p.version = json_extract(j.value, '$.v')
             )
             LIMIT 1`,
          ).bind(groupId, plan),
          env.DB.prepare(
            `UPDATE participants
             SET skill_group = (SELECT json_extract(j.value, '$.g') FROM json_each(?2) AS j
                                WHERE json_extract(j.value, '$.id') = participants.id),
                 version = version + 1
             WHERE group_id = ?1 AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`,
          ).bind(groupId, plan),
        ],
      };
    },
  });
}

async function participantPlan(
  env: Env,
  groupId: string,
  participantId: string,
  body: Body,
  baseVersion: number | null,
): Promise<Plan> {
  const existing = await env.DB.prepare(
    `SELECT id, name, name_key, skill_group, status, avoid_positions, version
     FROM participants WHERE id = ?1 AND group_id = ?2`,
  )
    .bind(participantId, groupId)
    .first<{
      id: string;
      name: string;
      name_key: string;
      skill_group: number | null;
      status: string;
      avoid_positions: string | null;
      version: number;
    }>();
  if (!existing) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");
  if (baseVersion !== null && baseVersion !== existing.version) {
    throw new ApiError(409, "VERSION_CONFLICT", "그 사이 다른 기기에서 이 참가자를 고쳤습니다. 최신 상태를 확인해 주세요.", {
      version: existing.version,
    });
  }
  // 합쳐진 사람을 다시 활성으로 바꾸면 그 사람이 새 경기에 들어가 되돌리기가 꼬인다. 되돌리기로만 돌린다.
  if (body.status === "active" && existing.status !== "active") {
    const merged = await env.DB.prepare(
      "SELECT 1 AS ok FROM participant_merges WHERE source_id = ?1 AND undone_at IS NULL",
    )
      .bind(participantId)
      .first<{ ok: number }>();
    if (merged) {
      throw new ApiError(
        409,
        "MERGED_PARTICIPANT",
        "다른 사람에게 합쳐진 이름이에요. 다시 쓰려면 모임 탭의 '중복 참가자 합치기'에서 되돌려 주세요.",
      );
    }
  }

  let name = existing.name;
  let key = existing.name_key;
  let skillGroup = existing.skill_group;
  let status = existing.status;
  if (body.name !== undefined) {
    name = parseName(body.name);
    key = nameKey(name);
  }
  if (body.skillGroup !== undefined) {
    if (body.skillGroup === null) {
      skillGroup = null;
    } else {
      const value = requireInt(body.skillGroup, "skillGroup");
      if (value < 1 || value > MAX_SKILL_GROUP) {
        throw new ApiError(400, "INVALID_FIELD", "skillGroup 값이 올바르지 않습니다.");
      }
      skillGroup = value;
    }
  }
  // 기피 라인: 포지션 이름 배열(중복은 지움) 또는 null(지우기). 5개 모두는 거절한다.
  let avoidPositions = existing.avoid_positions;
  if (body.avoidPositions !== undefined) avoidPositions = parseAvoidField(body.avoidPositions);
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived") {
      throw new ApiError(400, "INVALID_FIELD", "status 값이 올바르지 않습니다.");
    }
    status = body.status;
  }
  return {
    stored: {},
    statements: [
      // 읽은 뒤 그 사이 다른 수정(다른 요청·합치기·익명 처리·멤버의 기피 라인)이 있었으면 batch 전체를 되돌린다.
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM participants WHERE id = ?1 AND group_id = ?2 AND version = ?3)`,
      ).bind(participantId, groupId, existing.version),
      env.DB.prepare(
        `UPDATE participants SET name = ?1, name_key = ?2, skill_group = ?3, status = ?4, avoid_positions = ?7,
           version = version + 1
         WHERE id = ?5 AND group_id = ?6`,
      ).bind(name, key, skillGroup, status, participantId, groupId, avoidPositions),
      // 운영자가 기피 라인을 고치면 "본인이 정함" 표시를 지운다(migrations/0019). 보내지 않았으면 그대로.
      ...(body.avoidPositions !== undefined
        ? [
            env.DB.prepare(
              "UPDATE participant_links SET avoid_self_at = NULL WHERE group_id = ?1 AND participant_id = ?2",
            ).bind(groupId, participantId),
          ]
        : []),
    ],
  };
}

/**
 * 기피 라인 값 검증(운영자의 참가자 수정과 멤버의 내 기피 라인이 같이 쓴다). 저장할 글자 또는 NULL을 돌려준다.
 * 포지션 이름 배열(중복은 지움) 또는 null(지우기). 5개 모두·모르는 값은 거절한다.
 */
export function parseAvoidField(value: unknown): string | null {
  if (value === null) return null;
  const list = normalizeAvoidPositions(value);
  if (!list) {
    // 값은 모두 맞는데 서로 다른 라인이 다섯 개면 갈 라인이 없다는 이유를 알려 준다.
    const tooMany =
      Array.isArray(value) &&
      value.every((v) => normalizeAvoidPositions([v]) !== null) &&
      new Set(value).size > MAX_AVOID;
    throw new ApiError(
      400,
      "INVALID_FIELD",
      tooMany ? `기피 라인은 ${MAX_AVOID}개까지 정할 수 있어요.` : "avoidPositions 값이 올바르지 않습니다.",
    );
  }
  return encodeAvoid(list);
}

/** 설정 스냅샷 검증. 백업 복원(restore.ts)도 같은 규칙으로 검사한다. */
export function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "INVALID_FIELD", "settings 값이 올바르지 않습니다.");
  }
  const raw = value as Body;
  assertOnlyKeys(raw, [
    "rotationEnabled",
    "groupsPublic",
    "groupWeights",
    "titleBands",
    "teamDiversity",
    ...RATING_SETTING_KEYS,
  ]);
  if (typeof raw.rotationEnabled !== "boolean" || typeof raw.groupsPublic !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "settings 값이 올바르지 않습니다.");
  }
  // 5개(티어 1~5). 4개(티어 4단계 시절의 백업·그 시절 화면이 연 채로 보낸 저장)도 받아 upgradeGroupWeights로 5개로 맞춘다.
  const weights = raw.groupWeights;
  if (
    !Array.isArray(weights) ||
    (weights.length !== 4 && weights.length !== 5) ||
    !weights.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1000)
  ) {
    throw new ApiError(400, "INVALID_FIELD", "groupWeights 값이 올바르지 않습니다.");
  }
  const settings: Settings = {
    rotationEnabled: raw.rotationEnabled,
    groupsPublic: raw.groupsPublic,
    groupWeights: upgradeGroupWeights(weights as number[]),
  };
  // 칭호 구간: 보내지 않으면 저장하지 않은 상태(기본값 적용)로 두고, 빈 배열은 빈 채로 저장한다.
  if (raw.titleBands !== undefined) {
    const parsed = parseTitleBands(raw.titleBands);
    if (!parsed.ok) throw new ApiError(400, "INVALID_FIELD", parsed.message);
    settings.titleBands = parsed.bands;
  }
  // 팀 추천 다양성: 보내지 않으면 저장하지 않은 상태(켜짐으로 본다). 보내면 true/false만 받는다.
  if (raw.teamDiversity !== undefined) {
    if (typeof raw.teamDiversity !== "boolean") {
      throw new ApiError(400, "INVALID_FIELD", "teamDiversity 값이 올바르지 않습니다.");
    }
    settings.teamDiversity = raw.teamDiversity;
  }
  // 배치 경기 수·MMR 시작값·K: 보내지 않으면 저장하지 않은 상태(기본값). 보내면 범위 안 정수만 받는다.
  for (const key of RATING_SETTING_KEYS) {
    const n = raw[key];
    if (n === undefined) continue;
    const { label, min, max } = RATING_SETTING_RANGES[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw new ApiError(400, "INVALID_FIELD", `${label}는 ${min}~${max} 사이 정수여야 해요.`);
    }
    settings[key] = n;
  }
  return settings;
}

/** 설정은 병합하지 않고 전체 스냅샷을 새 버전으로 저장한다. */
export async function saveSettings(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "baseSettingsVersionId", "settings"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const baseId = requireString(body.baseSettingsVersionId, "baseSettingsVersionId", 1, 64);
  const settings = parseSettings(body.settings);
  await runMutation(env, {
    groupId,
    requestId,
    op: "settings",
    payload: { baseId, settings },
    build: async () => {
      const group = await loadGroup(env, groupId);
      if (group.settings_version_id !== baseId) {
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "그 사이 설정이 바뀌었습니다. 최신 설정을 확인해 주세요.",
        );
      }
      const id = newId();
      const now = nowIso();
      return {
        stored: { settingsVersionId: id },
        statements: [
          env.DB.prepare(
            `INSERT INTO guard (version_conflict)
             SELECT 1 WHERE NOT EXISTS (
               SELECT 1 FROM groups WHERE id = ?1 AND settings_version_id = ?2
             )`,
          ).bind(groupId, baseId),
          env.DB.prepare(
            `INSERT INTO settings_versions (id, group_id, version_no, payload, created_at)
             SELECT ?1, ?2, COALESCE(MAX(version_no), 0) + 1, ?3, ?4
             FROM settings_versions WHERE group_id = ?2`,
          ).bind(id, groupId, JSON.stringify(settings), now),
          env.DB.prepare("UPDATE groups SET settings_version_id = ?1 WHERE id = ?2").bind(
            id,
            groupId,
          ),
        ],
      };
    },
  });
}

/**
 * 현재 순환 주기를 닫고 새 주기를 연다(화면 이름 "서포터 횟수 초기화"). 전적은 바뀌지 않는다.
 * 새 주기에는 보정값(서포터 횟수 직접 입력)이 없다. 열린 내전이 없으면 첫 경기 전에 미리 넣어 둔 보정값만 지운다.
 */
export async function startNewCycle(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "baseLiveVersion"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const baseLiveVersion = requireInt(body.baseLiveVersion, "baseLiveVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "new-cycle",
    payload: { baseLiveVersion },
    conflictDetails: async () => ({ liveVersion: (await loadGroup(env, groupId)).live_version }),
    build: async () => {
      const session = await loadOpenSession(env, groupId);
      const clearPending = env.DB.prepare(
        "DELETE FROM support_adjustments WHERE group_id = ?1 AND cycle_id IS NULL",
      ).bind(groupId);
      if (!session) {
        return {
          stored: {},
          statements: [liveVersionGuard(env, groupId, baseLiveVersion), clearPending, bumpLiveVersion(env, groupId)],
        };
      }
      const now = nowIso();
      return {
        stored: {},
        statements: [
          liveVersionGuard(env, groupId, baseLiveVersion),
          clearPending,
          env.DB.prepare(
            "UPDATE rotation_cycles SET status = 'closed', closed_at = ?1 WHERE session_id = ?2 AND status = 'active'",
          ).bind(now, session.id),
          env.DB.prepare(
            `INSERT INTO rotation_cycles (id, group_id, session_id, status, created_at)
             VALUES (?1, ?2, ?3, 'active', ?4)`,
          ).bind(newId(), groupId, session.id, now),
          bumpLiveVersion(env, groupId),
        ],
      };
    },
  });
}

/** 오늘 내전을 마친다. 진행 중인 경기가 있으면 마칠 수 없다. */
export async function closeSession(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "baseLiveVersion"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const baseLiveVersion = requireInt(body.baseLiveVersion, "baseLiveVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "close-session",
    payload: { baseLiveVersion },
    conflictDetails: async () => ({ liveVersion: (await loadGroup(env, groupId)).live_version }),
    build: async () => {
      const session = await loadOpenSession(env, groupId);
      if (!session) throw new ApiError(409, "STATE_CONFLICT", "진행 중인 내전이 없습니다.");
      const current = await env.DB.prepare(
        "SELECT id FROM matches WHERE group_id = ?1 AND state = 'in_progress'",
      )
        .bind(groupId)
        .first<{ id: string }>();
      if (current) {
        throw new ApiError(409, "MATCH_IN_PROGRESS", "진행 중인 경기가 있습니다.", {
          matchId: current.id,
        });
      }
      const now = nowIso();
      return {
        stored: {},
        statements: [
          liveVersionGuard(env, groupId, baseLiveVersion),
          env.DB.prepare(
            "UPDATE rotation_cycles SET status = 'closed', closed_at = ?1 WHERE session_id = ?2 AND status = 'active'",
          ).bind(now, session.id),
          env.DB.prepare("UPDATE sessions SET closed_at = ?1 WHERE id = ?2").bind(now, session.id),
          bumpLiveVersion(env, groupId),
        ],
      };
    },
  });
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  // 2026-02-31 같은 없는 날짜를 거른다.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

/**
 * 시즌을 만든다. 기존 시즌과 날짜가 겹치면 거절한다.
 * 겹침 검사와 저장을 한 batch로 실행해 사이에 다른 시즌이 끼어들 수 없게 한다.
 */
export async function createSeason(
  env: Env,
  groupId: string,
  body: Body,
): Promise<{ id: string }> {
  assertOnlyKeys(body, ["name", "startsOn", "endsOn", "requestId"]);
  const name = parseName(body.name);
  const startsOn = parseDate(body.startsOn, "startsOn");
  const endsOn = parseDate(body.endsOn, "endsOn");
  if (startsOn > endsOn) {
    throw new ApiError(400, "INVALID_FIELD", "시작일이 종료일보다 늦습니다.");
  }
  const overlap = () => new ApiError(409, "SEASON_OVERLAP", "다른 시즌과 날짜가 겹칩니다.");
  try {
    const { stored } = await runMutation(env, {
      groupId,
      requestId: requireRequestId(body),
      op: "create-season",
      payload: { name, startsOn, endsOn },
      build: async () => {
        const id = newId();
        return {
          stored: { id },
          statements: [
            env.DB.prepare(
              `INSERT INTO guard (state_conflict)
               SELECT 1 WHERE EXISTS (
                 SELECT 1 FROM seasons
                 WHERE group_id = ?1 AND starts_on <= ?3 AND ends_on >= ?2
               )`,
            ).bind(groupId, startsOn, endsOn),
            env.DB.prepare(
              `INSERT INTO seasons (id, group_id, name, starts_on, ends_on, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            ).bind(id, groupId, name, startsOn, endsOn, nowIso()),
          ],
        };
      },
    });
    return { id: stored.id as string };
  } catch (error) {
    // 겹침 보호 문장(guard_state_conflict)은 공통 경로가 VERSION_CONFLICT로 바꾼다. 시즌에서는 겹침이라는 뜻이다.
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") throw overlap();
    throw error;
  }
}

/** 시즌을 지운다. 시즌은 통계 필터일 뿐이라 경기·배치·칭호는 바뀌지 않는다. 본문 { requestId }(필수). */
export async function deleteSeason(env: Env, groupId: string, seasonId: string, body: Body = {}): Promise<void> {
  assertOnlyKeys(body, ["requestId"]);
  await runMutation(env, {
    groupId,
    requestId: requireRequestId(body),
    op: "delete-season",
    payload: { seasonId },
    build: async () => ({
      stored: {},
      statements: [env.DB.prepare("DELETE FROM seasons WHERE id = ?1 AND group_id = ?2").bind(seasonId, groupId)],
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

/**
 * 1: 첫 형식. 2: 복원용 값 추가. 3: 중복 참가자 합치기 기록(participantMerges) 추가.
 * 4: 일괄 입력 출처(importBatches)와 경기의 가져오기 지문(importFingerprint, importRowKey) 추가.
 * src/server/restore.ts가 1~4를 모두 읽는다.
 * 형식 번호를 올리지 않고 더한 항목(없는 예전 백업도 복원된다): 서포터 횟수 보정값(supportAdjustments),
 * 기피 라인(참가자 avoidPositions), 경기 메모(경기 memo), 시리즈 묶음(series), 경기 삭제 시각(경기 deletedAt, migrations/0026),
 * 티어 5단계(참가자 skillGroup 5, 설정 groupWeights 5개 — 4개짜리 예전 백업은 parseSettings가 5개로 맞춘다).
 */
export const BACKUP_FORMAT_VERSION = 4;

/**
 * 운영자용 백업(docs/P4 P4-3).
 * 계정, 운영자 권한, 조회 토큰, 세션, 요청 기록은 들어가지 않는다.
 */
export async function exportBackup(env: Env, groupId: string): Promise<Record<string, unknown>> {
  // 스냅숏 읽기와 백업 전용 읽기를 D1 batch 한 번(한 트랜잭션, 왕복 1회)으로 한다(2026-11-08).
  // 예전에는 스냅숏 batch 뒤에 10번을 따로 읽어, 사이에 저장이 끼면 경기와 이력·명단이 서로 다른 시점일 수 있었다.
  // 문장과 정렬은 예전과 같아 백업 파일 내용(키 순서 포함)은 그대로다.
  // 지운 경기도 넣는다(withDeleted): 이력·명단·시리즈 소속이 그 경기를 가리키고, 복원한 뒤에도 지운 채로 남아야 한다.
  const base = snapshotStatements(env, groupId, "operator", true);
  const q = (sql: string) => env.DB.prepare(sql).bind(groupId);
  const results = await env.DB.batch([
    ...base,
    q("SELECT id, version_no, payload, created_at FROM settings_versions WHERE group_id = ?1 ORDER BY version_no"),
    q("SELECT id, started_at, last_activity_at, closed_at FROM sessions WHERE group_id = ?1 ORDER BY started_at"),
    q("SELECT id, session_id, status, created_at, closed_at FROM rotation_cycles WHERE group_id = ?1 ORDER BY created_at"),
    q(
      `SELECT id, cycle_id, match_id, participant_id, kind, voided, created_at
       FROM rotation_events WHERE group_id = ?1 ORDER BY created_at, id`,
    ),
    q(
      `SELECT cycle_id, participant_id, delta, updated_at FROM support_adjustments
       WHERE group_id = ?1 ORDER BY updated_at, participant_id`,
    ),
    q("SELECT id, match_id, kind, changes, created_at FROM match_revisions WHERE group_id = ?1 ORDER BY id"),
    // 형식 2: 복원에 필요한 값(제외 직전 상태, 적용 설정 버전, 일괄 입력 묶음, 참가자 생성 시각)을 더한다.
    q(
      `SELECT id, prev_state, settings_version_id, import_batch_id, import_fingerprint, import_row_key
       FROM matches WHERE group_id = ?1`,
    ),
    // 형식 4: 일괄 입력 출처.
    q("SELECT id, kind, source_key, label, created_at, options FROM import_batches WHERE group_id = ?1 ORDER BY created_at, id"),
    q("SELECT id, created_at FROM participants WHERE group_id = ?1"),
    // 형식 3: 합치기 기록. 되돌리기에 필요한 옮긴 행 목록을 그대로 넣는다.
    // moved_link(migrations/0023)는 계정 ID라 넣지 않는다(연결은 백업 밖). 새 모임으로 가져온 합치기는 연결 기록 없음(NULL)이
    // 된다. 같은 모임 복구는 지금 DB에도 유효한 같은 합치기면 그 값을 그대로 이어 쓴다(restore.ts rewindMergeLinks).
    q(
      `SELECT id, source_id, target_id, source_prev_status, moved_matches, rotation_changes, created_at, undone_at
       FROM participant_merges WHERE group_id = ?1 ORDER BY created_at, id`,
    ),
  ]);
  const snapshot = parseSnapshot("operator", results);
  let i = base.length;
  const next = <T>(): { results: T[] } => ({ results: (results[i++]?.results ?? []) as unknown as T[] });
  const settingsVersions = next<{ id: string; version_no: number; payload: string; created_at: string }>();
  const sessions = next<Record<string, unknown>>();
  const cycles = next<Record<string, unknown>>();
  const events = next<Record<string, unknown>>();
  const adjustments = next<{ cycle_id: string | null; participant_id: string; delta: number; updated_at: string }>();
  const revisions = next<{ id: number; match_id: string; kind: string; changes: string; created_at: string }>();
  const matchExtras = next<{
    id: string;
    prev_state: string | null;
    settings_version_id: string | null;
    import_batch_id: string | null;
    import_fingerprint: string | null;
    import_row_key: string | null;
  }>();
  const importBatches = next<{
    id: string;
    kind: string;
    source_key: string | null;
    label: string | null;
    created_at: string;
    options: string | null;
  }>();
  const extraById = new Map(matchExtras.results.map((m) => [m.id, m]));
  const participantTimes = next<{ id: string; created_at: string }>();
  const createdById = new Map(participantTimes.results.map((p) => [p.id, p.created_at]));
  const merges = next<{
    id: string;
    source_id: string;
    target_id: string;
    source_prev_status: string;
    moved_matches: string;
    rotation_changes: string;
    created_at: string;
    undone_at: string | null;
  }>();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: nowIso(),
    scope: "group",
    group: {
      id: snapshot.group.id,
      name: snapshot.group.name,
      timezone: snapshot.group.timezone,
      currentSettingsVersionId: snapshot.group.settingsVersionId ?? null,
    },
    matchCount: snapshot.matches.length,
    // 행 버전(version)은 이 서버 안의 동시 수정 확인용이라 백업에 넣지 않는다(복원하면 새로 0부터 센다).
    participants: snapshot.participants.map(({ version: _version, ...p }) => ({ ...p, createdAt: createdById.get(p.id) })),
    seasons: snapshot.seasons,
    // 시리즈 묶음(2026-11-06). 경기 메모는 경기 항목(memo)에 들어 있다. 둘 다 없는 예전 백업도 복원된다.
    series: snapshot.series ?? [],
    matches: snapshot.matches.map((m) => {
      const extra = extraById.get(m.id);
      return {
        ...m,
        prevState: extra?.prev_state ?? null,
        settingsVersionId: extra?.settings_version_id ?? null,
        importBatchId: extra?.import_batch_id ?? null,
        importFingerprint: extra?.import_fingerprint ?? null,
        importRowKey: extra?.import_row_key ?? null,
      };
    }),
    importBatches: importBatches.results.map((b) => ({
      id: b.id,
      kind: b.kind,
      sourceKey: b.source_key,
      label: b.label,
      createdAt: b.created_at,
      // 기존 사이트 가져오기의 날짜 처리 선택(migrations/0010). 그 밖에는 null.
      options: b.options === null ? null : parseStoredChoice(b.options),
    })),
    revisions: revisions.results.map((r) => ({
      id: r.id,
      matchId: r.match_id,
      kind: r.kind,
      changes: JSON.parse(r.changes) as unknown,
      createdAt: r.created_at,
    })),
    sessions: sessions.results,
    rotationCycles: cycles.results,
    rotationEvents: events.results,
    // 서포터 횟수 직접 입력의 보정값(2026-11-06). 이 항목이 없는 예전 백업도 복원된다.
    supportAdjustments: adjustments.results.map((a) => ({
      cycleId: a.cycle_id,
      participantId: a.participant_id,
      delta: a.delta,
      updatedAt: a.updated_at,
    })),
    settingsVersions: settingsVersions.results.map((s) => ({
      id: s.id,
      versionNo: s.version_no,
      settings: JSON.parse(s.payload) as unknown,
      createdAt: s.created_at,
    })),
    participantMerges: merges.results.map((m) => ({
      id: m.id,
      sourceId: m.source_id,
      targetId: m.target_id,
      sourcePrevStatus: m.source_prev_status,
      movedMatches: JSON.parse(m.moved_matches) as unknown,
      rotationChanges: JSON.parse(m.rotation_changes) as unknown,
      createdAt: m.created_at,
      undoneAt: m.undone_at,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 운영자 교체                                                          */
/* ------------------------------------------------------------------ */

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

function parseStoredChoice(text: string): LegacyChoice | null {
  try {
    return parseLegacyChoice(JSON.parse(text));
  } catch {
    return null;
  }
}
