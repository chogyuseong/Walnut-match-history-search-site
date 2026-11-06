import {
  DEFAULT_SETTINGS,
  type MatchState,
  type MatchSource,
  type MemberRequestKind,
  type MemberRequestStatus,
  type MemberRequestView,
  type MatchView,
  type ParticipantView,
  type Position,
  type RevisionView,
  type RotationView,
  type SeriesFormat,
  type SeriesView,
  type SessionView,
  type Settings,
  type Side,
  type Snapshot,
  type Team,
} from "../shared/types";
import { decodeAvoid } from "../shared/avoid";
import type { Env } from "./env";
import { loadAdjustmentsView } from "./supportCounts";
import { ApiError, nowIso } from "./http";

interface GroupRow {
  id: string;
  name: string;
  timezone: string;
  live_version: number;
  settings_version_id: string | null;
  view_token: string;
  next_match_no: number;
  generation: number;
  maintenance: number;
}

export async function loadGroup(env: Env, groupId: string): Promise<GroupRow> {
  const row = await env.DB.prepare(
    `SELECT id, name, timezone, live_version, settings_version_id, view_token, next_match_no,
       generation, maintenance
     FROM groups WHERE id = ?1`,
  )
    .bind(groupId)
    .first<GroupRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  return row;
}

/** 설정 버전의 전체 스냅샷을 읽는다. 저장된 적이 없으면 기본값이다. */
export async function loadSettings(env: Env, settingsVersionId: string | null): Promise<Settings> {
  if (!settingsVersionId) return { ...DEFAULT_SETTINGS };
  const row = await env.DB.prepare("SELECT payload FROM settings_versions WHERE id = ?1")
    .bind(settingsVersionId)
    .first<{ payload: string }>();
  if (!row) return { ...DEFAULT_SETTINGS };
  return JSON.parse(row.payload) as Settings;
}

export async function loadOpenSession(env: Env, groupId: string): Promise<SessionView | null> {
  const row = await env.DB.prepare(
    `SELECT id, started_at, last_activity_at FROM sessions
     WHERE group_id = ?1 AND closed_at IS NULL`,
  )
    .bind(groupId)
    .first<{ id: string; started_at: string; last_activity_at: string }>();
  if (!row) return null;
  return { id: row.id, startedAt: row.started_at, lastActivityAt: row.last_activity_at };
}

export async function loadActiveRotation(
  env: Env,
  sessionId: string,
): Promise<RotationView | null> {
  const cycle = await env.DB.prepare(
    "SELECT id FROM rotation_cycles WHERE session_id = ?1 AND status = 'active'",
  )
    .bind(sessionId)
    .first<{ id: string }>();
  if (!cycle) return null;
  const events = await env.DB.prepare(
    `SELECT match_id, participant_id, kind FROM rotation_events
     WHERE cycle_id = ?1 AND voided = 0 ORDER BY created_at, id`,
  )
    .bind(cycle.id)
    .all<{ match_id: string; participant_id: string; kind: "used" | "repeat" }>();
  return {
    cycleId: cycle.id,
    events: events.results.map((e) => ({
      matchId: e.match_id,
      participantId: e.participant_id,
      kind: e.kind,
    })),
  };
}

interface MatchRow {
  id: string;
  match_no: number;
  session_id: string | null;
  state: MatchState;
  source: MatchSource;
  started_at: string | null;
  ended_at: string | null;
  played_at: string;
  confirmed_at: string | null;
  winner_team: Team | null;
  team_a_side: Side | null;
  version: number;
  memo: string | null;
}

const MATCH_COLUMNS = `id, match_no, session_id, state, source, started_at, ended_at, played_at,
  confirmed_at, winner_team, team_a_side, version, memo`;

function toMatchView(row: MatchRow): MatchView {
  const view: MatchView = {
    id: row.id,
    matchNo: row.match_no,
    sessionId: row.session_id,
    state: row.state,
    source: row.source,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    playedAt: row.played_at,
    confirmedAt: row.confirmed_at,
    winnerTeam: row.winner_team,
    teamASide: row.team_a_side,
    version: row.version,
    roster: [],
  };
  // 메모는 있을 때만 넣는다(없는 경기의 응답 모양은 예전과 같다). 공개 정보라 조회 응답에도 나간다.
  if (row.memo !== null) view.memo = row.memo;
  return view;
}

