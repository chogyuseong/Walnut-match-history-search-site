import {
  isCounted,
  personRecordsByLine,
  searchByName,
  SMALL_SAMPLE,
  sortByWinRate,
  type PairTally,
  type PersonRecord,
  type Placement,
  type Tally,
} from "./stats";
import { POSITIONS, sideOfTeam, type MatchView, type Position } from "./types";

/**
 * 전적 사이트 화면(경기 카드·대시보드·랭킹·개인 요약·비교·경기 거르기)이 쓰는 계산.
 * 집계 기준은 stats.ts와 같다: 유효 확정 경기(isCounted)만 세고, 대기·진행 중·취소·제외 경기는 건너뛴다.
 * 범위(오늘·시즌·연도·전체)는 호출하는 쪽이 matchesInScope로 이미 좁힌 경기를 넘긴다.
 */

/**
 * 경기 시각 순서(오래된 것부터). 같은 시각이면 경기 번호가 작은 것이 먼저다.
 * 연승·연패·최근 흐름·추이는 모두 이 순서를 쓴다.
 */
export function byPlayedAt(a: MatchView, b: MatchView): number {
  return a.playedAt.localeCompare(b.playedAt) || a.matchNo - b.matchNo;
}

/** 유효 확정 경기만 시각 순서로. */
export function countedChronological(matches: readonly MatchView[]): MatchView[] {
  return matches.filter(isCounted).sort(byPlayedAt);
}

/** 가장 최근 것부터(경기 목록 표시 순서). */
export function newestFirst(matches: readonly MatchView[]): MatchView[] {
  return [...matches].sort((a, b) => byPlayedAt(b, a));
}

/** 이 사람이 이긴 경기인지. 확정 경기에 참가한 사람만 묻는다. */
export function wonBy(match: MatchView, participantId: string): boolean | null {
  if (!isCounted(match)) return null;
  const me = match.roster.find((r) => r.participantId === participantId);
  if (!me) return null;
  return me.team === match.winnerTeam;
}

/** 최근 흐름에 보여주는 경기 수. */
export const FORM_LENGTH = 5;

export interface PersonForm {
  /** 시각 순서의 승(true)·패(false). 넘겨받은 경기 안에서만이다. */
  results: boolean[];
  /** 현재 이어지는 연승(양수) 또는 연패(음수). 경기가 없으면 0. */
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
}

/** 연승·연패 계산. results는 시각 순서다. */
export function streakOf(results: readonly boolean[]): Omit<PersonForm, "results"> {
  let run = 0;
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  for (const won of results) {
    run = won ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
    if (run > longestWinStreak) longestWinStreak = run;
    if (-run > longestLoseStreak) longestLoseStreak = -run;
  }
  return { currentStreak: run, longestWinStreak, longestLoseStreak };
}

/**
 * 모든 사람의 승패 흐름을 한 번에 계산한다(경기 정렬 한 번, 경기당 10명).
 * position을 주면 그 라인으로 뛴 경기만 센다(라인별 랭킹과 같은 기준).
 */
export function personForms(
  matches: readonly MatchView[],
  position: Position | null = null,
): Map<string, PersonForm> {
  const results = new Map<string, boolean[]>();
  for (const match of countedChronological(matches)) {
    for (const entry of match.roster) {
      if (position !== null && entry.position !== position) continue;
      let list = results.get(entry.participantId);
      if (!list) {
        list = [];
        results.set(entry.participantId, list);
      }
      list.push(entry.team === match.winnerTeam);
    }
  }
  const forms = new Map<string, PersonForm>();
  for (const [id, list] of results) forms.set(id, { results: list, ...streakOf(list) });
  return forms;
}

/** 가장 최근 count경기의 승패. 최근 것이 앞이다. */
export function recentResults(form: PersonForm | undefined, count = FORM_LENGTH): boolean[] {
  if (!form) return [];
  return form.results.slice(-count).reverse();
}

/** 연속 기록을 글로. "3연승 중" · "2연패 중" · "" */
export function streakText(streak: number): string {
  if (streak > 0) return `${streak}연승 중`;
  if (streak < 0) return `${-streak}연패 중`;
  return "";
}

