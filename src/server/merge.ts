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
 * - 본인 연결(migrations/0019): 합칠 대상의 연결은 남길 대상에게 옮기거나(남길 대상에 연결이 없을 때) 지우고,
 *   무엇을 했는지 participant_merges.moved_link(migrations/0023)에 남긴다. 되돌리면 그 연결을 원래 사람에게 돌려놓는다.
 *   되돌리기는 "같은 사람이 아니었다"는 뜻이므로 다른 사람의 계정이 남길 대상의 "본인"으로 남지 않게 하는 것이
 *   먼저다(undoLinkPlan, docs/개선-합치기-2026-11-08.md).
 */
import { mergeStandings, overlappingMatches, type MergeStandings } from "../shared/merge";
import { placementGamesOf } from "../shared/stats";
import { titleBandsOf } from "../shared/titles";
import type { MatchState, MatchView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireString } from "./http";
import { ANON_NAME_PATTERN, MAX_LINKS_PER_ACCOUNT } from "./members";
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

/**
 * 합치기 때 합칠 대상에 있던 본인 연결과 그 처리(participant_merges.moved_link, migrations/0023).
 * 열이 NULL이면 기록 없음(이전 합치기·복원한 합치기), {}이면 연결이 없었다.
 */
export interface MovedLink {
  accountId: string;
  /** 원래 연결 행의 created_at(옮겨도 바뀌지 않는다). */
  linkedAt: string;
  avoidSelfAt: string | null;
  /** moved = 남길 대상에게 옮김, removed = 남길 대상에 이미 연결이 있어 지움. */
  action: "moved" | "removed";
  /** 연결과 함께 남길 대상에게 옮긴 요청 ID(removed면 비어 있다). */
  requestIds: string[];
}

/**
 * 되돌리기 결과 중 본인 연결 부분(응답의 link). null = 합칠 대상에 연결이 없었음.
 * - returned: 원래 사람에게 돌려놓음(옮긴 연결을 되돌리거나 지운 연결을 다시 만듦).
 * - not_returned: 그 사이 연결이 끊기거나 다른 계정으로 바뀌어(또는 그 계정이 다른 이름과 연결돼) 돌려놓지 않음.
 *   남길 대상에 그 계정의 연결은 남아 있지 않다.
 * - cut: 그 계정이 아직 남길 대상의 본인인데 원래 사람에게 돌려놓을 수 없어 끊음.
 * - unknown: 기록이 없는 합치기(0023 전·복원)이고 남길 대상에 합치기 전부터 있던 연결이 있음. 운영자가 확인한다.
 * avoidChanged: 합쳐져 있는 동안 그 계정이 남길 대상의 기피 라인을 직접 바꿨음(운영자가 확인한다).
 */