/** 경기 하나를 명단과 함께 읽는다. 다른 모임의 경기는 찾지 못한다. */
export async function loadMatch(env: Env, groupId: string, matchId: string): Promise<MatchView> {
  const row = await env.DB.prepare(
    `SELECT ${MATCH_COLUMNS} FROM matches WHERE id = ?1 AND group_id = ?2`,
  )
    .bind(matchId, groupId)
    .first<MatchRow>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "경기를 찾을 수 없습니다.");
  const view = toMatchView(row);
  const roster = await env.DB.prepare(
    "SELECT participant_id, team, position FROM match_roster WHERE match_id = ?1 AND group_id = ?2",
  )
    .bind(matchId, groupId)
    .all<{ participant_id: string; team: Team; position: Position | null }>();
  view.roster = roster.results.map((r) => ({
    participantId: r.participant_id,
    team: r.team,
    position: r.position,
  }));
  return view;
}

/**
 * 모임의 현재 상태 전체를 만든다.
 * 조회 응답·명단 텍스트·조회자용 내보내기는 모두 이 함수의 "viewer" 결과에서 나온다.
 * 비공개 모임에서 viewer 결과에는 실력 그룹·가중치·조회 토큰이 들어가지 않는다.
 */
export async function buildSnapshot(
  env: Env,
  groupId: string,
  role: "operator" | "viewer",
): Promise<Snapshot> {
  const group = await loadGroup(env, groupId);
  const settings = await loadSettings(env, group.settings_version_id);
  const includePrivate = role === "operator";
  const includeGroups = includePrivate || settings.groupsPublic;

  // 합쳐진 사람에게는 남은 사람의 ID를 붙인다(되돌리지 않은 합치기만). 공개 정보다: 이름과 같은 수준.
  const participantRows = await env.DB.prepare(
    `SELECT p.id, p.name, p.status, p.skill_group, p.avoid_positions, m.target_id AS merged_into
     FROM participants p
     LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
     WHERE p.group_id = ?1 ORDER BY p.created_at, p.id`,
  )
    .bind(groupId)
    .all<{
      id: string;
      name: string;
      status: "active" | "archived";
      skill_group: number | null;
      avoid_positions: string | null;
      merged_into: string | null;
    }>();
  const participants: ParticipantView[] = participantRows.results.map((p) => {
    const view: ParticipantView = { id: p.id, name: p.name, status: p.status };
    if (includeGroups) view.skillGroup = p.skill_group;
    // 기피 라인은 운영자에게만(티어 공개 설정과 무관). 없으면 필드를 넣지 않는다.
    if (includePrivate) {
      const avoid = decodeAvoid(p.avoid_positions);
      if (avoid.length > 0) view.avoidPositions = avoid;
    }
    if (p.merged_into) view.mergedInto = p.merged_into;
    return view;
  });

  const session = await loadOpenSession(env, groupId);
  let rotation = session ? await loadActiveRotation(env, session.id) : null;
  // 서포터 횟수 직접 입력의 보정값은 운영자에게만 준다(조회 응답에 새 정보를 늘리지 않는다).
  if (includePrivate) {
    const adjustments = await loadAdjustmentsView(env, groupId, rotation?.cycleId ?? null, participants);
    if (adjustments.length > 0) rotation = { ...(rotation ?? { cycleId: null, events: [] }), adjustments };
  }

  const matchRows = await env.DB.prepare(
    `SELECT ${MATCH_COLUMNS} FROM matches WHERE group_id = ?1 ORDER BY played_at, match_no`,
  )
    .bind(groupId)
    .all<MatchRow>();
  const byId = new Map<string, MatchView>();
  const matches = matchRows.results.map((row) => {
    const view = toMatchView(row);
    byId.set(view.id, view);
    return view;
  });
  const rosterRows = await env.DB.prepare(
    "SELECT match_id, participant_id, team, position FROM match_roster WHERE group_id = ?1",
  )
    .bind(groupId)
    .all<{ match_id: string; participant_id: string; team: Team; position: Position | null }>();
  for (const r of rosterRows.results) {
    byId.get(r.match_id)?.roster.push({
      participantId: r.participant_id,
      team: r.team,
      position: r.position,
    });
  }

  const revisions = await loadRevisions(env, groupId);

  const seasonRows = await env.DB.prepare(
    "SELECT id, name, starts_on, ends_on FROM seasons WHERE group_id = ?1 ORDER BY starts_on",
  )
    .bind(groupId)
    .all<{ id: string; name: string; starts_on: string; ends_on: string }>();

  const series = await loadSeries(env, groupId);

  const snapshot: Snapshot = {
    role,
    serverTime: nowIso(),
    group: {
      id: group.id,
      name: group.name,
      timezone: group.timezone,
      liveVersion: group.live_version,
      settings: includePrivate ? settings : viewerSettings(settings),
      // 점검 여부는 조회 화면에도 알린다(복원·삭제 진행 중 안내). 값 하나뿐이라 새는 정보가 없다.
      maintenance: group.maintenance === 1,
    },
    participants,
    session,
    rotation,
    matches,
    revisions,
    seasons: seasonRows.results.map((s) => ({
      id: s.id,
      name: s.name,
      startsOn: s.starts_on,
      endsOn: s.ends_on,
    })),
    // 시리즈 묶음은 공개 정보다(이름·형식·속한 경기). 조회 응답에도 나간다.
    series,
  };
  if (includePrivate) {
    snapshot.group.settingsVersionId = group.settings_version_id ?? undefined;
    snapshot.group.viewToken = group.view_token;
    snapshot.group.generation = group.generation;
    const batches = await env.DB.prepare(
      `SELECT import_batch_id AS id, COUNT(*) AS count,
         SUM(CASE WHEN state = 'excluded' THEN 1 ELSE 0 END) AS excluded,
         MIN(confirmed_at) AS imported_at
       FROM matches WHERE group_id = ?1 AND import_batch_id IS NOT NULL
       GROUP BY import_batch_id ORDER BY imported_at DESC`,
    )
      .bind(groupId)
      .all<{ id: string; count: number; excluded: number; imported_at: string }>();
    // 묶음의 출처(붙여 넣기 / 구글 시트, migrations/0007). 출처를 남기기 전에 넣은 묶음은 출처가 없다.
    // 출처 열쇠(시트 문서 ID·기존 사이트 배포 ID)는 내보내지 않는다. 종류와 이름만.
    const sources = new Map<string, { kind: "paste" | "sheet" | "legacy"; label: string | null }>();
    if (batches.results.length > 0) {
      try {
        const rows = await env.DB.prepare("SELECT id, kind, label FROM import_batches WHERE group_id = ?1")
          .bind(groupId)
          .all<{ id: string; kind: "paste" | "sheet" | "legacy"; label: string | null }>();
        for (const r of rows.results) sources.set(r.id, { kind: r.kind, label: r.label });
      } catch (error) {
        // 0007 마이그레이션 전의 DB(마이그레이션 전에 띄운 로컬 서버)에서도 스냅숏은 내려가게 한다. 출처만 빠진다.
        if (!String(error).includes("no such table")) throw error;
      }
    }
    snapshot.importBatches = batches.results.map((b) => ({
      id: b.id,
      count: b.count,
      excluded: b.excluded,
      importedAt: b.imported_at,
      ...sources.get(b.id),
    }));
    const merges = await env.DB.prepare(
      `SELECT id, source_id, target_id, json_array_length(moved_matches) AS match_count, created_at, undone_at
       FROM participant_merges WHERE group_id = ?1 ORDER BY created_at DESC, id LIMIT 50`,
    )
      .bind(groupId)
      .all<{
        id: string;
        source_id: string;
        target_id: string;
        match_count: number;
        created_at: string;
        undone_at: string | null;
      }>();
    snapshot.merges = merges.results.map((m) => ({
      id: m.id,
      sourceId: m.source_id,
      targetId: m.target_id,
      matchCount: m.match_count,
      createdAt: m.created_at,
      undoneAt: m.undone_at,
    }));
    // 참가자 본인 연결·연결 링크·참가자 요청(migrations/0019). 계정 ID·토큰은 넣지 않는다.
    const [links, claims] = await env.DB.batch([
      env.DB.prepare(
        "SELECT participant_id, created_at, avoid_self_at FROM participant_links WHERE group_id = ?1 ORDER BY created_at",
      ).bind(groupId),
      env.DB.prepare(
        `SELECT participant_id, MAX(expires_at) AS expires_at FROM participant_claims
         WHERE group_id = ?1 AND used_at IS NULL AND expires_at > ?2 GROUP BY participant_id`,
      ).bind(groupId, nowIso()),
    ]);
    snapshot.memberLinks = (
      links!.results as unknown as { participant_id: string; created_at: string; avoid_self_at: string | null }[]
    ).map((l) => ({ participantId: l.participant_id, linkedAt: l.created_at, avoidBySelf: l.avoid_self_at !== null }));
    snapshot.memberClaims = (claims!.results as unknown as { participant_id: string; expires_at: string }[]).map((c) => ({
      participantId: c.participant_id,
      expiresAt: c.expires_at,
    }));
    snapshot.memberRequests = await loadMemberRequests(env, groupId, null);
  }
  return snapshot;
}

