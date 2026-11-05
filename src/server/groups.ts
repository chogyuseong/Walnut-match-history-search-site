import { MAX_NAME_LENGTH, cleanName, nameKey } from "../shared/names";
import { DEFAULT_SETTINGS, type ParticipantView, type Settings } from "../shared/types";
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
import { bumpLiveVersion, liveVersionGuard, runMutation, sha256Hex } from "./mutation";
import { buildSnapshot, loadGroup, loadOpenSession } from "./snapshot";

const MAX_GROUPS_PER_ACCOUNT = 5;
const MAX_PARTICIPANTS_PER_GROUP = 200;

type Body = Record<string, unknown>;

function parseName(value: unknown): string {
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

/** 모임을 만들고 만든 계정을 운영자로 등록한다. */
export async function createGroup(
  env: Env,
  accountId: string,
  body: Body,
): Promise<{ id: string; name: string }> {
  assertOnlyKeys(body, ["name"]);
  const name = body.name === undefined ? "내 내전 모임" : parseName(body.name);
  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM group_operators WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_GROUPS_PER_ACCOUNT) {
    throw new ApiError(409, "TOO_MANY_GROUPS", "만들 수 있는 모임 수를 넘었습니다.");
  }
  const id = newId();
  const settingsId = newId();
  const now = nowIso();
  await env.DB.batch([
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
  return { id, name };
}

export async function listGroups(
  env: Env,
  accountId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT g.id, g.name FROM groups g
     JOIN group_operators o ON o.group_id = g.id
     WHERE o.account_id = ?1 ORDER BY g.created_at`,
  )
    .bind(accountId)
    .all<{ id: string; name: string }>();
  return rows.results;
}

export async function renameGroup(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["name"]);
  const name = parseName(body.name);
  await env.DB.prepare("UPDATE groups SET name = ?1 WHERE id = ?2").bind(name, groupId).run();
}

/**
 * 이름 목록에 해당하는 활성 참가자를 돌려준다. 없는 이름은 새로 만든다.
 * 같은 이름으로 여러 번 불러도 결과가 같다.
 */
export async function ensureParticipants(
  env: Env,
  groupId: string,
  body: Body,
): Promise<ParticipantView[]> {
  assertOnlyKeys(body, ["names"]);
  if (!Array.isArray(body.names) || body.names.length < 1 || body.names.length > 30) {
    throw new ApiError(400, "INVALID_FIELD", "names 값이 올바르지 않습니다.");
  }
  const names = body.names.map(parseName);
  const keys = names.map(nameKey);
  if (new Set(keys).size !== keys.length) {
    throw new ApiError(400, "DUPLICATE_NAME", "같은 이름이 두 번 들어 있습니다.");
  }
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM participants WHERE group_id = ?1")
    .bind(groupId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PARTICIPANTS_PER_GROUP) {
    throw new ApiError(409, "TOO_MANY_PARTICIPANTS", "참가자가 너무 많습니다.");
  }
  const now = nowIso();
  await env.DB.batch(
    names.map((name, i) =>
      env.DB.prepare(
        `INSERT INTO participants (id, group_id, name, name_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (group_id, name_key) WHERE status = 'active' DO NOTHING`,
      ).bind(newId(), groupId, name, keys[i], now),
    ),
  );
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

/** 참가자의 이름·실력 그룹·보관 상태를 바꾼다. 과거 경기의 소속과 승패는 바뀌지 않는다. */
export async function updateParticipant(
  env: Env,
  groupId: string,
  participantId: string,
  body: Body,
): Promise<void> {
  assertOnlyKeys(body, ["name", "skillGroup", "status"]);
  const existing = await env.DB.prepare(
    "SELECT id, name, name_key, skill_group, status FROM participants WHERE id = ?1 AND group_id = ?2",
  )
    .bind(participantId, groupId)
    .first<{
      id: string;
      name: string;
      name_key: string;
      skill_group: number | null;
      status: string;
    }>();
  if (!existing) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");

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
      if (value < 1 || value > 4) {
        throw new ApiError(400, "INVALID_FIELD", "skillGroup 값이 올바르지 않습니다.");
      }
      skillGroup = value;
    }
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "archived") {
      throw new ApiError(400, "INVALID_FIELD", "status 값이 올바르지 않습니다.");
    }
    status = body.status;
  }
  try {
    await env.DB.prepare(
      `UPDATE participants SET name = ?1, name_key = ?2, skill_group = ?3, status = ?4
       WHERE id = ?5 AND group_id = ?6`,
    )
      .bind(name, key, skillGroup, status, participantId, groupId)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("UNIQUE")) {
      throw new ApiError(409, "NAME_TAKEN", "같은 이름의 참가자가 이미 있습니다.", { name });
    }
    throw error;
  }
}

function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null) {
    throw new ApiError(400, "INVALID_FIELD", "settings 값이 올바르지 않습니다.");
  }
  const raw = value as Body;
  assertOnlyKeys(raw, ["rotationEnabled", "groupsPublic", "groupWeights"]);
  if (typeof raw.rotationEnabled !== "boolean" || typeof raw.groupsPublic !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "settings 값이 올바르지 않습니다.");
  }
  const weights = raw.groupWeights;
  if (
    !Array.isArray(weights) ||
    weights.length !== 4 ||
    !weights.every((w) => typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 1000)
  ) {
    throw new ApiError(400, "INVALID_FIELD", "groupWeights 값이 올바르지 않습니다.");
  }
  return {
    rotationEnabled: raw.rotationEnabled,
    groupsPublic: raw.groupsPublic,
    groupWeights: weights as [number, number, number, number],
  };
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

/** 현재 순환 주기를 닫고 새 주기를 연다. 전적은 바뀌지 않는다. */
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
      if (!session) {
        throw new ApiError(409, "STATE_CONFLICT", "진행 중인 내전이 없습니다.");
      }
      const now = nowIso();
      return {
        stored: {},
        statements: [
          liveVersionGuard(env, groupId, baseLiveVersion),
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
  assertOnlyKeys(body, ["name", "startsOn", "endsOn"]);
  const name = parseName(body.name);
  const startsOn = parseDate(body.startsOn, "startsOn");
  const endsOn = parseDate(body.endsOn, "endsOn");
  if (startsOn > endsOn) {
    throw new ApiError(400, "INVALID_FIELD", "시작일이 종료일보다 늦습니다.");
  }
  const id = newId();
  try {
    await env.DB.batch([
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
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict")) {
      throw new ApiError(409, "SEASON_OVERLAP", "다른 시즌과 날짜가 겹칩니다.");
    }
    throw error;
  }
  return { id };
}

/** 시즌을 지운다. 시즌은 통계 필터일 뿐이라 경기·배치·칭호는 바뀌지 않는다. */
export async function deleteSeason(env: Env, groupId: string, seasonId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM seasons WHERE id = ?1 AND group_id = ?2")
    .bind(seasonId, groupId)
    .run();
}

/** 조회 토큰을 새로 만든다. 이전 링크는 더 이상 열리지 않는다. */
export async function regenerateViewToken(env: Env, groupId: string): Promise<string> {
  const token = newViewToken();
  await env.DB.prepare("UPDATE groups SET view_token = ?1 WHERE id = ?2").bind(token, groupId).run();
  return token;
}

export const BACKUP_FORMAT_VERSION = 1;

/**
 * 운영자용 백업(docs/P4 P4-3).
 * 계정, 운영자 권한, 조회 토큰, 세션, 요청 기록은 들어가지 않는다.
 */
export async function exportBackup(env: Env, groupId: string): Promise<Record<string, unknown>> {
  const snapshot = await buildSnapshot(env, groupId, "operator");
  const settingsVersions = await env.DB.prepare(
    "SELECT id, version_no, payload, created_at FROM settings_versions WHERE group_id = ?1 ORDER BY version_no",
  )
    .bind(groupId)
    .all<{ id: string; version_no: number; payload: string; created_at: string }>();
  const sessions = await env.DB.prepare(
    "SELECT id, started_at, last_activity_at, closed_at FROM sessions WHERE group_id = ?1 ORDER BY started_at",
  )
    .bind(groupId)
    .all();
  const cycles = await env.DB.prepare(
    "SELECT id, session_id, status, created_at, closed_at FROM rotation_cycles WHERE group_id = ?1 ORDER BY created_at",
  )
    .bind(groupId)
    .all();
  const events = await env.DB.prepare(
    `SELECT id, cycle_id, match_id, participant_id, kind, voided, created_at
     FROM rotation_events WHERE group_id = ?1 ORDER BY created_at, id`,
  )
    .bind(groupId)
    .all();
  const revisions = await env.DB.prepare(
    "SELECT id, match_id, kind, changes, created_at FROM match_revisions WHERE group_id = ?1 ORDER BY id",
  )
    .bind(groupId)
    .all<{ id: number; match_id: string; kind: string; changes: string; created_at: string }>();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: nowIso(),
    scope: "group",
    group: {
      id: snapshot.group.id,
      name: snapshot.group.name,
      timezone: snapshot.group.timezone,
    },
    matchCount: snapshot.matches.length,
    participants: snapshot.participants,
    seasons: snapshot.seasons,
    matches: snapshot.matches,
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
    settingsVersions: settingsVersions.results.map((s) => ({
      id: s.id,
      versionNo: s.version_no,
      settings: JSON.parse(s.payload) as unknown,
      createdAt: s.created_at,
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
 * 인수 링크를 수락한다. 수락한 계정이 이 모임의 유일한 운영자가 되고
 * 이전 운영자는 더 이상 수정할 수 없다. 경기·참가자·조회 링크는 바뀌지 않는다.
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
  const owned = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM group_operators WHERE account_id = ?1",
  )
    .bind(accountId)
    .first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_GROUPS_PER_ACCOUNT) {
    throw new ApiError(409, "TOO_MANY_GROUPS", "맡을 수 있는 모임 수를 넘었습니다.");
  }
  const now = nowIso();
  try {
    await env.DB.batch([
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
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("guard_state_conflict")) {
      throw new ApiError(404, "TRANSFER_INVALID", "이 링크는 이미 썼거나 만료됐습니다.");
    }
    throw error;
  }
  return { groupId: row.group_id };
}
