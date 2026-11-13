import { searchPeople } from "./search";
import type { MatchView, Settings, Snapshot } from "./types";

/**
 * 통계는 저장하지 않고 유효 확정 경기에서 매번 계산한다(docs/P2 P2-11).
 * 유효 확정 경기 = 상태가 결과 확정인 경기. 대기·취소·제외 경기는 세지 않는다.
 */
/**
 * 배치 경기 수 기본값. 누적 확정 경기가 이 수 이상이면 배치 완료(칭호, MMR K가 배치 뒤 값으로, 랭킹 묶음, 예상 신뢰 판정).
 * 모임 설정(Settings.placementGames)에 값이 없으면 이 값을 쓴다. 바꾸면 그 설정을 저장하지 않은 모든 모임의 배치가 달라진다.
 */
export const PLACEMENT_GAMES_DEFAULT = 10;
/** 기본값의 옛 이름(테스트·기본 인자용). 계산은 placementGamesOf(settings)로 읽은 값을 넘겨 쓴다. */
export const PLACEMENT_GAMES = PLACEMENT_GAMES_DEFAULT;
/** 설정에서 고를 수 있는 배치 경기 수 범위. 서버 검증과 설정 화면 입력 칸이 같이 쓴다. */
export const PLACEMENT_GAMES_MIN = 1;
export const PLACEMENT_GAMES_MAX = 30;

/** 모임 설정의 배치 경기 수. 저장한 적이 없으면 기본값이다. */
export function placementGamesOf(settings: Pick<Settings, "placementGames">): number {
  return settings.placementGames ?? PLACEMENT_GAMES_DEFAULT;
}

export function isCounted(match: MatchView): boolean {
  return match.state === "confirmed" && match.winnerTeam !== null;
}

export interface PersonRecord {
  participantId: string;
  games: number;
  wins: number;
  losses: number;
}

/** 주어진 경기들에서 사람별 승·패를 센다. 진영 미상 경기도 승패에는 들어간다. */
export function personRecords(matches: readonly MatchView[]): Map<string, PersonRecord> {
  const records = new Map<string, PersonRecord>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      let record = records.get(entry.participantId);
      if (!record) {
        record = { participantId: entry.participantId, games: 0, wins: 0, losses: 0 };
        records.set(entry.participantId, record);
      }
      record.games += 1;
      if (entry.team === match.winnerTeam) record.wins += 1;
      else record.losses += 1;
    }
  }
  return records;
}

export interface Placement {
  /** 모임 전체 누적 유효 확정 경기 수. 시즌·오늘 필터로 바뀌지 않는다. */
  games: number;
  done: boolean;
}

/** 배치 상태. 항상 모임 전체 누적 기준이다. */
export function placements(
  allMatches: readonly MatchView[],
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): Map<string, Placement> {
  const result = new Map<string, Placement>();
  for (const [id, record] of personRecords(allMatches)) {
    result.set(id, { games: record.games, done: record.games >= placementGames });
  }
  return result;
}

/** "오늘"은 가장 최근 세션이다. 열린 세션이 있으면 그것, 없으면 마지막으로 경기한 세션. */
export function latestSessionId(snapshot: Snapshot): string | null {
  if (snapshot.session) return snapshot.session.id;
  let latest: MatchView | null = null;
  for (const match of snapshot.matches) {
    if (match.sessionId === null || match.state === "canceled") continue;
    if (!latest || match.playedAt > latest.playedAt) latest = match;
  }
  return latest?.sessionId ?? null;
}

/** 오늘의 경기: 가장 최근 세션의 경기 중 취소되지 않은 것(확정·대기·진행 중·제외). */
export function todayMatches(snapshot: Snapshot): MatchView[] {
  const sessionId = latestSessionId(snapshot);
  if (!sessionId) return [];
  return snapshot.matches
    .filter((m) => m.sessionId === sessionId && m.state !== "canceled")
    .sort((a, b) => a.matchNo - b.matchNo);
}

/** 모임 시간대가 없거나 이 기기가 모르는 값일 때 쓰는 시간대. */
export const DEFAULT_TIME_ZONE = "Asia/Seoul";
const zoneChecks = new Map<string, boolean>();