/** 운영자 화면에 싣는 처리한 요청 수(열린 요청은 모두 싣는다). */
const RECENT_RESOLVED_REQUESTS = 30;

interface RequestRow {
  id: string;
  participant_id: string;
  kind: MemberRequestKind;
  match_id: string | null;
  body: string;
  status: MemberRequestStatus;
  reply: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toRequestView(r: RequestRow): MemberRequestView {
  return {
    id: r.id,
    participantId: r.participant_id,
    kind: r.kind,
    matchId: r.match_id,
    text: r.body,
    status: r.status,
    reply: r.reply,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

/**
 * 참가자 요청 목록(최근 것부터). participantId가 있으면 그 사람 것만(멤버 본인 응답), 없으면 모임 전체(운영자 응답:
 * 열린 요청 전부 + 처리한 요청 최근 RECENT_RESOLVED_REQUESTS개).
 */
export async function loadMemberRequests(
  env: Env,
  groupId: string,
  participantId: string | null,
): Promise<MemberRequestView[]> {
  const columns = "id, participant_id, kind, match_id, body, status, reply, created_at, resolved_at";
  if (participantId !== null) {
    const rows = await env.DB.prepare(
      `SELECT ${columns} FROM participant_requests WHERE group_id = ?1 AND participant_id = ?2
       ORDER BY created_at DESC, id LIMIT ?3`,
    )
      .bind(groupId, participantId, RECENT_RESOLVED_REQUESTS)
      .all<RequestRow>();
    return rows.results.map(toRequestView);
  }
  const [open, resolved] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${columns} FROM participant_requests WHERE group_id = ?1 AND status = 'open' ORDER BY created_at DESC, id`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT ${columns} FROM participant_requests WHERE group_id = ?1 AND status <> 'open'
       ORDER BY resolved_at DESC, id LIMIT ?2`,
    ).bind(groupId, RECENT_RESOLVED_REQUESTS),
  ]);
  return [...(open!.results as unknown as RequestRow[]), ...(resolved!.results as unknown as RequestRow[])].map(
    toRequestView,
  );
}

