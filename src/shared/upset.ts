import { computeRatings, expectedScore } from "./rating";
import { isCounted, PLACEMENT_GAMES } from "./stats";
import type { MatchView, Side, Team } from "./types";

/**
 * 이변 지수와 편성 공정성(2026-11-09). 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관).
 *
 * - 경기 전 예상 승률: 그 경기 직전 각 팀원의 MMR(rating.ts의 history.before, 첫 경기면 시작값 1000) 평균으로
 *   팀 A가 이길 확률을 Elo 식(expectedScore)으로 구한다. MMR 계산과 같은 순서·같은 경기(유효 확정 경기)를 쓴다.
 * - MMR은 범위와 무관한 모임 전체 누적이므로 예상 승률도 누적 기준이다. 범위(시즌·연도·오늘)는 집계할 경기만 고른다.
 */

/**
 * 이변 기준: 이긴 팀의 경기 전 예상 승률이 이 값 미만이면 이변이다(임시값).
 * 0.4는 팀 평균 MMR 차가 약 70점 이상일 때다. 45~55%는 "균형"으로 보므로
 * 그보다 한 단계 더 벌어진 경우만 이변으로 쳐서 이변이 너무 흔해지지 않게 했다.
 */
export const UPSET_THRESHOLD = 0.4;
/** 균형 경기: 예상 승률이 50% ± 이 값 안(45~55%, 양 끝 포함). */
export const BALANCED_MARGIN = 0.05;
/** 편성 공정성은 판정 가능한 경기가 이만큼 이상일 때만 보여 준다(배치 판수와 같게). */
export const FAIRNESS_MIN_GAMES = 10;

export interface MatchExpectation {
  matchId: string;
  /** 팀 A가 이길 경기 전 예상 확률(0~1). */
  expectedA: number;
  teamASide: Side | null;
  winnerTeam: Team;
  /** 예상 우세 팀. 정확히 50%면 null. */
  favoriteTeam: Team | null;
  /**
   * 열 명 중 배치(누적 10경기)를 마친 사람이 한 명이라도 있으면 true.
   * 모두 배치 중이면 MMR이 아직 시작값 근처라 예상이 의미가 적어 이변·공정성 판정에서 뺀다(예상 값은 그대로 둔다).
   */
  reliable: boolean;
  /** reliable이고 이긴 팀의 예상 승률이 UPSET_THRESHOLD 미만이면 true. */
  upset: boolean;
  /** 1 − 이긴 팀의 예상 승률. 클수록 뜻밖의 결과다. */
  surprise: number;
}

/** 유효 확정 경기마다의 경기 전 예상(경기 ID → 예상). 한쪽 팀이 빈 경기는 MMR 계산처럼 건너뛴다. */
export function matchExpectations(matches: readonly MatchView[]): Map<string, MatchExpectation> {
  // 경기·사람별 그 경기 직전 MMR과 그 전 경기 수(history의 순번).
  const before = new Map<string, { rating: number; games: number }>();
  for (const person of computeRatings(matches).values()) {
    person.history.forEach((point, games) => {
      before.set(`${point.matchId}|${person.participantId}`, { rating: point.before, games });
    });
  }
  const out = new Map<string, MatchExpectation>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    const a: number[] = [];
    const b: number[] = [];
    let reliable = false;
    let missing = false;
    for (const r of match.roster) {
      const point = before.get(`${match.id}|${r.participantId}`);
      if (!point) {
        missing = true;
        break;
      }
      (r.team === "A" ? a : b).push(point.rating);
      if (point.games >= PLACEMENT_GAMES) reliable = true;
    }
    if (missing || a.length === 0 || b.length === 0) continue;
    const avg = (list: number[]) => list.reduce((s, v) => s + v, 0) / list.length;
    const expectedA = expectedScore(avg(a), avg(b));
    const winnerTeam = match.winnerTeam!;
    const winnerExpected = winnerTeam === "A" ? expectedA : 1 - expectedA;
    out.set(match.id, {
      matchId: match.id,
      expectedA,
      teamASide: match.teamASide,
      winnerTeam,
      favoriteTeam: expectedA > 0.5 ? "A" : expectedA < 0.5 ? "B" : null,
      reliable,
      upset: isUpset(winnerExpected, reliable),
      surprise: 1 - winnerExpected,
    });
  }
  return out;
}