/** Intl이 받아들이는 시간대 이름인지(실제로 만들어 본다). 백업 복원 검증과 화면 방어가 함께 쓴다. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  let ok = zoneChecks.get(value);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value });
      ok = true;
    } catch {
      ok = false;
    }
    zoneChecks.set(value, ok);
  }
  return ok;
}

/** 잘못된 시간대가 이미 저장돼 있어도 화면이 깨지지 않게(RangeError) 기본 시간대로 바꿔 쓴다. */
export function safeTimeZone(value: unknown): string {
  return isValidTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * 날짜 포매터를 언어·옵션(시간대 포함)별로 한 번만 만들어 다시 쓴다. Intl.DateTimeFormat은 만드는 비용이 커서
 * 통계·목록처럼 경기마다 부르는 곳에서 호출마다 새로 만들면 느려진다. 시간대는 부르는 쪽이 safeTimeZone으로 거른다.
 */
export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, format);
  }
  return format;
}

/** 주어진 시각의 모임 표시 시간대 날짜(YYYY-MM-DD). */
export function localDate(iso: string, timeZone: string): string {
  return dateTimeFormat("en-CA", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * 주어진 시각을 모임 표시 시간대의 날짜·시각 입력값("YYYY-MM-DDTHH:mm", datetime-local 칸의 형식)으로 바꾼다.
 * 기기 시간대가 아니라 모임 시간대로 읽는다. zonedInputToUtc와 짝이다.
 */
export function zonedDateTimeInput(iso: string, timeZone: string): string {
  const parts = dateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/**
 * 날짜·시각 입력값("YYYY-MM-DDTHH:mm")을 모임 표시 시간대의 시각으로 보고 UTC ISO 시각으로 바꾼다.
 * 형식이 맞지 않으면 null. zonedDateTimeInput과 짝이다.
 */
export function zonedInputToUtc(input: string, timeZone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(input);
  if (!match) return null;
  const iso = zonedTimeToUtc(match[1]!, match[2]!, timeZone);
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/**
 * 모임 표시 시간대의 날짜·시각(YYYY-MM-DD, HH:mm)을 UTC ISO 시각으로 바꾼다.
 * 지난 경기 입력에서 사용자가 고른 날짜·시각을 모임 시간대 기준으로 해석할 때 쓴다.
 * 시간대 규칙(서머타임 등)은 Intl에 맡긴다. 없는 시각(서머타임으로 건너뛴 시각)은 가까운 시각이 된다.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, mo - 1, d, h, mi);
  // 그 시각을 UTC로 가정했을 때 모임 시간대에서 몇 시로 보이는지로 시차를 구한다. 두 번 맞춘다.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const parts = dateTimeFormat("en-US", {
      timeZone: safeTimeZone(timeZone),
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date(guess));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const shown = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    guess += wanted - shown;
  }
  return new Date(guess).toISOString();
}

export type Scope =
  | { kind: "all" }
  | { kind: "today" }
  | { kind: "season"; seasonId: string }
  | { kind: "year"; year: number };

/** 모임 시간대 기준 연도. 12월 31일 밤 경기가 UTC로 다음 해여도 모임의 달력을 따른다. */
export function localYear(iso: string, timeZone: string): number {
  return Number(localDate(iso, timeZone).slice(0, 4));
}

/** 경기가 있는 연도(최근 연도부터). 연도 필터는 이 목록에서만 고를 수 있다. 취소 경기는 세지 않는다. */
export function matchYears(snapshot: Snapshot): number[] {
  const years = new Set<number>();
  for (const m of snapshot.matches) {
    if (m.state === "canceled") continue;
    years.add(localYear(m.playedAt, snapshot.group.timezone));
  }
  return [...years].sort((a, b) => b - a);
}

/** 범위 이름. 화면 제목과 안내 문구에 쓴다. */
export function scopeLabel(snapshot: Snapshot, scope: Scope): string {
  if (scope.kind === "today") return "오늘";
  if (scope.kind === "all") return "전체";
  if (scope.kind === "year") return `${scope.year}년`;
  return snapshot.seasons.find((s) => s.id === scope.seasonId)?.name ?? "시즌";
}

/**
 * 범위(전체·시즌·연도·오늘)에 속하는 경기. 취소된 경기는 어느 범위에도 넣지 않는다.
 * 배치와 칭호는 이 필터를 거치지 않고 항상 전체 누적으로 계산한다.
 */
export function matchesInScope(snapshot: Snapshot, scope: Scope): MatchView[] {
  if (scope.kind === "today") return todayMatches(snapshot);
  const visible = snapshot.matches.filter((m) => m.state !== "canceled");
  if (scope.kind === "all") return visible;
  if (scope.kind === "year") {
    return visible.filter((m) => localYear(m.playedAt, snapshot.group.timezone) === scope.year);
  }
  const season = snapshot.seasons.find((s) => s.id === scope.seasonId);
  if (!season) return [];
  return visible.filter((m) => {
    const date = localDate(m.playedAt, snapshot.group.timezone);
    return date >= season.startsOn && date <= season.endsOn;
  });
}

/** 적은 표본 기준. 이보다 적으면 승률 옆에 "자료 적음"을 붙인다. */
export const SMALL_SAMPLE = 5;

/**
 * 정수 num/den의 scale배를 반올림한 정수(0.5는 0에서 먼 쪽으로). den은 양의 정수.
 * 소수로 나눈 뒤 반올림하면 23/40(57.5%)이 57.49999…로 계산돼 57이 되는 것 같은 오차가 생겨 정수로만 센다.
 * 부호가 대칭이다: -12.5 → -13, 12.5 → 13.
 */
export function roundRatio(num: number, den: number, scale = 100): number {
  if (den <= 0) return 0;
  const n = BigInt(Math.abs(num)) * BigInt(scale) * 2n + BigInt(den);
  const value = Number(n / (2n * BigInt(den)));
  return num < 0 ? -value : value;
}

/**
 * 화면에 보이는 정수 승률(%). 0.5%는 올린다(57.5% → 58%). 경기가 없으면 0.
 * 보이는 숫자·색 단계(rateHeat)·칭호 경계(titleFor)가 모두 이 값 하나로 비교해, 보이는 숫자와 색·칭호가 어긋나지 않는다.
 * 식: Math.floor((200 × 승 + 경기) / (2 × 경기)).
 */
export function ratePercent(wins: number, games: number): number {
  if (games <= 0) return 0;
  return Math.floor((200 * wins + games) / (2 * games));
}

/**
 * 비율(0~1 소수)을 정수 %로. 승·경기 수 없이 비율만 있을 때(그래프의 점) 쓴다.
 * 소수 오차(0.575 × 100 = 57.49999…)를 지우려고 유효 숫자 12자리로 다듬은 뒤 반올림한다.
 */
export function fractionPercent(rate: number): number {
  return Math.round(Number((rate * 100).toPrecision(12)));
}

export interface Tally {
  games: number;
  wins: number;
}

/* ------------------------------------------------------------------ */
/* 우연 확률: 분석 코멘트(commentary.ts)가 표본이 작은 차이를 사실처럼 말하지 않게 거르는 데 쓴다      */
/* ------------------------------------------------------------------ */

// log(n!)을 차례로 쌓아 둔다. 한 모임의 경기 수(수천)를 넘지 않으니 필요할 때 늘린다.
const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactorials.length; i <= n; i++) logFactorials.push(logFactorials[i - 1]! + Math.log(i));
  return logFactorials[n]!;
}
const logChoose = (n: number, k: number) => logFactorial(n) - logFactorial(k) - logFactorial(n - k);

/** 확률이 같은 결과를 "같다"로 볼 여유. 부동소수 오차로 관찰값 자신이 빠지지 않게 한다. */
const SAME_PROBABILITY = 1 + 1e-7;

/**
 * 승률이 정말 p인 사람이 games판을 했을 때, 관찰한 wins만큼 또는 그보다 더 드문 결과가 나올 확률(양쪽).
 * 예: 4판 0승은 p = 0.5에서 12.5%다(0승·4승 각각 6.25%). 1에 가까울수록 우연으로 설명된다.
 */
export function binomialChance(wins: number, games: number, p = 0.5): number {
  if (games <= 0) return 1;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  const prob = (k: number) => Math.exp(logChoose(games, k) + k * logP + (games - k) * logQ);
  const observed = prob(wins) * SAME_PROBABILITY;
  let total = 0;
  for (let k = 0; k <= games; k++) {
    const pk = prob(k);
    if (pk <= observed) total += pk;
  }
  return Math.min(1, total);
}

/**
 * 두 묶음(예: 블루일 때·레드일 때)의 승률이 실제로는 같은데 지금만큼 이상 벌어질 확률(피셔 정확 검정, 양쪽).
 * 두 묶음의 승 수 합을 고정하고, 그 승이 a 쪽에 몇 개 몰리는지가 초기하분포를 따른다는 계산이다.
 * 표본이 작을수록 큰 차이도 쉽게 우연으로 나온다(8판 대 8판의 75% vs 38%는 약 32%).
 */
export function rateGapChance(a: Tally, b: Tally): number {
  const games = a.games + b.games;
  const wins = a.wins + b.wins;
  if (a.games <= 0 || b.games <= 0) return 1;
  const prob = (x: number) =>
    Math.exp(logChoose(wins, x) + logChoose(games - wins, a.games - x) - logChoose(games, a.games));
  const observed = prob(a.wins) * SAME_PROBABILITY;
  let total = 0;
  for (let x = Math.max(0, a.games - (games - wins)); x <= Math.min(wins, a.games); x++) {
    const px = prob(x);
    if (px <= observed) total += px;
  }
  return Math.min(1, total);
}

export interface PairTally extends Tally {
  participantId: string;
}

export interface PersonDetail {
  participantId: string;
  summary: PersonRecord;
  /** 범위 안에서 가장 최근 경기부터. 실제 집계한 경기 수는 games에 있다. */
  recent10: Tally;
  recent20: Tally;
  /** 포지션 기록이 있는 경기만. 기록이 없는 라인은 키가 없다(0%가 아니라 "기록 없음"). */
  byPosition: Partial<Record<string, Tally>>;
  positionUnknown: number;
  /** 진영을 아는 경기만. */
  bySide: { blue: Tally; red: Tally };
  sideUnknown: number;
  /** 현재 이어지고 있는 연승(양수) 또는 연패(음수). */
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
  /** 같은 팀이었던 사람별 성적. 함께한 경기 수 많은 순. */
  synergy: PairTally[];
  /** 상대 팀이었던 사람별 성적(이 사람 기준 승). 만난 경기 수 많은 순. */
  versus: PairTally[];
  /** 참여한 유효 확정 경기. 최근 것부터. */
  matches: MatchView[];
}

function sortPairs(pairs: Map<string, Tally>, nameOf: (id: string) => string): PairTally[] {
  return [...pairs.entries()]
    .map(([participantId, tally]) => ({ participantId, ...tally }))
    .sort(
      (a, b) =>
        b.games - a.games ||
        nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
        a.participantId.localeCompare(b.participantId),
    );
}

/** 한 사람의 상세 통계. 넘겨받은 경기(범위가 이미 적용된 것) 안에서만 계산한다. */
export function personDetail(
  scoped: readonly MatchView[],
  participantId: string,
  nameOf: (id: string) => string,
): PersonDetail {
  const mine = scoped
    .filter((m) => isCounted(m) && m.roster.some((r) => r.participantId === participantId))
    .sort((a, b) => a.playedAt.localeCompare(b.playedAt) || a.matchNo - b.matchNo);

  const summary: PersonRecord = { participantId, games: 0, wins: 0, losses: 0 };
  const byPosition: Partial<Record<string, Tally>> = {};
  const bySide = { blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 } };
  const synergy = new Map<string, Tally>();
  const versus = new Map<string, Tally>();
  let positionUnknown = 0;
  let sideUnknown = 0;
  let run = 0;
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  const results: boolean[] = [];

  for (const match of mine) {
    const me = match.roster.find((r) => r.participantId === participantId)!;
    const won = me.team === match.winnerTeam;
    results.push(won);
    summary.games += 1;
    if (won) summary.wins += 1;
    else summary.losses += 1;

    if (me.position === null) {
      positionUnknown += 1;
    } else {
      const tally = (byPosition[me.position] ??= { games: 0, wins: 0 });
      tally.games += 1;
      if (won) tally.wins += 1;
    }

    const teamASide = match.teamASide;
    if (teamASide === "blue" || teamASide === "red") {
      const mySide = me.team === "A" ? teamASide : teamASide === "blue" ? "red" : "blue";
      bySide[mySide].games += 1;
      if (won) bySide[mySide].wins += 1;
    } else {
      sideUnknown += 1;
    }

    run = won ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
    longestWinStreak = Math.max(longestWinStreak, run);
    longestLoseStreak = Math.max(longestLoseStreak, -run);

    for (const other of match.roster) {
      if (other.participantId === participantId) continue;
      const target = other.team === me.team ? synergy : versus;
      let tally = target.get(other.participantId);
      if (!tally) {
        tally = { games: 0, wins: 0 };
        target.set(other.participantId, tally);
      }
      tally.games += 1;
      if (won) tally.wins += 1;
    }
  }

  const recent = (count: number): Tally => {
    const slice = results.slice(-count);
    return { games: slice.length, wins: slice.filter(Boolean).length };
  };

  return {
    participantId,
    summary,
    recent10: recent(10),
    recent20: recent(20),
    byPosition,
    positionUnknown,
    bySide,
    sideUnknown,
    currentStreak: run,
    longestWinStreak,
    longestLoseStreak,
    synergy: sortPairs(synergy, nameOf),
    versus: sortPairs(versus, nameOf),
    matches: [...mine].reverse(),
  };
}

/**
 * 사람별 승·패를 한 라인으로 좁혀 센다. 그 라인을 맡은 경기만 들어간다.
 * position이 null이면 라인 구분 없이 전체다.
 */
export function personRecordsByLine(
  matches: readonly MatchView[],
  position: string | null,
): Map<string, PersonRecord> {
  if (position === null) return personRecords(matches);
  const records = new Map<string, PersonRecord>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      if (entry.position !== position) continue;
      let record = records.get(entry.participantId);
      if (!record) {
        record = { participantId: entry.participantId, games: 0, wins: 0, losses: 0 };
        records.set(entry.participantId, record);
      }
      record.games += 1;
      if (entry.team === match.winnerTeam) record.wins += 1;
      else record.losses += 1;
    }
  }
  return records;
}