export interface UndoLinkResult {
  outcome: "returned" | "not_returned" | "cut" | "unknown";
  avoidChanged: boolean;
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
    standings: mergeStandings(
      matches,
      sourceId,
      targetId,
      titleBandsOf(snapshot.group.settings),
      placementGamesOf(snapshot.group.settings),
    ),
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

interface LinkRow {
  participant_id: string;
  account_id: string;
  created_at: string;
  avoid_self_at: string | null;
}

/** 합칠 대상의 연결과, 합치면 그 연결을 어떻게 할지(남길 대상에 연결이 있는지)를 읽는다. */
async function loadMovedLink(
  env: Env,
  groupId: string,
  sourceId: string,
  targetId: string,
): Promise<{ moved: MovedLink | null; targetLinked: boolean }> {
  const rows = await env.DB.prepare(
    `SELECT participant_id, account_id, created_at, avoid_self_at FROM participant_links
     WHERE group_id = ?1 AND participant_id IN (?2, ?3)`,
  )
    .bind(groupId, sourceId, targetId)
    .all<LinkRow>();
  const source = rows.results.find((r) => r.participant_id === sourceId);
  const targetLinked = rows.results.some((r) => r.participant_id === targetId);
  if (!source) return { moved: null, targetLinked };
  let requestIds: string[] = [];
  if (!targetLinked) {
    const requests = await env.DB.prepare(
      "SELECT id FROM participant_requests WHERE group_id = ?1 AND participant_id = ?2 ORDER BY created_at, id",
    )
      .bind(groupId, sourceId)
      .all<{ id: string }>();
    requestIds = requests.results.map((r) => r.id);
  }
  return {
    moved: {
      accountId: source.account_id,
      linkedAt: source.created_at,
      avoidSelfAt: source.avoid_self_at,
      action: targetLinked ? "removed" : "moved",
      requestIds,
    },
    targetLinked,
  };
}

/** 합치기 때 연결을 옮기거나 지우는 문장들(moved_link에 남기는 처리와 같다). */
function linkMergeStatements(
  env: Env,
  groupId: string,
  sourceId: string,
  targetId: string,
  moved: MovedLink | null,
): D1PreparedStatement[] {
  if (!moved) return [];
  if (moved.action === "moved") {
    return [
      // 읽을 때 있던 요청만 옮긴다(그 뒤 들어온 요청은 합쳐진 쪽에 남아 운영자가 본다). 되돌릴 때 이 목록을 쓴다.
      env.DB.prepare(
        `UPDATE participant_requests SET participant_id = ?3
         WHERE group_id = ?1 AND participant_id = ?2 AND id IN (SELECT value FROM json_each(?4))`,
      ).bind(groupId, sourceId, targetId, JSON.stringify(moved.requestIds)),
      env.DB.prepare(
        `UPDATE participant_links SET participant_id = ?3
         WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?4`,
      ).bind(groupId, sourceId, targetId, moved.accountId),
    ];
  }
  return [
    // 연결이 없어지므로 그 계정의 본인 확인 신청 표시도 지운다(연결 끊기와 같다).
    env.DB.prepare("UPDATE join_requests SET account_id = NULL WHERE group_id = ?1 AND account_id = ?2").bind(
      groupId,
      moved.accountId,
    ),
    env.DB.prepare("DELETE FROM participant_links WHERE group_id = ?1 AND participant_id = ?2").bind(groupId, sourceId),
  ];
}

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
      const link = await loadMovedLink(env, groupId, sourceId, targetId);
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
        // 무엇을 했는지 합치기 기록(moved_link)에 남겨 되돌릴 때 돌려놓는다(undoMerge).
        // 읽은 뒤 연결이 바뀌었으면(그 사이 수락·끊기) 기록과 실제가 어긋나므로 막는다.
        stateGuard(
          env,
          `(SELECT account_id FROM participant_links WHERE group_id = ?1 AND participant_id = ?2) IS NOT ?3
           OR EXISTS (SELECT 1 FROM participant_links WHERE group_id = ?1 AND participant_id = ?4) <> ?5`,
          groupId,
          sourceId,
          link.moved?.accountId ?? null,
          targetId,
          link.targetLinked ? 1 : 0,
        ),
        ...linkMergeStatements(env, groupId, sourceId, targetId, link.moved),
        env.DB.prepare("DELETE FROM participant_claims WHERE group_id = ?1 AND participant_id = ?2").bind(
          groupId,
          sourceId,
        ),
        env.DB.prepare(
          `INSERT INTO participant_merges (id, group_id, source_id, target_id, source_prev_status,
             moved_matches, rotation_changes, created_at, moved_link)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        ).bind(
          mergeId,
          groupId,
          sourceId,
          targetId,
          ctx.source.status,
          movedIds,
          JSON.stringify(ctx.rotation),
          now,
          JSON.stringify(link.moved ?? {}),
        ),
      );
      if (ctx.rotation.length > 0) statements.push(bumpLiveVersion(env, groupId));
      return { stored: { mergeId, matchCount: ctx.moved.length }, statements };
    },
  });
  return { mergeId: stored.mergeId as string, matchCount: stored.matchCount as number };
}

/**
 * 되돌릴 때 본인 연결을 어떻게 할지 정한다(읽기만 하고 문장을 돌려준다). 원칙: 되돌리기는 "같은 사람이 아니었다"이므로
 * 합칠 대상의 계정이 남길 대상의 "본인"으로 남지 않게 하는 것이 먼저이고, 애매하면 연결하지 않는 쪽을 고른다.
 *
 * moved(남길 대상에게 옮겼던 연결):
 * - 그 계정이 지금도 남길 대상의 본인이면 원래 사람에게 돌려놓는다(avoid_self_at도 합치기 전 값으로).
 *   원래 사람에게 이미 다른 연결이 있으면(보통 생길 수 없다) 돌려놓을 수 없으므로 끊는다(cut).
 * - 그 사이 끊겼거나 남길 대상이 다른 계정과 연결됐으면 손대지 않는다(not_returned). 누군가 일부러 끊었거나
 *   새로 연결한 것이므로 원래 사람에게 다시 만들지 않는다. 운영자가 필요하면 연결 링크를 새로 보낸다.
 * - 요청: 합칠 때 옮긴 요청은 원래 사람이 쓴 것이고 정정 요청은 원래 사람의 경기를 가리키므로 연결 결과와 관계없이
 *   원래 사람에게 돌려놓는다. 합쳐져 있는 동안 남길 대상 이름으로 들어온 요청은 연결이 합칠 때 그대로(같은 계정·같은
 *   연결 시각)일 때만 그 계정이 쓴 것이 확실하므로 함께 돌려놓는다. 아니면 누가 썼는지 알 수 없어 남길 대상에 둔다.
 * - 본인 확인 참가 신청: 그 계정이 남길 대상 이름으로 낸 신청은 본인 확인 표시를 지운다(남길 대상의 본인이 아니므로).
 * - 그 계정이 합쳐져 있는 동안 남길 대상의 기피 라인을 직접 바꿨으면 avoidChanged로 알린다. 합치기 전 값을
 *   기록하지 않았고 그 사이 운영자가 고쳤을 수도 있어 자동으로 되돌리지 않는다.
 * removed(남길 대상에 연결이 있어 지웠던 연결): 원래 사람에게 연결이 없고, 그 계정이 이 모임에서 다른 이름과 연결되지
 * 않았고, 계정이 남아 있고, 연결 수 한도 안이고, 원래 사람이 익명 처리되지 않았을 때만 다시 만든다. 지운 신청 표시는
 * 되살리지 않는다(익명 신청으로 남는 것은 권한이 줄어드는 쪽이라 안전하다).
 * 기록이 없는 합치기(NULL): 연결을 건드리지 않는다. 남길 대상에 합치기 전부터 있던 연결이 있으면 그것이 옮겨 온
 * 연결일 수 있으므로 unknown으로 알려 운영자가 확인하게 한다.
 */
async function undoLinkPlan(
  env: Env,
  groupId: string,
  merge: { source_id: string; target_id: string; created_at: string; moved_link: string | null },
  sourceName: string,
): Promise<{ link: UndoLinkResult | null; statements: D1PreparedStatement[] }> {
  const sourceId = merge.source_id;
  const targetId = merge.target_id;
  const recorded = merge.moved_link === null ? null : (JSON.parse(merge.moved_link) as Partial<MovedLink>);
  const accountId = recorded?.accountId ?? null;
  const rows = await env.DB.prepare(
    `SELECT participant_id, account_id, created_at, avoid_self_at FROM participant_links
     WHERE group_id = ?1 AND (participant_id IN (?2, ?3) OR account_id = ?4)`,
  )
    .bind(groupId, sourceId, targetId, accountId)
    .all<LinkRow>();
  const targetLink = rows.results.find((r) => r.participant_id === targetId) ?? null;
  const sourceLink = rows.results.find((r) => r.participant_id === sourceId) ?? null;

  if (recorded === null) {
    const old = targetLink !== null && targetLink.created_at <= merge.created_at;
    return { link: old ? { outcome: "unknown", avoidChanged: false } : null, statements: [] };
  }
  if (!recorded.accountId || !recorded.action || !recorded.linkedAt) return { link: null, statements: [] };
  const moved = recorded as MovedLink;
  const accountLink = rows.results.find((r) => r.account_id === moved.accountId) ?? null;
  // 읽은 뒤 연결이 바뀌었으면(그 사이 수락·끊기) 판단이 어긋나므로 막는다(409, 다시 시도하면 새로 판단한다).
  const statements: D1PreparedStatement[] = [
    stateGuard(
      env,
      `(SELECT account_id FROM participant_links WHERE group_id = ?1 AND participant_id = ?2) IS NOT ?3
       OR (SELECT account_id FROM participant_links WHERE group_id = ?1 AND participant_id = ?4) IS NOT ?5
       OR (SELECT participant_id FROM participant_links WHERE group_id = ?1 AND account_id = ?6) IS NOT ?7`,
      groupId,
      targetId,
      targetLink?.account_id ?? null,
      sourceId,
      sourceLink?.account_id ?? null,
      moved.accountId,
      accountLink?.participant_id ?? null,
    ),
  ];

  if (moved.action === "moved") {
    statements.push(
      env.DB.prepare(
        `UPDATE participant_requests SET participant_id = ?3
         WHERE group_id = ?1 AND participant_id = ?2 AND id IN (SELECT value FROM json_each(?4))`,
      ).bind(groupId, targetId, sourceId, JSON.stringify(moved.requestIds ?? [])),
    );
    if (accountLink?.participant_id !== targetId) {
      return { link: { outcome: "not_returned", avoidChanged: false }, statements };
    }
    // avoid_self_at은 멤버가 기피 라인을 정할 때만 새 시각이 되고 운영자가 고치면 NULL이 된다. 합칠 때 값과 다르고
    // NULL이 아니면 마지막으로 남길 대상의 기피 라인을 정한 것이 이 계정이다.
    const avoidChanged = accountLink.avoid_self_at !== null && accountLink.avoid_self_at !== moved.avoidSelfAt;
    if (sourceLink !== null) {
      statements.push(
        env.DB.prepare(
          "DELETE FROM participant_links WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?3",
        ).bind(groupId, targetId, moved.accountId),
        env.DB.prepare("UPDATE join_requests SET account_id = NULL WHERE group_id = ?1 AND account_id = ?2").bind(
          groupId,
          moved.accountId,
        ),
      );
      return { link: { outcome: "cut", avoidChanged }, statements };
    }
    if (accountLink.created_at === moved.linkedAt) {
      statements.push(
        env.DB.prepare(
          `UPDATE participant_requests SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2 AND created_at >= ?4`,
        ).bind(groupId, targetId, sourceId, merge.created_at),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE participant_links SET participant_id = ?3, avoid_self_at = ?5
         WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?4`,
      ).bind(groupId, targetId, sourceId, moved.accountId, moved.avoidSelfAt ?? null),
      env.DB.prepare(
        "UPDATE join_requests SET account_id = NULL WHERE group_id = ?1 AND account_id = ?2 AND participant_id = ?3",
      ).bind(groupId, moved.accountId, targetId),
    );
    return { link: { outcome: "returned", avoidChanged }, statements };
  }

  // removed: 지웠던 연결을 다시 만들 수 있는지 본다.
  const account = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM participant_links WHERE account_id = ?1) AS n,
            EXISTS (SELECT 1 FROM accounts WHERE id = ?1) AS ok`,
  )
    .bind(moved.accountId)
    .first<{ n: number; ok: number }>();
  const canRestore =
    sourceLink === null &&
    accountLink === null &&
    account?.ok === 1 &&
    account.n < MAX_LINKS_PER_ACCOUNT &&
    !ANON_NAME_PATTERN.test(sourceName);
  if (!canRestore) return { link: { outcome: "not_returned", avoidChanged: false }, statements };
  statements.push(
    env.DB.prepare(
      `INSERT INTO participant_links (group_id, participant_id, account_id, created_at, avoid_self_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?3)`,
    ).bind(groupId, sourceId, moved.accountId, moved.linkedAt, moved.avoidSelfAt ?? null),
  );
  return { link: { outcome: "returned", avoidChanged: false }, statements };
}

/**
 * 합치기 되돌리기. 합치기 기록에 남긴 행만 원래대로 돌린다.
 * - 옮겼던 경기 중 지금도 남길 대상이 명단에 있는 경기만 합칠 대상으로 돌린다
 *   (그 사이 참가자 정정으로 빠진 경기는 정정을 존중해 그대로 둔다).
 * - 합친 뒤 남길 대상이 새로 뛴 경기·새 차례 기록은 건드리지 않는다.
 * - 차례 기록의 종류는 합치기가 바꾼 값 그대로일 때만 되돌린다.
 * - 본인 연결·요청은 undoLinkPlan이 정하고, 무엇을 했는지 응답의 link로 알린다(화면이 안내한다).
 */
export async function undoMerge(
  env: Env,
  groupId: string,
  mergeId: string,
  body: Body,
): Promise<{ mergeId: string; matchCount: number; link: UndoLinkResult | null }> {
  assertOnlyKeys(body, ["requestId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "undo-merge",
    payload: { mergeId },
    build: async () => {
      const merge = await env.DB.prepare(
        `SELECT id, source_id, target_id, source_prev_status, moved_matches, rotation_changes, created_at, undone_at,
                moved_link
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
          created_at: string;
          undone_at: string | null;
          moved_link: string | null;
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
      const linkPlan = await undoLinkPlan(env, groupId, merge, source.name);
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
        // 본인 연결·요청(undoLinkPlan).
        ...linkPlan.statements,
        env.DB.prepare("UPDATE participant_merges SET undone_at = ?1 WHERE id = ?2").bind(now, mergeId),
      ];
      if (rotation.length > 0) statements.push(bumpLiveVersion(env, groupId));
      return {
        stored: {
          mergeId,
          matchCount: stillThere.results.length,
          skipped: moved.length - stillThere.results.length,
          link: linkPlan.link,
        },
        statements,
      };
    },
  });
  return {
    mergeId: stored.mergeId as string,
    matchCount: stored.matchCount as number,
    // 이 기능 전에 저장된 요청 기록(같은 요청 ID 재전송)에는 link가 없다.
    link: (stored.link as UndoLinkResult | null | undefined) ?? null,
  };
}
