import {
  DEFAULT_SETTINGS,
  type MatchState,
  type MatchSource,
  type MatchView,
  type ParticipantView,
  type Position,
  type RevisionView,
  type RotationView,
  type SessionView,
  type Settings,
  type Side,
  type Snapshot,
  type Team,
} from "../shared/types";
import type { Env } from "./env";
import { ApiError, nowIso } from "./http";

interface GroupRow {
  id: string;
  name: string;
  timezone: string;
  live_version: number;
  settings_version_id: string | null;
  view_token: string;
  next_match_no: number;
}

export async function loadGroup(env: Env, groupId: string): Promise<GroupRow> {
  const row = await env.DB.prepare(
    `SELECT id, name, timezone, live_version, settings_version_id, view_token, next_match_no
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
}

const MATCH_COLUMNS = `id, match_no, session_id, state, source, started_at, ended_at, played_at,
  confirmed_at, winner_team, team_a_side, version`;

function toMatchView(row: MatchRow): MatchView {
  return {
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

  const participantRows = await env.DB.prepare(
    "SELECT id, name, status, skill_group FROM participants WHERE group_id = ?1 ORDER BY created_at, id",
  )
    .bind(groupId)
    .all<{ id: string; name: string; status: "active" | "archived"; skill_group: number | null }>();
  const participants: ParticipantView[] = participantRows.results.map((p) => {
    const view: ParticipantView = { id: p.id, name: p.name, status: p.status };
    if (includeGroups) view.skillGroup = p.skill_group;
    return view;
  });

  const session = await loadOpenSession(env, groupId);
  const rotation = session ? await loadActiveRotation(env, session.id) : null;

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

  const revisionRows = await env.DB.prepare(
    `SELECT r.id, r.match_id, m.match_no, r.kind, r.changes, r.created_at
     FROM match_revisions r JOIN matches m ON m.id = r.match_id
     WHERE r.group_id = ?1 ORDER BY r.id DESC LIMIT 200`,
  )
    .bind(groupId)
    .all<{
      id: number;
      match_id: string;
      match_no: number;
      kind: string;
      changes: string;
      created_at: string;
    }>();
  const revisions: RevisionView[] = revisionRows.results.map((r) => ({
    id: r.id,
    matchId: r.match_id,
    matchNo: r.match_no,
    kind: r.kind,
    changes: JSON.parse(r.changes) as RevisionView["changes"],
    createdAt: r.created_at,
  }));

  const seasonRows = await env.DB.prepare(
    "SELECT id, name, starts_on, ends_on FROM seasons WHERE group_id = ?1 ORDER BY starts_on",
  )
    .bind(groupId)
    .all<{ id: string; name: string; starts_on: string; ends_on: string }>();

  const snapshot: Snapshot = {
    role,
    serverTime: nowIso(),
    group: {
      id: group.id,
      name: group.name,
      timezone: group.timezone,
      liveVersion: group.live_version,
      settings: includePrivate
        ? settings
        : {
            rotationEnabled: settings.rotationEnabled,
            groupsPublic: settings.groupsPublic,
            // 가중치는 비공개 평가의 일부이므로 공개 모임에서만 내보낸다.
            groupWeights: settings.groupsPublic ? settings.groupWeights : [0, 0, 0, 0],
          },
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
  };
  if (includePrivate) {
    snapshot.group.settingsVersionId = group.settings_version_id ?? undefined;
    snapshot.group.viewToken = group.view_token;
    const batches = await env.DB.prepare(
      `SELECT import_batch_id AS id, COUNT(*) AS count,
         SUM(CASE WHEN state = 'excluded' THEN 1 ELSE 0 END) AS excluded,
         MIN(confirmed_at) AS imported_at
       FROM matches WHERE group_id = ?1 AND import_batch_id IS NOT NULL
       GROUP BY import_batch_id ORDER BY imported_at DESC`,
    )
      .bind(groupId)
      .all<{ id: string; count: number; excluded: number; imported_at: string }>();
    snapshot.importBatches = batches.results.map((b) => ({
      id: b.id,
      count: b.count,
      excluded: b.excluded,
      importedAt: b.imported_at,
    }));
  }
  return snapshot;
}
