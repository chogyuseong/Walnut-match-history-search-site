import { rankAndSearch, rankingGroup, type RankedRow, type RankingGroup } from "./insights";
import { RATING_TIERS, ratingTierOf, ratingValues, type PersonRating, type RatingTable, type RatingTier } from "./rating";
import { personRecords, type Placement } from "./stats";
import type { MatchView } from "./types";

/**
 * MMR 랭킹 화면(src/web/screens/Ranking.tsx)의 계산. 순위와 묶음은 기록 화면 "소환사 랭킹"의 MMR 순과 같은
 * 규칙(insights.rankAndSearch)을 그대로 쓰고, 여기서는 그 위에 얹는 요약 타일과 묶음 인원만 뽑는다.
 * MMR 자체가 모임 전체 누적이라 범위(오늘·시즌·연도)를 두지 않는다. 배치와 MMR 모두 유효 확정 경기만 센다.
 */

/** 누적 50경기 이상 묶음(insights.RANKING_VETERAN_GAMES). 요약 타일 후보는 이 묶음뿐이다. */
const VETERANS: RankingGroup = 0;
/** 배치 진행 중 묶음. MMR이 아직 크게 흔들려(배치 중 K) 막대 눈금·티어 분포에서 뺀다. */
const STILL_PLACING: RankingGroup = 2;

