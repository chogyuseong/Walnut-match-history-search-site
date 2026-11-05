import {
  POSITIONS,
  SIDES,
  TEAMS,
  teamASideFromWinner,
  type MatchView,
  type Position,
  type RosterEntry,
  type Side,
  type Team,
} from "../shared/types";
import type { Env } from "./env";
import {
  ApiError,
  assertOnlyKeys,
  newId,
  nowIso,
  requireInt,
  requireIsoTime,
  requireOneOf,
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
import { loadGroup, loadMatch, loadOpenSession, loadSettings } from "./snapshot";

const MAX_AWAITING = 10;

type Body = Record<string, unknown>;

function requestIdOf(body: Body): string {
  return requireString(body.requestId, "requestId", 8, 64);
}

/** 명단 10명을 검증한다: 서로 다른 10명, 팀당 5명, 팀 내 포지션 중복 없음. */
function parseRoster(value: unknown, positionsRequired: boolean): RosterEntry[] {
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
async function assertActiveParticipants(env: Env, groupId: string, ids: string[]): Promise<void> {
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

function insertRoster(
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

async function matchConflictDetails(env: Env, groupId: string, matchId: string): Promise<unknown> {
  const group = await loadGroup(env, groupId);
  const match = await env.DB.prepare(
    "SELECT version, state FROM matches WHERE id = ?1 AND group_id = ?2",
  )
    .bind(matchId, groupId)
    .first<{ version: number; state: string }>();
  return { liveVersion: group.live_version, match };
}

function assertMatchVersion(match: MatchView, baseVersion: number): void {
  if (match.version !== baseVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "그 사이 이 경기가 바뀌었습니다. 최신 상태를 확인해 주세요.",
      { match: { version: match.version, state: match.state } },
    );
  }
}

function assertState(match: MatchView, allowed: readonly string[]): void {
  if (!allowed.includes(match.state)) {
    throw new ApiError(409, "STATE_CONFLICT", "지금 상태에서는 할 수 없는 작업입니다.", {
      match: { version: match.version, state: match.state },
    });
  }
}

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
  ]);
  const requestId = requestIdOf(body);
  const baseLiveVersion = requireInt(body.baseLiveVersion, "baseLiveVersion");
  const roster = parseRoster(body.roster, true);
  const ackRepeat = Array.isArray(body.ackRepeat)
    ? body.ackRepeat.map((id) => requireString(id, "ackRepeat", 1, 64))
    : [];
  const moveCurrent =
    body.moveCurrentToAwaiting === undefined || body.moveCurrentToAwaiting === null
      ? null
      : requireString(body.moveCurrentToAwaiting, "moveCurrentToAwaiting", 1, 64);
  const newSession = body.newSession === true;
  const payload = { baseLiveVersion, roster, ackRepeat, moveCurrent, newSession };

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
          insertRevision(env, groupId, current.id, "end", {}, now),
        );
      }

      const awaiting = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM matches WHERE group_id = ?1 AND state = 'awaiting_result'",
      )
        .bind(groupId)
        .first<{ n: number }>();
      if ((awaiting?.n ?? 0) + (current ? 1 : 0) > MAX_AWAITING) {
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
             started_at, played_at, settings_version_id)
           SELECT ?1, id, next_match_no, ?3, 'in_progress', 'live', ?4, ?4, settings_version_id
           FROM groups WHERE id = ?2`,
        ).bind(matchId, groupId, sessionId, now),
        env.DB.prepare(
          `UPDATE groups SET next_match_no = next_match_no + 1, live_version = live_version + 1
           WHERE id = ?1`,
        ).bind(groupId),
        ...insertRoster(env, groupId, matchId, roster),
        insertRevision(env, groupId, matchId, "start", {}, now),
      );

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
  const requestId = requestIdOf(body);
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
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, "in_progress"),
          env.DB.prepare(
            `UPDATE matches SET state = 'awaiting_result', ended_at = ?1, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(now, matchId, groupId),
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
  assertOnlyKeys(body, ["requestId", "baseMatchVersion", "winnerTeam", "winnerSide"]);
  const requestId = requestIdOf(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const winnerTeam = requireOneOf<Team>(body.winnerTeam, TEAMS, "winnerTeam");
  const winnerSide = requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide");
  const teamASide = teamASideFromWinner(winnerTeam, winnerSide);
  await runMutation(env, {
    groupId,
    requestId,
    op: "result",
    payload: { matchId, baseMatchVersion, winnerTeam, winnerSide },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["in_progress", "awaiting_result"]);
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
            teamASide: { from: null, to: teamASide },
          },
          now,
        ),
      ];
      // 진행 중이던 경기가 끝나면 "진행 중 1개" 자리가 비므로 진행 상태가 바뀐다.
      if (match.state === "in_progress") statements.push(bumpLiveVersion(env, groupId));
      return { stored: { matchId }, statements };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 미진행 취소 / 전적 제외 / 복구                                       */
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
  const requestId = requestIdOf(body);
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

      const later = await env.DB.prepare(
        `SELECT r.id, r.participant_id FROM rotation_events r
         WHERE r.kind = 'repeat' AND r.voided = 0 AND r.match_id <> ?1
           AND EXISTS (
             SELECT 1 FROM rotation_events u
             WHERE u.match_id = ?1 AND u.kind = 'used' AND u.voided = 0
               AND u.cycle_id = r.cycle_id AND u.participant_id = r.participant_id
           )
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

/** 화면의 "삭제"는 전적 제외다. 복구할 수 있고 서포터 차례는 그대로 둔다. */
export async function excludeMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requestIdOf(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "exclude",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["awaiting_result", "confirmed"]);
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, match.state),
          env.DB.prepare(
            `UPDATE matches SET state = 'excluded', prev_state = ?1, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(match.state, matchId, groupId),
          insertRevision(
            env,
            groupId,
            matchId,
            "exclude",
            { state: { from: match.state, to: "excluded" } },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

export async function restoreMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "baseMatchVersion"]);
  const requestId = requestIdOf(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  await runMutation(env, {
    groupId,
    requestId,
    op: "restore",
    payload: { matchId, baseMatchVersion },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["excluded"]);
      const prev = await env.DB.prepare("SELECT prev_state FROM matches WHERE id = ?1")
        .bind(matchId)
        .first<{ prev_state: string | null }>();
      const target = prev?.prev_state ?? "confirmed";
      const now = nowIso();
      return {
        stored: { matchId },
        statements: [
          matchGuard(env, groupId, matchId, baseMatchVersion, "excluded"),
          env.DB.prepare(
            `UPDATE matches SET state = ?1, prev_state = NULL, version = version + 1
             WHERE id = ?2 AND group_id = ?3`,
          ).bind(target, matchId, groupId),
          insertRevision(
            env,
            groupId,
            matchId,
            "restore",
            { state: { from: "excluded", to: target } },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 항목별 정정                                                          */
/* ------------------------------------------------------------------ */

type CorrectionField = "winner" | "side" | "playedAt" | "positions" | "participant";
const CORRECTION_FIELDS: readonly CorrectionField[] = [
  "winner",
  "side",
  "playedAt",
  "positions",
  "participant",
];

function supportOf(roster: RosterEntry[], team: Team): string | null {
  return roster.find((r) => r.team === team && r.position === "support")?.participantId ?? null;
}

/**
 * 확정 경기의 한 항목을 고친다. 경기 ID는 유지되고 이력이 한 줄 늘어난다.
 * 추천·배정·추첨을 다시 실행하지 않는다.
 * 정정으로 이 경기의 서포터가 달라지면 차례 기록도 고칠지 반드시 정해서 보내야 한다.
 */
export async function correctMatch(
  env: Env,
  groupId: string,
  matchId: string,
  body: Body,
): Promise<MatchView> {
  assertOnlyKeys(body, [
    "requestId",
    "baseMatchVersion",
    "field",
    "winnerTeam",
    "winnerSide",
    "playedAt",
    "positions",
    "outParticipantId",
    "inParticipantId",
    "fixRotation",
  ]);
  const requestId = requestIdOf(body);
  const baseMatchVersion = requireInt(body.baseMatchVersion, "baseMatchVersion");
  const field = requireOneOf<CorrectionField>(body.field, CORRECTION_FIELDS, "field");
  const fixRotation = typeof body.fixRotation === "boolean" ? body.fixRotation : null;

  // 항목별 입력을 먼저 검증해 요청 내용(해시 대상)을 확정한다.
  let input: Record<string, unknown>;
  if (field === "winner") {
    input = {
      winnerTeam: requireOneOf<Team>(body.winnerTeam, TEAMS, "winnerTeam"),
      winnerSide: requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide"),
    };
  } else if (field === "side") {
    input = { winnerSide: requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide") };
  } else if (field === "playedAt") {
    input = { playedAt: requireIsoTime(body.playedAt, "playedAt") };
  } else if (field === "positions") {
    if (!Array.isArray(body.positions) || body.positions.length < 1 || body.positions.length > 10) {
      throw new ApiError(400, "INVALID_FIELD", "positions 값이 올바르지 않습니다.");
    }
    input = {
      positions: body.positions.map((raw) => {
        const entry = raw as Body;
        return {
          participantId: requireString(entry?.participantId, "participantId", 1, 64),
          position: requireOneOf<Position>(entry?.position, POSITIONS, "position"),
        };
      }),
    };
  } else {
    input = {
      outParticipantId: requireString(body.outParticipantId, "outParticipantId", 1, 64),
      inParticipantId: requireString(body.inParticipantId, "inParticipantId", 1, 64),
    };
  }

  await runMutation(env, {
    groupId,
    requestId,
    op: "correct",
    payload: { matchId, baseMatchVersion, field, input, fixRotation },
    conflictDetails: () => matchConflictDetails(env, groupId, matchId),
    build: async () => {
      const match = await loadMatch(env, groupId, matchId);
      assertMatchVersion(match, baseMatchVersion);
      assertState(match, ["confirmed"]);
      const now = nowIso();
      const statements: D1PreparedStatement[] = [
        matchGuard(env, groupId, matchId, baseMatchVersion, "confirmed"),
      ];
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      let newRoster = match.roster;

      if (field === "winner") {
        const winnerTeam = input.winnerTeam as Team;
        const teamASide = teamASideFromWinner(winnerTeam, input.winnerSide as Side);
        changes.winnerTeam = { from: match.winnerTeam, to: winnerTeam };
        if (teamASide !== match.teamASide) {
          changes.teamASide = { from: match.teamASide, to: teamASide };
        }
        statements.push(
          env.DB.prepare(
            "UPDATE matches SET winner_team = ?1, team_a_side = ?2 WHERE id = ?3 AND group_id = ?4",
          ).bind(winnerTeam, teamASide, matchId, groupId),
        );
      } else if (field === "side") {
        // 진영만 바꾼다. 승리 팀과 개인 승패는 그대로다.
        const teamASide = teamASideFromWinner(match.winnerTeam as Team, input.winnerSide as Side);
        changes.teamASide = { from: match.teamASide, to: teamASide };
        statements.push(
          env.DB.prepare("UPDATE matches SET team_a_side = ?1 WHERE id = ?2 AND group_id = ?3").bind(
            teamASide,
            matchId,
            groupId,
          ),
        );
      } else if (field === "playedAt") {
        changes.playedAt = { from: match.playedAt, to: input.playedAt };
        statements.push(
          env.DB.prepare("UPDATE matches SET played_at = ?1 WHERE id = ?2 AND group_id = ?3").bind(
            input.playedAt,
            matchId,
            groupId,
          ),
        );
      } else if (field === "positions") {
        const updates = input.positions as { participantId: string; position: Position }[];
        const byId = new Map(updates.map((u) => [u.participantId, u.position]));
        if (byId.size !== updates.length) {
          throw new ApiError(400, "INVALID_FIELD", "같은 참가자가 두 번 들어 있습니다.");
        }
        for (const id of byId.keys()) {
          if (!match.roster.some((r) => r.participantId === id)) {
            throw new ApiError(400, "INVALID_PARTICIPANT", "이 경기의 참가자가 아닙니다.", {
              participantIds: [id],
            });
          }
        }
        newRoster = match.roster.map((r) =>
          byId.has(r.participantId) ? { ...r, position: byId.get(r.participantId)! } : r,
        );
        for (const team of TEAMS) {
          const positions = newRoster
            .filter((r) => r.team === team)
            .map((r) => r.position)
            .filter((p): p is Position => p !== null);
          if (new Set(positions).size !== positions.length) {
            throw new ApiError(400, "INVALID_ROSTER", `팀 ${team}에 같은 포지션이 두 번 있습니다.`);
          }
        }
        // 자리 맞바꿈이 유일 제약에 걸리지 않도록 먼저 비우고 다시 채운다.
        for (const id of byId.keys()) {
          statements.push(
            env.DB.prepare(
              "UPDATE match_roster SET position = NULL WHERE match_id = ?1 AND participant_id = ?2",
            ).bind(matchId, id),
          );
        }
        for (const [id, position] of byId) {
          const before = match.roster.find((r) => r.participantId === id)!.position;
          changes[`position:${id}`] = { from: before, to: position };
          statements.push(
            env.DB.prepare(
              "UPDATE match_roster SET position = ?1 WHERE match_id = ?2 AND participant_id = ?3",
            ).bind(position, matchId, id),
          );
        }
      } else {
        const outId = input.outParticipantId as string;
        const inId = input.inParticipantId as string;
        if (!match.roster.some((r) => r.participantId === outId)) {
          throw new ApiError(400, "INVALID_PARTICIPANT", "이 경기의 참가자가 아닙니다.", {
            participantIds: [outId],
          });
        }
        if (match.roster.some((r) => r.participantId === inId)) {
          throw new ApiError(400, "INVALID_PARTICIPANT", "이미 이 경기에 있는 참가자입니다.", {
            participantIds: [inId],
          });
        }
        await assertActiveParticipants(env, groupId, [inId]);
        newRoster = match.roster.map((r) =>
          r.participantId === outId ? { ...r, participantId: inId } : r,
        );
        changes.participant = { from: outId, to: inId };
        statements.push(
          env.DB.prepare(
            "UPDATE match_roster SET participant_id = ?1 WHERE match_id = ?2 AND participant_id = ?3",
          ).bind(inId, matchId, outId),
        );
      }

      // 이 정정으로 서포터가 바뀌는 팀을 찾아 차례 기록 처리 여부를 확인한다.
      for (const team of TEAMS) {
        const before = supportOf(match.roster, team);
        const after = supportOf(newRoster, team);
        if (before === after || before === null) continue;
        const event = await env.DB.prepare(
          `SELECT id, cycle_id, kind FROM rotation_events
           WHERE match_id = ?1 AND participant_id = ?2 AND voided = 0`,
        )
          .bind(matchId, before)
          .first<{ id: string; cycle_id: string; kind: string }>();
        if (!event) continue;
        if (fixRotation === null) {
          throw new ApiError(
            409,
            "ROTATION_DECISION_REQUIRED",
            "이 정정으로 서포터가 바뀝니다. 서포터 차례 기록도 함께 고칠지 정해 주세요.",
            { team, from: before, to: after },
          );
        }
        if (!fixRotation) continue;
        if (after === null) {
          statements.push(
            env.DB.prepare("UPDATE rotation_events SET voided = 1 WHERE id = ?1").bind(event.id),
          );
        } else {
          // 새 서포터가 같은 주기에서 이미 차례를 썼다면 이 사건은 "반복"으로 남긴다.
          const already = await env.DB.prepare(
            `SELECT 1 AS ok FROM rotation_events
             WHERE cycle_id = ?1 AND participant_id = ?2 AND kind = 'used' AND voided = 0 AND id <> ?3`,
          )
            .bind(event.cycle_id, after, event.id)
            .first<{ ok: number }>();
          statements.push(
            env.DB.prepare(
              "UPDATE rotation_events SET participant_id = ?1, kind = ?2 WHERE id = ?3",
            ).bind(after, already ? "repeat" : event.kind, event.id),
          );
        }
        changes[`rotation:${team}`] = { from: before, to: after };
      }

      statements.push(
        env.DB.prepare("UPDATE matches SET version = version + 1 WHERE id = ?1 AND group_id = ?2").bind(
          matchId,
          groupId,
        ),
        insertRevision(env, groupId, matchId, "correction", changes, now),
      );
      return { stored: { matchId }, statements };
    },
  });
  return loadMatch(env, groupId, matchId);
}

/* ------------------------------------------------------------------ */
/* 지난 경기 입력                                                       */
/* ------------------------------------------------------------------ */

/**
 * 초안·진행 중을 거치지 않고 결과 확정 경기를 직접 만든다.
 * 세션·현재 경기·순환·진행 상태 버전을 건드리지 않는다.
 */
export async function backfillMatch(env: Env, groupId: string, body: Body): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "playedAt", "roster", "winnerTeam", "winnerSide"]);
  const requestId = requestIdOf(body);
  const playedAt = requireIsoTime(body.playedAt, "playedAt");
  const roster = parseRoster(body.roster, false);
  const winnerTeam = requireOneOf<Team>(body.winnerTeam, TEAMS, "winnerTeam");
  const winnerSide = requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide");
  const teamASide = teamASideFromWinner(winnerTeam, winnerSide);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "backfill",
    payload: { playedAt, roster, winnerTeam, winnerSide },
    build: async () => {
      await assertActiveParticipants(
        env,
        groupId,
        roster.map((r) => r.participantId),
      );
      const now = nowIso();
      const matchId = newId();
      return {
        stored: { matchId },
        statements: [
          env.DB.prepare(
            `INSERT INTO matches (id, group_id, match_no, state, source, played_at, ended_at,
               confirmed_at, winner_team, team_a_side, settings_version_id)
             SELECT ?1, id, next_match_no, 'confirmed', 'backfill', ?3, ?3, ?4, ?5, ?6, settings_version_id
             FROM groups WHERE id = ?2`,
          ).bind(matchId, groupId, playedAt, now, winnerTeam, teamASide),
          env.DB.prepare("UPDATE groups SET next_match_no = next_match_no + 1 WHERE id = ?1").bind(
            groupId,
          ),
          ...insertRoster(env, groupId, matchId, roster),
          insertRevision(
            env,
            groupId,
            matchId,
            "backfill",
            {
              winnerTeam: { from: null, to: winnerTeam },
              teamASide: { from: null, to: teamASide },
            },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, stored.matchId as string);
}

/* ------------------------------------------------------------------ */
/* 지난 기록 한꺼번에 넣기                                              */
/* ------------------------------------------------------------------ */

export const MAX_IMPORT_MATCHES = 50;
export const MAX_IMPORT_BODY_BYTES = 256 * 1024;

interface ImportMatch {
  playedAt: string;
  roster: RosterEntry[];
  winnerTeam: Team;
  winnerSide: Side;
}

/**
 * 결과가 이미 정해진 지난 경기를 한 번에 여러 개 넣는다(시트에 기록해 둔 모임용).
 * 받은 묶음 전체를 먼저 검증하고, 하나라도 틀리면 아무것도 저장하지 않는다.
 * 한 묶음은 한 batch로 저장하므로 일부만 들어가는 일이 없다.
 * 세션·현재 경기·순환·진행 상태 버전은 건드리지 않는다.
 * 진영은 요청이 정한 값을 그대로 쓴다(미상으로 넣을지 그대로 넣을지는 사용자가 고른다).
 */
export async function importMatches(
  env: Env,
  groupId: string,
  body: Body,
): Promise<{ matchIds: string[] }> {
  assertOnlyKeys(body, ["requestId", "batchId", "matches"]);
  const requestId = requestIdOf(body);
  // 한 번의 일괄 입력을 여러 묶음으로 나눠 보내도 같은 batchId를 쓴다. 되돌릴 때 이 값으로 찾는다.
  const batchId = requireString(body.batchId, "batchId", 8, 64);
  if (
    !Array.isArray(body.matches) ||
    body.matches.length < 1 ||
    body.matches.length > MAX_IMPORT_MATCHES
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `한 번에 1~${MAX_IMPORT_MATCHES}경기까지 넣을 수 있습니다.`,
    );
  }
  const matches: ImportMatch[] = body.matches.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError(400, "INVALID_FIELD", "경기 형식이 올바르지 않습니다.", { index });
    }
    const entry = raw as Body;
    try {
      assertOnlyKeys(entry, ["playedAt", "roster", "winnerTeam", "winnerSide"]);
      return {
        playedAt: requireIsoTime(entry.playedAt, "playedAt"),
        roster: parseRoster(entry.roster, false),
        winnerTeam: requireOneOf<Team>(entry.winnerTeam, TEAMS, "winnerTeam"),
        winnerSide: requireOneOf<Side>(entry.winnerSide, SIDES, "winnerSide"),
      };
    } catch (error) {
      // 몇 번째 경기에서 틀렸는지 알려준다.
      if (error instanceof ApiError) {
        throw new ApiError(400, error.code, error.message, { index });
      }
      throw error;
    }
  });

  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "import",
    payload: { batchId, matches },
    build: async () => {
      const active = await env.DB.prepare(
        "SELECT id FROM participants WHERE group_id = ?1 AND status = 'active'",
      )
        .bind(groupId)
        .all<{ id: string }>();
      const activeIds = new Set(active.results.map((r) => r.id));
      matches.forEach((match, index) => {
        const missing = match.roster.map((r) => r.participantId).filter((id) => !activeIds.has(id));
        if (missing.length > 0) {
          throw new ApiError(
            400,
            "INVALID_PARTICIPANT",
            "이 모임의 참가자가 아닌 사람이 있습니다.",
            { index, participantIds: missing },
          );
        }
      });

      const now = nowIso();
      const statements: D1PreparedStatement[] = [];
      const matchIds: string[] = [];
      matches.forEach((match, offset) => {
        const matchId = newId();
        matchIds.push(matchId);
        const teamASide = teamASideFromWinner(match.winnerTeam, match.winnerSide);
        statements.push(
          env.DB.prepare(
            `INSERT INTO matches (id, group_id, match_no, state, source, played_at, ended_at,
               confirmed_at, winner_team, team_a_side, settings_version_id, import_batch_id)
             SELECT ?1, id, next_match_no + ?7, 'confirmed', 'import', ?3, ?3, ?4, ?5, ?6,
               settings_version_id, ?8
             FROM groups WHERE id = ?2`,
          ).bind(
            matchId,
            groupId,
            match.playedAt,
            now,
            match.winnerTeam,
            teamASide,
            offset,
            batchId,
          ),
        );
        // 명단 10행을 한 문장으로 넣는다(문장당 값 50개).
        const values = match.roster.map(() => "(?, ?, ?, ?, ?)").join(", ");
        statements.push(
          env.DB.prepare(
            `INSERT INTO match_roster (match_id, group_id, participant_id, team, position)
             VALUES ${values}`,
          ).bind(
            ...match.roster.flatMap((r) => [matchId, groupId, r.participantId, r.team, r.position]),
          ),
        );
        statements.push(
          insertRevision(
            env,
            groupId,
            matchId,
            "backfill",
            {
              winnerTeam: { from: null, to: match.winnerTeam },
              teamASide: { from: null, to: teamASide },
            },
            now,
          ),
        );
      });
      statements.push(
        env.DB.prepare("UPDATE groups SET next_match_no = next_match_no + ?1 WHERE id = ?2").bind(
          matches.length,
          groupId,
        ),
      );
      return { stored: { matchIds }, statements };
    },
  });
  return { matchIds: stored.matchIds as string[] };
}

