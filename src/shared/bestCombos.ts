import { beyondChance, without } from "./commentary";
import { BUDDY_SYNERGY_MIN } from "./commentaryRules";
import { COMPARE_MIN_GAMES, compareMetrics, synergyPoints } from "./insights";
import { personDetail, personRecords, rateGapChance, SMALL_SAMPLE, type PairTally, type PersonDetail, type Tally } from "./stats";
import type { MatchView } from "./types";

/**
 * "최고의 콤비": 서로가 서로의 잘 맞는 동료인 두 사람(2026-11-20 사용자 요청).
 * 한쪽만 상대를 꼽으면 콤비가 아니다. 그래서 한 사람의 콤비는 많아야 한 명이다.
 * 쓰는 곳: 두 사람 비교 "같은 팀일 때", 개인 통계 "잘 맞는 동료", 그래프 분석 고른 플레이어, 팀 짜기(같은 팀에 둘이 있을 때).
 * 판정 기준은 분석 코멘트의 동료 문장(playerCommentary.ts)과 같은 confirmedBuddy다. 한쪽만 바꾸면 코멘트는
 * "잘 맞는다"고 하는데 배지가 없거나 그 반대가 된다.
 */

export interface ConfirmedBuddy {
  /** 같은 팀일 때 이 사람 기준 성적(= 그 팀의 승패). */
  pair: PairTally;
  /** 같은 팀 승률 − 두 사람 승률 평균(%p). */
  synergy: number;
  /** 같은 짝 수만큼 엄하게 본 우연 가능성(근거 줄에 쓴다). */
  chance: number;
}

/**
 * 이 사람의 "잘 맞는 동료"를 말할 만한지까지 따진 결과. 없으면 null.
 * 후보는 누적 기준(COMPARE_MIN_GAMES)과 표본(SMALL_SAMPLE)을 넘는 동료 중 같은 팀 승률 1위(compareMetrics.buddy)이고,
 * 시너지가 BUDDY_SYNERGY_MIN 이상이며 우연 문턱(후보 수만큼 엄하게)을 넘어야 한다.
 * records는 같은 범위의 personRecords(상대의 혼자 승률을 읽는다).
 */
export function confirmedBuddy(
  detail: PersonDetail,
  cumulative: ReadonlyMap<string, { games: number }>,
  records: ReadonlyMap<string, Tally>,
): ConfirmedBuddy | null {
  const compare = compareMetrics(detail, cumulative);
  const pair = compare.buddy;
  if (!pair) return null;
  const synergy = synergyPoints(pair, detail.summary, records.get(pair.participantId) ?? { games: 0, wins: 0 });
  // 기준을 넘는 짝 중 가장 극단을 고른 것이라 그 짝 수만큼 우연 문턱을 엄하게 한다.
  // 견주는 쪽은 "그 사람과 함께 뛴 경기"와 "그 밖의 내 경기"다.
  const candidates = compare.synergy.filter((p) => p.games >= SMALL_SAMPLE).length;
  const chance = rateGapChance(pair, without(detail.summary, pair));
  if (synergy === null || synergy < BUDDY_SYNERGY_MIN || !beyondChance(chance, candidates)) return null;
  return { pair, synergy, chance };
}

export interface Combo {
  /** 상대 사람. */
  partnerId: string;
  /** 두 사람이 같은 팀이었던 성적. */
  together: Tally;
  synergy: number;
}

/**
 * 범위 안의 최고의 콤비를 사람 → 콤비로 돌려준다(두 사람 모두 키로 들어 있다).
 * 사람마다 personDetail을 한 번씩 돌린다. 누적 기준을 못 넘는 사람은 건너뛰므로 실제로 도는 수는 그보다 적다.
 * 2000경기·60명이어도 수십 ms라 화면에서 useMemo로 스냅숏·범위가 바뀔 때만 다시 센다.
 */
export function bestCombos(
  scoped: readonly MatchView[],
  cumulative: ReadonlyMap<string, { games: number }>,
  nameOf: (id: string) => string,
): Map<string, Combo> {
  const records = personRecords(scoped);
  const buddyOf = new Map<string, ConfirmedBuddy>();
  for (const id of records.keys()) {
    // compareMetrics도 같은 기준으로 비우지만, personDetail을 돌기 전에 걸러 계산을 아낀다.
    if ((cumulative.get(id)?.games ?? 0) < COMPARE_MIN_GAMES) continue;
    const buddy = confirmedBuddy(personDetail(scoped, id, nameOf), cumulative, records);
    if (buddy) buddyOf.set(id, buddy);
  }
  const combos = new Map<string, Combo>();
  for (const [id, buddy] of buddyOf) {
    const partnerId = buddy.pair.participantId;
    if (buddyOf.get(partnerId)?.pair.participantId !== id) continue;
    combos.set(id, {
      partnerId,
      together: { games: buddy.pair.games, wins: buddy.pair.wins },
      synergy: buddy.synergy,
    });
  }
  return combos;
}