// ---------------------------------------------------------------------------
// 랭킹

export type RankingSort = "rate" | "games" | "wins";

export const RANKING_SORT_LABEL: Record<RankingSort, string> = {
  rate: "승률",
  games: "경기 수",
  wins: "승수",
};

/** 랭킹에서 이 경기 수(모임 전체 누적) 이상인 사람은 그보다 적은 사람보다 항상 위에 둔다. 배치와는 별개다. */
export const RANKING_VETERAN_GAMES = 50;

/** 랭킹 묶음. 0: 누적 50경기 이상, 1: 배치 완료(50경기 미만), 2: 배치 진행 중. 항상 누적 기준이다. */
export type RankingGroup = 0 | 1 | 2;

export const RANKING_GROUP_LABEL: Record<RankingGroup, string> = {
  0: `누적 ${RANKING_VETERAN_GAMES}경기 이상`,
  1: `배치 완료 · ${RANKING_VETERAN_GAMES}경기 미만`,
  2: "배치 진행 중",
};

export function rankingGroup(
  placement: ReadonlyMap<string, Placement>,
  participantId: string,
): RankingGroup {
  const p = placement.get(participantId);
  if (!p) return 2;
  if (p.games >= RANKING_VETERAN_GAMES) return 0;
  return p.done ? 1 : 2;
}

/**
 * 랭킹 정렬. 누적 50경기 이상 → 배치 완료 → 배치 진행 중 순으로 묶고(모두 모임 전체 누적 기준),
 * 묶음 안에서 고른 기준으로 정렬한다.
 * - 승률: 승률 → 경기 수 → 이름 → ID (묶음 안에서는 stats.sortRanking과 같다)
 * - 경기 수: 경기 수 → 승률 → 이름 → ID
 * - 승수: 승수 → 승률 → 경기 수 → 이름 → ID
 */
export function sortRankingBy(
  records: readonly PersonRecord[],
  placement: ReadonlyMap<string, Placement>,
  nameOf: (id: string) => string,
  sort: RankingSort,
): PersonRecord[] {
  const rate = (r: PersonRecord) => (r.games === 0 ? 0 : r.wins / r.games);
  const group = (r: PersonRecord) => rankingGroup(placement, r.participantId);
  const byName = (a: PersonRecord, b: PersonRecord) =>
    nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
    a.participantId.localeCompare(b.participantId);
  if (sort === "rate") {
    const sorted = sortByWinRate([...records], nameOf);
    return sorted.sort((a, b) => group(a) - group(b));
  }
  return [...records].sort(
    (a, b) =>
      group(a) - group(b) ||
      (sort === "games"
        ? b.games - a.games || rate(b) - rate(a)
        : b.wins - a.wins || rate(b) - rate(a) || b.games - a.games) ||
      byName(a, b),
  );
}

export interface RankedRow extends PersonRecord {
  /** 검색 전 전체 순위. 검색해도 바뀌지 않는다. */
  rank: number;
  name: string;
}

/**
 * 순위를 매기고(검색 전) 검색어로 거른다. 검색은 일치도 순으로 보여주되 순위 숫자는 그대로 둔다.
 */
export function rankAndSearch(
  records: readonly PersonRecord[],
  placement: ReadonlyMap<string, Placement>,
  nameOf: (id: string) => string,
  sort: RankingSort,
  query: string,
): { ranked: RankedRow[]; shown: RankedRow[] } {
  const ranked = sortRankingBy(records, placement, nameOf, sort).map((r, i) => ({
    ...r,
    rank: i + 1,
    name: nameOf(r.participantId),
  }));
  const shown = query.trim() === "" ? ranked : searchByName(ranked, query);
  return { ranked, shown };
}

/** 라인별 랭킹. 그 라인으로 뛴 경기만 센다. 포지션 기록이 없는 경기는 어느 라인에도 들어가지 않는다. */
export function lineRanking(
  matches: readonly MatchView[],
  position: Position | null,
): PersonRecord[] {
  return [...personRecordsByLine(matches, position).values()];
}

