/**
 * 백업 복원·가져오기(docs/P4 P4-3, 검증 시나리오 36·37·38).
 *
 * - 같은 모임 복구: 파일의 모임 ID가 대상 모임과 같을 때. ID를 그대로 쓰고 그 모임의 경기·참가자·이력·
 *   세션·순환·시즌·설정 버전을 파일 내용으로 바꾼다. 운영자·조회 토큰·인수 링크는 건드리지 않는다.
 * - 새 모임 가져오기: 다른 모임(또는 빈 환경)의 파일. 모든 ID를 새로 만들고 파일 안의 참조를 대응표로 바꾼다.
 *   다른 모임의 파일로 기존 모임을 덮어쓰는 길은 두지 않는다.
 *
 * 순서: 파일 전체 검증(아무것도 쓰지 않음) → 실행 계획 → 적용.
 * 적용은 D1 batch(한 트랜잭션, docs/구현현황.md 스파이크)로 한다. 데이터가 커서 한 batch에 넣기 부담스러우면
 * 모임을 점검 상태로 바꾼 뒤 여러 batch로 나눠 넣고 마지막 batch에서 점검을 푼다. 중간에 끊기면 점검 상태가
 * 남고(다른 쓰기는 거절), 같은 백업 파일로 다시 복원하면 처음부터 다시 지우고 넣어 끝난다.
 *
 * 행은 json_each로 넣는다: 문장 하나에 행 수천 개를 JSON 문자열 값 하나로 실어 보낸다.
 * D1 한도(2026-11-05 확인, https://developers.cloudflare.com/d1/platform/limits/):
 * 문장 길이 100KB, 문장당 바인딩 값 100개, 문자열·행 2MB. batch 문장 수 상한은 문서에 없다.
 */
import { encodeAvoid, normalizeAvoidPositions } from "../shared/avoid";
import { LEGACY_SOURCE_KEY, parseLegacyChoice, type LegacyChoice } from "../shared/legacy";
import { MEMO_MAX, memoLength, normalizeMemo } from "../shared/memo";
import { MAX_NAME_LENGTH, cleanName, nameKey } from "../shared/names";
import { SERIES_NAME_MAX } from "../shared/series";
import { isValidTimeZone } from "../shared/stats";
import { MAX_SKILL_GROUP } from "../shared/types";
import type { Env } from "./env";
import { accountGroupCount, MAX_GROUPS_PER_ACCOUNT, parseSettings, tooManyGroupsError } from "./groups";
import { ApiError, assertOnlyKeys, nowIso, readJsonBody, requireInt, requireString } from "./http";
import { runMutation, sha256Hex, type Plan } from "./mutation";
import { newViewToken } from "./auth";

export const RESTORE_CONFIRM_TEXT = "복원";

/**
 * 모임 데이터 표를 외래 키 순서(참조하는 쪽 먼저)로 적은 목록. 같은 모임 복원과 모임 삭제(deletion.ts)가 함께 쓴다.
 * 참가자·경기를 참조하는 표를 새로 만들면 여기에 넣어야 한다. 빠지면 외래 키 때문에 복원·삭제가 실패한다.
 * 운영자·조회 토큰·인수 링크·복원 작업 표는 들어가지 않는다(복원이 바꾸지 않는 것).
 */
export const GROUP_DATA_TABLES = [
  // 참가 신청(migrations/0014). 그날그날 쓰는 임시 자료라 백업에 넣지 않고, 복원하면 비워진다.
  "join_requests",
  "support_adjustments",
  "rotation_events",
  // 시리즈에 속한 경기(migrations/0017). 경기·시리즈보다 먼저 지운다.
  "match_series_members",
  "match_revisions",
  "match_roster",
  "participant_merges",
  "import_batches",
  "rotation_cycles",
  "matches",
  "match_series",
  "sessions",
  "seasons",
  "participants",
  "settings_versions",
  "requests",
] as const;
export const MAX_RESTORE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PARTICIPANTS = 200;
const MAX_MATCHES = 10_000;
const MAX_PROBLEMS = 30;
/** json_each로 넘기는 값 하나의 크기 상한. D1 문자열 한도 2MB보다 충분히 작게. */
const CHUNK_BYTES = 512 * 1024;
/** 이보다 크면 점검 상태에서 여러 batch로 나눠 넣는다. RESTORE_BATCH_BYTES로 바꾼다. */
const DEFAULT_BATCH_BYTES = 1024 * 1024;

/** 변경 이력 한 행의 내용(changes) 크기 상한(UTF-8 바이트). 정상 이력은 몇 KB를 넘지 않는다. */
export const MAX_REVISION_CHANGES_BYTES = 16 * 1024;
/** 합치기 기록 한 행(옮긴 경기·차례 변경 목록)의 크기 상한(UTF-8 바이트). */
const MAX_MERGE_ROW_BYTES = 256 * 1024;

/* ------------------------------------------------------------------ */
/* 작업 잠금(restore_jobs, migrations/0008)                              */
/* ------------------------------------------------------------------ */

/**
 * 작업 행의 주인이 이만큼 단계를 끝내지 못하면 실행이 죽었다고 보고 다른 실행이 이어받는다.
 * 한 단계는 D1 batch 하나(최대 RESTORE_BATCH_BYTES)라 보통 몇 초 안에 끝난다.
 * 이 값이 너무 짧아 살아 있는 실행을 이어받아도 데이터는 섞이지 않는다: 앞 실행의 다음 단계가 주인 확인에서 실패한다.
 */
export const JOB_STALE_MS = 60_000;
/** 모임 삭제가 쓰는 작업 행 표시. 복원은 삭제 작업 행을 이어받지 않는다(삭제만 다시 실행해 끝낸다). */
export const DELETE_JOB = "delete";
/** D1(SQLite) 안의 지금 시각(유닉스 밀리초). 단계가 실제로 실행되는 시각을 쓰려고 SQL에서 계산한다. */
export const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

interface JobRow {
  request_id: string | null;
  run_token: string | null;
  heartbeat_ms: number;
}

async function readJob(env: Env, groupId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT request_id, run_token, heartbeat_ms FROM restore_jobs WHERE group_id = ?1")
    .bind(groupId)
    .first<JobRow>();
}

/** 작업 행 주인이 살아 있는지(실패를 알고 놓지 않았고, 단계 소식이 최근에 있음). */
function jobIsLive(job: JobRow): boolean {
  return job.run_token !== null && job.heartbeat_ms >= Date.now() - JOB_STALE_MS;
}

export function jobBusyError(sameRequest: boolean): ApiError {
  return new ApiError(
    409,
    "RESTORE_IN_PROGRESS",
    sameRequest
      ? "이 복원 요청이 아직 처리 중입니다. 잠시 뒤 화면을 새로 고쳐 결과를 확인해 주세요."
      : "이 모임에서 다른 복원이 진행 중입니다. 잠시 뒤 화면을 새로 고쳐 확인해 주세요. 기존 기록은 그대로입니다.",
  );
}

/**
 * 작업 행을 이 실행(runToken)의 것으로 만든다. 행이 없으면 만들고, 있으면 아래 조건일 때만 이어받는다:
 * - 모임 삭제의 작업 행이 아니고,
 * - 주인이 없거나(앞 실행이 실패를 알고 놓음, 또는 0008 이전 버전이 남긴 행) 주인의 마지막 단계가 JOB_STALE_MS보다 오래됨.
 * 이어받지 못하면 아무것도 바꾸지 않는다. 바로 뒤의 jobOwnerGuard가 batch를 실패시킨다.
 */
function claimJob(env: Env, groupId: string, requestId: string, runToken: string, at: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO restore_jobs (group_id, started_at, request_id, run_token, heartbeat_ms)
     VALUES (?1, ?2, ?3, ?4, ${NOW_MS_SQL})
     ON CONFLICT (group_id) DO UPDATE SET
       started_at = excluded.started_at, request_id = excluded.request_id,
       run_token = excluded.run_token, heartbeat_ms = excluded.heartbeat_ms
     WHERE restore_jobs.request_id IS NOT '${DELETE_JOB}'
       AND (restore_jobs.run_token IS NULL OR restore_jobs.heartbeat_ms < ${NOW_MS_SQL} - ?5)`,
  ).bind(groupId, at, requestId, runToken, JOB_STALE_MS);
}

/** 작업 행의 주인이 이 실행이 아니면 batch 전체를 실패시킨다(guard_job_busy). 모든 단계의 맨 앞에 둔다. */
function jobOwnerGuard(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (job_busy)
     SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM restore_jobs WHERE group_id = ?1 AND run_token = ?2)`,
  ).bind(groupId, runToken);
}

