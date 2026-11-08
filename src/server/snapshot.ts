import {
  DEFAULT_SETTINGS,
  upgradeGroupWeights,
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
import { foldAdjustments } from "./supportCounts";
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
  const settings = JSON.parse(row.payload) as Settings;
  // 티어 4단계 시절에 저장한 버전은 가중치가 4개다. 저장 행은 그대로 두고 읽을 때 5개로 맞춘다.
  return { ...settings, groupWeights: upgradeGroupWeights(settings.groupWeights) };
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
    "SELECT id, created_at FROM rotation_cycles WHERE session_id = ?1 AND status = 'active'",
  )
    .bind(sessionId)
    .first<{ id: string; created_at: string }>();
  if (!cycle) return null;
  const events = await env.DB.prepare(
    `SELECT match_id, participant_id, kind FROM rotation_events
     WHERE cycle_id = ?1 AND voided = 0 ORDER BY created_at, id`,
  )
    .bind(cycle.id)
    .all<{ match_id: string; participant_id: string; kind: "used" | "repeat" }>();
  return {
    cycleId: cycle.id,
    cycleStartedAt: cycle.created_at,
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
 * 여러 경기를 명단과 함께 한 번(batch 1회)에 읽는다. 다른 모임의 경기·없는 경기는 빠진다(순서는 정하지 않는다).
 * loadMatch를 경기마다 부르면 경기당 질의 2회라 무료 요금제 한도(호출당 50회)에 금방 닿는다(2026-11-08 정합성 점검).
 */
export async function loadMatchesByIds(env: Env, groupId: string, matchIds: readonly string[]): Promise<MatchView[]> {
  if (matchIds.length === 0) return [];
  const list = JSON.stringify(matchIds);
  const [rows, roster] = await env.DB.batch([
    env.DB.prepare(
      `SELECT ${MATCH_COLUMNS} FROM matches WHERE group_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
    ).bind(groupId, list),
    env.DB.prepare(
      `SELECT match_id, participant_id, team, position FROM match_roster
       WHERE group_id = ?1 AND match_id IN (SELECT value FROM json_each(?2))`,
    ).bind(groupId, list),
  ]);
  const views = new Map(
    (rows!.results as unknown as MatchRow[]).map((r) => [r.id, toMatchView(r)] as const),
  );
  for (const r of roster!.results as unknown as {
    match_id: string;
    participant_id: string;
    team: Team;
    position: Position | null;
  }[]) {
    views.get(r.match_id)?.roster.push({ participantId: r.participant_id, team: r.team, position: r.position });
  }
  return [...views.values()];
}

/* ------------------------------------------------------------------ */
/* ETag(조건부 요청)                                                     */
/* ------------------------------------------------------------------ */

/** ETag 계산에 쓰는 모임 행의 값. 화면 자료가 바뀌면 data_version(트리거, migrations/0021)이 오른다. */
export interface EtagHead {
  id: string;
  name: string;
  timezone: string;
  live_version: number;
  settings_version_id: string | null;
  view_token: string;
  generation: number;
  maintenance: number;
  data_version: number;
  /**
   * 운영자만: 쓰지 않은 연결 링크 중 아직 만료되지 않은 것의 가장 이른 만료 시각(없으면 null).
   * 운영자 스냅숏의 memberClaims는 "지금 만료되지 않은 링크"만 싣기 때문에 시간이 지나기만 해도 내용이 바뀐다.
   * 링크 행이 바뀌면(만들기·쓰기·지우기) data_version이 오르고, 행이 그대로일 때 내용이 바뀌는 순간은 어떤 링크의
   * 만료 시각이 지나는 순간뿐이다. 그 순간에는 이 값(가장 이른 "아직 안 지난" 만료)도 반드시 다음 값으로 바뀌므로,
   * 이 값이 같으면 실린 링크 목록도 같다. 그냥 MIN(expires_at)을 쓰면 지난 만료가 계속 최솟값으로 남아 ETag가
   * 그대로인 채 목록만 달라지므로(만료된 링크가 304로 계속 보임) 만료가 지난 것은 뺀다.
   */
  claims_next_expiry?: string | null;
}

const ETAG_HEAD_COLUMNS =
  "id, name, timezone, live_version, settings_version_id, view_token, generation, maintenance, data_version";

/** 운영자 스냅숏의 ETag용 모임 행(1행 읽기 + 연결 링크 색인 몇 행). 없으면 null. */
export async function loadEtagHead(env: Env, groupId: string): Promise<EtagHead | null> {
  // 비교 기준 시각은 스냅숏의 memberClaims 질의(snapshotStatements)와 같은 nowIso() 꼴이다.
  return env.DB.prepare(
    `SELECT ${ETAG_HEAD_COLUMNS},
       (SELECT MIN(expires_at) FROM participant_claims
        WHERE group_id = ?1 AND used_at IS NULL AND expires_at > ?2) AS claims_next_expiry
     FROM groups WHERE id = ?1`,
  )
    .bind(groupId, nowIso())
    .first<EtagHead>();
}

/** 조회 토큰으로 모임 행을 찾는다(조회 링크 경로가 토큰 확인과 ETag 계산을 한 번에 한다). 없으면 null. */
export async function loadEtagHeadByViewToken(env: Env, token: string): Promise<EtagHead | null> {
  return env.DB.prepare(`SELECT ${ETAG_HEAD_COLUMNS} FROM groups WHERE view_token = ?1`).bind(token).first<EtagHead>();
}

/**
 * 스냅숏 응답 모양이 바뀌면 올린다. 배포 버전(CF_VERSION_METADATA)도 함께 넣으므로 보통은 올리지 않아도 되지만,
 * 버전 정보가 없는 환경(로컬)에서 응답 모양을 바꿨을 때를 위해 둔다.
 */
const ETAG_SHAPE = "s1";

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 스냅숏 ETag(약한 비교: 본문의 serverTime은 매번 다르지만 같은 자료로 본다).
 * 넣는 값: 역할, 모임 ID, 화면 자료 버전(data_version), 진행 상태 버전, 세대(복원), 설정 버전 ID, 점검 여부,
 * 이름·시간대·조회 토큰, 배포 버전. 운영자는 가장 이른 "아직 안 지난" 연결 링크 만료 시각도 넣는다
 * (EtagHead.claims_next_expiry. 2026-11-08 전에는 1분 단위 시각을 넣어 1분마다 304가 깨졌다).
 * 이 값들이 같으면 buildSnapshot의 결과(serverTime 말고)가 같다는 것이 이 설계의 약속이다:
 * 스냅숏에 새 표를 싣게 되면 그 표에도 data_version 트리거를 만들어야 한다(migrations/0021 머리말).
 * 시각에 따라 달라지는 값을 스냅숏에 새로 넣으면 그 "다음 바뀌는 시각"도 claims_next_expiry처럼 재료에 넣어야 한다.
 */
export async function snapshotEtag(env: Env, head: EtagHead, role: "operator" | "viewer"): Promise<string> {
  const parts: (string | number | null)[] = [
    ETAG_SHAPE,
    env.CF_VERSION_METADATA?.id ?? "",
    role,
    head.id,
    head.data_version,
    head.live_version,
    head.generation,
    head.settings_version_id,
    head.maintenance,
    head.name,
    head.timezone,
    head.view_token,
  ];
  if (role === "operator") parts.push(head.claims_next_expiry ?? null);
  return `W/"${await shortHash(JSON.stringify(parts))}"`;
}

/**
 * ETag 경로(GET 운영자 스냅숏·조회 링크, src/server/index.ts)가 200 본문을 만드는 단일 경계.
 * 순서: loadEtagHead(ByViewToken) → snapshotEtag → (If-None-Match가 맞으면 304) → 이 함수.
 *
 * 확장 자리(지금은 구현하지 않음): 나중에 gzip 본문을 ETag 열쇠로 D1 한 행에 캐시할 자리다.
 * 같은 ETag면 본문이 같다는 것이 snapshotEtag의 약속이므로, 여기서 (모임 ID, 역할) 행의 저장된 ETag가 같으면
 * 저장된 본문을 그대로 내보내고 다르면 buildSnapshot 후 갈아 끼운다. serverTime은 캐시 본문에서는 굳으므로 그때는
 * 응답 헤더 등 다른 곳으로 옮겨야 한다.
 * 도입 기준: 가장 큰 모임이 약 1000경기(서버 JS 시간이 무료 요금제 요청당 CPU 10ms에 닿는 지점.
 * 522경기에서 4~5ms 실측). 그 전에는 D1 쓰기만 늘어 이득이 없다.
 */
export async function snapshotBody(
  env: Env,
  groupId: string,
  role: "operator" | "viewer",
  _etag: string,
): Promise<Snapshot> {
  return buildSnapshot(env, groupId, role);
}

/** If-None-Match 헤더가 이 ETag와 맞는지(약한 비교, 여러 값·"*" 허용). */
export function etagMatches(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const want = bare(etag);
  return ifNoneMatch.split(",").some((t) => t.trim() === "*" || bare(t) === want);
}

/* ------------------------------------------------------------------ */
/* 스냅숏                                                               */
/* ------------------------------------------------------------------ */

interface ParticipantRow {
  id: string;
  name: string;
  status: "active" | "archived";
  skill_group: number | null;
  avoid_positions: string | null;
  merged_into: string | null;
  version: number;
}

/** batch 결과의 행 목록. */
function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as unknown as T[];
}

/**
 * 모임의 현재 상태 전체를 만든다.
 * 조회 응답·명단 텍스트·조회자용 내보내기는 모두 이 함수의 "viewer" 결과에서 나온다.
 * 비공개 모임에서 viewer 결과에는 실력 그룹·가중치·조회 토큰이 들어가지 않는다.
 *
 * 모든 읽기를 D1 batch 한 번(왕복 1회)으로 한다(2026-11-07). batch는 한 트랜잭션이라 모든 값이 같은 시점이다
 * (예전에는 10번 넘게 따로 읽어, 읽는 사이에 저장이 끼면 경기와 명단이 서로 다른 시점일 수 있었다).
 * 활성 순환 주기·보정값처럼 앞 결과에 기대는 값은 하위 질의로 같은 batch 안에서 찾는다.
 */
export async function buildSnapshot(
  env: Env,
  groupId: string,
  role: "operator" | "viewer",
): Promise<Snapshot> {
  return parseSnapshot(role, await env.DB.batch(snapshotStatements(env, groupId, role)));
}

/**
 * 스냅숏을 만드는 읽기 문장들(이 순서대로 parseSnapshot이 읽는다). 백업 내려받기(groups.ts exportBackup)는
 * 여기에 자기 읽기를 이어 붙여 batch 한 번(같은 시점)으로 읽는다.
 */
export function snapshotStatements(
  env: Env,
  groupId: string,
  role: "operator" | "viewer",
): D1PreparedStatement[] {
  const includePrivate = role === "operator";
  const db = env.DB;
  // 열린 내전의 활성 순환 주기(없으면 NULL). 열린 내전은 모임당 하나다(uq_sessions_open).
  const activeCycle = `(SELECT c.id FROM rotation_cycles c JOIN sessions s ON s.id = c.session_id
     WHERE s.group_id = ?1 AND s.closed_at IS NULL AND c.status = 'active' LIMIT 1)`;
  const common: D1PreparedStatement[] = [
    db
      .prepare(
        `SELECT id, name, timezone, live_version, settings_version_id, view_token, next_match_no, generation, maintenance
         FROM groups WHERE id = ?1`,
      )
      .bind(groupId),
    db
      .prepare(
        "SELECT payload FROM settings_versions WHERE id = (SELECT settings_version_id FROM groups WHERE id = ?1)",
      )
      .bind(groupId),
    // 합쳐진 사람에게는 남은 사람의 ID를 붙인다(되돌리지 않은 합치기만). 공개 정보다: 이름과 같은 수준.
    db
      .prepare(
        `SELECT p.id, p.name, p.status, p.skill_group, p.avoid_positions, p.version, m.target_id AS merged_into
         FROM participants p
         LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
         WHERE p.group_id = ?1 ORDER BY p.created_at, p.id`,
      )
      .bind(groupId),
    db
      .prepare("SELECT id, started_at, last_activity_at FROM sessions WHERE group_id = ?1 AND closed_at IS NULL")
      .bind(groupId),
    // 활성 주기의 id와 열린 시각(화면의 "언제부터 세는지").
    db
      .prepare(
        `SELECT c.id, c.created_at FROM rotation_cycles c JOIN sessions s ON s.id = c.session_id
         WHERE s.group_id = ?1 AND s.closed_at IS NULL AND c.status = 'active' LIMIT 1`,
      )
      .bind(groupId),
    db
      .prepare(
        `SELECT match_id, participant_id, kind FROM rotation_events
         WHERE cycle_id = ${activeCycle} AND voided = 0 ORDER BY created_at, id`,
      )
      .bind(groupId),
    db.prepare(`SELECT ${MATCH_COLUMNS} FROM matches WHERE group_id = ?1 ORDER BY played_at, match_no`).bind(groupId),
    db.prepare("SELECT match_id, participant_id, team, position FROM match_roster WHERE group_id = ?1").bind(groupId),
    ...revisionStatements(env, groupId),
    db
      .prepare("SELECT id, name, starts_on, ends_on FROM seasons WHERE group_id = ?1 ORDER BY starts_on")
      .bind(groupId),
    ...seriesStatements(env, groupId),
  ];
  const operatorOnly: D1PreparedStatement[] = includePrivate
    ? [
        // 서포터 횟수 보정값: 활성 주기의 것, 주기가 없으면 첫 경기 전에 받아 둔 것(cycle_id IS NULL).
        db
          .prepare(
            `SELECT participant_id, delta FROM support_adjustments WHERE group_id = ?1 AND cycle_id IS ${activeCycle}`,
          )
          .bind(groupId),
        db
          .prepare(
            `SELECT import_batch_id AS id, COUNT(*) AS count,
               SUM(CASE WHEN state = 'excluded' THEN 1 ELSE 0 END) AS excluded,
               MIN(confirmed_at) AS imported_at
             FROM matches WHERE group_id = ?1 AND import_batch_id IS NOT NULL
             GROUP BY import_batch_id ORDER BY imported_at DESC`,
          )
          .bind(groupId),
        db.prepare("SELECT id, kind, label FROM import_batches WHERE group_id = ?1").bind(groupId),
        db
          .prepare(
            `SELECT id, source_id, target_id, json_array_length(moved_matches) AS match_count, created_at, undone_at
             FROM participant_merges WHERE group_id = ?1 ORDER BY created_at DESC, id LIMIT 50`,
          )
          .bind(groupId),
        db
          .prepare(
            "SELECT participant_id, created_at, avoid_self_at FROM participant_links WHERE group_id = ?1 ORDER BY created_at",
          )
          .bind(groupId),
        db
          .prepare(
            `SELECT participant_id, MAX(expires_at) AS expires_at FROM participant_claims
             WHERE group_id = ?1 AND used_at IS NULL AND expires_at > ?2 GROUP BY participant_id`,
          )
          .bind(groupId, nowIso()),
        ...memberRequestStatements(env, groupId),
      ]
    : [];
  return [...common, ...operatorOnly];
}

/**
 * snapshotStatements의 batch 결과로 스냅숏을 만든다. results 뒤에 다른 결과가 더 붙어 있어도 된다(앞에서부터 읽는다).
 */
export function parseSnapshot(role: "operator" | "viewer", results: D1Result[]): Snapshot {
  const includePrivate = role === "operator";
  let i = 0;
  const next = () => results[i++];

  const group = rowsOf<GroupRow>(next())[0];
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  const settingsRow = rowsOf<{ payload: string }>(next())[0];
  const settings = settingsFromPayload(group.settings_version_id ? settingsRow?.payload : undefined);
  const includeGroups = includePrivate || settings.groupsPublic;

  const participants: ParticipantView[] = rowsOf<ParticipantRow>(next()).map((p) => {
    const view: ParticipantView = { id: p.id, name: p.name, status: p.status };
    if (includeGroups) view.skillGroup = p.skill_group;
    // 기피 라인은 운영자에게만(티어 공개 설정과 무관). 없으면 필드를 넣지 않는다.
    if (includePrivate) {
      const avoid = decodeAvoid(p.avoid_positions);
      if (avoid.length > 0) view.avoidPositions = avoid;
      // 참가자 수정의 동시 수정 확인에 쓰는 버전(migrations/0021). 운영자에게만.
      view.version = p.version;
    }
    if (p.merged_into) view.mergedInto = p.merged_into;
    return view;
  });

  const sessionRow = rowsOf<{ id: string; started_at: string; last_activity_at: string }>(next())[0];
  const session: SessionView | null = sessionRow
    ? { id: sessionRow.id, startedAt: sessionRow.started_at, lastActivityAt: sessionRow.last_activity_at }
    : null;
  const cycleRow = rowsOf<{ id: string; created_at: string }>(next())[0];
  const cycleId = cycleRow?.id ?? null;
  const eventRows = rowsOf<{ match_id: string; participant_id: string; kind: "used" | "repeat" }>(next());
  let rotation: RotationView | null = cycleRow
    ? {
        cycleId,
        cycleStartedAt: cycleRow.created_at,
        events: eventRows.map((e) => ({ matchId: e.match_id, participantId: e.participant_id, kind: e.kind })),
      }
    : null;

  const byId = new Map<string, MatchView>();
  const matches = rowsOf<MatchRow>(next()).map((row) => {
    const view = toMatchView(row);
    byId.set(view.id, view);
    return view;
  });
  for (const r of rowsOf<{ match_id: string; participant_id: string; team: Team; position: Position | null }>(next())) {
    byId.get(r.match_id)?.roster.push({
      participantId: r.participant_id,
      team: r.team,
      position: r.position,
    });
  }

  const revisions = parseRevisions(next(), next(), next());
  const seasonRows = rowsOf<{ id: string; name: string; starts_on: string; ends_on: string }>(next());
  const series = parseSeries(next(), next());

  // 서포터 횟수 직접 입력의 보정값은 운영자에게만 준다(조회 응답에 새 정보를 늘리지 않는다).
  if (includePrivate) {
    const adjustments = foldAdjustments(rowsOf<{ participant_id: string; delta: number }>(next()), participants);
    if (adjustments.length > 0) rotation = { ...(rotation ?? { cycleId: null, events: [] }), adjustments };
  }

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
    seasons: seasonRows.map((s) => ({
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
    const batches = rowsOf<{ id: string; count: number; excluded: number; imported_at: string }>(next());
    // 묶음의 출처(붙여 넣기 / 구글 시트, migrations/0007). 출처를 남기기 전에 넣은 묶음은 출처가 없다.
    // 출처 열쇠(시트 문서 ID·기존 사이트 배포 ID)는 내보내지 않는다. 종류와 이름만.
    const sources = new Map<string, { kind: "paste" | "sheet" | "legacy"; label: string | null }>();
    for (const r of rowsOf<{ id: string; kind: "paste" | "sheet" | "legacy"; label: string | null }>(next())) {
      sources.set(r.id, { kind: r.kind, label: r.label });
    }
    snapshot.importBatches = batches.map((b) => ({
      id: b.id,
      count: b.count,
      excluded: b.excluded,
      importedAt: b.imported_at,
      ...sources.get(b.id),
    }));
    snapshot.merges = rowsOf<{
      id: string;
      source_id: string;
      target_id: string;
      match_count: number;
      created_at: string;
      undone_at: string | null;
    }>(next()).map((m) => ({
      id: m.id,
      sourceId: m.source_id,
      targetId: m.target_id,
      matchCount: m.match_count,
      createdAt: m.created_at,
      undoneAt: m.undone_at,
    }));
    // 참가자 본인 연결·연결 링크·참가자 요청(migrations/0019). 계정 ID·토큰은 넣지 않는다.
    snapshot.memberLinks = rowsOf<{ participant_id: string; created_at: string; avoid_self_at: string | null }>(
      next(),
    ).map((l) => ({ participantId: l.participant_id, linkedAt: l.created_at, avoidBySelf: l.avoid_self_at !== null }));
    snapshot.memberClaims = rowsOf<{ participant_id: string; expires_at: string }>(next()).map((c) => ({
      participantId: c.participant_id,
      expiresAt: c.expires_at,
    }));
    snapshot.memberRequests = parseMemberRequests(next(), next());
  }
  return snapshot;
}

/** 저장된 설정 JSON을 읽는다. 없으면 기본값. 티어 4단계 시절의 가중치 4개는 5개로 맞춘다. */
function settingsFromPayload(payload: string | undefined): Settings {
  if (!payload) return { ...DEFAULT_SETTINGS };
  const settings = JSON.parse(payload) as Settings;
  return { ...settings, groupWeights: upgradeGroupWeights(settings.groupWeights) };
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
  if (participantId !== null) {
    const rows = await env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM participant_requests WHERE group_id = ?1 AND participant_id = ?2
       ORDER BY created_at DESC, id LIMIT ?3`,
    )
      .bind(groupId, participantId, RECENT_RESOLVED_REQUESTS)
      .all<RequestRow>();
    return rows.results.map(toRequestView);
  }
  const [open, resolved] = await env.DB.batch(memberRequestStatements(env, groupId));
  return parseMemberRequests(open, resolved);
}

const REQUEST_COLUMNS = "id, participant_id, kind, match_id, body, status, reply, created_at, resolved_at";

/** 모임 전체 참가자 요청(열린 것 전부 + 처리한 것 최근 몇 개)을 읽는 두 문장. buildSnapshot의 batch에도 들어간다. */
function memberRequestStatements(env: Env, groupId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM participant_requests WHERE group_id = ?1 AND status = 'open' ORDER BY created_at DESC, id`,
    ).bind(groupId),
    env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM participant_requests WHERE group_id = ?1 AND status <> 'open'
       ORDER BY resolved_at DESC, id LIMIT ?2`,
    ).bind(groupId, RECENT_RESOLVED_REQUESTS),
  ];
}