/** 모임 전체 누적 MMR 순위. 순위 숫자는 검색 전 기준이라 검색해도 바뀌지 않는다. */
export function mmrRanking(
  matches: readonly MatchView[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
  nameOf: (id: string) => string,
  query: string,
): { ranked: RankedRow[]; shown: RankedRow[] } {
  return rankAndSearch([...personRecords(matches).values()], placement, nameOf, "rating", query, ratingValues(table));
}

export interface RankingHighlight {
  row: RankedRow;
  rating: PersonRating;
}

export interface RankingHighlights {
  /** 누적 50경기 이상인 사람 중 맨 위. 그 묶음이 순위표 맨 위라 순위표 1위이자 시상대 1위(podiumOf)와 같다. */
  leader: RankingHighlight | null;
  /** 누적 50경기 이상 중 최근 10경기 MMR이 가장 많이 오른 사람. 반올림해 +1 이상인 사람만 후보다. */
  riser: RankingHighlight | null;
  /** 누적 50경기 이상 중 지금까지의 최고 MMR(peak)이 가장 높은 사람. */
  peak: RankingHighlight | null;
}

/**
 * 요약 타일 세 칸. 후보는 누적 50경기 이상 묶음뿐이다. 배치 중에는 K가 커서 최근 상승이 부풀려 보이고,
 * 배치를 막 마친 사람도 판수가 적어 몇 판 운으로 최고 MMR·최고 상승을 차지하기 쉽다. 그런 사람이 없으면 셋 다 null.
 * 값이 같으면 순위표에서 위에 있는 사람이 이긴다(ranked 순서대로 보고 더 클 때만 바꾼다).
 */
export function rankingHighlights(
  ranked: readonly RankedRow[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
): RankingHighlights {
  const veterans: RankingHighlight[] = [];
  for (const row of ranked) {
    const rating = table.get(row.participantId);
    if (rating && rankingGroup(placement, row.participantId) === VETERANS) veterans.push({ row, rating });
  }
  const best = (score: (entry: RankingHighlight) => number, eligible: (entry: RankingHighlight) => boolean) => {
    let top: RankingHighlight | null = null;
    for (const entry of veterans) {
      if (eligible(entry) && (!top || score(entry) > score(top))) top = entry;
    }
    return top;
  };
  return {
    leader: veterans[0] ?? null,
    riser: best((entry) => entry.rating.delta10, (entry) => Math.round(entry.rating.delta10) > 0),
    peak: best((entry) => entry.rating.peak, () => true),
  };
}

/** 시상대에 세우는 순위 수(금·은·동). */
export const PODIUM_PLACES = 3;
/** 순위 숫자를 브랜드 색으로 강조하는 마지막 순위(4위부터 여기까지). */
export const BRAND_PLACES = 5;
/** 왼쪽 색 띠와 굵은 순위 숫자를 주는 마지막 순위. 늘리면 강조가 흔해져 상위가 덜 눈에 띈다. */
export const HIGHLIGHT_PLACES = 10;

/**
 * 시상대: 누적 50경기 이상 묶음의 1~3위. 그 묶음이 맨 위라 순위 숫자 그대로 1·2·3이다.
 * 50경기 넘은 사람이 없는 새 모임에서는 비어 있다(배치 완료자를 올리면 몇 판 안 한 사람이 금메달을 단다).
 */
export function podiumOf(ranked: readonly RankedRow[], placement: ReadonlyMap<string, Placement>): RankedRow[] {
  return ranked.filter((row) => row.rank <= PODIUM_PLACES && rankingGroup(placement, row.participantId) === 0);
}

const MEDALS = ["medal-1", "medal-2", "medal-3"] as const;

export type RankEmphasis = (typeof MEDALS)[number] | "tier-brand" | "tier-bold" | null;

/** 순위별 강조 단계. 배치 진행 중인 사람은 순위가 높아 보여도 강조하지 않는다(점수가 아직 흔들린다). */
export function rankEmphasis(rank: number, placing: boolean): RankEmphasis {
  if (placing || rank > HIGHLIGHT_PLACES) return null;
  if (rank <= PODIUM_PLACES) return MEDALS[rank - 1]!;
  return rank <= BRAND_PLACES ? "tier-brand" : "tier-bold";
}

/** 시작값 기준 막대의 눈금: 왼쪽 끝 lo · 오른쪽 끝 hi · 기준선 start. */
export interface MmrScale {
  lo: number;
  hi: number;
  start: number;
}

/**
 * 순위표 막대의 눈금. 배치 완료자의 최저·최고 MMR로 잡되 시작값이 늘 범위 안에 들게 넓힌다(모두 시작값보다
 * 높아도 기준선이 왼쪽 끝에 보여야 "얼마나 올랐나"가 읽힌다). 배치 진행 중은 막대를 그리지 않으므로 빼고,
 * 검색으로 줄이 줄어도 눈금이 흔들리지 않게 검색 전 전체 순위표(ranked)로 계산한다. 배치 완료자가 없으면 null.
 */
export function mmrScale(
  ranked: readonly RankedRow[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
  start: number,
): MmrScale | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of ranked) {
    const rating = table.get(row.participantId)?.rating;
    if (rating === undefined || rankingGroup(placement, row.participantId) === STILL_PLACING) continue;
    lo = Math.min(lo, rating);
    hi = Math.max(hi, rating);
  }
  if (lo === Infinity) return null;
  return { lo: Math.min(lo, start), hi: Math.max(hi, start), start };
}

/**
 * 한 사람의 막대 위치(0~1 비율). 시작값보다 높으면 기준선에서 오른쪽으로, 낮으면 왼쪽으로 뻗는다.
 * 모두 시작값 그대로라 눈금 폭이 0이면 길이 0(기준선만 보인다).
 */
export function divergingBar(rating: number, scale: MmrScale): { left: number; width: number; up: boolean } {
  const span = scale.hi - scale.lo;
  if (span === 0) return { left: 0, width: 0, up: true };
  const at = (value: number) => (value - scale.lo) / span;
  const up = rating >= scale.start;
  return up
    ? { left: at(scale.start), width: at(rating) - at(scale.start), up }
    : { left: at(rating), width: at(scale.start) - at(rating), up };
}

/** 묶음별 인원(묶음 머리글에 적는다). 검색 전 전체 순위표 기준이다. */
export function rankingGroupSizes(
  ranked: readonly RankedRow[],
  placement: ReadonlyMap<string, Placement>,
): Record<RankingGroup, number> {
  const sizes: Record<RankingGroup, number> = { 0: 0, 1: 0, 2: 0 };
  for (const row of ranked) sizes[rankingGroup(placement, row.participantId)] += 1;
  return sizes;
}

/** 티어별 인원(배치 완료자만, 높은 티어부터). 0명인 티어는 뺀다. 검색 전 전체 순위표 기준이다. */
export function ratingTierCounts(
  ranked: readonly RankedRow[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
): { tier: RatingTier; count: number }[] {
  const counts = new Map<RatingTier, number>();
  for (const row of ranked) {
    const rating = table.get(row.participantId);
    const tier = rating && ratingTierOf(rating.rating, rankingGroup(placement, row.participantId) !== STILL_PLACING);
    if (tier) counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  return RATING_TIERS.filter((tier) => counts.has(tier)).map((tier) => ({ tier, count: counts.get(tier)! }));
}
