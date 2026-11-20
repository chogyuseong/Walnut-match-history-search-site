/**
 * 이미 기록된 경기의 내용을 고치는 쓰기 요청: 항목별 정정(승패·진영·시각·포지션·사람)과 날짜 일괄 정정.
 * 경기 상세의 정정 창과 기록 화면 "날짜 점검"이 부른다(경로는 index.ts).
 * 두 요청 모두 경기마다 정정 기록(revision)을 남기고 경기 버전을 올린다. 통계는 기기가 스냅숏으로 다시 계산한다.
 */
import { FUTURE_TOLERANCE_MS } from "../shared/backfill";
import { shiftYears } from "../shared/dateCheck";
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
  nowIso,
  requireInt,
  requireIsoTime,
  requireOneOf,
  requireRequestId,
  requireString,
} from "./http";
import { bumpLiveVersion, insertRevision, matchGuard, runMutation } from "./mutation";
import {
  assertActiveParticipants,
  assertMatchVersion,
  assertState,
  matchConflictDetails,
  type Body,
} from "./matchChecks";
import { loadMatch } from "./snapshot";

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
  const requestId = requireRequestId(body);
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
    // 지난 경기 입력·일괄 입력과 같은 기준: 경기 시각을 미래로 고칠 수 없다.
    if (Date.parse(input.playedAt as string) > Date.now() + FUTURE_TOLERANCE_MS) {
      throw new ApiError(400, "FUTURE_MATCH", "아직 오지 않은 시각으로는 고칠 수 없습니다. 날짜와 시각을 확인해 주세요.");
    }
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
          // 새 서포터가 같은 주기에서 이미 차례를 썼다면 이 사건은 "반복"으로, 아니면 "사용"으로 남긴다. 예전 사건의
          // 종류(event.kind)를 물려받으면, 반복이던 서포터를 아직 차례를 안 쓴 사람으로 고쳐도 반복으로 남아 그 사람의
          // 차례가 소비되지 않았다(진행 중 교체와 같은 규칙으로 맞춤, 2026-11-08 정합성 점검).
          const already = await env.DB.prepare(
            `SELECT 1 AS ok FROM rotation_events
             WHERE cycle_id = ?1 AND participant_id = ?2 AND kind = 'used' AND voided = 0 AND id <> ?3`,
          )
            .bind(event.cycle_id, after, event.id)
            .first<{ ok: number }>();
          statements.push(
            env.DB.prepare(
              "UPDATE rotation_events SET participant_id = ?1, kind = ?2 WHERE id = ?3",
            ).bind(after, already ? "repeat" : "used", event.id),
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
/* 날짜 일괄 정정(2026-11-08)                                            */
/* ------------------------------------------------------------------ */

const MAX_SHIFT_MATCHES = 500;
/** 날짜 일괄 정정 요청 본문 상한. 경기 ID(UUID) 500개가 약 20KB라 기본 16KB로는 400개 남짓에서 413이 났다. */
export const SHIFT_DATES_BODY_BYTES = 64 * 1024;

/**
 * 여러 경기의 시각을 한 해 뒤(+1) 또는 앞(-1)으로 옮긴다(화면 "날짜 점검"). 가져온 기록의 연도가 통째로 틀린 경우를
 * 한 번에 고치려는 것이다. 경기마다 "경기 시각 수정"과 같은 정정 기록(correction, playedAt)을 남기고 경기 버전을 올린다.
 * 확정 경기와 전적 제외 경기를 옮길 수 있다(2026-11-08 정합성 점검: 같은 묶음의 제외 경기만 틀린 연도로 남지 않게).
 * 제외 경기는 제외 상태 그대로라 통계에는 영향이 없다.
 * 한 경기라도 옮긴 시각이 미래이거나 옮길 수 없는 상태(진행 중·결과 대기·취소)이면 전체를 거절한다(부분 적용 없음).
 * 되돌리기는 같은 경기에 반대 부호. 연도는 모임 시간대의 날짜·시각을 기준으로 옮긴다(shiftYears의 timeZone).
 *
 * 질의 수(무료 요금제: 호출당 50회): 경기 수와 상관없이 읽기 1회(경기 전부를 json_each로) + batch 1회.
 * 예전에는 경기마다 loadMatch(질의 2회)라 21경기부터 한도를 넘었다.
 */
export async function shiftMatchDates(env: Env, groupId: string, body: Body): Promise<{ changed: number }> {
  assertOnlyKeys(body, ["requestId", "matchIds", "years"]);
  const requestId = requireRequestId(body);
  if (!Array.isArray(body.matchIds) || body.matchIds.length < 1 || body.matchIds.length > MAX_SHIFT_MATCHES) {
    throw new ApiError(400, "INVALID_FIELD", `matchIds는 1~${MAX_SHIFT_MATCHES}개여야 합니다.`);
  }
  const matchIds = [...new Set(body.matchIds.map((v) => requireString(v, "matchIds", 1, 64)))];
  if (body.years !== 1 && body.years !== -1) {
    throw new ApiError(400, "INVALID_FIELD", "years는 1 또는 -1이어야 합니다.");
  }
  const years = body.years;
  await runMutation(env, {
    groupId,
    requestId,
    op: "shift-dates",
    payload: { matchIds, years },
    conflictDetails: () => matchConflictDetails(env, groupId, matchIds[0]!),
    build: async () => {
      const now = nowIso();
      const list = JSON.stringify(matchIds);
      const rows = await env.DB.prepare(
        `SELECT id, match_no, version, state, played_at,
           (SELECT timezone FROM groups WHERE id = ?1) AS timezone
         FROM matches WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND deleted_at IS NULL`,
      )
        .bind(groupId, list)
        .all<{ id: string; match_no: number; version: number; state: string; played_at: string; timezone: string }>();
      const byId = new Map(rows.results.map((r) => [r.id, r]));
      // 각 경기: [id, 읽은 버전, 읽은 상태, 옮긴 시각, 정정 기록(JSON)]. batch 문장은 경기 수와 상관없이 3개다.
      const items: [string, number, string, string, string][] = [];
      for (const matchId of matchIds) {
        const row = byId.get(matchId);
        if (!row) throw new ApiError(404, "NOT_FOUND", "경기를 찾을 수 없습니다.");
        if (row.state !== "confirmed" && row.state !== "excluded") {
          throw new ApiError(409, "STATE_CONFLICT", "지금 상태에서는 할 수 없는 작업입니다.", {
            match: { version: row.version, state: row.state },
          });
        }
        const to = shiftYears(row.played_at, years, row.timezone);
        if (Date.parse(to) > Date.now() + FUTURE_TOLERANCE_MS) {
          throw new ApiError(
            400,
            "FUTURE_MATCH",
            `${row.match_no}경기를 옮기면 아직 오지 않은 시각이 됩니다. 범위를 확인해 주세요.`,
          );
        }
        items.push([matchId, row.version, row.state, to, JSON.stringify({ playedAt: { from: row.played_at, to } })]);
      }
      const payload = JSON.stringify(items);
      const statements: D1PreparedStatement[] = [
        // 읽은 뒤 한 경기라도 버전·상태가 바뀌었으면 batch 전체를 실패시킨다(경기마다 matchGuard를 둔 것과 같다).
        env.DB.prepare(
          `INSERT INTO guard (version_conflict)
           SELECT 1 WHERE (
             SELECT COUNT(*) FROM json_each(?2) j
             JOIN matches m ON m.group_id = ?1 AND m.id = json_extract(j.value, '$[0]')
               AND m.version = json_extract(j.value, '$[1]') AND m.state = json_extract(j.value, '$[2]')
           ) <> ?3`,
        ).bind(groupId, payload, items.length),
        // 정정 기록은 요청 순서대로 남긴다(경기마다 insertRevision을 부른 예전과 같은 순서).
        env.DB.prepare(
          `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
           SELECT ?1, json_extract(value, '$[0]'), 'correction', json_extract(value, '$[4]'), ?3
           FROM json_each(?2) ORDER BY key`,
        ).bind(groupId, payload, now),
        env.DB.prepare(
          `UPDATE matches
           SET played_at = (SELECT json_extract(value, '$[3]') FROM json_each(?2)
                            WHERE json_extract(value, '$[0]') = matches.id),
               version = version + 1
           WHERE group_id = ?1 AND id IN (SELECT json_extract(value, '$[0]') FROM json_each(?2))`,
        ).bind(groupId, payload),
        bumpLiveVersion(env, groupId),
      ];
      return { stored: { changed: matchIds.length }, statements };
    },
  });
  return { changed: matchIds.length };
}