/** 포지션 기록이 하나라도 빠진 유효 확정 경기 수. 라인별 랭킹에서 빠지는 경기다. */
export function matchesWithoutPositions(matches: readonly MatchView[]): number {
  return matches.filter((m) => isCounted(m) && m.roster.some((r) => r.position === null)).length;
}

// ---------------------------------------------------------------------------
// 홈 대시보드: 요즘 흐름

/** 연승 중으로 보여주는 최소 연승. */
export const HOT_STREAK_MIN = 3;
/** 최근 승률 상위에 쓰는 최근 경기 수. 이만큼 뛴 사람만 넣는다. */
export const RECENT_FORM_GAMES = 10;
/** "요즘" 뛴 사람: 모임의 최근 이 수의 유효 확정 경기 안에 한 번이라도 나온 사람. */
export const ACTIVE_WINDOW = 30;

export interface TrendRow {
  participantId: string;
  streak: number;
  recent: Tally;
}

export interface Trends {
  /** 지금 HOT_STREAK_MIN 이상 연승 중인 사람. 연승이 긴 순. */
  hotStreaks: TrendRow[];
  /** 최근 RECENT_FORM_GAMES경기 승률 상위. 그만큼 뛰지 않은 사람은 넣지 않는다. */
  recentBest: TrendRow[];
}

/**
 * 요즘 흐름. 범위 없이 넘긴 경기 전체에서 계산하되, 모임의 최근 ACTIVE_WINDOW경기에
 * 나오지 않은 사람(오래 쉰 사람)은 넣지 않는다. 기준 미달이면 빈 목록이다.
 */
export function trends(
  matches: readonly MatchView[],
  nameOf: (id: string) => string,
  limit = 3,
): Trends {
  const chrono = countedChronological(matches);
  const active = new Set<string>();
  for (const match of chrono.slice(-ACTIVE_WINDOW)) {
    for (const entry of match.roster) active.add(entry.participantId);
  }
  const forms = personForms(chrono);
  const rows: TrendRow[] = [];
  for (const [participantId, form] of forms) {
    if (!active.has(participantId)) continue;
    const last = form.results.slice(-RECENT_FORM_GAMES);
    rows.push({
      participantId,
      streak: form.currentStreak,
      recent: { games: last.length, wins: last.filter(Boolean).length },
    });
  }
  const byName = (a: TrendRow, b: TrendRow) =>
    nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
    a.participantId.localeCompare(b.participantId);
  const hotStreaks = rows
    .filter((r) => r.streak >= HOT_STREAK_MIN)
    .sort((a, b) => b.streak - a.streak || byName(a, b))
    .slice(0, limit);
  const recentBest = rows
    .filter((r) => r.recent.games >= RECENT_FORM_GAMES)
    .sort((a, b) => b.recent.wins - a.recent.wins || b.streak - a.streak || byName(a, b))
    .slice(0, limit);
  return { hotStreaks, recentBest };
}

// ---------------------------------------------------------------------------
// 개인 요약

export interface MainLine {
  position: Position;
  tally: Tally;
}

/** 가장 많이 뛴 라인. 같으면 승률 → 라인 순서. 포지션 기록이 없으면 null. */
export function mainLine(byPosition: Partial<Record<string, Tally>>): MainLine | null {
  let best: MainLine | null = null;
  for (const position of POSITIONS) {
    const tally = byPosition[position];
    if (!tally || tally.games === 0) continue;
    if (
      !best ||
      tally.games > best.tally.games ||
      (tally.games === best.tally.games && tally.wins > best.tally.wins)
    ) {
      best = { position, tally };
    }
  }
  return best;
}

/**
 * 표본 기준(SMALL_SAMPLE경기 이상)을 넘는 짝 중 이 사람의 승률이 가장 높은(best) / 낮은(worst) 사람.
 * 같은 승률이면 경기 수가 많은 쪽. 기준을 넘는 사람이 없으면 null.
 * 시너지에 쓰면 "가장 잘 맞는 동료", 상대 전적에 worst로 쓰면 "가장 어려운 상대"다.
 */
