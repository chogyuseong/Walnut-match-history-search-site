import type { AttendanceReport } from "./attendance";
import { countedChronological, personForms } from "./insights";
import type { RatingTable } from "./rating";
import { fractionPercent, isCounted, localDate, PLACEMENT_GAMES_DEFAULT, SMALL_SAMPLE, type Tally } from "./stats";
import { POSITIONS, type MatchView, type Position } from "./types";
import type { MatchExpectation } from "./upset";

/**
 * 그래프 분석 화면(src/web/screens/Graphs.tsx)의 그림 계산(2026-11-09): 이야기 띠 · 순위 변동 · 라인 모양 · 활동 달력 ·
 * . 그리기는 screens/graphFigures.tsx가 한다.
 * 데이터는 스냅숏의 경기(snapshot.matches, 또는 matchesInScope로 범위를 적용한 것)와 그 경기로 만든
 * MMR(rating.ts)·경기 전 예상(upset.ts)·참석(attendance.ts)이다. 저장하지 않고 매번 계산한다(서버·스키마와 무관).
 */

export interface RatingRank {
  rank: number;
  /** 순위를 매긴 사람 수(배치를 마친 사람). */
  total: number;
}

/**
 * 배치 마친 사람끼리의 지금 MMR 순위. table은 모임 전체 경기로 만든 것이라 범위와 무관한 누적 기준이다
 * (랭킹 화면의 MMR과 같은 값). 같은 MMR이면 ID순이라 순위가 흔들리지 않는다.
 */
export function ratingRank(
  table: RatingTable,
  participantId: string,
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): RatingRank | null {
  const placed = [...table.values()].filter((p) => p.games >= placementGames);
  if (!placed.some((p) => p.participantId === participantId)) return null;
  placed.sort((a, b) => b.rating - a.rating || a.participantId.localeCompare(b.participantId));
  return { rank: placed.findIndex((p) => p.participantId === participantId) + 1, total: placed.length };
}

/** 범위 안 유효 경기가 이만큼 넘으면 경기 단위 대신 모임 날 단위로 묶는다(임시값). 낮추면 선이 덜 촘촘하지만 하루 안 변화가 사라진다. */
export const RACE_DAY_BUCKET_OVER = 60;
/** 순위 변동을 그리는 최소 범위 안 유효 경기 수(기본 배치 판수와 같은 값, 배치 설정과는 무관). 낮추면 거의 빈 그림이 나온다. */
export const RACE_MIN_GAMES = 10;

export interface RaceSeries {
  participantId: string;
  /** 시점마다의 순위(1이 1위). 그 시점에 배치 전이면 null. */
  ranks: (number | null)[];
  /** 마지막 시점의 순위(그때 배치 전이면 null). */
  finalRank: number | null;
}

export interface RankRace {
  /** "day"면 시점이 모임 날, 아니면 경기. */
  unit: "match" | "day";
  /** 시점 이름: 경기 단위는 "n경기째", 날 단위는 "YYYY-MM-DD". */
  labels: string[];
  /** 범위 안 경기에 나온 사람만. 마지막 순위순(배치 전은 뒤). */
  series: RaceSeries[];
  /** 어느 시점이든 가장 큰 순위 값(세로축 끝). */
  maxRank: number;
  /** 범위 안 유효 경기 수. */
  games: number;
}

/**
 * 시점마다 그때까지 배치를 마친 사람끼리 순위를 매긴다(같으면 ID순). ratings는 allMatches 전체로 만든 것이어야
 * 범위가 일부여도 MMR·배치가 누적으로 맞는다.
 * MMR을 다시 계산하지 않고 ratings.history의 after를 countedChronological 순서대로 따라간다.
 * 이 순서를 바꾸면 rating.ts의 계산 순서와 어긋난다.
 */
