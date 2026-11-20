/**
 * 경기 쓰기 요청들이 함께 쓰는 검증과 batch 가드: 명단 10명 검증, 경기 버전·상태 확인, 결과 미입력 상한,
 * 가져온 경기의 지문 중복 검사. matches.ts(경기 진행)·matchRemoval.ts(전적 제외·삭제)·matchCorrection.ts(정정)·
 * matchImport.ts(지난 경기 입력·가져오기)가 쓴다.
 * 가드 문장(guard 표에 INSERT)은 runMutation의 batch 안에서만 뜻이 있다. 미리 읽은 값과 batch 시점 사이에
 * 끼어든 요청을 batch 전체 실패로 막는 장치라, 읽기 검사만 남기고 가드를 빼면 경합 때 조용히 틀린다.
 */
import {
  POSITIONS,
  TEAMS,
  type MatchView,
  type Position,
  type RosterEntry,
  type Team,
} from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, requireOneOf, requireString } from "./http";
import { groupFingerprints } from "./sheets";
import { loadGroup } from "./snapshot";

export const MAX_AWAITING = 10;

export type Body = Record<string, unknown>;

/** 명단 10명을 검증한다: 서로 다른 10명, 팀당 5명, 팀 내 포지션 중복 없음. */
export function parseRoster(value: unknown, positionsRequired: boolean): RosterEntry[] {
  if (!Array.isArray(value) || value.length !== 10) {
    throw new ApiError(400, "INVALID_ROSTER", "참가자는 정확히 10명이어야 합니다.");
  }
  const roster: RosterEntry[] = value.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError(400, "INVALID_ROSTER", "명단 형식이 올바르지 않습니다.");
    }
    const entry = raw as Body;
    assertOnlyKeys(entry, ["participantId", "team", "position"]);
    const position =
      entry.position === null || entry.position === undefined
        ? null
        : requireOneOf<Position>(entry.position, POSITIONS, "position");
    return {
      participantId: requireString(entry.participantId, "participantId", 1, 64),
      team: requireOneOf<Team>(entry.team, TEAMS, "team"),
      position,
    };
  });
  if (new Set(roster.map((r) => r.participantId)).size !== 10) {
    throw new ApiError(400, "INVALID_ROSTER", "같은 참가자가 두 번 들어 있습니다.");
  }
  for (const team of TEAMS) {
    const members = roster.filter((r) => r.team === team);
    if (members.length !== 5) {
      throw new ApiError(400, "INVALID_ROSTER", `팀 ${team}는 5명이어야 합니다.`);
    }
    const positions = members.map((m) => m.position).filter((p): p is Position => p !== null);
    if (new Set(positions).size !== positions.length) {
      throw new ApiError(400, "INVALID_ROSTER", `팀 ${team}에 같은 포지션이 두 번 있습니다.`);
    }
    if (positionsRequired && positions.length !== 5) {
      throw new ApiError(400, "INVALID_ROSTER", `팀 ${team}의 포지션이 모두 정해지지 않았습니다.`);
    }
  }
  return roster;
}

/** 명단의 모두가 이 모임의 활성 참가자인지 확인한다. */
export async function assertActiveParticipants(env: Env, groupId: string, ids: string[]): Promise<void> {
  const placeholders = ids.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT id FROM participants
     WHERE group_id = ?1 AND status = 'active' AND id IN (${placeholders})`,
  )
    .bind(groupId, ...ids)
    .all<{ id: string }>();
  const found = new Set(rows.results.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ApiError(400, "INVALID_PARTICIPANT", "이 모임의 참가자가 아닌 사람이 있습니다.", {
      participantIds: missing,
    });
  }
}

export function insertRoster(
  env: Env,
  groupId: string,
  matchId: string,
  roster: RosterEntry[],
): D1PreparedStatement[] {
  return roster.map((r) =>
    env.DB.prepare(
      `INSERT INTO match_roster (match_id, group_id, participant_id, team, position)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(matchId, groupId, r.participantId, r.team, r.position),
  );
}

export async function matchConflictDetails(env: Env, groupId: string, matchId: string): Promise<unknown> {
  const group = await loadGroup(env, groupId);
  const match = await env.DB.prepare(
    "SELECT version, state FROM matches WHERE id = ?1 AND group_id = ?2",
  )
    .bind(matchId, groupId)
    .first<{ version: number; state: string }>();
  return { liveVersion: group.live_version, match };
}

export function assertMatchVersion(match: MatchView, baseVersion: number): void {
  if (match.version !== baseVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "그 사이 이 경기가 바뀌었습니다. 최신 상태를 확인해 주세요.",
      { match: { version: match.version, state: match.state } },
    );
  }
}

export function assertState(match: MatchView, allowed: readonly string[]): void {
  if (!allowed.includes(match.state)) {
    throw new ApiError(409, "STATE_CONFLICT", "지금 상태에서는 할 수 없는 작업입니다.", {
      match: { version: match.version, state: match.state },
    });
  }
}

