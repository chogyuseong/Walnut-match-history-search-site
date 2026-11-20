// 모임 설정 저장(전체 스냅샷을 새 버전으로)과 검증, 서포터 횟수 새 주기, 오늘 내전 마치기.
// parseSettings는 백업 복원(restoreChecks.ts)도 같은 규칙으로 쓴다.
import { RATING_SETTING_KEYS, RATING_SETTING_RANGES } from "../shared/rating";
import { parseTitleBands } from "../shared/titles";
import { upgradeGroupWeights, type Settings } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireInt, requireRequestId, requireString } from "./http";
import { bumpLiveVersion, liveVersionGuard, runMutation } from "./mutation";
import { loadGroup, loadOpenSession } from "./snapshot";

type Body = Record<string, unknown>;

/** 설정 스냅샷 검증. 백업 복원(restoreChecks.ts)도 같은 규칙으로 검사한다. */
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
  const requestId = requireRequestId(body);
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
  const requestId = requireRequestId(body);
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
  const requestId = requireRequestId(body);
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