export interface SideTotals {
  /** 진영을 아는 경기 수. 블루와 레드의 경기 수는 같다. */
  known: number;
  blueWins: number;
  redWins: number;
  /** 진영 미상이라 뺀 경기 수. */
  unknown: number;
}

/** 진영별 누적 승패. 진영 미상 경기는 빼고 그 수를 함께 돌려준다. */
export function sideTotals(matches: readonly MatchView[]): SideTotals {
  const totals: SideTotals = { known: 0, blueWins: 0, redWins: 0, unknown: 0 };
  for (const match of matches) {
    if (!isCounted(match)) continue;
    if (match.teamASide !== "blue" && match.teamASide !== "red") {
      totals.unknown += 1;
      continue;
    }
    totals.known += 1;
    const blueTeam = match.teamASide === "blue" ? "A" : "B";
    if (match.winnerTeam === blueTeam) totals.blueWins += 1;
    else totals.redWins += 1;
  }
  return totals;
}

/** 플레이어 × 라인 표. 기록이 없는 칸은 키가 없다. */
export function playerLineMatrix(
  matches: readonly MatchView[],
): Map<string, Partial<Record<string, Tally>>> {
  const matrix = new Map<string, Partial<Record<string, Tally>>>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      if (entry.position === null) continue;
      let row = matrix.get(entry.participantId);
      if (!row) {
        row = {};
        matrix.set(entry.participantId, row);
      }
      const tally = (row[entry.position] ??= { games: 0, wins: 0 });
      tally.games += 1;
      if (entry.team === match.winnerTeam) tally.wins += 1;
    }
  }
  return matrix;
}