function jobHeartbeat(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE restore_jobs SET heartbeat_ms = ${NOW_MS_SQL} WHERE group_id = ?1 AND run_token = ?2`,
  ).bind(groupId, runToken);
}

/** 실패를 안 실행이 작업 행을 놓는다. 같은 파일(또는 다른 요청)로 바로 다시 복원해 끝낼 수 있게 된다. */
function jobRelease(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE restore_jobs SET run_token = NULL WHERE group_id = ?1 AND run_token = ?2").bind(
    groupId,
    runToken,
  );
}

/**
 * 점검 중인 모임에서 복원을 받아들일지(runMutation의 allowMaintenance).
 * - 작업 행이 없거나 모임 삭제의 작업 행이면 받지 않는다(점검 오류).
 * - 주인이 살아 있으면 409(RESTORE_IN_PROGRESS). 같은 요청 ID의 재전송이 앞 실행과 겹친 경우도 여기서 막는다.
 * 미리 보는 확인일 뿐이고, 실제 잠금은 batch 안의 claimJob + jobOwnerGuard다.
 */
async function canResumeRestore(env: Env, groupId: string, requestId: string): Promise<boolean> {
  const job = await readJob(env, groupId);
  if (!job || job.request_id === DELETE_JOB) return false;
  if (jobIsLive(job)) throw jobBusyError(job.request_id === requestId);
  return true;
}

/** 테스트 전용: 단계 사이에 끼어들어 "중간에 끊긴 복원"을 만든다. */
export const restoreHooks: { afterStage: ((index: number) => void | Promise<void>) | null } = {
  afterStage: null,
};

type Body = Record<string, unknown>;

const STATES = ["in_progress", "awaiting_result", "confirmed", "canceled", "excluded"] as const;
const SOURCES = ["live", "backfill", "import"] as const;
const POSITIONS = ["top", "jungle", "mid", "adc", "support"] as const;
const REVISION_KINDS = [
  "start",
  "end",
  "result",
  "correction",
  "exclude",
  "restore",
  "cancel",
  "backfill",
] as const;

interface PRow {
  id: string;
  name: string;
  nameKey: string;
  status: "active" | "archived";
  skillGroup: number | null;
  /** 기피 라인 저장 글자(없으면 null). 이 항목이 없는 예전 백업은 null. */
  avoidPositions: string | null;
  createdAt: string;
}
interface SRow {
  id: string;
  startedAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}
interface RosterRow {
  participantId: string;
  team: "A" | "B";
  position: string | null;
}
interface MRow {
  id: string;
  matchNo: number;
  sessionId: string | null;
  state: string;
  prevState: string | null;
  source: string;
  startedAt: string | null;
  endedAt: string | null;
  playedAt: string;
  confirmedAt: string | null;
  winnerTeam: string | null;
  teamASide: string | null;
  settingsVersionId: string | null;
  importBatchId: string | null;
  /** 형식 4: 다시 가져오기 중복 방지용 시트 내용 지문과 줄 위치 열쇠. */
  importFingerprint: string | null;
  importRowKey: string | null;
  version: number;
  roster: RosterRow[];
  /** 경기 메모(migrations/0016). 이 항목이 없는 예전 백업은 null. */
  memo: string | null;
}
/** 시리즈 묶음(migrations/0017). 이 항목이 없는 예전 백업은 빈 목록. */
interface SeriesRowB {
  id: string;
  name: string | null;
  format: "bo3" | "bo5" | "free";
  createdAt: string;
  matchIds: string[];
}
/** 일괄 입력 묶음의 출처(형식 4). */
interface IBRow {
  id: string;
  kind: "paste" | "sheet" | "legacy";
  sourceKey: string | null;
  label: string | null;
  createdAt: string;
  /** 기존 사이트 가져오기의 날짜 처리 선택(migrations/0010). 이전 파일에는 없다. */
  options: LegacyChoice | null;
}
interface CRow {
  id: string;
  sessionId: string;
  status: "active" | "closed";
  createdAt: string;
  closedAt: string | null;
}
interface ERow {
  id: string;
  cycleId: string;
  matchId: string;
  participantId: string;
  kind: "used" | "repeat";
  voided: number;
  createdAt: string;
}
/** 서포터 횟수 직접 입력의 보정값(migrations/0012). cycleId가 null이면 첫 경기 전에 받아 둔 값. */
interface ARow {
  cycleId: string | null;
  participantId: string;
  delta: number;
  updatedAt: string;
}
interface RRow {
  matchId: string;
  kind: string;
  changes: string;
  createdAt: string;
}
interface SeasonRow {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}
interface VRow {
  id: string;
  versionNo: number;
  payload: string;
  createdAt: string;
}
/** 중복 참가자 합치기 기록(형식 3). 되돌리기에 필요한 옮긴 행 목록을 함께 옮긴다. */
interface MergeRow {
  id: string;
  sourceId: string;
  targetId: string;
  sourcePrevStatus: "active" | "archived";
  movedMatches: string[];
  rotationChanges: {
    id: string;
    participantFrom: string;
    participantTo: string;
    kindFrom: "used" | "repeat";
    kindTo: "used" | "repeat";
  }[];
  createdAt: string;
  undoneAt: string | null;
}

export interface BackupData {
  formatVersion: number;
  createdAt: string;
  group: { id: string; name: string; timezone: string };
  currentSettingsVersionId: string;
  participants: PRow[];
  sessions: SRow[];
  matches: MRow[];
  cycles: CRow[];
  events: ERow[];
  /** 이 항목이 없는 예전 백업은 빈 목록으로 읽는다. */
  adjustments: ARow[];
  revisions: RRow[];
  seasons: SeasonRow[];
  settingsVersions: VRow[];
  merges: MergeRow[];
  importBatches: IBRow[];
  series: SeriesRowB[];
}

/* ------------------------------------------------------------------ */
/* 검증                                                                */
/* ------------------------------------------------------------------ */

class Problems {
  list: string[] = [];
  add(message: string): void {
    if (this.list.length < MAX_PROBLEMS) this.list.push(message);
  }
}

const isObj = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9_-]+$/.test(v);
const isTime = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 10 && v.length <= 40 && !Number.isNaN(Date.parse(v));
const isTimeOrNull = (v: unknown): v is string | null => v === null || v === undefined || isTime(v);
const iso = (v: string) => new Date(Date.parse(v)).toISOString();
const isoOrNull = (v: unknown) => (typeof v === "string" ? iso(v) : null);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string =>
  typeof v === "string" &&
  DATE.test(v) &&
  new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;

function oneOf<T extends string>(v: unknown, list: readonly T[]): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function arrayField(raw: Body, key: string, problems: Problems): unknown[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.add(`${key} 항목이 목록이 아닙니다.`);
    return [];
  }
  return value;
}

/**
 * 백업 파일 전체를 검증한다. 하나라도 틀리면 문제 목록을 돌려주고, 맞으면 정리한 자료를 돌려준다.
 * 이 함수는 DB를 읽지도 쓰지도 않는다.
 */
export function validateBackup(
  raw: unknown,
): { ok: true; data: BackupData } | { ok: false; problems: string[] } {
  const p = new Problems();
  if (!isObj(raw)) return { ok: false, problems: ["백업 파일 형식이 아닙니다(JSON 객체가 아님)."] };
  const formatVersion = raw.formatVersion;
  if (formatVersion !== 1 && formatVersion !== 2 && formatVersion !== 3 && formatVersion !== 4) {
    return {
      ok: false,
      problems: [`지원하지 않는 백업 형식 버전입니다: ${String(formatVersion)} (1~4만 읽습니다).`],
    };
  }
  if (raw.scope !== "group") p.add("백업 범위(scope)가 모임이 아닙니다.");
  if (!isTime(raw.createdAt)) p.add("백업 생성 시각이 올바르지 않습니다.");
  const g = raw.group;
  let group = { id: "", name: "", timezone: "Asia/Seoul" };
  if (!isObj(g) || !isId(g.id) || typeof g.name !== "string" || typeof g.timezone !== "string") {
    p.add("모임 정보(group)가 올바르지 않습니다.");
  } else {
    const name = cleanName(g.name);
    if (name === "" || [...name].length > MAX_NAME_LENGTH) p.add("모임 이름이 올바르지 않습니다.");
    // 화면의 Intl.DateTimeFormat이 받아들이지 않는 값이면 날짜 표시가 깨진다(RangeError). 실제로 만들어 본다.
    if (!isValidTimeZone(g.timezone)) p.add("모임 시간대 값이 올바르지 않습니다.");
    group = { id: g.id, name, timezone: g.timezone };
  }

  // 참가자
  const participants: PRow[] = [];
  const pids = new Set<string>();
  const activeKeys = new Set<string>();
  const rawParticipants = arrayField(raw, "participants", p);
  if (rawParticipants.length > MAX_PARTICIPANTS) p.add(`참가자가 ${MAX_PARTICIPANTS}명을 넘습니다.`);
  rawParticipants.forEach((r, i) => {
    const at = `참가자 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || typeof r.name !== "string") return p.add(`${at}: 형식 오류`);
    if (pids.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    pids.add(r.id);
    const name = cleanName(r.name);
    if (name === "" || [...name].length > MAX_NAME_LENGTH) return p.add(`${at}: 이름이 올바르지 않습니다.`);
    if (r.status !== "active" && r.status !== "archived") return p.add(`${at}: 상태 값 오류`);
    const sg = r.skillGroup ?? null;
    if (sg !== null && !(Number.isInteger(sg) && (sg as number) >= 1 && (sg as number) <= MAX_SKILL_GROUP)) {
      return p.add(`${at}: 실력 그룹 값 오류`);
    }
    // 기피 라인(2026-11-06). 없으면(예전 백업) 없음으로 본다.
    let avoid: string | null = null;
    if (r.avoidPositions !== undefined && r.avoidPositions !== null) {
      const list = normalizeAvoidPositions(r.avoidPositions);
      if (!list) return p.add(`${at}: 기피 라인 값 오류`);
      avoid = encodeAvoid(list);
    }
    const key = nameKey(name);
    if (r.status === "active") {
      if (activeKeys.has(key)) return p.add(`${at}: 활성 참가자 이름 '${name}'이 중복됩니다.`);
      activeKeys.add(key);
    }
    participants.push({
      id: r.id,
      name,
      nameKey: key,
      status: r.status,
      skillGroup: sg as number | null,
      avoidPositions: avoid,
      createdAt: isTime(r.createdAt) ? iso(r.createdAt) : "",
    });
  });

  // 세션
  const sessions: SRow[] = [];
  const sids = new Set<string>();
  let openSessions = 0;
  arrayField(raw, "sessions", p).forEach((r, i) => {
    const at = `세션 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || !isTime(r.started_at) || !isTime(r.last_activity_at)) {
      return p.add(`${at}: 형식 오류`);
    }
    if (!isTimeOrNull(r.closed_at)) return p.add(`${at}: 종료 시각 오류`);
    if (sids.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    sids.add(r.id);
    if (r.closed_at == null) openSessions += 1;
    sessions.push({
      id: r.id,
      startedAt: iso(r.started_at),
      lastActivityAt: iso(r.last_activity_at),
      closedAt: isoOrNull(r.closed_at),
    });
  });
  if (openSessions > 1) p.add("열린 내전(세션)이 둘 이상입니다.");

  // 설정 버전
  const settingsVersions: VRow[] = [];
  const vids = new Set<string>();
  const vnos = new Set<number>();
  arrayField(raw, "settingsVersions", p).forEach((r, i) => {
    const at = `설정 버전 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || !Number.isInteger(r.versionNo) || !isTime(r.createdAt)) {
      return p.add(`${at}: 형식 오류`);
    }
    if (vids.has(r.id) || vnos.has(r.versionNo as number)) return p.add(`${at}: 중복`);
    vids.add(r.id);
    vnos.add(r.versionNo as number);
    try {
      const settings = parseSettings(r.settings);
      settingsVersions.push({
        id: r.id,
        versionNo: r.versionNo as number,
        payload: JSON.stringify(settings),
        createdAt: iso(r.createdAt),
      });
    } catch (e) {
      p.add(`${at}: 설정 값 오류(${e instanceof Error ? e.message : "형식"})`);
    }
  });
  if (settingsVersions.length === 0) p.add("설정 버전이 하나도 없습니다.");
  let currentSettingsVersionId = "";
  const declaredCurrent = isObj(g) ? g.currentSettingsVersionId : undefined;
  if (typeof declaredCurrent === "string") {
    if (!vids.has(declaredCurrent)) p.add("현재 설정 버전이 설정 목록에 없습니다.");
    currentSettingsVersionId = declaredCurrent;
  } else if (settingsVersions.length > 0) {
    // 형식 1에는 현재 설정 표시가 없다: 가장 높은 번호를 현재로 본다.
    currentSettingsVersionId = [...settingsVersions].sort((a, b) => b.versionNo - a.versionNo)[0]!.id;
  }

  // 경기
  const matches: MRow[] = [];
  const mids = new Set<string>();
  const mnos = new Set<number>();
  let inProgress = 0;
  const rawMatches = arrayField(raw, "matches", p);
  if (rawMatches.length > MAX_MATCHES) p.add(`경기가 ${MAX_MATCHES}개를 넘습니다.`);
  if (raw.matchCount !== rawMatches.length) {
    p.add(`경기 수가 맞지 않습니다: 적힌 수 ${String(raw.matchCount)}, 실제 ${rawMatches.length}.`);
  }
  rawMatches.forEach((r, i) => {
    const at = isObj(r) && Number.isInteger(r.matchNo) ? `${String(r.matchNo)}경기` : `경기 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id)) return p.add(`${at}: 형식 오류`);
    if (mids.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    mids.add(r.id);
    if (!Number.isInteger(r.matchNo) || (r.matchNo as number) < 1) return p.add(`${at}: 경기 번호 오류`);
    if (mnos.has(r.matchNo as number)) return p.add(`${at}: 경기 번호가 중복됩니다.`);
    mnos.add(r.matchNo as number);
    if (!oneOf(r.state, STATES)) return p.add(`${at}: 상태 값 오류`);
    if (!oneOf(r.source, SOURCES)) return p.add(`${at}: 출처 값 오류`);
    if (!isTime(r.playedAt)) return p.add(`${at}: 경기 시각 오류`);
    if (!isTimeOrNull(r.startedAt) || !isTimeOrNull(r.endedAt) || !isTimeOrNull(r.confirmedAt)) {
      return p.add(`${at}: 시각 값 오류`);
    }
    const winner = r.winnerTeam ?? null;
    const side = r.teamASide ?? null;
    if (winner !== null && winner !== "A" && winner !== "B") return p.add(`${at}: 승리 팀 값 오류`);
    if (side !== null && !oneOf(side, ["blue", "red", "unknown"] as const)) {
      return p.add(`${at}: 진영 값 오류`);
    }
    if (r.state === "confirmed" && (winner === null || side === null)) {
      return p.add(`${at}: 결과 확정 경기에 승리 팀·진영이 없습니다.`);
    }
    if (r.state === "in_progress") inProgress += 1;
    const sessionId = r.sessionId ?? null;
    if (sessionId !== null && !(typeof sessionId === "string" && sids.has(sessionId))) {
      return p.add(`${at}: 연결된 내전(세션)이 파일에 없습니다.`);
    }
    // 전적 제외 직전 상태: 형식 2는 파일에 있다. 형식 1은 결과 유무로 정한다.
    let prevState: string | null = null;
    if (r.state === "excluded") {
      const declared = r.prevState;
      if (declared === "awaiting_result" || declared === "confirmed") prevState = declared;
      else if (declared === undefined || declared === null) {
        prevState = winner !== null && side !== null ? "confirmed" : "awaiting_result";
      } else return p.add(`${at}: 제외 직전 상태 값 오류`);
      if (prevState === "confirmed" && (winner === null || side === null)) {
        return p.add(`${at}: 확정이었던 제외 경기에 결과가 없습니다.`);
      }
    }
    const settingsVersionId = r.settingsVersionId ?? null;
    if (settingsVersionId !== null && !(typeof settingsVersionId === "string" && vids.has(settingsVersionId))) {
      return p.add(`${at}: 적용 설정 버전이 파일에 없습니다.`);
    }
    const importBatchId = r.importBatchId ?? null;
    if (importBatchId !== null && !isId(importBatchId)) return p.add(`${at}: 일괄 입력 묶음 값 오류`);
    // 형식 4: 다시 가져오기 지문. 없으면 null(이전 형식).
    const importFingerprint = r.importFingerprint ?? null;
    const importRowKey = r.importRowKey ?? null;
    if (importFingerprint !== null && !(typeof importFingerprint === "string" && /^v1-[0-9a-f]{16}$/.test(importFingerprint))) {
      return p.add(`${at}: 가져오기 지문 값 오류`);
    }
    if (
      importRowKey !== null &&
      !(typeof importRowKey === "string" && /^(\d{4}-\d{2}-\d{2}#\d{1,5}|v1id:[0-9a-f]{16})$/.test(importRowKey))
    ) {
      return p.add(`${at}: 가져오기 줄 위치 값 오류`);
    }
    if (!Number.isInteger(r.version) || (r.version as number) < 1) return p.add(`${at}: 경기 버전 오류`);
    // 경기 메모(2026-11-06). 없으면(예전 백업) 없음.
    let memo: string | null = null;
    if (r.memo !== undefined && r.memo !== null) {
      if (typeof r.memo !== "string") return p.add(`${at}: 메모 값 오류`);
      memo = normalizeMemo(r.memo);
      if (memo !== null && memoLength(memo) > MEMO_MAX) return p.add(`${at}: 메모가 ${MEMO_MAX}자를 넘습니다.`);
    }

    // 명단: 경기당 10명, 팀당 5명, 같은 사람 두 번 없음, 팀 안 포지션 중복 없음, 모두 파일의 참가자.
    if (!Array.isArray(r.roster) || r.roster.length !== 10) return p.add(`${at}: 명단이 10명이 아닙니다.`);
    const roster: RosterRow[] = [];
    const seen = new Set<string>();
    const posSeen = new Set<string>();
    let teamA = 0;
    for (const e of r.roster as unknown[]) {
      if (!isObj(e) || typeof e.participantId !== "string") return p.add(`${at}: 명단 형식 오류`);
      if (!pids.has(e.participantId)) return p.add(`${at}: 명단의 참가자가 파일에 없습니다.`);
      if (seen.has(e.participantId)) return p.add(`${at}: 명단에 같은 사람이 두 번 있습니다.`);
      seen.add(e.participantId);
      if (e.team !== "A" && e.team !== "B") return p.add(`${at}: 팀 값 오류`);
      if (e.team === "A") teamA += 1;
      const pos = e.position ?? null;
      if (pos !== null) {
        if (!oneOf(pos, POSITIONS)) return p.add(`${at}: 포지션 값 오류`);
        if (posSeen.has(`${e.team}:${pos}`)) return p.add(`${at}: 한 팀에 같은 포지션이 둘입니다.`);
        posSeen.add(`${e.team}:${pos}`);
      }
      roster.push({ participantId: e.participantId, team: e.team, position: pos as string | null });
    }
    if (teamA !== 5) return p.add(`${at}: 팀당 5명이 아닙니다.`);
    matches.push({
      id: r.id,
      matchNo: r.matchNo as number,
      sessionId: sessionId as string | null,
      state: r.state,
      prevState,
      source: r.source,
      startedAt: isoOrNull(r.startedAt),
      endedAt: isoOrNull(r.endedAt),
      playedAt: iso(r.playedAt),
      confirmedAt: isoOrNull(r.confirmedAt),
      winnerTeam: winner as string | null,
      teamASide: side as string | null,
      settingsVersionId: settingsVersionId as string | null,
      importBatchId: importBatchId as string | null,
      importFingerprint: importFingerprint as string | null,
      importRowKey: importRowKey as string | null,
      version: r.version as number,
      roster,
      memo,
    });
  });
  if (inProgress > 1) p.add("진행 중 경기가 둘 이상입니다.");

  // 순환 주기·사건
  const cycles: CRow[] = [];
  const cids = new Set<string>();
  const activePerSession = new Set<string>();
  arrayField(raw, "rotationCycles", p).forEach((r, i) => {
    const at = `순환 주기 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || typeof r.session_id !== "string" || !isTime(r.created_at)) {
      return p.add(`${at}: 형식 오류`);
    }
    if (!sids.has(r.session_id)) return p.add(`${at}: 연결된 내전(세션)이 파일에 없습니다.`);
    if (r.status !== "active" && r.status !== "closed") return p.add(`${at}: 상태 값 오류`);
    if (!isTimeOrNull(r.closed_at)) return p.add(`${at}: 종료 시각 오류`);
    if (cids.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    cids.add(r.id);
    if (r.status === "active") {
      if (activePerSession.has(r.session_id)) return p.add(`${at}: 한 내전에 활성 주기가 둘입니다.`);
      activePerSession.add(r.session_id);
    }
    cycles.push({
      id: r.id,
      sessionId: r.session_id,
      status: r.status,
      createdAt: iso(r.created_at),
      closedAt: isoOrNull(r.closed_at),
    });
  });
  const events: ERow[] = [];
  const eids = new Set<string>();
  const usedKeys = new Set<string>();
  arrayField(raw, "rotationEvents", p).forEach((r, i) => {
    const at = `서포터 차례 기록 ${i + 1}번째`;
    if (
      !isObj(r) ||
      !isId(r.id) ||
      typeof r.cycle_id !== "string" ||
      typeof r.match_id !== "string" ||
      typeof r.participant_id !== "string" ||
      !isTime(r.created_at)
    ) {
      return p.add(`${at}: 형식 오류`);
    }
    if (!cids.has(r.cycle_id) || !mids.has(r.match_id) || !pids.has(r.participant_id)) {
      return p.add(`${at}: 연결된 주기·경기·참가자가 파일에 없습니다.`);
    }
    if (r.kind !== "used" && r.kind !== "repeat") return p.add(`${at}: 종류 값 오류`);
    if (r.voided !== 0 && r.voided !== 1) return p.add(`${at}: 무효 표시 값 오류`);
    if (eids.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    eids.add(r.id);
    if (r.kind === "used" && r.voided === 0) {
      const key = `${r.cycle_id}:${r.participant_id}`;
      if (usedKeys.has(key)) return p.add(`${at}: 한 주기에 같은 사람의 차례 사용이 둘입니다.`);
      usedKeys.add(key);
    }
    events.push({
      id: r.id,
      cycleId: r.cycle_id,
      matchId: r.match_id,
      participantId: r.participant_id,
      kind: r.kind,
      voided: r.voided,
      createdAt: iso(r.created_at),
    });
  });

  // 서포터 횟수 보정값(없으면 예전 백업: 빈 목록)
  const adjustments: ARow[] = [];
  const adjustmentKeys = new Set<string>();
  arrayField(raw, "supportAdjustments", p).forEach((r, i) => {
    const at = `서포터 횟수 보정값 ${i + 1}번째`;
    const cycleId = isObj(r) ? (r.cycleId ?? null) : null;
    if (
      !isObj(r) ||
      !(cycleId === null || typeof cycleId === "string") ||
      typeof r.participantId !== "string" ||
      !Number.isInteger(r.delta) ||
      Math.abs(r.delta as number) > 100000 ||
      !isTime(r.updatedAt)
    ) {
      return p.add(`${at}: 형식 오류`);
    }
    if ((cycleId !== null && !cids.has(cycleId)) || !pids.has(r.participantId)) {
      return p.add(`${at}: 연결된 주기·참가자가 파일에 없습니다.`);
    }
    const key = `${cycleId ?? ""}:${r.participantId}`;
    if (adjustmentKeys.has(key)) return p.add(`${at}: 같은 주기에 같은 사람이 둘입니다.`);
    adjustmentKeys.add(key);
    adjustments.push({
      cycleId,
      participantId: r.participantId,
      delta: r.delta as number,
      updatedAt: iso(r.updatedAt),
    });
  });

  // 변경 이력
  const revisions: RRow[] = [];
  arrayField(raw, "revisions", p).forEach((r, i) => {
    const at = `변경 이력 ${i + 1}번째`;
    if (!isObj(r) || typeof r.matchId !== "string" || !isTime(r.createdAt) || !isObj(r.changes)) {
      return p.add(`${at}: 형식 오류`);
    }
    if (!mids.has(r.matchId)) return p.add(`${at}: 연결된 경기가 파일에 없습니다.`);
    if (!oneOf(r.kind, REVISION_KINDS)) return p.add(`${at}: 종류 값 오류`);
    const changes = JSON.stringify(r.changes);
    if (utf8Bytes(changes) > MAX_REVISION_CHANGES_BYTES) return p.add(`${at}: 내용이 너무 큽니다.`);
    revisions.push({
      matchId: r.matchId,
      kind: r.kind,
      changes,
      createdAt: iso(r.createdAt),
    });
  });

  // 시즌
  const seasons: SeasonRow[] = [];
  const seasonIds = new Set<string>();
  arrayField(raw, "seasons", p).forEach((r, i) => {
    const at = `시즌 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || typeof r.name !== "string" || !isDate(r.startsOn) || !isDate(r.endsOn)) {
      return p.add(`${at}: 형식 오류`);
    }
    if (r.startsOn > r.endsOn) return p.add(`${at}: 시작일이 종료일보다 늦습니다.`);
    if (seasonIds.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    seasonIds.add(r.id);
    const name = cleanName(r.name);
    if (name === "" || [...name].length > MAX_NAME_LENGTH) return p.add(`${at}: 이름 오류`);
    for (const s of seasons) {
      if (s.startsOn <= r.endsOn && s.endsOn >= r.startsOn) return p.add(`${at}: 다른 시즌과 날짜가 겹칩니다.`);
    }
    seasons.push({ id: r.id, name, startsOn: r.startsOn, endsOn: r.endsOn });
  });

  // 중복 참가자 합치기 기록(형식 3). 참조하는 참가자·경기·차례 기록이 모두 파일에 있어야 한다.
  const merges: MergeRow[] = [];
  const mergeIds = new Set<string>();
  const activeSources = new Set<string>();
  const statusOf = new Map(participants.map((r) => [r.id, r.status]));
  arrayField(raw, "participantMerges", p).forEach((r, i) => {
    const at = `참가자 합치기 기록 ${i + 1}번째`;
    if (
      !isObj(r) ||
      !isId(r.id) ||
      typeof r.sourceId !== "string" ||
      typeof r.targetId !== "string" ||
      !isTime(r.createdAt) ||
      !isTimeOrNull(r.undoneAt) ||
      !Array.isArray(r.movedMatches) ||
      !Array.isArray(r.rotationChanges)
    ) {
      return p.add(`${at}: 형식 오류`);
    }
    if (mergeIds.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    mergeIds.add(r.id);
    if (!pids.has(r.sourceId) || !pids.has(r.targetId) || r.sourceId === r.targetId) {
      return p.add(`${at}: 연결된 참가자가 파일에 없습니다.`);
    }
    if (r.sourcePrevStatus !== "active" && r.sourcePrevStatus !== "archived") {
      return p.add(`${at}: 이전 상태 값 오류`);
    }
    if (!(r.movedMatches as unknown[]).every((m) => typeof m === "string" && mids.has(m))) {
      return p.add(`${at}: 옮긴 경기가 파일에 없습니다.`);
    }
    if (new Set(r.movedMatches as string[]).size !== r.movedMatches.length) {
      return p.add(`${at}: 옮긴 경기가 중복됩니다.`);
    }
    if (utf8Bytes(JSON.stringify([r.movedMatches, r.rotationChanges])) > MAX_MERGE_ROW_BYTES) {
      return p.add(`${at}: 내용이 너무 큽니다.`);
    }
    const changes: MergeRow["rotationChanges"] = [];
    for (const c of r.rotationChanges as unknown[]) {
      if (
        !isObj(c) ||
        typeof c.id !== "string" ||
        !eids.has(c.id) ||
        typeof c.participantFrom !== "string" ||
        typeof c.participantTo !== "string" ||
        !pids.has(c.participantFrom) ||
        !pids.has(c.participantTo) ||
        !oneOf(c.kindFrom, ["used", "repeat"] as const) ||
        !oneOf(c.kindTo, ["used", "repeat"] as const)
      ) {
        return p.add(`${at}: 서포터 차례 변경 기록 오류`);
      }
      changes.push({
        id: c.id,
        participantFrom: c.participantFrom,
        participantTo: c.participantTo,
        kindFrom: c.kindFrom,
        kindTo: c.kindTo,
      });
    }
    const undoneAt = isoOrNull(r.undoneAt);
    if (undoneAt === null) {
      if (activeSources.has(r.sourceId)) return p.add(`${at}: 같은 사람의 합치기가 둘입니다.`);
      activeSources.add(r.sourceId);
      if (statusOf.get(r.sourceId) !== "archived") {
        return p.add(`${at}: 합쳐진 사람이 보관 상태가 아닙니다.`);
      }
    }
    merges.push({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      sourcePrevStatus: r.sourcePrevStatus,
      movedMatches: r.movedMatches as string[],
      rotationChanges: changes,
      createdAt: iso(r.createdAt),
      undoneAt,
    });
  });

  // 일괄 입력 묶음의 출처(형식 4).
  const importBatches: IBRow[] = [];
  const batchIds = new Set<string>();
  arrayField(raw, "importBatches", p).forEach((r, i) => {
    const at = `일괄 입력 출처 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || !isTime(r.createdAt)) return p.add(`${at}: 형식 오류`);
    if (batchIds.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    batchIds.add(r.id);
    if (r.kind !== "paste" && r.kind !== "sheet" && r.kind !== "legacy") return p.add(`${at}: 종류 값 오류`);
    const sourceKey = r.sourceKey ?? null;
    if (
      sourceKey !== null &&
      !(
        typeof sourceKey === "string" &&
        (r.kind === "legacy"
          ? LEGACY_SOURCE_KEY.test(sourceKey)
          : /^(sheet|pub):[A-Za-z0-9_-]{20,220}:(\d{1,12}|first)$/.test(sourceKey))
      )
    ) {
      return p.add(`${at}: 출처 값 오류`);
    }
    const rawOptions = r.options ?? null;
    const options = rawOptions === null ? null : parseLegacyChoice(rawOptions);
    if (rawOptions !== null && (options === null || r.kind !== "legacy")) return p.add(`${at}: 날짜 처리 값 오류`);
    const label = r.label ?? null;
    if (label !== null && !(typeof label === "string" && [...label].length <= 100)) return p.add(`${at}: 이름 값 오류`);
    importBatches.push({
      id: r.id,
      kind: r.kind,
      sourceKey: sourceKey as string | null,
      label: label as string | null,
      createdAt: iso(r.createdAt),
      options,
    });
  });

  // 시리즈 묶음(2026-11-06). 속한 경기는 모두 파일에 있어야 하고 한 경기는 한 시리즈에만 들어간다.
  // 팀 구성이 같은지는 다시 보지 않는다(화면이 구성 다른 판을 점수에서 빼고 알린다).
  const series: SeriesRowB[] = [];
  const seriesIds = new Set<string>();
  const inSeries = new Set<string>();
  arrayField(raw, "series", p).forEach((r, i) => {
    const at = `시리즈 ${i + 1}번째`;
    if (!isObj(r) || !isId(r.id) || !isTime(r.createdAt) || !Array.isArray(r.matchIds)) return p.add(`${at}: 형식 오류`);
    if (seriesIds.has(r.id)) return p.add(`${at}: ID가 중복됩니다.`);
    seriesIds.add(r.id);
    if (!oneOf(r.format, ["bo3", "bo5", "free"] as const)) return p.add(`${at}: 형식 값 오류`);
    let name: string | null = null;
    if (r.name !== undefined && r.name !== null) {
      if (typeof r.name !== "string") return p.add(`${at}: 이름 오류`);
      name = cleanName(r.name) || null;
      if (name !== null && [...name].length > SERIES_NAME_MAX) return p.add(`${at}: 이름 오류`);
    }
    const ids = r.matchIds as unknown[];
    if (ids.length === 0) return p.add(`${at}: 속한 경기가 없습니다.`);
    for (const id of ids) {
      if (typeof id !== "string" || !mids.has(id)) return p.add(`${at}: 속한 경기가 파일에 없습니다.`);
      if (inSeries.has(id)) return p.add(`${at}: 한 경기가 두 시리즈에 들어 있습니다.`);
      inSeries.add(id);
    }
    series.push({ id: r.id, name, format: r.format, createdAt: iso(r.createdAt), matchIds: ids as string[] });
  });

  if (p.list.length > 0) return { ok: false, problems: p.list };
  const createdAt = iso(raw.createdAt as string);
  // 형식 1에는 참가자 생성 시각이 없다: 파일 순서를 지키도록 백업 시각에서 1밀리초씩 늘려 채운다.
  const base = Date.parse(createdAt);
  participants.forEach((row, i) => {
    if (row.createdAt === "") row.createdAt = new Date(base + i).toISOString();
  });
  return {
    ok: true,
    data: {
      formatVersion,
      createdAt,
      group,
      currentSettingsVersionId,
      participants,
      sessions,
      matches,
      cycles,
      events,
      adjustments,
      revisions,
      seasons,
      settingsVersions,
      merges,
      importBatches,
      series,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 요약                                                                 */
/* ------------------------------------------------------------------ */

export interface RestoreCounts {
  matches: number;
  confirmed: number;
  participants: number;
}

function countsOf(data: BackupData): RestoreCounts {
  return {
    matches: data.matches.length,
    confirmed: data.matches.filter((m) => m.state === "confirmed").length,
    participants: data.participants.length,
  };
}

async function currentCounts(env: Env, groupId: string): Promise<RestoreCounts> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM matches WHERE group_id = ?1) AS matches,
       (SELECT COUNT(*) FROM matches WHERE group_id = ?1 AND state = 'confirmed') AS confirmed,
       (SELECT COUNT(*) FROM participants WHERE group_id = ?1) AS participants`,
  )
    .bind(groupId)
    .first<RestoreCounts>();
  return row ?? { matches: 0, confirmed: 0, participants: 0 };
}

/** 같은 모임 복구에서 파일의 ID가 다른 모임의 행과 겹치는지 확인한다(손으로 고친 파일 대비). */
async function foreignIdCollision(env: Env, groupId: string, data: BackupData): Promise<string | null> {
  const checks: [string, string[]][] = [
    ["participants", data.participants.map((r) => r.id)],
    ["matches", data.matches.map((r) => r.id)],
    ["sessions", data.sessions.map((r) => r.id)],
    ["rotation_cycles", data.cycles.map((r) => r.id)],
    ["rotation_events", data.events.map((r) => r.id)],
    ["seasons", data.seasons.map((r) => r.id)],
    ["settings_versions", data.settingsVersions.map((r) => r.id)],
    ["participant_merges", data.merges.map((r) => r.id)],
    ["match_series", data.series.map((r) => r.id)],
  ];
  for (const [table, ids] of checks) {
    if (ids.length === 0) continue;
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM ${table} WHERE group_id <> ?1 AND id IN (SELECT value FROM json_each(?2))`,
    )
      .bind(groupId, JSON.stringify(ids))
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) return table;
  }
  return null;
}

