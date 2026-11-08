/**
 * 중복 참가자 합치기와 되돌리기(docs/P2 P2-1 "중복 참가자"의 후속 기능).
 *
 * 합치기: "합칠 대상(source)"이 들어 있던 모든 경기 명단 행과 서포터 차례 기록을 "남길 대상(target)"으로 옮기고
 * 합칠 대상은 보관 상태로 둔다. 한 요청·한 batch(트랜잭션)로 처리하며 하나라도 실패하면 아무것도 바뀌지 않는다.
 *
 * "원본을 수정하지 않는다"(docs/P2 P2-11)와 맞추는 방법:
 * - 참가자 행은 지우지 않는다(보관). 이름·ID가 남아 변경 이력과 백업이 계속 읽힌다.
 * - 옮긴 행의 목록(경기 ID, 바꾼 차례 기록의 전후 값)을 participant_merges에 남긴다. 되돌리기는 이 목록에 있는
 *   행만 원래대로 돌린다. 합친 뒤 남길 대상이 새로 뛴 경기는 목록에 없으므로 그대로 남는다.
 * - 옮긴 경기마다 변경 이력(정정 · 참가자)을 한 줄 남기고 경기 버전을 올린다. 열려 있던 결과 창은 버전 충돌로 막힌다.
 *
 * 규칙:
 * - 두 사람이 같은 경기(상태와 관계없이)에 함께 있으면 합칠 수 없다. 겹치는 경기 번호를 알려준다.
 * - 합칠 대상이 진행 중 경기에 있으면 합칠 수 없다(경기를 마치거나 "결과 나중에"로 돌린 뒤).
 * - 서포터 순환: 같은 주기에 두 사람이 각각 "차례 사용"을 했으면 같은 사람이 두 번 쓴 것이므로
 *   먼저 쓴 기록만 "사용"으로 두고 나중 기록을 "반복 허용"으로 바꾼다(그 주기의 사용 인원 수가 1 줄어든다).
 *   차례 기록이 바뀌면 진행 상태 버전을 올린다(초안의 후보 목록이 달라지므로).
 * - 이미 합쳐진 사람은 다시 합치거나 남길 대상으로 고를 수 없다. 되돌리기는 나중에 한 합치기부터
 *   (남길 대상이 그 뒤 다른 사람에게 합쳐졌으면 그쪽을 먼저 되돌린다).
 */
import { mergeStandings, overlappingMatches, type MergeStandings } from "../shared/merge";
import { titleBandsOf } from "../shared/titles";
import type { MatchState, MatchView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireString } from "./http";
import { bumpLiveVersion, runMutation } from "./mutation";
import { buildSnapshot } from "./snapshot";

type Body = Record<string, unknown>;

/** 테스트 전용: batch 중간에 끼울 문장. "중간 실패 시 아무것도 바뀌지 않음"을 확인할 때 쓴다. */
export const mergeHooks: { midBatch: ((env: Env) => D1PreparedStatement) | null } = {
  midBatch: null,
};

interface PersonRow {
  id: string;
  name: string;
  name_key: string;
  status: "active" | "archived";
  merged_into: string | null;
}

interface EventRow {
  id: string;
  cycle_id: string;
  participant_id: string;
  kind: "used" | "repeat";
  voided: number;
  created_at: string;
}

export interface RotationChange {
  id: string;
  participantFrom: string;
  participantTo: string;
  kindFrom: "used" | "repeat";
  kindTo: "used" | "repeat";
}

export interface MergePreview {
  ok: boolean;
  problems: string[];
  source: { id: string; name: string; status: string };
  target: { id: string; name: string; status: string };
  /** 옮길 경기 수와 상태별 수. */
  movedMatches: number;
  byState: Partial<Record<MatchState, number>>;
  /** 두 사람이 함께 있는 경기(있으면 합칠 수 없다). */
  overlaps: { matchId: string; matchNo: number }[];
  /** 합칠 대상이 들어 있는 진행 중 경기. */
  inProgress: { matchId: string; matchNo: number }[];
  /** 옮길 서포터 차례 기록 수와, 같은 주기 중복이라 "반복 허용"으로 바뀌는 수. */
  rotation: { moved: number; converted: number };
  /** 합치기 전후의 누적 승패·배치·칭호. */
  standings: MergeStandings;
}

