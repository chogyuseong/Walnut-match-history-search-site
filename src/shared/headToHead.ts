import { isCounted } from "./stats";
import type { MatchView } from "./types";

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