export interface RestorePreview {
  ok: boolean;
  problems: string[];
  /** 파일이 이 모임의 백업인지. 아니면 새 모임으로만 가져올 수 있다. */
  sameGroup: boolean;
  file?: RestoreCounts & { groupName: string; createdAt: string; formatVersion: number };
  current: RestoreCounts;
  generation: number;
  confirmText: string;
}

/** 복원 미리보기: 검증 결과와 바뀌는 내용 요약. 아무것도 쓰지 않는다. */
export async function previewRestore(env: Env, groupId: string, req: Request): Promise<RestorePreview> {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["backup"]);
  const group = await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1")
    .bind(groupId)
    .first<{ generation: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  const current = await currentCounts(env, groupId);
  const result = validateBackup(body.backup);
  const base = { current, generation: group.generation, confirmText: RESTORE_CONFIRM_TEXT };
  if (!result.ok) return { ok: false, problems: result.problems, sameGroup: false, ...base };
  const data = result.data;
  const sameGroup = data.group.id === groupId;
  const problems: string[] = [];
  if (sameGroup) {
    const clash = await foreignIdCollision(env, groupId, data);
    if (clash) problems.push("파일의 ID가 다른 모임의 기록과 겹칩니다. 이 파일로는 복원할 수 없습니다.");
  }
  return {
    ok: problems.length === 0,
    problems,
    sameGroup,
    file: {
      ...countsOf(data),
      groupName: data.group.name,
      createdAt: data.createdAt,
      formatVersion: data.formatVersion,
    },
    ...base,
  };
}