export function rankRace(
  allMatches: readonly MatchView[],
  ratings: RatingTable,
  scoped: readonly MatchView[],
  timeZone: string,
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): RankRace {
  // 경기 ID → 그 경기 뒤의 사람별 MMR.
  const after = new Map<string, { id: string; rating: number }[]>();
  for (const person of ratings.values()) {
    for (const point of person.history) {
      let ratingsAfter = after.get(point.matchId);
      if (!ratingsAfter) after.set(point.matchId, (ratingsAfter = []));
      ratingsAfter.push({ id: person.participantId, rating: point.after });
    }
  }
  const inScope = new Set(scoped.filter(isCounted).map((m) => m.id));
  const people = new Set<string>();
  for (const m of scoped) if (isCounted(m)) for (const r of m.roster) people.add(r.participantId);
  const timeline = countedChronological(allMatches);
  const scopedTimeline = timeline.filter((m) => inScope.has(m.id) && after.has(m.id));
  const games = scopedTimeline.length;
  const unit: RankRace["unit"] = games > RACE_DAY_BUCKET_OVER ? "day" : "match";

  // 시점을 닫는 경기: 경기 단위면 범위 안 경기마다, 날 단위면 그날 마지막 범위 안 경기.
  const closes = new Map<string, string>();
  scopedTimeline.forEach((m, i) => {
    if (unit === "match") closes.set(m.id, `${i + 1}경기째`);
    else {
      const date = localDate(m.playedAt, timeZone);
      const next = scopedTimeline[i + 1];
      if (!next || localDate(next.playedAt, timeZone) !== date) closes.set(m.id, date);
    }
  });

  const rating = new Map<string, number>();
  const played = new Map<string, number>();
  const labels: string[] = [];
  const ranksById = new Map<string, (number | null)[]>([...people].map((id) => [id, []]));
  let maxRank = 0;
  for (const m of timeline) {
    for (const p of after.get(m.id) ?? []) {
      rating.set(p.id, p.rating);
      played.set(p.id, (played.get(p.id) ?? 0) + 1);
    }
    const label = closes.get(m.id);
    if (label === undefined) continue;
    labels.push(label);
    const placed = [...people]
      .filter((id) => (played.get(id) ?? 0) >= placementGames)
      .sort((a, b) => rating.get(b)! - rating.get(a)! || a.localeCompare(b));
    maxRank = Math.max(maxRank, placed.length);
    const rankOf = new Map(placed.map((id, i) => [id, i + 1]));
    for (const [id, ranks] of ranksById) ranks.push(rankOf.get(id) ?? null);
  }

  const series: RaceSeries[] = [...ranksById].map(([participantId, ranks]) => ({
    participantId,
    ranks,
    finalRank: ranks.at(-1) ?? null,
  }));
  series.sort(
    (a, b) =>
      (a.finalRank ?? Infinity) - (b.finalRank ?? Infinity) || a.participantId.localeCompare(b.participantId),
  );
  return { unit, labels, series, maxRank, games };
}

/** 순위 변동을 그릴 수 있는지: 범위 안 경기 RACE_MIN_GAMES 이상, 마지막에 배치 마친 사람 2명 이상. */
export function raceDrawable(race: RankRace): boolean {
  return race.games >= RACE_MIN_GAMES && race.series.filter((s) => s.finalRank !== null).length >= 2;
}

// ---------------------------------------------------------------------------
// 라인 모양(오각형)

export type ShapeMode = "rate" | "games";

export interface ShapeAxis {
  position: Position;
  /** 중심 0 ~ 끝 1. */
  value: number;
  games: number;
  wins: number;
  /** 승률 보기에서 SMALL_SAMPLE경기 미만이라 중심으로 당긴 축. */
  weak: boolean;
}

/**
 * row는 playerLineMatrix의 한 줄이나 groupLineTotals 결과. 축은 POSITIONS 순서(그림의 위에서 시계 방향)다.
 * - 승률: SMALL_SAMPLE경기 미만은 games/SMALL_SAMPLE배로 중심에 당긴다(한두 판 100%가 튀어나오지 않게).
 * - 경기 수: 그 사람의 가장 많이 뛴 라인을 1로 둔다. 두 사람을 비교할 때도 사람마다 따로 맞춘다.
 */
export function lineShape(row: Partial<Record<string, Tally>>, mode: ShapeMode): ShapeAxis[] {
  const most = Math.max(0, ...POSITIONS.map((p) => row[p]?.games ?? 0));
  return POSITIONS.map((position) => {
    const games = row[position]?.games ?? 0;
    const wins = row[position]?.wins ?? 0;
    if (mode === "games") return { position, value: most > 0 ? games / most : 0, games, wins, weak: false };
    const rate = games > 0 ? wins / games : 0;
    const weak = games < SMALL_SAMPLE;
    return { position, value: weak ? rate * (games / SMALL_SAMPLE) : rate, games, wins, weak };
  });
}