/**
 * 일괄 입력 한 번(묶음)으로 넣은 경기를 모두 전적 제외하거나 다시 복구한다.
 * 경기마다 하나씩 제외하는 것과 같은 결과이며 변경 이력도 경기마다 남는다.
 * 그 묶음의 경기 중 손으로 따로 제외·정정한 경기도 상태 기준으로만 처리한다:
 * 제외는 "결과 확정" 경기에만, 복구는 "확정이었다가 제외된" 경기에만 적용된다.
 */
export async function setImportBatchExcluded(
  env: Env,
  groupId: string,
  batchId: string,
  body: Body,
): Promise<{ changed: number }> {
  assertOnlyKeys(body, ["requestId", "exclude"]);
  const requestId = requestIdOf(body);
  if (typeof body.exclude !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "exclude 값이 올바르지 않습니다.");
  }
  const exclude = body.exclude;
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "import-batch",
    payload: { batchId, exclude },
    build: async () => {
      const target = await env.DB.prepare(
        exclude
          ? `SELECT COUNT(*) AS n FROM matches
             WHERE group_id = ?1 AND import_batch_id = ?2 AND state = 'confirmed'`
          : `SELECT COUNT(*) AS n FROM matches
             WHERE group_id = ?1 AND import_batch_id = ?2 AND state = 'excluded'
               AND prev_state = 'confirmed'`,
      )
        .bind(groupId, batchId)
        .first<{ n: number }>();
      const exists = await env.DB.prepare(
        "SELECT 1 AS ok FROM matches WHERE group_id = ?1 AND import_batch_id = ?2 LIMIT 1",
      )
        .bind(groupId, batchId)
        .first<{ ok: number }>();
      if (!exists) throw new ApiError(404, "NOT_FOUND", "일괄 입력 기록을 찾을 수 없습니다.");
      const now = nowIso();
      const from = exclude ? "confirmed" : "excluded";
      const to = exclude ? "excluded" : "confirmed";
      const where = exclude
        ? "group_id = ?1 AND import_batch_id = ?2 AND state = 'confirmed'"
        : "group_id = ?1 AND import_batch_id = ?2 AND state = 'excluded' AND prev_state = 'confirmed'";
      return {
        stored: { changed: target?.n ?? 0 },
        statements: [
          // 이력을 먼저 남긴다(상태를 바꾸기 전의 대상 경기를 기준으로).
          env.DB.prepare(
            `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
             SELECT group_id, id, ?3, ?4, ?5 FROM matches WHERE ${where}`,
          ).bind(
            groupId,
            batchId,
            exclude ? "exclude" : "restore",
            JSON.stringify({ state: { from, to } }),
            now,
          ),
          env.DB.prepare(
            exclude
              ? `UPDATE matches SET state = 'excluded', prev_state = 'confirmed', version = version + 1
                 WHERE ${where}`
              : `UPDATE matches SET state = 'confirmed', prev_state = NULL, version = version + 1
                 WHERE ${where}`,
          ).bind(groupId, batchId),
        ],
      };
    },
  });
  return { changed: stored.changed as number };
}