/** 지우지 않은 결과 미입력 경기 수. 경기 시작·결과는 나중에·되살리기가 같은 상한(MAX_AWAITING)을 이 값으로 잰다. */
export async function countAwaiting(env: Env, groupId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM matches WHERE group_id = ?1 AND state = 'awaiting_result' AND deleted_at IS NULL",
  )
    .bind(groupId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 지우지 않은 결과 미입력 경기가 MAX_AWAITING개를 넘으면 batch 전체를 실패시킨다(동시에 들어온 요청 경합용). */
export function awaitingLimitGuard(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE (
       SELECT COUNT(*) FROM matches WHERE group_id = ?1 AND state = 'awaiting_result' AND deleted_at IS NULL
     ) > ?2`,
  ).bind(groupId, MAX_AWAITING);
}

/* ------------------------------------------------------------------ */
/* 지문 중복 검사(일괄 입력·복구)                                        */
/* ------------------------------------------------------------------ */

/** 지문이 있을 수 있는 경기(일괄 입력·지난 경기 입력) 중 전적 제외도, 지운 것도 아닌 것. */
const FINGERPRINT_SCOPE =
  "group_id = ?1 AND state <> 'excluded' AND deleted_at IS NULL AND source IN ('import', 'backfill')";
const SCOPE_STAMP = "COUNT(*) || ':' || COALESCE(SUM(version), 0)";

/** 확인한 때의 범위 상태(경기 수:버전 합). 확인과 저장 사이에 범위가 바뀌면 batch를 실패시키는 데 쓴다. */
export async function fingerprintScopeStamp(env: Env, groupId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT ${SCOPE_STAMP} AS stamp FROM matches WHERE ${FINGERPRINT_SCOPE}`)
    .bind(groupId)
    .first<{ stamp: string }>();
  return String(row?.stamp ?? "0:0");
}

/**
 * 확인 뒤 다른 요청이 일괄 입력·지난 경기 입력·제외·복구·정정을 했으면 batch 전체를 실패시킨다.
 * 계산한 지문(지문 없는 예전 경기)은 SQL로 견줄 수 없으므로 이 문장으로 확인 결과가 그대로인지 지킨다.
 */
export function fingerprintScopeGuard(env: Env, groupId: string, stamp: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE (SELECT ${SCOPE_STAMP} FROM matches WHERE ${FINGERPRINT_SCOPE}) <> ?2`,
  ).bind(groupId, stamp);
}

/** 복구할 경기(ids)와 저장된 지문이 같은, 전적 제외도 지운 것도 아닌 다른 경기가 있으면 batch 전체를 실패시킨다. */
export function storedFingerprintRestoreGuard(env: Env, groupId: string, ids: readonly string[]): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE EXISTS (
       SELECT 1 FROM matches a
       JOIN matches b ON b.group_id = a.group_id AND b.import_fingerprint = a.import_fingerprint AND b.id <> a.id
       WHERE a.group_id = ?1 AND a.id IN (SELECT value FROM json_each(?2)) AND b.state <> 'excluded'
         AND b.deleted_at IS NULL
     )`,
  ).bind(groupId, JSON.stringify(ids));
}

export interface FingerprintOverlap {
  matchId: string;
  matchNo: number;
  /** 같은 지문을 가진, 전적 제외가 아닌 다른 경기의 번호. */
  with: number[];
}

/**
 * ids의 경기 가운데 같은 지문(저장된 것 또는 내용으로 계산한 것)의 다른 경기가 전적 제외가 아닌 상태로 있는 것.
 * 다시 가져오기에서 "이미 들어간 경기"로 보는 기준과 같다(src/server/sheets.ts groupFingerprints).
 * ids는 지운 경기여도 된다(되살리기). 다른 경기 쪽의 지운 경기는 견주지 않는다.
 */
export async function fingerprintOverlaps(env: Env, groupId: string, ids: readonly string[]): Promise<FingerprintOverlap[]> {
  if (ids.length === 0) return [];
  const all = await groupFingerprints(env, groupId, ids);
  const target = new Set(ids);
  const active = new Map<string, Set<number>>();
  for (const f of all) {
    if (target.has(f.matchId) || f.state === "excluded") continue;
    const set = active.get(f.fingerprint) ?? new Set<number>();
    set.add(f.matchNo);
    active.set(f.fingerprint, set);
  }
  const found = new Map<string, FingerprintOverlap>();
  for (const f of all) {
    if (!target.has(f.matchId)) continue;
    const hits = active.get(f.fingerprint);
    if (!hits) continue;
    const entry = found.get(f.matchId) ?? { matchId: f.matchId, matchNo: f.matchNo, with: [] };
    for (const no of hits) if (!entry.with.includes(no)) entry.with.push(no);
    found.set(f.matchId, entry);
  }
  return [...found.values()]
    .map((o) => ({ ...o, with: o.with.sort((x, y) => x - y) }))
    .sort((x, y) => x.matchNo - y.matchNo);
}

export function overlapText(overlaps: readonly FingerprintOverlap[]): string {
  const shown = overlaps.slice(0, 5).map((o) => `${o.matchNo}번↔${o.with.map((n) => `${n}번`).join("·")}`);
  return shown.join(", ") + (overlaps.length > 5 ? ` 외 ${overlaps.length - 5}경기` : "");
}