/**
 * 순위형 목록의 정렬: 배치 완료자를 먼저 두고 그 안에서 승률순.
 * 배치 여부는 범위와 무관하게 전체 누적 기준(placement)이다.
 * 범위 안에 경기가 없는 사람은 records에 없으므로 순위에 들어가지 않는다.
 */
export function sortRanking(
  records: PersonRecord[],
  placement: ReadonlyMap<string, Placement>,
  nameOf: (id: string) => string,
): PersonRecord[] {
  const sorted = sortByWinRate(records, nameOf);
  const done = (r: PersonRecord) => (placement.get(r.participantId)?.done ? 0 : 1);
  // sort는 안정 정렬이라 같은 묶음 안의 승률 순서가 유지된다.
  return sorted.sort((a, b) => done(a) - done(b));
}

/**
 * 이름 검색: 완전 일치 → 앞부분 일치 → 포함 → 초성 일치(앞부분) → 초성 포함 순. 배치 여부로 순서를 바꾸지 않는다.
 * 공백·대소문자·전각을 무시하고 초성("ㄱㅅ")으로도 찾는다. 규칙은 search.ts의 searchPeople에 있다.
 */
export function searchByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  return searchPeople(items, query);
}

/** 승률순 정렬. 동률은 경기 수 많은 순 → 이름 → 참가자 ID. */
export function sortByWinRate(
  records: PersonRecord[],
  nameOf: (id: string) => string,
): PersonRecord[] {
  const rate = (r: PersonRecord) => (r.games === 0 ? 0 : r.wins / r.games);
  return [...records].sort(
    (a, b) =>
      rate(b) - rate(a) ||
      b.games - a.games ||
      nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
      a.participantId.localeCompare(b.participantId),
  );
}
