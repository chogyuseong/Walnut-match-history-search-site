/**
 * 기존 사이트(v1, Apps Script 웹 앱에 공용 기록을 두던 사이트)의 기록 가져오기.
 *
 * v1은 공용 기록을 Apps Script 웹 앱에서 받았다(v1 storage.js googleRequest):
 *   POST https://script.google.com/macros/s/{배포 ID}/exec, Content-Type: text/plain;charset=utf-8,
 *   본문 {"action":"read"} → {ok, revision, payload}
 * payload 형식은 v1 rules.js의 validPayload·validMatch·validTeams가 정한다. 여기서는 그 규칙을 그대로 옮겨
 * 전체를 검증하고(하나라도 어긋나면 아무것도 가져오지 않는다), 경기만 v2 일괄 입력 형식으로 바꾼다.
 *
 * - 선수 {name, lane}: lane 0~4 = 탑·정글·미드·원딜·서포터, null = 포지션 없음.
 * - blue = 표의 위 5명(팀 A), red = 아래 5명(팀 B). 실제 진영인지는 사용자가 고른다.
 * - trash(휴지통)·featureOptions·auditLog·순환 상태는 가져오지 않는다(수만 알려 준다).
 * 이 파일은 화면·서버 어디에도 기대지 않는 순수 함수만 둔다.
 */
import { FUTURE_TOLERANCE_MS } from "./backfill";
import { cleanName, MAX_NAME_LENGTH, nameKey } from "./names";
import { fingerprinter, hash64, playedAtTimes, type SheetError, type SheetMatch, type SheetPlayer } from "./sheetTable";
import { localDate } from "./stats";
import { POSITIONS, type Position } from "./types";

/* ------------------------------------------------------------------ */
/* 주소                                                                 */
/* ------------------------------------------------------------------ */

const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{20,200}$/;

export type LegacyUrlProblem = "empty" | "not-url" | "not-script";

export const LEGACY_URL_MESSAGES: Record<LegacyUrlProblem, string> = {
  empty: "기존 사이트에서 쓰던 연결 주소를 붙여 넣어 주세요.",
  "not-url": "주소 형식이 아니에요. 연결 주소를 통째로 복사해 붙여 넣어 주세요.",
  "not-script":
    "기존 사이트의 연결 주소가 아니에요. https://script.google.com/macros/s/…/exec 모양의 주소를 붙여 넣어 주세요.",
};

/**
 * Apps Script 웹 앱 주소에서 배포 ID만 뽑는다. 사용자가 준 주소는 절대 그대로 요청하지 않는다(SSRF 방지).
 * 받는 모양: https://script.google.com/macros/s/{ID}/exec (뒤의 ?·#는 무시),
 *           https://script.google.com/a/macros/{도메인}/s/{ID}/exec (회사·학교 계정 배포)
 */
export function parseLegacyUrl(
  input: string,
): { ok: true; deploymentId: string } | { ok: false; problem: LegacyUrlProblem } {
  const text = input.trim();
  if (text === "") return { ok: false, problem: "empty" };
  if (text.length > 2000 || /\s/.test(text)) return { ok: false, problem: "not-url" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: "not-url" };
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "script.google.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return { ok: false, problem: "not-script" };
  }
  const m = /^\/(?:a\/macros\/[A-Za-z0-9.-]{1,100}|macros)\/s\/([^/]+)\/exec\/?$/.exec(url.pathname);
  if (!m || !DEPLOYMENT_ID.test(m[1]!)) return { ok: false, problem: "not-script" };
  return { ok: true, deploymentId: m[1]! };
}

/** 주소 칸에 넣은 글이 Apps Script 주소처럼 보이는지(시트 주소 칸에서 자동으로 판별할 때). */
export function looksLikeLegacyUrl(input: string): boolean {
  return /(^|\/\/)script\.google\.com\//i.test(input.trim());
}

/** 서버가 요청할 주소. ID는 parseLegacyUrl로 검증한 값만 받는다. */
export function legacyExecUrl(deploymentId: string): string {
  if (!DEPLOYMENT_ID.test(deploymentId)) throw new Error("invalid deployment id");
  return `https://script.google.com/macros/s/${deploymentId}/exec`;
}

