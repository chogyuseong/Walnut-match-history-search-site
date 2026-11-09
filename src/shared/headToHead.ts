import { isCounted } from "./stats";
import { POSITIONS, type MatchView, type Position } from "./types";

/**
 * 두 사람의 상대 전적(2026-11-07). 준비 화면의 라인 맞대결(prepTools.ts laneMatchups), 두 사람 비교
 * (insights.ts headToHead → Compare.tsx), 개인 통계의 "상대 전적 보기"(Person.tsx)가 모두 이 계산을 쓴다.
 * 세는 경기는 전적 집계와 같다(stats.ts isCounted: 결과가 확정된 경기만. 진행 중·결과 대기·미진행 취소·전적 제외는 뺀다).
 * 그 경기에서 두 사람의 포지션은 따지지 않는다.
 */

/** 한 경기에서 두 사람의 관계. 둘 중 하나라도 없거나 세지 않는 경기면 null. aWon은 a 쪽 팀이 이겼는지. */
export interface PairOutcome {
  relation: "together" | "against";
  aWon: boolean;
}

export function pairOutcome(match: MatchView, a: string, b: string): PairOutcome | null {
  if (a === b || !isCounted(match)) return null;
  const ea = match.roster.find((r) => r.participantId === a);
  const eb = match.roster.find((r) => r.participantId === b);
  if (!ea || !eb) return null;
  return { relation: ea.team === eb.team ? "together" : "against", aWon: ea.team === match.winnerTeam };
}

export interface PairRecord {
  /** 서로 다른 팀으로 만난 경기 수와 a 기준 승·패. */
  against: { games: number; wins: number; losses: number };
  /** 같은 팀이었던 경기 수와 그 팀이 이긴 수. */
  together: { games: number; wins: number };
}

/** 넘겨받은 경기(범위는 호출하는 쪽이 정한다)에서 두 사람의 상대·같은 팀 전적(a 기준). */
export function pairRecord(matches: readonly MatchView[], a: string, b: string): PairRecord {
  const record: PairRecord = { against: { games: 0, wins: 0, losses: 0 }, together: { games: 0, wins: 0 } };
  for (const match of matches) {
    const outcome = pairOutcome(match, a, b);
    if (!outcome) continue;
    if (outcome.relation === "together") {
      record.together.games += 1;
      if (outcome.aWon) record.together.wins += 1;
    } else {
      record.against.games += 1;
      if (outcome.aWon) record.against.wins += 1;
      else record.against.losses += 1;
    }
  }
  return record;
}

export interface LaneDuel {
  position: Position;
  /** 이 라인에서 서로 마주 선 경기 수와 a 기준 승·패. */
  games: number;
  wins: number;
  losses: number;
}

/**
 * 같은 라인 맞대결(2026-11-08, 두 사람 비교 "상대일 때"): 상대 팀으로 만난 경기 중 두 사람이 같은 포지션이었던
 * 경기만 라인별로 센다(a 기준). 세는 경기는 pairOutcome과 같고, 둘 중 한 사람이라도 포지션 기록이 없으면 뺀다.
 * 준비 화면의 라인 맞대결(prepTools laneMatchups)은 포지션과 무관하게 세는 것과 다르다.
 * 라인 순서(탑~서폿)로, 맞붙은 적 있는 라인만 돌려준다.
 */
export function laneDuels(matches: readonly MatchView[], a: string, b: string): LaneDuel[] {
  const byLine = new Map<Position, LaneDuel>();
  for (const match of matches) {
    const outcome = pairOutcome(match, a, b);
    if (!outcome || outcome.relation !== "against") continue;
    const pa = match.roster.find((r) => r.participantId === a)!.position;
    const pb = match.roster.find((r) => r.participantId === b)!.position;
    if (pa === null || pa !== pb) continue;
    const duel = byLine.get(pa) ?? { position: pa, games: 0, wins: 0, losses: 0 };
    duel.games += 1;
    if (outcome.aWon) duel.wins += 1;
    else duel.losses += 1;
    byLine.set(pa, duel);
  }
  return POSITIONS.flatMap((p) => byLine.get(p) ?? []);
}

export interface LaneRival {
  position: Position;
  opponentId: string;
  /** 이 라인에서 상대 팀으로 마주 선 경기 수와 me 기준 승·패. */
  games: number;
  wins: number;
  losses: number;
}

/**
 * 맞라인 상대: me와 상대 팀이면서 같은 포지션이었던 사람을 라인별로 센다(laneDuels를 모든 상대로 펼친 것).
 * 한 사람과 여러 라인에서 맞붙었으면 라인마다 따로 담고, me의 포지션 기록이 없는 경기는 뺀다.
 * 라인 순서(탑~서폿) → 경기 수 많은 순.
 */
export function laneRivals(matches: readonly MatchView[], me: string): LaneRival[] {
  const byKey = new Map<string, LaneRival>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    const mine = match.roster.find((r) => r.participantId === me);
    if (!mine || mine.position === null) continue;
    const won = mine.team === match.winnerTeam;
    for (const r of match.roster) {
      if (r.team === mine.team || r.position !== mine.position) continue;
      const key = `${mine.position}:${r.participantId}`;
      const rival = byKey.get(key) ?? { position: mine.position, opponentId: r.participantId, games: 0, wins: 0, losses: 0 };
      rival.games += 1;
      if (won) rival.wins += 1;
      else rival.losses += 1;
      byKey.set(key, rival);
    }
  }
  const lineOrder = (p: Position) => POSITIONS.indexOf(p);
  return [...byKey.values()].sort((a, b) => lineOrder(a.position) - lineOrder(b.position) || b.games - a.games);
}

/** 라인별 가장 어려운·쉬운 맞라인 상대로 고를 최소 경기 수. 이보다 적으면 한두 판 운으로 순위가 갈린다. */
export const LANE_RIVAL_MIN = 3;

export interface LaneRivalPick {
  position: Position;
  /** min경기 이상 상대 중 승률 최저(같으면 경기 수 많은 쪽). 후보가 없으면 null. */
  hardest: LaneRival | null;
  /** min경기 이상 상대 중 승률 최고(같으면 경기 수 많은 쪽). */
  easiest: LaneRival | null;
}

/** 맞라인 기록이 있는 라인마다(탑~서폿) 가장 어려운·쉬운 상대. 후보가 하나면 둘 다 같은 사람이다. */
export function laneRivalSummary(rivals: readonly LaneRival[], min = LANE_RIVAL_MIN): LaneRivalPick[] {
  return POSITIONS.flatMap((position) => {
    const inLine = rivals.filter((r) => r.position === position);
    if (inLine.length === 0) return [];
    const eligible = inLine.filter((r) => r.games >= min);
    const rate = (r: LaneRival) => r.wins / r.games;
    // "어려운" 상대는 내가 지는 쪽(50% 미만)에서만, "쉬운" 상대는 이기는 쪽(50% 이상)에서만 고른다.
    // 그냥 최저·최고로 고르면 67% 이기는 상대가 "가장 어려운"으로 나온다.
    const hardest = [...eligible].filter((r) => rate(r) < 0.5).sort((a, b) => rate(a) - rate(b) || b.games - a.games)[0] ?? null;
    const easiest = [...eligible].filter((r) => rate(r) >= 0.5).sort((a, b) => rate(b) - rate(a) || b.games - a.games)[0] ?? null;
    return [{ position, hardest, easiest }];
  });
}
