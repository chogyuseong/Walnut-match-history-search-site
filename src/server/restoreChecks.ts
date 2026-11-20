/**
 * 백업 파일 검증: 형식 1~4의 파일 전체를 읽어 문제 목록이나 정리한 자료(BackupData)를 돌려준다. DB는 읽지도 쓰지도 않는다.
 * restore.ts(미리보기·같은 모임 복구·새 모임 가져오기)가 쓰고, restoreRows.ts가 행 크기 거절에 invalid를 쓴다.
 * 백업 항목을 새로 만들면 backupExport.ts exportBackup과 여기 검증, restore.ts buildRestorePlan의 넣기를 함께 고친다.
 */
import { encodeAvoid, normalizeAvoidPositions } from "../shared/avoid";
import { LEGACY_SOURCE_KEY, parseLegacyChoice, type LegacyChoice } from "../shared/legacy";
import { MEMO_MAX, memoLength, normalizeMemo } from "../shared/memo";
import { MAX_NAME_LENGTH, cleanName, nameKey } from "../shared/names";
import { SERIES_NAME_MAX } from "../shared/series";
import { isValidTimeZone } from "../shared/stats";
import { MAX_SKILL_GROUP } from "../shared/types";
import { MAX_PARTICIPANTS_PER_GROUP } from "./groups";
import { parseSettings } from "./groupSettings";
import { ApiError } from "./http";

const MAX_MATCHES = 10_000;
const MAX_PROBLEMS = 30;

/** 변경 이력 한 행의 내용(changes) 크기 상한(UTF-8 바이트). 정상 이력은 몇 KB를 넘지 않는다. */
export const MAX_REVISION_CHANGES_BYTES = 16 * 1024;
/** 합치기 기록 한 행(옮긴 경기·차례 변경 목록)의 크기 상한(UTF-8 바이트). */
const MAX_MERGE_ROW_BYTES = 256 * 1024;

export type Body = Record<string, unknown>;

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
  /** 챔피언 키(migrations/0025). 이 항목이 없는 예전 백업은 null. */
  champion: string | null;
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
  /** 지운 시각(migrations/0026). 이 항목이 없는 예전 백업은 null(지운 경기 없음). */
  deletedAt: string | null;
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
  if (rawParticipants.length > MAX_PARTICIPANTS_PER_GROUP) p.add(`참가자가 ${MAX_PARTICIPANTS_PER_GROUP}명을 넘습니다.`);
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
    // 지운 경기(2026-11-11). 진행 중·취소 경기는 지울 수 없으므로(matchRemoval.ts DELETABLE_STATES) 그런 파일은 손댄 것이다.
    if (!isTimeOrNull(r.deletedAt)) return p.add(`${at}: 삭제 시각 오류`);
    if (isTime(r.deletedAt) && (r.state === "in_progress" || r.state === "canceled")) {
      return p.add(`${at}: 진행 중·취소 경기는 지운 상태일 수 없습니다.`);
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
      // 챔피언(2026-11-10). 지금 목록에 있는 키인지는 보지 않고 모양만 본다: 목록에서 이름이 빠진 키가 든 백업도
      // 복원은 되어야 한다(화면은 모르는 키를 키 글자 그대로 보여 준다).
      const champion = e.champion ?? null;
      if (champion !== null && !(typeof champion === "string" && /^[A-Za-z0-9]{1,32}$/.test(champion))) {
        return p.add(`${at}: 챔피언 값 오류`);
      }
      roster.push({ participantId: e.participantId, team: e.team, position: pos as string | null, champion });
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
      deletedAt: isoOrNull(r.deletedAt),
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

export function invalid(problems: string[]): ApiError {
  return new ApiError(400, "RESTORE_INVALID", "백업 파일을 검사했더니 문제가 있어 복원하지 않았습니다. 기존 기록은 그대로입니다.", {
    problems,
  });
}