/** 시리즈 묶음과 속한 경기(경기 시각 → 경기 번호 순). */
export async function loadSeries(env: Env, groupId: string): Promise<SeriesView[]> {
  const [rows, members] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, name, format, created_at FROM match_series WHERE group_id = ?1 ORDER BY created_at, id",
    ).bind(groupId),
    env.DB.prepare(
      `SELECT s.series_id, s.match_id FROM match_series_members s
       JOIN matches m ON m.id = s.match_id AND m.group_id = s.group_id
       WHERE s.group_id = ?1 ORDER BY m.played_at, m.match_no`,
    ).bind(groupId),
  ]);
  const byId = new Map<string, SeriesView>();
  for (const r of rows!.results as unknown as { id: string; name: string | null; format: SeriesFormat; created_at: string }[]) {
    byId.set(r.id, { id: r.id, name: r.name, format: r.format, createdAt: r.created_at, matchIds: [] });
  }
  for (const m of members!.results as unknown as { series_id: string; match_id: string }[]) {
    byId.get(m.series_id)?.matchIds.push(m.match_id);
  }
  return [...byId.values()];
}

/** 스냅숏에 싣는 변경 이력 수. 모임당 수천 경기여도 응답 크기가 일정하도록 상한을 둔다. */
const RECENT_REVISIONS = 200;
/** "변경 내역"(정정·제외·복구)은 경기 시작·결과 이력에 밀려나지 않게 따로 이만큼 싣는다. */
const RECENT_CHANGES = 200;
/** 묶어서 싣는 합치기 이력(합치기·되돌리기 한 번이 한 줄). */
const RECENT_MERGES = 50;

/**
 * 합치기·되돌리기가 남긴 정정 이력인지 가리는 식. 합치기는 옮긴 경기마다 참가자 정정 한 줄을
 * 합치기 기록과 같은 시각으로 남긴다(src/server/merge.ts). 원본 행은 그대로 두고 읽을 때만 가린다.
 * 결과: 합치기 기록 ID와 방향("merge" 또는 "undo"). 합치기 이력이 아니면 NULL.
 */
const MERGE_REF = `(SELECT pm.id || CASE WHEN pm.created_at = r.created_at THEN ':merge' ELSE ':undo' END
   FROM participant_merges pm
   WHERE pm.group_id = r.group_id AND r.kind = 'correction'
     AND (SELECT COUNT(*) FROM json_each(r.changes)) = 1
     AND ((pm.created_at = r.created_at
           AND json_extract(r.changes, '$.participant.from') = pm.source_id
           AND json_extract(r.changes, '$.participant.to') = pm.target_id)
       OR (pm.undone_at = r.created_at
           AND json_extract(r.changes, '$.participant.from') = pm.target_id
           AND json_extract(r.changes, '$.participant.to') = pm.source_id))
   LIMIT 1)`;