/* ------------------------------------------------------------------ */
/* 실행 계획                                                            */
/* ------------------------------------------------------------------ */

/** 문자열의 UTF-8 바이트 수(한글은 글자당 3바이트, 그림 문자 같은 대리 쌍은 4바이트). */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 행들을 JSON 배열 문자열 묶음으로 나눈다. 묶음 하나의 UTF-8 바이트가 maxBytes를 넘지 않게 한다
 * (행 하나가 maxBytes보다 크면 그 행 혼자 한 묶음). 행 하나가 CHUNK_BYTES를 넘으면 D1 값 한도에 걸릴 수 있으므로
 * 아무것도 실행하기 전(계획 단계)에 거절한다.
 */
export function chunkRows(rows: unknown[][], maxBytes: number, table = "행"): { json: string; bytes: number }[] {
  const chunks: { json: string; bytes: number }[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const bytes = utf8Bytes(text);
    if (bytes + 2 > CHUNK_BYTES) {
      throw invalid([`${table} 한 행이 너무 큽니다(${bytes}바이트). 이 파일로는 복원할 수 없습니다.`]);
    }
    if (current.length > 0 && size + bytes + 1 > maxBytes) {
      chunks.push({ json: `[${current.join(",")}]`, bytes: size - 1 });
      current = [];
      size = 2;
    }
    current.push(text);
    size += bytes + 1;
  }
  if (current.length > 0) chunks.push({ json: `[${current.join(",")}]`, bytes: size - 1 });
  return chunks;
}