function parseMemberRequests(open: D1Result | undefined, resolved: D1Result | undefined): MemberRequestView[] {
  return [...rowsOf<RequestRow>(open), ...rowsOf<RequestRow>(resolved)].map(toRequestView);
}

/** 시리즈 묶음과 속한 경기(경기 시각 → 경기 번호 순). */
export async function loadSeries(env: Env, groupId: string): Promise<SeriesView[]> {
  const [rows, members] = await env.DB.batch(seriesStatements(env, groupId));
  return parseSeries(rows, members);
}

function seriesStatements(env: Env, groupId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      "SELECT id, name, format, created_at FROM match_series WHERE group_id = ?1 ORDER BY created_at, id",
    ).bind(groupId),
    // 시리즈에 든 경기에서 출발해(idx_series_members) 경기 행은 기본 키로 찾는다. CROSS JOIN은 SQLite에서 이 순서를
    // 고정한다: 그냥 JOIN이면 통계 없는 계획기가 matches(모임의 경기 전부)에서 출발해 시리즈가 0개여도 다 훑었다
    // (2026-11-08 EXPLAIN QUERY PLAN 확인). 정렬(경기 시각 → 경기 번호)은 parseSeries가 JS에서 한다.
    env.DB.prepare(
      `SELECT s.series_id, s.match_id, m.played_at, m.match_no FROM match_series_members s
       CROSS JOIN matches m ON m.id = s.match_id AND m.group_id = s.group_id
       WHERE s.group_id = ?1`,
    ).bind(groupId),
  ];
}