/** 모임 전체의 라인별 경기 수(사람별 칸의 합). 모임 전체 승률은 늘 50%라 경기 수 분포만 쓴다. */
export function groupLineTotals(matrix: ReadonlyMap<string, Partial<Record<string, Tally>>>): Partial<Record<Position, Tally>> {
  const totals: Partial<Record<Position, Tally>> = {};
  for (const row of matrix.values()) {
    for (const p of POSITIONS) {
      const tally = row[p];
      if (!tally) continue;
      const sum = (totals[p] ??= { games: 0, wins: 0 });
      sum.games += tally.games;
      sum.wins += tally.wins;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// 활동(달력)

/** 범위 "전체"에서 달력이 보여 주는 최근 주 수(오늘까지). 늘리면 폰에서 가로 스크롤이 길어진다. */
export const CALENDAR_WEEKS = 26;
/** 칸 색 단계의 아래 끝: 0 · 1~2 · 3~5 · 6~9 · 10+. 바꾸면 graphFigures.tsx CalendarLegend 글자도 함께 바꾼다. */
export const CALENDAR_LEVELS = [1, 3, 6, 10] as const;
/** 요일 이름. 달력 행 순서(월요일 시작)와 같다. */
export const WEEKDAY_LABEL = ["월", "화", "수", "목", "금", "토", "일"] as const;

export interface CalendarCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  /** 0 월 ~ 6 일. */
  weekday: number;
  /** 범위 밖(첫 주 앞·마지막 주 뒤를 채운 칸). */
  outside: boolean;
}

export interface ActivityCalendar {
  /** 열 = 주(월요일 시작). 각 주는 칸 7개. */
  weeks: CalendarCell[][];
  /** 경기가 있던 날 수(범위 안). */
  activeDays: number;
  /** 경기가 가장 많은 요일(0 월 ~ 6 일). 경기가 없으면 null. */
  busiestWeekday: number | null;
  /** 경기가 있던 날의 하루 평균 경기 수. */
  avgPerDay: number;
  total: number;
}

/** 하루 경기 수 → 색 단계(0~4). */
export function calendarLevel(count: number): CalendarCell["level"] {
  let level = 0;
  for (const min of CALENDAR_LEVELS) if (count >= min) level += 1;
  return level as CalendarCell["level"];
}

// 날짜 계산은 "YYYY-MM-DD"를 UTC 자정으로 읽어 한다(시간대·서머타임과 무관하게 하루 = 86400000ms).
const DAY_MS = 86_400_000;
const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** 0 월 ~ 6 일. */
export function weekdayOf(date: string): number {
  return (new Date(toUtc(date)).getUTCDay() + 6) % 7;
}
/** date에서 days일 뒤(앞이면 음수). */
export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/**
 * 모임 시간대 날짜별 경기 수. 결과 대기·진행 중·전적 제외 경기도 센다(참석 통계처럼 "그날 모였는지"를 보여 주는
 * 그림이라). 취소 경기만 뺀다.
 */
export function dailyCounts(matches: readonly MatchView[], timeZone: string, playerId: string | null = null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of matches) {
    if (m.state === "canceled") continue;
    if (playerId !== null && !m.roster.some((r) => r.participantId === playerId)) continue;
    const date = localDate(m.playedAt, timeZone);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

/**
 * start~end는 양 끝 포함. 첫 주 앞·마지막 주 뒤는 outside 칸으로 채워 주마다 칸이 7개가 되게 한다(그림에서는 그리지 않음).
 * 기간 밖 날짜의 경기는 세지 않는다.
 */
export function activityCalendar(counts: ReadonlyMap<string, number>, start: string, end: string): ActivityCalendar {
  const first = addDays(start, -weekdayOf(start));
  const last = addDays(end, 6 - weekdayOf(end));
  const weeks: CalendarCell[][] = [];
  let week: CalendarCell[] = [];
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  let activeDays = 0;
  let total = 0;
  for (let ms = toUtc(first); ms <= toUtc(last); ms += DAY_MS) {
    const date = fromUtc(ms);
    const weekday = weekdayOf(date);
    if (weekday === 0) weeks.push((week = []));
    const outside = date < start || date > end;
    const count = outside ? 0 : (counts.get(date) ?? 0);
    if (count > 0) {
      activeDays += 1;
      total += count;
      byWeekday[weekday]! += count;
    }
    week.push({ date, count, level: calendarLevel(count), weekday, outside });
  }
  const top = Math.max(...byWeekday);
  return {
    weeks,
    activeDays,
    busiestWeekday: top > 0 ? byWeekday.indexOf(top) : null,
    avgPerDay: activeDays > 0 ? total / activeDays : 0,
    total,
  };
}

/** 범위별 달력 기간. 시즌은 시즌 기간, 연도는 그해, 전체는 today까지 최근 CALENDAR_WEEKS주. */
export function calendarRange(
  scope: { kind: "all" } | { kind: "season"; startsOn: string; endsOn: string } | { kind: "year"; year: number },
  today: string,
): { start: string; end: string } {
  if (scope.kind === "season") return { start: scope.startsOn, end: scope.endsOn };
  if (scope.kind === "year") return { start: `${scope.year}-01-01`, end: `${scope.year}-12-31` };
  return { start: addDays(today, -(CALENDAR_WEEKS * 7 - 1)), end: today };
}

// ---------------------------------------------------------------------------
// 이야기 띠

/** 이야기 띠를 보여 주는 최소 범위 안 유효 경기 수. 낮추면 "1연승"처럼 싱거운 문장이 나온다. */
export const STORY_MIN_GAMES = 5;
/** 카드 최대 수. 띠가 PC 4칸 한 줄이라 늘리면 줄이 넘어간다(styles.css .story-strip). */
export const STORY_MAX = 4;
/** 최대 이변 문장에 이름을 이만큼까지 쓰고 나머지는 "외 n명". */
const STORY_NAMES = 2;

export type StoryKind = "streak" | "upset" | "pair" | "attendance" | "rating";

export interface StoryCard {
  kind: StoryKind;
  label: string;
  text: string;
  /** 문장에 나온 사람(앞사람이 카드를 누르면 고를 사람). */
  people: string[];
}

export interface StoryInput {
  /** 범위 적용된 경기(matchesInScope). 유효 확정 경기만 골라 쓴다. */
  scoped: readonly MatchView[];
  /** matchExpectations(모임 전체 경기). 범위로 다시 구하면 예상이 달라지므로 누적으로 만든 것을 넘긴다. */
  expectations: ReadonlyMap<string, MatchExpectation>;
  /** attendanceReport(scoped). 출전 카드에 쓴다. */
  attendance: AttendanceReport;
  /** computeRatings(모임 전체 경기). 범위 안 경기의 변화만 더해 MMR 상승을 구한다. */
  ratings: RatingTable;
  nameOf: (id: string) => string;
  /** 위에서 고른 플레이어. 그 사람이 나온 문장을 앞에 둔다. */
  picked: string | null;
}

export interface TeammatePair {
  /** 두 사람 ID(a < b). */
  a: string;
  b: string;
  /** 같은 팀이었던 경기 수. */
  n: number;
}

/** 넘겨받은 경기에서 같은 팀이었던 두 사람 쌍과 그 횟수. 이야기 띠의 "뭉친 플레이어"와 분석 코멘트가 쓴다. */
export function teammatePairs(matches: readonly MatchView[]): TeammatePair[] {
  const pairs = new Map<string, TeammatePair>();
  for (const match of matches) {
    for (const team of ["A", "B"] as const) {
      const ids = match.roster.filter((r) => r.team === team).map((r) => r.participantId).sort();
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${ids[i]}|${ids[j]}`;
          const pair = pairs.get(key) ?? { a: ids[i]!, b: ids[j]!, n: 0 };
          pair.n += 1;
          pairs.set(key, pair);
        }
      }
    }
  }
  return [...pairs.values()];
}

/** 값이 가장 큰 항목(같으면 이름순 앞). 동률일 때 카드가 그릴 때마다 바뀌지 않게 한다. */
export function topBy<T>(items: Iterable<T>, value: (t: T) => number, name: (t: T) => string): T | null {
  let best: T | null = null;
  for (const candidate of items) {
    if (
      best === null ||
      value(candidate) > value(best) ||
      (value(candidate) === value(best) && name(candidate).localeCompare(name(best), "ko") < 0)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 이번 범위 이야기: 데이터가 있는 후보 중 최대 STORY_MAX개. 순서는 연승 → 이변 → 뭉친 플레이어 → 출전 → MMR 상승,
 * 고른 플레이어가 나온 문장은 맨 앞으로. 범위 안 유효 경기가 STORY_MIN_GAMES 미만이면 빈 목록.
 */
export function storyCards(input: StoryInput): StoryCard[] {
  const { scoped, nameOf, picked } = input;
  const counted = scoped.filter(isCounted);
  if (counted.length < STORY_MIN_GAMES) return [];
  const cards: StoryCard[] = [];

  const forms = personForms(counted);
  const streak = topBy(forms, ([, f]) => f.longestWinStreak, ([id]) => nameOf(id));
  if (streak && streak[1].longestWinStreak >= 2) {
    cards.push({ kind: "streak", label: "최장 연승", text: `${nameOf(streak[0])} ${streak[1].longestWinStreak}연승`, people: [streak[0]] });
  }

  let upset: { match: MatchView; e: MatchExpectation } | null = null;
  for (const match of counted) {
    const e = input.expectations.get(match.id);
    if (!e?.upset) continue;
    if (!upset || e.surprise > upset.e.surprise) upset = { match, e };
  }
  if (upset) {
    const winners = upset.match.roster
      .filter((r) => r.team === upset.e.winnerTeam)
      .map((r) => r.participantId)
      .sort((a, b) => Number(b === picked) - Number(a === picked) || nameOf(a).localeCompare(nameOf(b), "ko"));
    const shown = winners.slice(0, STORY_NAMES).map(nameOf).join("·");
    const rest = winners.length - STORY_NAMES;
    cards.push({
      kind: "upset",
      label: "최대 이변",
      text: `${shown}${rest > 0 ? ` 외 ${rest}명` : ""} 예상 ${fractionPercent(1 - upset.e.surprise)}%에서 승리`,
      people: winners,
    });
  }

  const pairs = teammatePairs(counted);
  const pairName = (p: { a: string; b: string }) => [nameOf(p.a), nameOf(p.b)].sort((x, y) => x.localeCompare(y, "ko")).join("·");
  const pair = topBy(pairs, (p) => p.n, pairName);
  if (pair && pair.n >= 2) {
    const ids = [pair.a, pair.b].sort((x, y) => Number(y === picked) - Number(x === picked) || nameOf(x).localeCompare(nameOf(y), "ko"));
    cards.push({ kind: "pair", label: "가장 많이 뭉친 플레이어", text: `${ids.map(nameOf).join("·")} 같은 팀 ${pair.n}회`, people: ids });
  }

  const attend = topBy(input.attendance.people.values(), (p) => p.days, (p) => nameOf(p.participantId));
  if (attend && attend.days > 0) {
    cards.push({ kind: "attendance", label: "최다 출전", text: `${nameOf(attend.participantId)} ${attend.days}일 출전`, people: [attend.participantId] });
  }

  const countedIds = new Set(counted.map((m) => m.id));
  const gains: { id: string; gain: number }[] = [];
  for (const person of input.ratings.values()) {
    let gain = 0;
    for (const point of person.history) if (countedIds.has(point.matchId)) gain += point.after - point.before;
    gains.push({ id: person.participantId, gain: Math.round(gain) });
  }
  const gain = topBy(gains, (g) => g.gain, (g) => nameOf(g.id));
  if (gain && gain.gain > 0) {
    cards.push({ kind: "rating", label: "MMR 최고 상승", text: `${nameOf(gain.id)} +${gain.gain}`, people: [gain.id] });
  }

  if (picked) {
    // 안정 정렬: 고른 사람이 나온 문장만 앞으로, 나머지는 원래 순서.
    cards.sort((a, b) => Number(b.people.includes(picked)) - Number(a.people.includes(picked)));
  }
  return cards.slice(0, STORY_MAX);
}