export function pickPair(
  pairs: readonly PairTally[],
  which: "best" | "worst",
  minGames = SMALL_SAMPLE,
): PairTally | null {
  let chosen: PairTally | null = null;
  for (const pair of pairs) {
    if (pair.games < minGames) continue;
    if (!chosen) {
      chosen = pair;
      continue;
    }
    // 승률 비교는 나눗셈 대신 곱셈으로(소수 오차 없이).
    const diff = pair.wins * chosen.games - chosen.wins * pair.games;
    const better = which === "best" ? diff > 0 : diff < 0;
    if (better || (diff === 0 && pair.games > chosen.games)) chosen = pair;
  }
  return chosen;
}

export interface TrendPoint {
  /** 몇 번째 경기(1부터). */
  game: number;
  /** 그 경기까지의 누적 승률(0~1). */
  rate: number;
}

/**
 * 누적 승률 추이. results는 시각 순서. 점이 maxPoints보다 많으면 고르게 솎되 마지막 점은 남긴다.
 * 2000경기여도 그리는 점은 maxPoints개를 넘지 않는다.
 */
export function cumulativeTrend(results: readonly boolean[], maxPoints = 120): TrendPoint[] {
  const points: TrendPoint[] = [];
  let wins = 0;
  const step = Math.max(1, Math.ceil(results.length / maxPoints));
  results.forEach((won, i) => {
    if (won) wins += 1;
    const game = i + 1;
    if (game % step === 0 || game === results.length) points.push({ game, rate: wins / game });
  });
  return points;
}

