import { rankAndSearch, rankingGroup, type RankedRow, type RankingGroup } from "./insights";
import { RATING_TIERS, ratingTierOf, ratingValues, type PersonRating, type RatingTable, type RatingTier } from "./rating";
import { personRecords, type Placement } from "./stats";
import type { MatchView } from "./types";

/**
 * MMR 랭킹 화면(src/web/screens/Ranking.tsx)의 계산. 순위와 묶음은 기록 화면 "소환사 랭킹"의 MMR 순과 같은
 * 규칙(insights.rankAndSearch)을 그대로 쓰고, 여기서는 그 위에 얹는 요약 타일과 묶음 인원만 뽑는다.
 * MMR 자체가 모임 전체 누적이라 범위(오늘·시즌·연도)를 두지 않는다. 배치와 MMR 모두 유효 확정 경기만 센다.
 */

/** 배치 진행 중 묶음. 이 묶음은 MMR이 아직 크게 흔들려(배치 중 K) 요약 타일 후보에서 뺀다. */
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
  /** 순위표 1위(배치 완료자 중 맨 위). */
  leader: RankingHighlight | null;
  /** 최근 10경기 MMR이 가장 많이 오른 사람. 반올림해 +1 이상인 사람만 후보다. */
  riser: RankingHighlight | null;
  /** 지금까지의 최고 MMR(peak)이 가장 높은 사람. */
  peak: RankingHighlight | null;
}

/**
 * 요약 타일 세 칸. 후보는 배치 완료자뿐이다(배치 중 K가 커서 최근 상승이 부풀려 보인다).
 * 값이 같으면 순위표에서 위에 있는 사람이 이긴다(ranked 순서대로 보고 더 클 때만 바꾼다).
 */
export function rankingHighlights(
  ranked: readonly RankedRow[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
): RankingHighlights {
  const placed: RankingHighlight[] = [];
  for (const row of ranked) {
    const rating = table.get(row.participantId);
    if (rating && rankingGroup(placement, row.participantId) !== STILL_PLACING) placed.push({ row, rating });
  }
  const best = (score: (entry: RankingHighlight) => number, eligible: (entry: RankingHighlight) => boolean) => {
    let top: RankingHighlight | null = null;
    for (const entry of placed) {
      if (eligible(entry) && (!top || score(entry) > score(top))) top = entry;
    }
    return top;
  };
  return {
    leader: placed[0] ?? null,
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
/** MMR 막대의 가장 짧은 길이(묶음 최저 MMR). 0이면 꼴찌 막대가 사라져 빈 줄처럼 보인다. */
export const BAR_FLOOR = 0.08;

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

/** 묶음별 MMR 최저·최고. 막대는 묶음 안에서만 견준다(묶음이 다르면 경기 수 기준이 달라 견주기 어렵다). */
export function ratingRangeByGroup(
  ranked: readonly RankedRow[],
  table: RatingTable,
  placement: ReadonlyMap<string, Placement>,
): Map<RankingGroup, { min: number; max: number }> {
  const ranges = new Map<RankingGroup, { min: number; max: number }>();
  for (const row of ranked) {
    const rating = table.get(row.participantId)?.rating;
    if (rating === undefined) continue;
    const group = rankingGroup(placement, row.participantId);
    const range = ranges.get(group);
    if (!range) ranges.set(group, { min: rating, max: rating });
    else {
      range.min = Math.min(range.min, rating);
      range.max = Math.max(range.max, rating);
    }
  }
  return ranges;
}

/**
 * MMR 막대 길이(0~1). 최고 대비 비율(rating/max)은 시작값 근처끼리라 모두 0.9 언저리로 똑같아 보여서,
 * 묶음 최저를 BAR_FLOOR, 최고를 1로 두고 그 사이를 선형으로 나눈다. 모두 같으면 가득 채운다.
 */
export function mmrBarShare(rating: number, range: { min: number; max: number }): number {
  if (range.max === range.min) return 1;
  return BAR_FLOOR + (1 - BAR_FLOOR) * ((rating - range.min) / (range.max - range.min));
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