/** 묶음 출처 열쇠. 시트 ID와 같이 조회 응답(스냅숏)에는 내보내지 않는다. */
export function legacySourceKey(deploymentId: string): string {
  return `legacy:${deploymentId}`;
}

export const LEGACY_SOURCE_KEY = /^legacy:[A-Za-z0-9_-]{20,200}$/;

/** 리디렉션을 따라가도 되는 호스트(정확히 일치). 실제 응답: script.google.com → 302 → script.googleusercontent.com */
export function isLegacyRedirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "script.google.com" || host === "script.googleusercontent.com";
}

/* ------------------------------------------------------------------ */
/* v1 형식 검증(v1 rules.js·balance.js를 그대로 옮김)                       */
/* ------------------------------------------------------------------ */

export interface LegacyPlayer {
  name: string;
  lane: number | null;
}

export interface LegacyMatch {
  id: string;
  time: number;
  blue: LegacyPlayer[];
  red: LegacyPlayer[];
  winner: "blue" | "red";
  /** v1에서 진영을 아는 경기인지. 없으면 안다고 본다(v1 기본값). */
  sidesKnown?: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** v1 validTeams. allowUnknown이면 lane null(포지션 없음)을 받는다. */
export function validLegacyTeams(v: unknown, allowUnknown = false): boolean {
  if (!isObj(v)) return false;
  const names: string[] = [];
  return (
    (["blue", "red"] as const).every((t) => {
      const team = v[t];
      if (!Array.isArray(team) || team.length !== 5) return false;
      const ok = team.every((x: unknown) => {
        if (
          !isObj(x) ||
          typeof x.name !== "string" ||
          !x.name.trim() ||
          x.name.length > 40 ||
          !((allowUnknown && x.lane === null) || (Number.isInteger(x.lane) && (x.lane as number) >= 0 && (x.lane as number) < 5))
        ) {
          return false;
        }
        names.push(x.name.trim().normalize("NFC").toLocaleLowerCase());
        return true;
      });
      if (!ok) return false;
      const lanes = (team as Obj[]).filter((x) => x.lane !== null).map((x) => x.lane);
      return new Set(lanes).size === lanes.length;
    }) && new Set(names).size === 10
  );
}

/** v1 validMatch. */
export function validLegacyMatch(m: unknown): m is LegacyMatch {
  return (
    isObj(m) &&
    typeof m.id === "string" &&
    m.id.length > 0 &&
    m.id.length <= 100 &&
    typeof m.time === "number" &&
    Number.isFinite(m.time) &&
    (m.winner === "blue" || m.winner === "red") &&
    validLegacyTeams(m, true)
  );
}

const balanceName = (value: string) => String(value).trim().normalize("NFC");
const balanceNameKey = (value: string) => balanceName(value).toLowerCase();

/** v1 validLegacyElite(balance.js). */
function validElite(values: unknown): boolean {
  return (
    Array.isArray(values) &&
    values.length <= 100 &&
    values.every((n) => typeof n === "string" && n.trim().length > 0 && n.length <= 40) &&
    new Set(values.map((n: string) => n.toLowerCase())).size === values.length
  );
}

/** v1 validBalanceNames(balance.js). */
function validBalanceNames(values: unknown): values is string[] {
  return (
    Array.isArray(values) &&
    values.length <= 100 &&
    values.every((n) => typeof n === "string" && n === balanceName(n) && n.length > 0 && n.length <= 40) &&
    new Set(values.map(balanceNameKey)).size === values.length
  );
}

/** v1 validSkillGroups(balance.js, BALANCE_RULES version 2 · 가중치 4개). */
function validSkillGroups(value: unknown): boolean {
  if (!isObj(value) || ![1, 2].includes(value.version as number) || !Array.isArray(value.groups)) return false;
  if (value.groups.length !== (value.version === 1 ? 3 : 4) || !value.groups.every(validBalanceNames)) return false;
  const all = (value.groups as string[][]).flat();
  return all.length <= 100 && new Set(all.map(balanceNameKey)).size === all.length;
}

/**
 * v1 validPayload. 문제가 있으면 어디가 틀렸는지 한 문장으로 돌려준다(없으면 null).
 * v1의 validReport는 소스에 정의가 없어(reports가 있으면 v1도 오류) 여기서는 "id가 겹치지 않는 객체 200개 이하"로 본다.
 */
export function legacyPayloadProblem(v: unknown): string | null {
  if (!isObj(v)) return "기록 묶음이 비어 있어요.";
  if (!Array.isArray(v.matches)) return "경기 목록이 없어요.";
  if (v.matches.length > 20000) return "경기가 20,000개를 넘어요.";
  if (!(v.resetAt === null || v.resetAt === undefined || (typeof v.resetAt === "number" && Number.isFinite(v.resetAt)))) {
    return "순환 시작 시각 값이 올바르지 않아요.";
  }
  if (v.resetAt === undefined) return "순환 시작 시각 값이 없어요.";
  if (v.schemaVersion !== undefined && v.schemaVersion !== 1 && v.schemaVersion !== 2) return "형식 버전이 1·2가 아니에요.";
  if (v.featureOptions !== undefined) {
    const f = v.featureOptions;
    if (!isObj(f)) return "기능 설정 값이 올바르지 않아요.";
    if (f.elite !== undefined && !validElite(f.elite)) return "상위권 이름 목록이 올바르지 않아요.";
    if (Object.prototype.hasOwnProperty.call(f, "skillGroups") && !validSkillGroups(f.skillGroups)) {
      return "실력 그룹 설정이 올바르지 않아요.";
    }
  }
  if (v.reports !== undefined) {
    const r = v.reports;
    if (!Array.isArray(r) || r.length > 200 || !r.every((x) => isObj(x) && typeof x.id === "string")) {
      return "보고 목록이 올바르지 않아요.";
    }
    if (new Set(r.map((x: Obj) => x.id)).size !== r.length) return "보고 목록에 겹치는 id가 있어요.";
  }
  const ids = new Set<string>();
  for (let i = 0; i < v.matches.length; i++) {
    const m = v.matches[i];
    if (!validLegacyMatch(m)) return `${i + 1}번째 경기의 형식이 올바르지 않아요(10명·이름 1~40자·라인 0~4·이긴 쪽).`;
    if (ids.has(m.id)) return `${i + 1}번째 경기의 id가 앞의 경기와 겹쳐요.`;
    ids.add(m.id);
  }
  if (v.cyclePending !== undefined && v.cyclePending !== null && !validLegacyTeams(v.cyclePending)) {
    return "진행 중이던 팀 구성이 올바르지 않아요.";
  }
  if (v.trash !== undefined) {
    const t = v.trash;
    if (!Array.isArray(t) || t.length > 20000 || !t.every(validLegacyMatch)) return "휴지통 경기의 형식이 올바르지 않아요.";
    if (new Set(t.map((m) => m.id)).size !== t.length) return "휴지통 경기의 id가 겹쳐요.";
  }
  if (v.auditLog !== undefined) {
    const a = v.auditLog;
    if (
      !Array.isArray(a) ||
      a.length > 200 ||
      !a.every(
        (x) =>
          isObj(x) &&
          typeof x.time === "number" &&
          Number.isFinite(x.time) &&
          typeof x.kind === "string" &&
          x.kind.length <= 80 &&
          Number.isInteger(x.before) &&
          Number.isInteger(x.after),
      )
    ) {
      return "변경 기록 형식이 올바르지 않아요.";
    }
  }
  return null;
}

export function validLegacyPayload(v: unknown): boolean {
  return legacyPayloadProblem(v) === null;
}

/** 가져오지 않는 값의 요약(화면에 한 줄로 알린다). */
export interface LegacySummary {
  matches: number;
  trash: number;
  elite: number;
  skillGroups: boolean;
  auditLog: number;
  reports: number;
  /** 순환·서포터 차례·진행 중 팀 구성 같은 진행 상태가 있었는지. */
  progress: boolean;
}

export function legacySummary(v: Obj): LegacySummary {
  const fo = isObj(v.featureOptions) ? v.featureOptions : {};
  return {
    matches: Array.isArray(v.matches) ? v.matches.length : 0,
    trash: Array.isArray(v.trash) ? v.trash.length : 0,
    elite: Array.isArray(fo.elite) ? fo.elite.length : 0,
    skillGroups: Object.prototype.hasOwnProperty.call(fo, "skillGroups"),
    auditLog: Array.isArray(v.auditLog) ? v.auditLog.length : 0,
    reports: Array.isArray(v.reports) ? v.reports.length : 0,
    progress:
      (v.cyclePending !== undefined && v.cyclePending !== null) ||
      (isObj(v.cycleUsed) && Object.keys(v.cycleUsed).length > 0) ||
      (isObj(v.supportUsed) && Object.keys(v.supportUsed).length > 0) ||
      typeof v.resetAt === "number",
  };
}

/** 화면에 보일 "가져오지 않는 것" 한 줄. */
export function legacySkippedText(s: LegacySummary): string {
  const parts: string[] = [];
  if (s.trash > 0) parts.push(`휴지통의 ${s.trash}경기`);
  if (s.elite > 0) parts.push(`상위권 이름 ${s.elite}개`);
  if (s.skillGroups) parts.push("실력 그룹 설정");
  if (s.progress) parts.push("진행 상태(순환·서포터 차례)");
  if (s.auditLog > 0) parts.push(`변경 기록 ${s.auditLog}건`);
  if (s.reports > 0) parts.push(`보고 ${s.reports}건`);
  return parts.length === 0
    ? "경기 기록만 가져와요."
    : `경기 기록만 가져와요. 가져오지 않는 것: ${parts.join(", ")}.`;
}

/** 서버가 화면으로 보내는 경기(필요한 값만). */
export function trimLegacyMatch(m: LegacyMatch): LegacyMatch {
  return {
    id: m.id,
    time: m.time,
    blue: m.blue.map((p) => ({ name: p.name, lane: p.lane })),
    red: m.red.map((p) => ({ name: p.name, lane: p.lane })),
    winner: m.winner,
    sidesKnown: m.sidesKnown !== false,
  };
}

/* ------------------------------------------------------------------ */
/* v2 경기로 바꾸기                                                      */
/* ------------------------------------------------------------------ */

/** 옮기기 기준: 이 날짜(포함)부터의 경기와 아직 오지 않은 경기를 한 해 앞으로 옮기거나 뺀다. */
export type LegacyFutureMode = "shift" | "drop";

export interface LegacyOptions {
  /** 모임 시간대. 정오가 아닌 v1 시각은 이 시간대의 날짜·시각으로 읽는다. */
  timeZone: string;
  now: number;
  /** null이면 아직 고르지 않음(옮길 경기가 있으면 넣을 수 없다). */
  futureMode: LegacyFutureMode | null;
  /** 기준 날짜(YYYY-MM-DD, 포함). null이면 아직 오지 않은 경기만. */
  from: string | null;
}

export interface LegacyConverted extends SheetMatch {
  /** v1 경기 id. */
  id: string;
  /** v1에 적힌 날짜(옮기기 전). */
  originalDate: string;
  shifted: boolean;
}

export interface LegacyConversion {
  matches: LegacyConverted[];
  errors: SheetError[];
  names: string[];
  /** 지금 시각 기준으로 아직 오지 않은 경기. */
  future: { count: number; first: string | null; last: string | null };
  /** 기준에 걸린 경기(옮기거나 뺄 경기). */
  affected: { count: number; first: string | null; last: string | null };
  /** 옮긴 뒤 날짜 범위(옮기기일 때). */
  shiftedRange: { first: string | null; last: string | null };
  /** 뺀 경기 수(빼기일 때). */
  dropped: number;
  /** 옮기거나 뺄 경기가 있는데 아직 고르지 않았다. */
  needsChoice: boolean;
}

/** v1 시각(밀리초)이 한국 시간 정오 정각인지. v1 표 가져오기는 늘 그 시각으로 넣었다. */
function isSeoulNoon(time: number): boolean {
  return (time - 3 * 3600_000) % 86_400_000 === 0;
}

function hourMinute(time: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(
    new Date(time),
  );
}

/** 한 해 앞으로(1년 빼기). 2월 29일처럼 그 해에 없는 날이면 null. */
export function yearEarlier(date: string): string | null {
  const y = Number(date.slice(0, 4)) - 1;
  const text = `${String(y).padStart(4, "0")}${date.slice(4)}`;
  const d = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text ? null : text;
}

/** 줄 위치 열쇠: v1 경기 id(아무 글자나 올 수 있어 해시로 줄인다). 같은 id인데 내용이 바뀐 경기를 "바뀐 줄"로 찾는다. */
export function legacyRowKey(id: string): string {
  return `v1id:${hash64(id)}`;
}

const LANE_OF = (lane: number | null): Position | null => (lane === null ? null : POSITIONS[lane]!);

/**
 * v1 경기를 v2 일괄 입력용 경기로 바꾼다.
 * - 날짜: v1 시각이 한국 시간 정오면(표로 넣은 경기) 한국 날짜만 쓰고 시각은 없음 → v2 규칙대로 모임 시간대 정오.
 *   그 밖의 시각(v1에서 바로 기록한 경기)은 모임 시간대의 날짜와 HH:MM.
 * - 순서: 날짜순, 같은 날은 v1 배열 순서(v1은 시각순으로 정렬해 저장했다). 지문의 "같은 날 n번째"와
 *   경기 시각의 1초씩 늦추기도 이 순서를 따른다(시트·붙여 넣기와 같은 함수).
 * - 지문: 시트 가져오기와 같은 fingerprinter. 붙여 넣기·시트로 넣은 같은 경기와 겹치지 않는다.
 */
export function convertLegacy(matches: readonly LegacyMatch[], options: LegacyOptions): LegacyConversion {
  const errors: SheetError[] = [];
  type Base = {
    index: number;
    m: LegacyMatch;
    date: string;
    time: string | null;
    teamA: SheetPlayer[];
    teamB: SheetPlayer[];
  };
  const bases: Base[] = [];
  matches.forEach((m, index) => {
    const line = index + 1;
    const noon = isSeoulNoon(m.time);
    const iso = new Date(m.time).toISOString();
    const date = noon ? localDate(iso, "Asia/Seoul") : localDate(iso, options.timeZone);
    const time = noon ? null : hourMinute(m.time, options.timeZone);
    const team = (players: LegacyPlayer[]) => players.map((p) => ({ name: cleanName(p.name), position: LANE_OF(p.lane) }));
    const teamA = team(m.blue);
    const teamB = team(m.red);
    const all = [...teamA, ...teamB];
    const tooLong = all.find((p) => [...p.name].length > MAX_NAME_LENGTH);
    if (tooLong) {
      errors.push({ line, where: `${line}번째 경기(${date})`, message: `'${tooLong.name}'는 ${MAX_NAME_LENGTH}자를 넘어요. 기존 사이트에서 이름을 줄인 뒤 다시 읽어 주세요.` });
      return;
    }
    const keys = new Set(all.map((p) => nameKey(p.name)));
    if (keys.size !== 10) {
      errors.push({ line, where: `${line}번째 경기(${date})`, message: "띄어쓰기만 다른 같은 이름이 한 경기에 두 번 있어요." });
      return;
    }
    bases.push({ index, m, date, time, teamA, teamB });
  });

  // 아직 오지 않은 경기(지금 시각 기준). 서버의 FUTURE_MATCH와 같은 기준이다.
  const limit = options.now + FUTURE_TOLERANCE_MS;
  const futureAt = playedAtTimes(bases, options.timeZone).map((t) => Date.parse(t) > limit);
  const futureDates = bases.filter((_, i) => futureAt[i]).map((b) => b.date).sort();
  const isAffected = (b: Base, i: number) => futureAt[i]! || (options.from !== null && b.date >= options.from);
  const affectedDates = bases.filter(isAffected).map((b) => b.date).sort();
  const needsChoice = affectedDates.length > 0 && options.futureMode === null;

  type Placed = Base & { newDate: string; shifted: boolean };
  const placed: Placed[] = [];
  let dropped = 0;
  bases.forEach((b, i) => {
    if (!isAffected(b, i)) {
      placed.push({ ...b, newDate: b.date, shifted: false });
      return;
    }
    if (options.futureMode !== "shift") {
      dropped += 1;
      return;
    }
    const earlier = yearEarlier(b.date);
    if (earlier === null) {
      errors.push({ line: b.index + 1, where: `${b.index + 1}번째 경기(${b.date})`, message: `${b.date}를 한 해 앞으로 옮기면 없는 날짜(2월 29일)가 돼요.` });
      return;
    }
    placed.push({ ...b, newDate: earlier, shifted: true });
  });
  // 날짜순, 같은 날은 v1 배열 순서.
  placed.sort((x, y) => (x.newDate < y.newDate ? -1 : x.newDate > y.newDate ? 1 : x.index - y.index));

  // 옮긴 뒤에도 아직 오지 않은 경기는 틀린 줄이다.
  const afterAt = playedAtTimes(
    placed.map((p) => ({ date: p.newDate, time: p.time })),
    options.timeZone,
  ).map((t) => Date.parse(t) > limit);

  const fingerprintOf = fingerprinter();
  const perDay = new Map<string, number>();
  const out: LegacyConverted[] = [];
  placed.forEach((p, k) => {
    const orderInDay = (perDay.get(p.newDate) ?? 0) + 1;
    perDay.set(p.newDate, orderInDay);
    const winner = p.m.winner === "blue" ? "A" : "B";
    const fingerprint = fingerprintOf({ date: p.newDate, time: p.time, teamA: p.teamA, teamB: p.teamB, winner });
    if (afterAt[k]) {
      errors.push({
        line: p.index + 1,
        where: `${p.index + 1}번째 경기(${p.date})`,
        message: p.shifted
          ? `한 해 앞으로 옮긴 ${p.newDate}도 아직 오지 않은 날짜예요.`
          : `${p.newDate}는 아직 오지 않은 날짜예요.`,
      });
      return;
    }
    out.push({
      id: p.m.id,
      originalDate: p.date,
      shifted: p.shifted,
      line: out.length + 1,
      lines: [p.index + 1],
      where: `${p.index + 1}번째 경기`,
      date: p.newDate,
      time: p.time,
      yearGuessed: false,
      teamA: p.teamA,
      teamB: p.teamB,
      winner,
      // "기존 사이트의 블루·레드 그대로"를 고르면 팀 A(blue)가 블루. v1에서 진영을 모른다고 한 경기는 미상.
      sideA: p.m.sidesKnown === false ? null : "blue",
      orderInDay,
      fingerprint,
      rowKey: legacyRowKey(p.m.id),
    });
  });
  errors.sort((x, y) => x.line - y.line);
  const names = new Map<string, string>();
  for (const m of out) for (const p of [...m.teamA, ...m.teamB]) if (!names.has(nameKey(p.name))) names.set(nameKey(p.name), p.name);
  const shiftedDates = out.filter((m) => m.shifted).map((m) => m.date).sort();
  return {
    matches: out,
    errors,
    names: [...names.values()],
    future: { count: futureDates.length, first: futureDates[0] ?? null, last: futureDates[futureDates.length - 1] ?? null },
    affected: { count: affectedDates.length, first: affectedDates[0] ?? null, last: affectedDates[affectedDates.length - 1] ?? null },
    shiftedRange: { first: shiftedDates[0] ?? null, last: shiftedDates[shiftedDates.length - 1] ?? null },
    dropped,
    needsChoice,
  };
}

/** 묶음에 남기는 선택(다시 가져올 때 같은 기준을 기본으로 쓴다). */
export interface LegacyChoice {
  futureMode: LegacyFutureMode | null;
  from: string | null;
}

export function parseLegacyChoice(value: unknown): LegacyChoice | null {
  if (!isObj(value)) return null;
  const mode = value.futureMode;
  const from = value.from;
  if (!(mode === null || mode === "shift" || mode === "drop")) return null;
  if (!(from === null || (typeof from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(from)))) return null;
  return { futureMode: mode, from };
}