const col = (i: number) => `json_extract(value, '$[${i}]')`;

/** 표 하나의 행을 json_each로 넣는 문장들. 행 순서를 지킨다(변경 이력의 자동 번호 순서). */
function insertStatements(
  env: Env,
  groupId: string,
  table: string,
  columns: string[],
  rows: unknown[][],
  maxBytes: number,
): { statement: D1PreparedStatement; bytes: number }[] {
  const select = columns.map((_, i) => col(i)).join(", ");
  const sql = `INSERT INTO ${table} (group_id, ${columns.join(", ")})
     SELECT ?1, ${select} FROM json_each(?2) ORDER BY CAST(key AS INTEGER)`;
  return chunkRows(rows, maxBytes, table).map(({ json, bytes }) => ({
    statement: env.DB.prepare(sql).bind(groupId, json),
    bytes,
  }));
}

/** ID 대응표: 새 모임으로 가져올 때 모든 ID를 새로 만든다. 같은 모임 복구는 그대로 쓴다. */
function idMapper(remap: boolean): (id: string) => string {
  if (!remap) return (id) => id;
  const table = new Map<string, string>();
  return (id) => {
    let mapped = table.get(id);
    if (!mapped) {
      mapped = crypto.randomUUID();
      table.set(id, mapped);
    }
    return mapped;
  };
}