async function loadPerson(env: Env, groupId: string, id: string): Promise<PersonRow> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.name, p.name_key, p.status, m.target_id AS merged_into
     FROM participants p
     LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
     WHERE p.id = ?1 AND p.group_id = ?2`,
  )
    .bind(id, groupId)
    .first<PersonRow>();
  // 다른 모임의 참가자는 없는 것과 같은 답을 준다.
  if (!row) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");
  return row;
}

async function loadEvents(env: Env, groupId: string, participantId: string): Promise<EventRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, cycle_id, participant_id, kind, voided, created_at FROM rotation_events
     WHERE group_id = ?1 AND participant_id = ?2 ORDER BY created_at, id`,
  )
    .bind(groupId, participantId)
    .all<EventRow>();
  return rows.results;
}

const earlier = (a: EventRow, b: EventRow) =>
  a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);

/**
 * 옮길 차례 기록과 바뀌는 종류를 정한다.
 * 같은 주기에 두 사람 모두 유효한 "사용"이 있으면 늦은 쪽을 "반복 허용"으로 바꾼다.
 */
export function planRotation(
  sourceEvents: readonly EventRow[],
  targetEvents: readonly EventRow[],
  sourceId: string,
  targetId: string,
): RotationChange[] {
  const changes = new Map<string, RotationChange>();
  for (const e of sourceEvents) {
    changes.set(e.id, {
      id: e.id,
      participantFrom: sourceId,
      participantTo: targetId,
      kindFrom: e.kind,
      kindTo: e.kind,
    });
  }
  const liveUsed = (e: EventRow) => e.kind === "used" && e.voided === 0;
  for (const s of sourceEvents.filter(liveUsed)) {
    const t = targetEvents.find((e) => liveUsed(e) && e.cycle_id === s.cycle_id);
    if (!t) continue;
    if (earlier(t, s)) {
      changes.get(s.id)!.kindTo = "repeat";
    } else {
      changes.set(t.id, {
        id: t.id,
        participantFrom: targetId,
        participantTo: targetId,
        kindFrom: "used",
        kindTo: "repeat",
      });
    }
  }
  return [...changes.values()];
}

interface MergeContext {
  source: PersonRow;
  target: PersonRow;
  matches: MatchView[];
  moved: MatchView[];
  overlaps: MatchView[];
  inProgress: MatchView[];
  sourceEvents: EventRow[];
  rotation: RotationChange[];
  standings: MergeStandings;
  problems: string[];
}

async function loadContext(
  env: Env,
  groupId: string,
  sourceId: string,
  targetId: string,
): Promise<MergeContext> {
  if (sourceId === targetId) {
    throw new ApiError(400, "SAME_PARTICIPANT", "같은 사람끼리는 합칠 수 없습니다.");
  }
  const source = await loadPerson(env, groupId, sourceId);
  const target = await loadPerson(env, groupId, targetId);
  const snapshot = await buildSnapshot(env, groupId, "operator");
  const matches = snapshot.matches;
  const moved = matches.filter((m) => m.roster.some((r) => r.participantId === sourceId));
  const overlaps = overlappingMatches(matches, sourceId, targetId);
  const inProgress = moved.filter((m) => m.state === "in_progress");
  const sourceEvents = await loadEvents(env, groupId, sourceId);
  const targetEvents = await loadEvents(env, groupId, targetId);
  const rotation = planRotation(sourceEvents, targetEvents, sourceId, targetId);

  const problems: string[] = [];
  if (source.merged_into) problems.push(`'${source.name}'은(는) 이미 다른 사람에게 합쳐졌어요.`);
  if (target.merged_into) {
    problems.push(`'${target.name}'은(는) 다른 사람에게 합쳐진 이름이라 남길 대상으로 고를 수 없어요.`);
  }
  if (overlaps.length > 0) {
    problems.push(
      `두 사람이 같은 경기에 함께 나왔어요(${overlaps.map((m) => `${m.matchNo}경기`).join(", ")}). ` +
        "한 경기에 같은 사람이 두 번 들어갈 수 없어 합칠 수 없습니다. 다른 사람이면 합치지 마세요.",
    );
  }
  if (inProgress.length > 0) {
    problems.push(
      `'${source.name}'이(가) 진행 중인 ${inProgress[0]!.matchNo}경기에 있어요. ` +
        "결과를 저장하거나 '결과는 나중에'로 돌린 뒤 합쳐 주세요.",
    );
  }
  return {
    source,
    target,
    matches,
    moved,
    overlaps,
    inProgress,
    sourceEvents,
    rotation,
    standings: mergeStandings(matches, sourceId, targetId, titleBandsOf(snapshot.group.settings)),
    problems,
  };
}