function parseSeries(rows: D1Result | undefined, members: D1Result | undefined): SeriesView[] {
  const byId = new Map<string, SeriesView>();
  for (const r of rows!.results as unknown as { id: string; name: string | null; format: SeriesFormat; created_at: string }[]) {
    byId.set(r.id, { id: r.id, name: r.name, format: r.format, createdAt: r.created_at, matchIds: [] });
  }
  const memberRows = members!.results as unknown as {
    series_id: string;
    match_id: string;
    played_at: string;
    match_no: number;
  }[];
  // 예전 SQL의 ORDER BY m.played_at, m.match_no와 같은 순서(played_at은 ASCII 시각 문자열이라 JS 문자열 비교가
  // SQLite의 기본 BINARY 비교와 같다. 경기 번호는 모임 안에서 겹치지 않아(UNIQUE) 순서가 하나로 정해진다).
  memberRows.sort((a, b) =>
    a.played_at < b.played_at ? -1 : a.played_at > b.played_at ? 1 : a.match_no - b.match_no,
  );
  for (const m of memberRows) {
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
function revisionStatements(env: Env, groupId: string): D1PreparedStatement[] {
  const select = `SELECT r.id, r.match_id, m.match_no, r.kind, r.changes, r.created_at
     FROM match_revisions r JOIN matches m ON m.id = r.match_id AND m.group_id = r.group_id`;
  return [
    env.DB.prepare(
      `${select} WHERE r.group_id = ?1 AND ${MERGE_REF} IS NULL ORDER BY r.id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_REVISIONS),
    // ORDER BY +r.id: "+"는 id 순서를 색인으로 맞추지 말라는 표시다. 이게 없으면 계획기가 정렬을 아끼려고
    // idx_revisions_group을 거꾸로 걸으며 종류를 하나씩 걸러 사실상 이력 전부를 읽는다. 있으면
    // idx_revisions_group_kind(migrations/0022)로 세 종류의 줄만 읽고 그것만 정렬한다(결과는 같다. id는 겹치지 않는다).
    env.DB.prepare(
      `${select} WHERE r.group_id = ?1 AND r.kind IN ('correction', 'exclude', 'restore')
         AND ${MERGE_REF} IS NULL ORDER BY +r.id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_CHANGES),
    env.DB.prepare(
      `SELECT ref, MAX(id) AS id, COUNT(*) AS match_count, MAX(created_at) AS created_at,
         MAX(json_extract(changes, '$.participant.from')) AS from_id,
         MAX(json_extract(changes, '$.participant.to')) AS to_id
       FROM (SELECT r.id, r.changes, r.created_at, ${MERGE_REF} AS ref
             FROM match_revisions r WHERE r.group_id = ?1 AND r.kind = 'correction')
       WHERE ref IS NOT NULL GROUP BY ref ORDER BY id DESC LIMIT ?2`,
    ).bind(groupId, RECENT_MERGES),
  ];
}

function parseRevisions(
  recent: D1Result | undefined,
  changes: D1Result | undefined,
  merges: D1Result | undefined,
): RevisionView[] {
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
    groupWeights: settings.groupsPublic ? settings.groupWeights : [0, 0, 0, 0, 0],
  };
  if (settings.titleBands !== undefined) view.titleBands = settings.titleBands;
  return view;
}