interface RevisionRow {
  id: number;
  match_id: string;
  match_no: number;
  kind: string;
  changes: string;
  created_at: string;
}

/**
 * 스냅숏의 변경 이력.
 * - 최근 이력(종류 무관) RECENT_REVISIONS줄 + 정정·제외·복구 RECENT_CHANGES줄. 합치기가 만든 정정 줄은 빼고 센다.
 * - 합치기·되돌리기는 경기 수만큼 늘어나므로 한 번에 한 줄(kind "merge" / "merge_undo")로 묶어 싣는다.
 *   그래서 많이 뛴 사람을 합쳐도 실제 정정이 상한에 밀려 사라지지 않는다.
 * 합친 사람·남은 사람의 ID는 참가자 목록의 mergedInto와 같은 공개 정보다.
 */
async function loadRevisions(env: Env, groupId: string): Promise<RevisionView[]> {
  const select = `SELECT r.id, r.match_id, m.match_no, r.kind, r.changes, r.created_at
     FROM match_revisions r JOIN matches m ON m.id = r.match_id AND m.group_id = r.group_id`;
  const [recent, changes, merges] = await env.DB.batch([
    env.DB.prepare(
      `${select} WHERE r.group_id = ?1 AND ${MERGE_REF} IS NULL ORDER BY r.id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_REVISIONS),
    env.DB.prepare(
      `${select} WHERE r.group_id = ?1 AND r.kind IN ('correction', 'exclude', 'restore')
         AND ${MERGE_REF} IS NULL ORDER BY r.id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_CHANGES),
    env.DB.prepare(
      `SELECT ref, MAX(id) AS id, COUNT(*) AS match_count, MAX(created_at) AS created_at,
         MAX(json_extract(changes, '$.participant.from')) AS from_id,
         MAX(json_extract(changes, '$.participant.to')) AS to_id
       FROM (SELECT r.id, r.changes, r.created_at, ${MERGE_REF} AS ref
             FROM match_revisions r WHERE r.group_id = ?1 AND r.kind = 'correction')
       WHERE ref IS NOT NULL GROUP BY ref ORDER BY id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_MERGES),
  ]);
  const byId = new Map<number, RevisionView>();
  for (const r of [...(recent!.results as unknown as RevisionRow[]), ...(changes!.results as unknown as RevisionRow[])]) {
    byId.set(r.id, {
      id: r.id,
      matchId: r.match_id,
      matchNo: r.match_no,
      kind: r.kind,
      changes: JSON.parse(r.changes) as RevisionView["changes"],
      createdAt: r.created_at,
    });
  }
  for (const g of merges!.results as unknown as {
    ref: string;
    id: number;
    match_count: number;
    created_at: string;
    from_id: string;
    to_id: string;
  }[]) {
    const undo = g.ref.endsWith(":undo");
    byId.set(g.id, {
      id: g.id,
      matchId: "",
      matchNo: 0,
      kind: undo ? "merge_undo" : "merge",
      changes: {},
      createdAt: g.created_at,
      merge: {
        // 되돌리기 줄은 남았던 사람 → 합쳐졌던 사람 방향으로 저장돼 있다. 화면에는 합치기 기준으로 보낸다.
        sourceId: undo ? g.to_id : g.from_id,
        targetId: undo ? g.from_id : g.to_id,
        matchCount: g.match_count,
      },
    });
  }
  return [...byId.values()].sort((x, y) => y.id - x.id);
}

/**
 * 조회 응답에 넣는 설정. 허용 목록 방식: 여기 적은 값만 나간다(docs/P2 P2-9, P2-10).
 * - 실력 그룹 가중치는 비공개 평가의 일부라 공개 모임에서만 내보낸다.
 * - 칭호 구간은 공개 정보다(검색·랭킹·개인 화면이 같은 칭호를 보여준다). 저장한 적이 없으면 넣지 않는다
 *   (화면이 기본 구간을 쓴다). 빈 배열로 저장했으면 빈 배열을 그대로 보낸다.
 * - 팀 추천 다양성 같은 운영 설정은 내보내지 않는다.
 */
function viewerSettings(settings: Settings): Settings {
  const view: Settings = {
    rotationEnabled: settings.rotationEnabled,
    groupsPublic: settings.groupsPublic,
    groupWeights: settings.groupsPublic ? settings.groupWeights : [0, 0, 0, 0],
  };
  if (settings.titleBands !== undefined) view.titleBands = settings.titleBands;
  return view;
}