/** 이변 판정: 판정 가능한 경기에서 이긴 팀의 경기 전 예상 승률이 UPSET_THRESHOLD 미만(경계값 0.4는 이변이 아니다). */
export function isUpset(winnerExpected: number, reliable: boolean): boolean {
  return reliable && winnerExpected < UPSET_THRESHOLD;
}

/** 팀의 경기 전 예상 승률(0~1). */
export function expectedOf(e: MatchExpectation, team: Team): number {
  return team === "A" ? e.expectedA : 1 - e.expectedA;
}

export interface PersonUpsets {
  /** 이변으로 이긴(약팀으로 이긴) 횟수. */
  upsetWins: number;
  /** 이변으로 진(강팀으로 진) 횟수. */
  upsetLosses: number;
  /** 약팀(예상 승률 50% 미만)이었던 판정 가능 경기 수. */
  underdogGames: number;
  underdogWins: number;
}

/** 한 사람의 이변 집계. scoped는 범위가 적용된 경기, expectations는 모임 전체로 구한 예상. */
export function personUpsets(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
  participantId: string,
): PersonUpsets {
  const out: PersonUpsets = { upsetWins: 0, upsetLosses: 0, underdogGames: 0, underdogWins: 0 };
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e || !e.reliable) continue;
    const me = match.roster.find((r) => r.participantId === participantId);
    if (!me) continue;
    const won = me.team === e.winnerTeam;
    if (e.upset) {
      if (won) out.upsetWins += 1;
      else out.upsetLosses += 1;
    }
    if (e.favoriteTeam !== null && e.favoriteTeam !== me.team) {
      out.underdogGames += 1;
      if (won) out.underdogWins += 1;
    }
  }
  return out;
}

/** 범위 안 사람별 이변 승 횟수(0회인 사람은 없다). 시즌 시상이 쓴다. */
export function upsetWinsByPerson(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e?.upset) continue;
    for (const r of match.roster) {
      if (r.team === e.winnerTeam) out.set(r.participantId, (out.get(r.participantId) ?? 0) + 1);
    }
  }
  return out;
}

export interface FairnessReport {
  /** 판정 가능한(reliable) 범위 안 경기 수. 아래 값의 분모다. */
  games: number;
  /** 예상 승률이 45~55% 안인 경기 수. */
  balanced: number;
  /** |예상 승률 − 50%|의 평균(0~0.5). 경기가 없으면 0. */
  avgDeviation: number;
  /** 우세 팀이 있던(정확히 50%가 아닌) 경기 수. */
  favoriteGames: number;
  /** 그중 우세 팀이 실제로 이긴 경기 수(예측 적중). */
  favoriteWins: number;
  /** 이변 경기 수. */
  upsets: number;
}

/** 편성 공정성. 범위 안 유효 경기 중 판정 가능한 경기만 센다(모두 배치 중인 경기는 예상이 50% 근처라 뺀다). */
export function fairnessReport(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
): FairnessReport {
  const out: FairnessReport = { games: 0, balanced: 0, avgDeviation: 0, favoriteGames: 0, favoriteWins: 0, upsets: 0 };
  let deviation = 0;
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e || !e.reliable) continue;
    out.games += 1;
    const d = Math.abs(e.expectedA - 0.5);
    deviation += d;
    // 소수 오차(0.55 − 0.5 = 0.05000…1)로 경계가 빠지지 않게 아주 작은 여유를 둔다.
    if (d <= BALANCED_MARGIN + 1e-9) out.balanced += 1;
    if (e.favoriteTeam !== null) {
      out.favoriteGames += 1;
      if (e.favoriteTeam === e.winnerTeam) out.favoriteWins += 1;
    }
    if (e.upset) out.upsets += 1;
  }
  out.avgDeviation = out.games > 0 ? deviation / out.games : 0;
  return out;
}
