import { countedChronological } from "./insights";
import { isCounted, localDate, type Tally } from "./stats";
import { shownRating, type RatingTable } from "./rating";
import type { MatchView } from "./types";
import type { MatchExpectation } from "./upset";
import { EARLY_GAMES } from "./commentaryRules";

/**
 * 개인 코멘트가 읽는 집계 중 다른 화면에 없는 것: 예상 우세 판 성적, 진 다음 판·이긴 다음 판, 모임 날 초반·후반,
 * 챔피언별 성적, MMR 1위까지의 점수 차. playerCommentary.ts만 쓴다.
 */

/** 팀 평균 MMR이 높았던(예상 우세) 판의 성적(배치 마친 사람이 있는 판만, upset.ts reliable). */
export function favoredTally(expectations: ReadonlyMap<string, MatchExpectation>, scoped: readonly MatchView[], id: string): Tally {
  const tally: Tally = { games: 0, wins: 0 };
  for (const match of scoped) {
    const e = expectations.get(match.id);
    const me = match.roster.find((r) => r.participantId === id);
    if (!e?.reliable || !me || e.favoriteTeam !== me.team) continue;
    tally.games += 1;
    if (e.winnerTeam === me.team) tally.wins += 1;
  }
  return tally;
}

/** 이 사람의 유효 경기를 모임 날(시간대 기준)별로 시각 순서대로 묶는다. */
function myDays(scoped: readonly MatchView[], id: string, timeZone: string): { won: boolean }[][] {
  const days = new Map<string, { won: boolean }[]>();
  for (const match of countedChronological(scoped)) {
    const me = match.roster.find((r) => r.participantId === id);
    if (!me) continue;
    const day = localDate(match.playedAt, timeZone);
    let list = days.get(day);
    if (!list) days.set(day, (list = []));
    list.push({ won: me.team === match.winnerTeam });
  }
  return [...days.values()];
}

/** 같은 날 바로 다음 경기의 성적: 진 다음 판·이긴 다음 판. 날이 바뀌면 이어 세지 않는다(다음 모임은 기분이 새로 시작된다). */
export function afterResults(scoped: readonly MatchView[], id: string, timeZone: string): { afterLoss: Tally; afterWin: Tally } {
  const afterLoss: Tally = { games: 0, wins: 0 };
  const afterWin: Tally = { games: 0, wins: 0 };
  for (const day of myDays(scoped, id, timeZone)) {
    for (let i = 1; i < day.length; i++) {
      const target = day[i - 1]!.won ? afterWin : afterLoss;
      target.games += 1;
      if (day[i]!.won) target.wins += 1;
    }
  }
  return { afterLoss, afterWin };
}

/** 모임 날 첫 EARLY_GAMES판과 그 뒤 판의 성적. */
export function dayParts(scoped: readonly MatchView[], id: string, timeZone: string): { early: Tally; late: Tally } {
  const early: Tally = { games: 0, wins: 0 };
  const late: Tally = { games: 0, wins: 0 };
  for (const day of myDays(scoped, id, timeZone)) {
    day.forEach((g, i) => {
      const target = i < EARLY_GAMES ? early : late;
      target.games += 1;
      if (g.won) target.wins += 1;
    });
  }
  return { early, late };
}

/** 챔피언별 성적(챔피언을 기록한 유효 경기만). */
export function championTallies(scoped: readonly MatchView[], id: string): (Tally & { key: string })[] {
  const byKey = new Map<string, Tally & { key: string }>();
  for (const match of scoped) {
    if (!isCounted(match)) continue;
    const me = match.roster.find((r) => r.participantId === id);
    if (!me?.champion) continue;
    const tally = byKey.get(me.champion) ?? { key: me.champion, games: 0, wins: 0 };
    tally.games += 1;
    if (me.team === match.winnerTeam) tally.wins += 1;
    byKey.set(me.champion, tally);
  }
  return [...byKey.values()];
}

/** 배치 마친 사람 중 MMR 1위와 그 1위까지의 점수 차(정수). 본인이 1위거나 배치 전이면 null. */
export function chaseLeader(ratings: RatingTable, id: string, placementGames: number): { id: string; gap: number } | null {
  const me = ratings.get(id);
  if (!me || me.games < placementGames) return null;
  let top: { id: string; rating: number } | null = null;
  for (const p of ratings.values()) {
    if (p.games < placementGames) continue;
    if (!top || p.rating > top.rating) top = { id: p.participantId, rating: p.rating };
  }
  if (!top || top.id === id) return null;
  return { id: top.id, gap: shownRating(top.rating) - shownRating(me.rating) };
}
