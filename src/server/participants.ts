// 참가자 쓰기: 이름 목록으로 한꺼번에 넣기(ensureParticipants), 한 사람 고치기(이름·티어·보관·기피 라인),
// 티어 일괄 저장, 기피 라인 값 검증. 모임 탭·티어 배정·고르기 화면과 멤버의 내 기피 라인(members.ts)이 부른다.
import { encodeAvoid, MAX_AVOID, normalizeAvoidPositions } from "../shared/avoid";
import { nameKey } from "../shared/names";
import { MAX_SKILL_GROUP, type ParticipantView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireInt, requireRequestId, requireString } from "./http";
import { runMutation, type Plan } from "./mutation";
import { MAX_PARTICIPANTS_PER_GROUP, parseName } from "./groups";

type Body = Record<string, unknown>;

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
    const row = byKey.get(key);
    // 넣은 뒤 다시 읽기 전에 다른 기기가 같은 사람을 보관하거나 이름을 바꾸면 없을 수 있다(예전에는 500).
    if (!row) {
      throw new ApiError(409, "STATE_CONFLICT", "그 사이 참가자 이름이 바뀌었어요. 화면을 새로 고친 뒤 다시 해 주세요.");
    }
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