/**
 * 변경 이력의 항목에 든 참가자 ID도 새 ID로 바꾼다(새 모임으로 가져올 때).
 * 참가자 정정(participant), 포지션 정정(position:ID), 서포터 차례 정정(rotation:팀)의 값이 참가자 ID다.
 * 바꾸지 않으면 가져온 모임에서 이력의 이름이 비고, 합치기 이력을 묶어 보여주지 못한다.
 */
function remapChanges(changes: string, map: (id: string) => string): string {
  let parsed: Record<string, { from: unknown; to: unknown }>;
  try {
    parsed = JSON.parse(changes) as Record<string, { from: unknown; to: unknown }>;
  } catch {
    return changes;
  }
  const id = (value: unknown) => (typeof value === "string" ? map(value) : value);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "participant" || key.startsWith("rotation:")) {
      out[key] = { from: id(value?.from), to: id(value?.to) };
    } else if (key.startsWith("position:")) {
      out[`position:${map(key.slice(9))}`] = value;
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

function batchBytesOf(env: Env): number {
  const n = Number(env.RESTORE_BATCH_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BATCH_BYTES;
}

/**
 * 복원 실행 계획. stages가 있으면 runMutation이 그 batch들을 먼저 차례로 실행한다.
 * 첫 단계는 작업 잠금 + 세대 확인 + 점검 상태 전환 + 기존 행 삭제, 마지막(plan.statements)은 점검 해제·잠금 해제다.
 * 모든 batch의 맨 앞은 "작업 행의 주인 = 이 실행" 확인이라, 다른 실행이 이어받은 뒤의 늦은 단계는 아무것도 바꾸지 못한다.
 * 단계를 다시 실행해도(같은 요청 ID의 재전송) 첫 단계가 모두 지우고 처음부터 넣으므로 결과가 같다.
 */
async function buildRestorePlan(
  env: Env,
  groupId: string,
  data: BackupData,
  options: { remap: boolean; baseGeneration: number; requestId: string },
): Promise<Plan> {
  const map = idMapper(options.remap);
  const at = nowIso();
  // 오래된 탭이 들고 있는 경기 버전과 겹치지 않게, 같은 모임 복구는 경기 버전을 지금 최대값만큼 올린다.
  const offsetRow = options.remap
    ? null
    : await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM matches WHERE group_id = ?1")
        .bind(groupId)
        .first<{ v: number }>();
  const versionOffset = offsetRow?.v ?? 0;
  const batchMap = new Map<string, string>();
  const batchId = (id: string | null) => {
    if (id === null || !options.remap) return id;
    let mapped = batchMap.get(id);
    if (!mapped) {
      mapped = crypto.randomUUID();
      batchMap.set(id, mapped);
    }
    return mapped;
  };

  const maxBytes = Math.min(CHUNK_BYTES, batchBytesOf(env));
  const inserts = [
    ...insertStatements(env, groupId, "settings_versions", ["id", "version_no", "payload", "created_at"],
      data.settingsVersions.map((v) => [map(v.id), v.versionNo, v.payload, v.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "participants",
      ["id", "name", "name_key", "skill_group", "status", "created_at", "avoid_positions"],
      data.participants.map((r) => [map(r.id), r.name, r.nameKey, r.skillGroup, r.status, r.createdAt, r.avoidPositions]),
      maxBytes),
    ...insertStatements(env, groupId, "sessions", ["id", "started_at", "last_activity_at", "closed_at"],
      data.sessions.map((s) => [map(s.id), s.startedAt, s.lastActivityAt, s.closedAt]), maxBytes),
    ...insertStatements(env, groupId, "matches",
      ["id", "match_no", "session_id", "state", "prev_state", "source", "started_at", "ended_at",
        "played_at", "confirmed_at", "winner_team", "team_a_side", "settings_version_id", "version",
        "import_batch_id", "import_fingerprint", "import_row_key", "memo"],
      data.matches.map((m) => [
        map(m.id), m.matchNo, m.sessionId === null ? null : map(m.sessionId), m.state, m.prevState,
        m.source, m.startedAt, m.endedAt, m.playedAt, m.confirmedAt, m.winnerTeam, m.teamASide,
        m.settingsVersionId === null ? null : map(m.settingsVersionId), m.version + versionOffset,
        batchId(m.importBatchId), m.importFingerprint, m.importRowKey, m.memo,
      ]), maxBytes),
    // 시리즈 묶음: 경기 뒤에 넣는다(경기 외래 키). 시리즈 ID·경기 ID도 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "match_series", ["id", "name", "format", "created_at"],
      data.series.map((r) => [map(r.id), r.name, r.format, r.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "match_series_members", ["series_id", "match_id", "added_at"],
      data.series.flatMap((r) => r.matchIds.map((id) => [map(r.id), map(id), r.createdAt])), maxBytes),
    // 일괄 입력 출처: 묶음 ID는 경기의 import_batch_id와 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "import_batches", ["id", "kind", "source_key", "label", "created_at", "options"],
      data.importBatches.map((b) => [
        batchId(b.id), b.kind, b.sourceKey, b.label, b.createdAt, b.options === null ? null : JSON.stringify(b.options),
      ]), maxBytes),
    ...insertStatements(env, groupId, "match_roster", ["match_id", "participant_id", "team", "position"],
      data.matches.flatMap((m) =>
        m.roster.map((r) => [map(m.id), map(r.participantId), r.team, r.position])), maxBytes),
    ...insertStatements(env, groupId, "rotation_cycles",
      ["id", "session_id", "status", "created_at", "closed_at"],
      data.cycles.map((c) => [map(c.id), map(c.sessionId), c.status, c.createdAt, c.closedAt]), maxBytes),
    ...insertStatements(env, groupId, "rotation_events",
      ["id", "cycle_id", "match_id", "participant_id", "kind", "voided", "created_at"],
      data.events.map((e) => [map(e.id), map(e.cycleId), map(e.matchId), map(e.participantId), e.kind,
        e.voided, e.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "support_adjustments", ["cycle_id", "participant_id", "delta", "updated_at"],
      data.adjustments.map((a) => [a.cycleId === null ? null : map(a.cycleId), map(a.participantId), a.delta,
        a.updatedAt]), maxBytes),
    ...insertStatements(env, groupId, "match_revisions", ["match_id", "kind", "changes", "created_at"],
      data.revisions.map((r) => [map(r.matchId), r.kind, remapChanges(r.changes, map), r.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "seasons", ["id", "name", "starts_on", "ends_on", "created_at"],
      data.seasons.map((s) => [map(s.id), s.name, s.startsOn, s.endsOn, at]), maxBytes),
    // 합치기 기록: 참가자 뒤에 넣는다(참가자 외래 키). 안의 ID 목록도 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "participant_merges",
      ["id", "source_id", "target_id", "source_prev_status", "moved_matches", "rotation_changes",
        "created_at", "undone_at"],
      data.merges.map((m) => [
        map(m.id), map(m.sourceId), map(m.targetId), m.sourcePrevStatus,
        JSON.stringify(m.movedMatches.map(map)),
        JSON.stringify(m.rotationChanges.map((c) => ({
          ...c, id: map(c.id), participantFrom: map(c.participantFrom), participantTo: map(c.participantTo),
        }))),
        m.createdAt, m.undoneAt,
      ]), maxBytes),
  ];

  const guard = env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND generation = ?2)`,
  ).bind(groupId, options.baseGeneration);
  // 작업 잠금: 실행마다 새 표시를 만들고, 모든 batch가 "작업 행의 주인 = 이 실행"을 확인한다.
  const runToken = crypto.randomUUID();
  const claim = claimJob(env, groupId, options.requestId, runToken, at);
  const owner = jobOwnerGuard(env, groupId, runToken);
  // 외래 키 순서대로 지운다. 운영자(group_operators)·조회 토큰·인수 링크는 지우지 않는다.
  const deletes = GROUP_DATA_TABLES.map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE group_id = ?1`).bind(groupId),
  );
  const nextMatchNo = data.matches.reduce((max, m) => Math.max(max, m.matchNo), 0) + 1;
  // 참가자 본인 연결·연결 링크·참가자 요청(migrations/0019)은 백업에 없고 복원이 지우지 않는다.
  // 복원한 기록에 그 참가자(정정 요청이면 그 경기)가 남아 있으면 그대로 두고, 없어졌으면 지운다.
  const cleanupMembers = [
    env.DB.prepare(
      `DELETE FROM participant_links WHERE group_id = ?1
         AND participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)`,
    ).bind(groupId),
    env.DB.prepare(
      `DELETE FROM participant_claims WHERE group_id = ?1
         AND participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)`,
    ).bind(groupId),
    env.DB.prepare(
      `DELETE FROM participant_requests WHERE group_id = ?1
         AND (participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)
           OR (match_id IS NOT NULL AND match_id NOT IN (SELECT id FROM matches WHERE group_id = ?1)))`,
    ).bind(groupId),
  ];
  const finish = [
    ...cleanupMembers,
    env.DB.prepare(
      `UPDATE groups SET name = ?2, timezone = ?3, settings_version_id = ?4, next_match_no = ?5,
         live_version = live_version + 1, generation = generation + 1, maintenance = 0
       WHERE id = ?1`,
    ).bind(groupId, data.group.name, data.group.timezone, map(data.currentSettingsVersionId), nextMatchNo),
    env.DB.prepare("DELETE FROM restore_jobs WHERE group_id = ?1").bind(groupId),
  ];
  const stored = { groupId, ...countsOf(data) };

  const total = inserts.reduce((sum, s) => sum + s.bytes, 0);
  const limit = batchBytesOf(env);
  if (total <= limit) {
    // 한 batch = 한 트랜잭션. 점검 상태로 바꿀 필요 없이 통째로 바뀌거나 아무것도 안 바뀐다.
    // 잠금도 같은 batch 안에서 잡고(claim) 마지막에 지운다(finish): 다른 실행의 여러 단계 복원이 진행 중이면 실패한다.
    return {
      stored,
      statements: [claim, owner, guard, ...deletes, ...inserts.map((s) => s.statement), ...finish],
    };
  }
  // 여러 단계: 잠금 + 점검 상태로 바꾸고 지우기 → 넣기(크기별로 나눔) → 점검 해제.
  // 모든 단계의 맨 앞은 주인 확인(owner)이다. 이 실행이 이어받힌 뒤에는 늦은 단계가 아무것도 넣지 못한다.
  const stages: D1PreparedStatement[][] = [
    [
      claim,
      owner,
      guard,
      env.DB.prepare("UPDATE groups SET maintenance = 1 WHERE id = ?1").bind(groupId),
      ...deletes,
    ],
  ];
  const heartbeat = jobHeartbeat(env, groupId, runToken);
  let current: D1PreparedStatement[] = [owner, heartbeat];
  let size = 0;
  for (const s of inserts) {
    if (size > 0 && size + s.bytes > limit) {
      stages.push(current);
      current = [owner, heartbeat];
      size = 0;
    }
    current.push(s.statement);
    size += s.bytes;
  }
  return { stored, stages, statements: [...current, ...finish], release: [jobRelease(env, groupId, runToken)] };
}

function parseApplyBody(body: Body): { requestId: string; backup: unknown } {
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  if (body.confirm !== RESTORE_CONFIRM_TEXT) {
    throw new ApiError(400, "CONFIRM_REQUIRED", `확인 문구 '${RESTORE_CONFIRM_TEXT}'를 입력해 주세요.`);
  }
  return { requestId, backup: body.backup };
}

function invalid(problems: string[]): ApiError {
  return new ApiError(400, "RESTORE_INVALID", "백업 파일을 검사했더니 문제가 있어 복원하지 않았습니다. 기존 기록은 그대로입니다.", {
    problems,
  });
}

/** 같은 모임 복구. 파일의 모임 ID가 이 모임과 같아야 한다. */
export async function applyRestore(
  env: Env,
  groupId: string,
  req: Request,
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["requestId", "confirm", "baseGeneration", "backup"]);
  const { requestId, backup } = parseApplyBody(body);
  const baseGeneration = requireInt(body.baseGeneration, "baseGeneration");
  const result = validateBackup(backup);
  if (!result.ok) throw invalid(result.problems);
  const data = result.data;
  if (data.group.id !== groupId) {
    throw new ApiError(
      409,
      "OTHER_GROUP_FILE",
      "다른 모임의 백업 파일입니다. 이 모임을 덮어쓰지 않습니다. 새 모임으로 가져오기를 써 주세요.",
    );
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "restore",
    payload: { baseGeneration, backup },
    allowMaintenance: () => canResumeRestore(env, groupId, requestId),
    onStageDone: (i) => restoreHooks.afterStage?.(i),
    conflictDetails: async () => ({
      generation: (
        await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1").bind(groupId).first<{ generation: number }>()
      )?.generation,
    }),
    build: async () => {
      const clash = await foreignIdCollision(env, groupId, data);
      if (clash) throw invalid(["파일의 ID가 다른 모임의 기록과 겹칩니다."]);
      return buildRestorePlan(env, groupId, data, { remap: false, baseGeneration, requestId });
    },
  });
  return stored;
}

/**
 * 새 모임으로 가져오기(빈 환경 포함). 모든 ID를 새로 만든다.
 * 모임 ID는 (계정, 요청 ID)에서 정해지므로 같은 요청을 다시 보내면 같은 모임으로 이어진다.
 */
export async function importAsNewGroup(
  env: Env,
  accountId: string,
  req: Request,
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["requestId", "confirm", "backup"]);
  const { requestId, backup } = parseApplyBody(body);
  const result = validateBackup(backup);
  if (!result.ok) throw invalid(result.problems);
  const data = result.data;

  const hex = await sha256Hex(`import-group\n${accountId}\n${requestId}`);
  const groupId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const existing = await env.DB.prepare(
    "SELECT account_id FROM group_operators WHERE group_id = ?1",
  )
    .bind(groupId)
    .first<{ account_id: string }>();
  if (existing && existing.account_id !== accountId) {
    throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  }
  if (existing) {
    // 이미 있는 모임: 끝나지 않은 가져오기(작업 행이 남음)를 이어서 끝내거나, 끝난 요청의 재전송(요청 기록)이다.
    // 둘 다 아니면 요청 기록이 보관 기간(14일) 뒤 지워진 것이다. 그 사이 쓴 기록을 파일로 덮어쓰지 않게 거절한다.
    const [job, record] = await Promise.all([
      readJob(env, groupId),
      env.DB.prepare("SELECT 1 AS ok FROM requests WHERE group_id = ?1 AND request_id = ?2")
        .bind(groupId, requestId)
        .first<{ ok: number }>(),
    ]);
    // 작업 행은 이 요청이 남긴 것(또는 0008 이전 버전이 남긴 주인 표시 없는 행)이어야 이어서 끝낼 수 있다.
    const ownJob = job !== null && (job.request_id === null || job.request_id === requestId);
    if (!ownJob && !record) {
      throw new ApiError(
        409,
        "REQUEST_EXPIRED",
        "이 가져오기는 이미 끝났고 요청 기록 보관 기간이 지났습니다. 그 모임을 덮어쓰지 않았습니다. 새로 가져오려면 파일을 다시 골라 주세요.",
        { groupId },
      );
    }
  }
  if (!existing) {
    // 계정당 모임 수(대표 + 공동 운영 합계) 한도. src/server/groups.ts
    if ((await accountGroupCount(env, accountId)) >= MAX_GROUPS_PER_ACCOUNT) throw tooManyGroupsError();
    const now = nowIso();
    // 빈 모임을 점검 상태로 먼저 만든다. 가져오기가 끝나야 점검이 풀린다.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO groups (id, name, view_token, maintenance, created_at) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT (id) DO NOTHING`,
      ).bind(groupId, data.group.name, newViewToken(), now),
      env.DB.prepare(
        `INSERT INTO group_operators (group_id, account_id, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id) DO NOTHING`,
      ).bind(groupId, accountId, now),
      // 주인 없는 작업 행: 바로 뒤의 runMutation(또는 같은 요청의 재전송)이 잠금을 잡는다.
      env.DB.prepare(
        `INSERT INTO restore_jobs (group_id, started_at, request_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id) DO NOTHING`,
      ).bind(groupId, now, requestId),
    ]);
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "restore-new-group",
    payload: { backup },
    allowMaintenance: () => canResumeRestore(env, groupId, requestId),
    onStageDone: (i) => restoreHooks.afterStage?.(i),
    build: async () => {
      const generation = await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1")
        .bind(groupId)
        .first<{ generation: number }>();
      return buildRestorePlan(env, groupId, data, {
        remap: true,
        baseGeneration: generation?.generation ?? 0,
        requestId,
      });
    },
  });
  return stored;
}