/** 한 사람의 시각 순서 승패. 넘겨받은 경기(범위 적용됨) 안에서만. */
export function resultsOf(matches: readonly MatchView[], participantId: string): boolean[] {
  const out: boolean[] = [];
  for (const match of countedChronological(matches)) {
    const me = match.roster.find((r) => r.participantId === participantId);
    if (me) out.push(me.team === match.winnerTeam);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 두 사람 비교

export interface HeadToHead {
  /** 같은 팀이었던 유효 확정 경기. wins는 그 팀이 이긴 수. */
  together: Tally;
  /** 상대 팀이었던 유효 확정 경기. */
  against: { games: number; aWins: number; bWins: number };
  /** 같은 팀이었던 경기(최근 것부터). 대기·제외 경기는 넣지 않는다. */
  togetherMatches: MatchView[];
  /** 상대 팀이었던 경기(최근 것부터). */
  againstMatches: MatchView[];
}

export function headToHead(matches: readonly MatchView[], a: string, b: string): HeadToHead {
  const together: Tally = { games: 0, wins: 0 };
  const against = { games: 0, aWins: 0, bWins: 0 };
  const togetherMatches: MatchView[] = [];
  const againstMatches: MatchView[] = [];
  for (const match of countedChronological(matches)) {
    const ea = match.roster.find((r) => r.participantId === a);
    const eb = match.roster.find((r) => r.participantId === b);
    if (!ea || !eb || a === b) continue;
    if (ea.team === eb.team) {
      together.games += 1;
      if (ea.team === match.winnerTeam) together.wins += 1;
      togetherMatches.push(match);
    } else {
      against.games += 1;
      if (ea.team === match.winnerTeam) against.aWins += 1;
      else against.bWins += 1;
      againstMatches.push(match);
    }
  }
  return {
    together,
    against,
    togetherMatches: togetherMatches.reverse(),
    againstMatches: againstMatches.reverse(),
  };
}

// ---------------------------------------------------------------------------
// 경기 거르기

export type ResultFilter = "win" | "loss";
/** 이긴 팀의 진영. "unknown"은 진영 미상으로 확정된 경기. */
export type WinnerSideFilter = "blue" | "red" | "unknown";

export interface MatchFilter {
  /** 이 사람들이 모두 뛴 경기만(AND). 비어 있으면 거르지 않는다. */
  people: string[];
  /** 첫 번째로 고른 사람(기준)이 이 라인으로 뛴 경기만. 사람을 고르지 않으면 무시한다. */
  position: Position | null;
  /** 기준인 사람이 이기거나 진 경기만. 사람을 고르지 않으면 무시한다. 확정 경기만 남는다. */
  result: ResultFilter | null;
  /** 이긴 팀의 진영. 확정 경기만 남는다. */
  winnerSide: WinnerSideFilter | null;
}

export const EMPTY_FILTER: MatchFilter = { people: [], position: null, result: null, winnerSide: null };

/** 실제로 적용되는 조건이 있는지. 사람 없이 고른 라인·승패는 적용되지 않으므로 세지 않는다. */
export function isFilterActive(filter: MatchFilter): boolean {
  return (
    filter.people.length > 0 || filter.winnerSide !== null
  );
}

export function winnerSideOf(match: MatchView): WinnerSideFilter | null {
  if (match.state !== "confirmed" || match.winnerTeam === null) return null;
  const side = sideOfTeam(match.winnerTeam, match.teamASide);
  return side === "blue" || side === "red" ? side : "unknown";
}

/** 경기 거르기. 넘겨받은 경기(범위 적용됨)의 순서를 그대로 둔다. */
export function filterMatches(matches: readonly MatchView[], filter: MatchFilter): MatchView[] {
  const anchor = filter.people[0] ?? null;
  return matches.filter((match) => {
    for (const id of filter.people) {
      if (!match.roster.some((r) => r.participantId === id)) return false;
    }
    if (anchor !== null) {
      const me = match.roster.find((r) => r.participantId === anchor)!;
      if (filter.position !== null && me.position !== filter.position) return false;
      if (filter.result !== null) {
        if (!isCounted(match)) return false;
        const won = me.team === match.winnerTeam;
        if ((filter.result === "win") !== won) return false;
      }
    }
    if (filter.winnerSide !== null && winnerSideOf(match) !== filter.winnerSide) return false;
    return true;
  });
}

/** 거른 경기 안에서 기준인 사람의 승패(유효 확정 경기만). */
export function anchorRecord(matches: readonly MatchView[], participantId: string): Tally {
  const tally: Tally = { games: 0, wins: 0 };
  for (const match of matches) {
    const won = wonBy(match, participantId);
    if (won === null) continue;
    tally.games += 1;
    if (won) tally.wins += 1;
  }
  return tally;
}

// ---------------------------------------------------------------------------
// 오늘의 결과(이미지·요약)

export interface DayPersonRow extends PersonRecord {
  name: string;
}

/** 오늘(가장 최근 세션) 확정 경기의 개인 승패. 승 많은 순 → 패 적은 순 → 이름. */
export function dayRecords(
  matches: readonly MatchView[],
  nameOf: (id: string) => string,
): DayPersonRow[] {
  const map = new Map<string, DayPersonRow>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      let row = map.get(entry.participantId);
      if (!row) {
        row = {
          participantId: entry.participantId,
          name: nameOf(entry.participantId),
          games: 0,
          wins: 0,
          losses: 0,
        };
        map.set(entry.participantId, row);
      }
      row.games += 1;
      if (entry.team === match.winnerTeam) row.wins += 1;
      else row.losses += 1;
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      a.losses - b.losses ||
      a.name.localeCompare(b.name, "ko") ||
      a.participantId.localeCompare(b.participantId),
  );
}

/** 사람별 마지막 경기 시각과 누적 경기 수(참가자 고르기 화면). 취소 경기는 세지 않는다. */
export function participation(
  matches: readonly MatchView[],
): Map<string, { games: number; lastPlayedAt: string; lastSessionId: string | null }> {
  const out = new Map<string, { games: number; lastPlayedAt: string; lastSessionId: string | null }>();
  for (const match of matches) {
    if (match.state === "canceled") continue;
    for (const entry of match.roster) {
      const row = out.get(entry.participantId) ?? { games: 0, lastPlayedAt: "", lastSessionId: null };
      if (isCounted(match)) row.games += 1;
      if (match.playedAt > row.lastPlayedAt) {
        row.lastPlayedAt = match.playedAt;
        row.lastSessionId = match.sessionId;
      }
      out.set(entry.participantId, row);
    }
  }
  return out;
}