function parseIds(raw: { sourceId?: unknown; targetId?: unknown }): { sourceId: string; targetId: string } {
  return {
    sourceId: requireString(raw.sourceId, "sourceId", 1, 64),
    targetId: requireString(raw.targetId, "targetId", 1, 64),
  };
}

/** 합치기 미리보기: 아무것도 쓰지 않는다. */
export async function previewMerge(
  env: Env,
  groupId: string,
  query: { sourceId?: unknown; targetId?: unknown },
): Promise<MergePreview> {
  const { sourceId, targetId } = parseIds(query);
  const ctx = await loadContext(env, groupId, sourceId, targetId);
  const byState: Partial<Record<MatchState, number>> = {};
  for (const m of ctx.moved) byState[m.state] = (byState[m.state] ?? 0) + 1;
  return {
    ok: ctx.problems.length === 0,
    problems: ctx.problems,
    source: { id: ctx.source.id, name: ctx.source.name, status: ctx.source.status },
    target: { id: ctx.target.id, name: ctx.target.name, status: ctx.target.status },
    movedMatches: ctx.moved.length,
    byState,
    overlaps: ctx.overlaps.map((m) => ({ matchId: m.id, matchNo: m.matchNo })),
    inProgress: ctx.inProgress.map((m) => ({ matchId: m.id, matchNo: m.matchNo })),
    rotation: {
      moved: ctx.sourceEvents.length,
      converted: ctx.rotation.filter((c) => c.kindFrom !== c.kindTo).length,
    },
    standings: ctx.standings,
  };
}

const stateGuard = (env: Env, sql: string, ...values: unknown[]) =>
  env.DB.prepare(`INSERT INTO guard (state_conflict) SELECT 1 WHERE ${sql}`).bind(...values);

/** 합치기 실행. 미리보기와 같은 검사를 다시 하고, 사이에 바뀐 것이 있으면 batch 안의 보호 문장이 막는다. */
export async function mergeParticipants(
  env: Env,
  groupId: string,
  body: Body,
): Promise<{ mergeId: string; matchCount: number }> {
  assertOnlyKeys(body, ["requestId", "sourceId", "targetId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const { sourceId, targetId } = parseIds(body);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "merge-participants",
    payload: { sourceId, targetId },
    build: async () => {
      const ctx = await loadContext(env, groupId, sourceId, targetId);
      if (ctx.source.merged_into || ctx.target.merged_into) {
        throw new ApiError(409, "ALREADY_MERGED", ctx.problems[0]!);
      }
      if (ctx.overlaps.length > 0) {
        throw new ApiError(409, "MERGE_OVERLAP", ctx.problems[0]!, {
          matchNos: ctx.overlaps.map((m) => m.matchNo),
        });
      }
      if (ctx.inProgress.length > 0) {
        throw new ApiError(409, "MATCH_IN_PROGRESS", ctx.problems[ctx.problems.length - 1]!, {
          matchId: ctx.inProgress[0]!.id,
        });
      }
      const mergeId = newId();
      const now = nowIso();
      const movedIds = JSON.stringify(ctx.moved.map((m) => m.id));
      const eventIds = JSON.stringify(ctx.sourceEvents.map((e) => e.id));
      const toRepeat = JSON.stringify(
        ctx.rotation.filter((c) => c.kindTo === "repeat" && c.kindFrom === "used").map((c) => c.id),
      );
      const statements: D1PreparedStatement[] = [
        // 사이에 바뀐 것이 있으면 막는다: 이미 합쳐짐, 명단·차례 기록이 늘거나 줄어듦, 겹침, 진행 중.
        stateGuard(
          env,
          "EXISTS (SELECT 1 FROM participant_merges WHERE source_id IN (?1, ?2) AND undone_at IS NULL)",
          sourceId,
          targetId,
        ),
        stateGuard(
          env,
          `(SELECT COUNT(*) FROM match_roster WHERE group_id = ?1 AND participant_id = ?2) <> ?3
           OR EXISTS (SELECT 1 FROM match_roster WHERE group_id = ?1 AND participant_id = ?2
                      AND match_id NOT IN (SELECT value FROM json_each(?4)))`,
          groupId,
          sourceId,
          ctx.moved.length,
          movedIds,
        ),
        stateGuard(
          env,
          `(SELECT COUNT(*) FROM rotation_events WHERE group_id = ?1 AND participant_id = ?2) <> ?3`,
          groupId,
          sourceId,
          ctx.sourceEvents.length,
        ),
        stateGuard(
          env,
          `EXISTS (SELECT 1 FROM match_roster a JOIN match_roster b ON a.match_id = b.match_id
                   WHERE a.group_id = ?1 AND a.participant_id = ?2 AND b.participant_id = ?3)
           OR EXISTS (SELECT 1 FROM match_roster r JOIN matches m ON m.id = r.match_id
                      WHERE r.group_id = ?1 AND r.participant_id = ?2 AND m.state = 'in_progress')`,
          groupId,
          sourceId,
          targetId,
        ),
        // 변경 이력: 옮긴 경기마다 한 줄(정정 · 참가자). 상태를 바꾸기 전에 남긴다.
        env.DB.prepare(
          `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
           SELECT ?1, value, 'correction', ?2, ?3 FROM json_each(?4)`,
        ).bind(
          groupId,
          JSON.stringify({ participant: { from: sourceId, to: targetId } }),
          now,
          movedIds,
        ),
        env.DB.prepare(
          "UPDATE match_roster SET participant_id = ?3 WHERE group_id = ?1 AND participant_id = ?2",
        ).bind(groupId, sourceId, targetId),
      ];
      if (mergeHooks.midBatch) statements.push(mergeHooks.midBatch(env));
      statements.push(
        env.DB.prepare(
          `UPDATE matches SET version = version + 1
           WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
        ).bind(groupId, movedIds),
        // 같은 주기의 중복 "사용"은 옮기기 전에 "반복 허용"으로 바꿔야 유일 제약에 걸리지 않는다.
        env.DB.prepare(
          `UPDATE rotation_events SET kind = 'repeat'
           WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
        ).bind(groupId, toRepeat),
        env.DB.prepare(
          `UPDATE rotation_events SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2 AND id IN (SELECT value FROM json_each(?4))`,
        ).bind(groupId, sourceId, targetId, eventIds),
        env.DB.prepare(
          "UPDATE participants SET status = 'archived', version = version + 1 WHERE id = ?1 AND group_id = ?2",
        ).bind(sourceId, groupId),
        // 참가자 본인 연결(migrations/0019): 남은 사람에게 연결이 없으면 합쳐진 쪽의 연결(과 그 요청)을 남은 사람에게 옮기고,
        // 이미 있으면 합쳐진 쪽 연결은 지운다(요청은 합쳐진 쪽에 남아 운영자만 본다). 쓰지 않은 연결 링크는 지운다.
        // 되돌려도 연결·요청은 돌아가지 않는다(합치기 기록에 남기지 않음).
        env.DB.prepare(
          `UPDATE join_requests SET account_id = NULL
           WHERE group_id = ?1
             AND account_id IN (SELECT account_id FROM participant_links WHERE group_id = ?1 AND participant_id = ?2)
             AND EXISTS (SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?3)`,
        ).bind(groupId, sourceId, targetId),
        env.DB.prepare(
          `UPDATE participant_requests SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2
             AND NOT EXISTS (SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?3)`,
        ).bind(groupId, sourceId, targetId),
        env.DB.prepare(
          `UPDATE participant_links SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2
             AND NOT EXISTS (SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?3)`,
        ).bind(groupId, sourceId, targetId),
        env.DB.prepare("DELETE FROM participant_links WHERE group_id = ?1 AND participant_id = ?2").bind(
          groupId,
          sourceId,
        ),
        env.DB.prepare("DELETE FROM participant_claims WHERE group_id = ?1 AND participant_id = ?2").bind(
          groupId,
          sourceId,
        ),
        env.DB.prepare(
          `INSERT INTO participant_merges (id, group_id, source_id, target_id, source_prev_status,
             moved_matches, rotation_changes, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        ).bind(
          mergeId,
          groupId,
          sourceId,
          targetId,
          ctx.source.status,
          movedIds,
          JSON.stringify(ctx.rotation),
          now,
        ),
      );
      if (ctx.rotation.length > 0) statements.push(bumpLiveVersion(env, groupId));
      return { stored: { mergeId, matchCount: ctx.moved.length }, statements };
    },
  });
  return { mergeId: stored.mergeId as string, matchCount: stored.matchCount as number };
}

/**
 * 합치기 되돌리기. 합치기 기록에 남긴 행만 원래대로 돌린다.
 * - 옮겼던 경기 중 지금도 남길 대상이 명단에 있는 경기만 합칠 대상으로 돌린다
 *   (그 사이 참가자 정정으로 빠진 경기는 정정을 존중해 그대로 둔다).
 * - 합친 뒤 남길 대상이 새로 뛴 경기·새 차례 기록은 건드리지 않는다.
 * - 차례 기록의 종류는 합치기가 바꾼 값 그대로일 때만 되돌린다.
 */
export async function undoMerge(
  env: Env,
  groupId: string,
  mergeId: string,
  body: Body,
): Promise<{ mergeId: string; matchCount: number }> {
  assertOnlyKeys(body, ["requestId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "undo-merge",
    payload: { mergeId },
    build: async () => {
      const merge = await env.DB.prepare(
        `SELECT id, source_id, target_id, source_prev_status, moved_matches, rotation_changes, undone_at
         FROM participant_merges WHERE id = ?1 AND group_id = ?2`,
      )
        .bind(mergeId, groupId)
        .first<{
          id: string;
          source_id: string;
          target_id: string;
          source_prev_status: "active" | "archived";
          moved_matches: string;
          rotation_changes: string;
          undone_at: string | null;
        }>();
      if (!merge) throw new ApiError(404, "NOT_FOUND", "합치기 기록을 찾을 수 없습니다.");
      if (merge.undone_at) throw new ApiError(409, "ALREADY_UNDONE", "이미 되돌린 합치기입니다.");
      const source = await loadPerson(env, groupId, merge.source_id);
      const target = await loadPerson(env, groupId, merge.target_id);
      if (target.merged_into) {
        throw new ApiError(
          409,
          "MERGE_ORDER",
          `'${target.name}'이(가) 그 뒤 다른 사람에게 합쳐졌어요. 그 합치기를 먼저 되돌려 주세요.`,
        );
      }
      if (merge.source_prev_status === "active") {
        const clash = await env.DB.prepare(
          `SELECT name FROM participants
           WHERE group_id = ?1 AND status = 'active' AND name_key = ?2 AND id <> ?3`,
        )
          .bind(groupId, source.name_key, source.id)
          .first<{ name: string }>();
        if (clash) {
          throw new ApiError(
            409,
            "NAME_TAKEN",
            `'${source.name}'과(와) 같은 이름의 참가자가 지금 있어요. 그 사람의 이름을 바꾼 뒤 되돌려 주세요.`,
            { name: clash.name },
          );
        }
      }
      const moved = JSON.parse(merge.moved_matches) as string[];
      const rotation = JSON.parse(merge.rotation_changes) as RotationChange[];
      const stillThere = await env.DB.prepare(
        `SELECT match_id FROM match_roster
         WHERE group_id = ?1 AND participant_id = ?2 AND match_id IN (SELECT value FROM json_each(?3))`,
      )
        .bind(groupId, merge.target_id, merge.moved_matches)
        .all<{ match_id: string }>();
      const back = JSON.stringify(stillThere.results.map((r) => r.match_id));
      const movedEvents = JSON.stringify(
        rotation.filter((c) => c.participantFrom !== c.participantTo).map((c) => c.id),
      );
      const kindChanges = JSON.stringify(rotation.filter((c) => c.kindFrom !== c.kindTo));
      const now = nowIso();
      const statements: D1PreparedStatement[] = [
        stateGuard(
          env,
          `NOT EXISTS (SELECT 1 FROM participant_merges WHERE id = ?1 AND undone_at IS NULL)
           OR EXISTS (SELECT 1 FROM participant_merges WHERE source_id = ?2 AND undone_at IS NULL)`,
          mergeId,
          merge.target_id,
        ),
        stateGuard(
          env,
          `?1 = 'active' AND EXISTS (SELECT 1 FROM participants
             WHERE group_id = ?2 AND status = 'active' AND name_key = ?3 AND id <> ?4)`,
          merge.source_prev_status,
          groupId,
          source.name_key,
          source.id,
        ),
        env.DB.prepare(
          `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
           SELECT ?1, value, 'correction', ?2, ?3 FROM json_each(?4)`,
        ).bind(
          groupId,
          JSON.stringify({ participant: { from: merge.target_id, to: merge.source_id } }),
          now,
          back,
        ),
        env.DB.prepare(
          `UPDATE match_roster SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2 AND match_id IN (SELECT value FROM json_each(?4))`,
        ).bind(groupId, merge.target_id, merge.source_id, back),
        env.DB.prepare(
          `UPDATE matches SET version = version + 1
           WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
        ).bind(groupId, back),
        // 차례 기록: 사람을 먼저 돌려놓고 종류를 돌린다(유일 제약 순서).
        env.DB.prepare(
          `UPDATE rotation_events SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2 AND id IN (SELECT value FROM json_each(?4))`,
        ).bind(groupId, merge.target_id, merge.source_id, movedEvents),
        env.DB.prepare(
          `UPDATE rotation_events
           SET kind = (SELECT json_extract(value, '$.kindFrom') FROM json_each(?2)
                       WHERE json_extract(value, '$.id') = rotation_events.id)
           WHERE group_id = ?1
             AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?2))
             AND kind = (SELECT json_extract(value, '$.kindTo') FROM json_each(?2)
                         WHERE json_extract(value, '$.id') = rotation_events.id)`,
        ).bind(groupId, kindChanges),
        env.DB.prepare("UPDATE participants SET status = ?1, version = version + 1 WHERE id = ?2 AND group_id = ?3").bind(
          merge.source_prev_status,
          merge.source_id,
          groupId,
        ),
        env.DB.prepare("UPDATE participant_merges SET undone_at = ?1 WHERE id = ?2").bind(now, mergeId),
      ];
      if (rotation.length > 0) statements.push(bumpLiveVersion(env, groupId));
      return {
        stored: {
          mergeId,
          matchCount: stillThere.results.length,
          skipped: moved.length - stillThere.results.length,
        },
        statements,
      };
    },
  });
  return { mergeId: stored.mergeId as string, matchCount: stored.matchCount as number };
}
