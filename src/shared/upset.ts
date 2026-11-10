import { computeRatings, DEFAULT_RATING_OPTIONS, expectedScore, type RatingOptions } from "./rating";
import { isCounted } from "./stats";
import type { MatchView, Side, Team } from "./types";

/**
 * 이변 지수와 편성 공정성(2026-11-09). 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관).
 *
 * - 경기 전 예상 승률: 그 경기 직전 각 팀원의 MMR(rating.ts의 history.before, 첫 경기면 시작값) 평균으로
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
/** 편성 공정성은 판정 가능한 경기가 이만큼 이상일 때만 보여 준다(기본 배치 판수와 같은 값, 배치 설정과는 무관). */
export const FAIRNESS_MIN_GAMES = 10;
/**
 * "많이 치우친" 경기: |예상 − 50%|가 이 값을 넘으면(65% 초과 또는 35% 미만). BALANCED_MARGIN~이 값 사이는 "조금 치우침".
 * 올리면 "많이 치우침" 띠가 짧아지고 "조금 치우침"이 길어진다. 이변 기준(0.4)과는 별개다.
 */
export const LOPSIDED_MARGIN = 0.15;
/** 균형 경기 비율의 구간 경계(good·ok·poor). 그래프 분석은 이 구간을 숫자로만 쓴다("균형 경기 60% 이상"). */
export const FAIRNESS_GOOD = 0.6;
export const FAIRNESS_OK = 0.4;

export interface MatchExpectation {
  matchId: string;
  /** 팀 A가 이길 경기 전 예상 확률(0~1). */
  expectedA: number;
  teamASide: Side | null;
  winnerTeam: Team;
  /** 예상 우세 팀. 정확히 50%면 null. */
  favoriteTeam: Team | null;
  /**
   * 열 명 중 배치(누적 경기가 배치 경기 수 이상)를 마친 사람이 한 명이라도 있으면 true.
   * 모두 배치 중이면 MMR이 아직 시작값 근처라 예상이 의미가 적어 이변·공정성 판정에서 뺀다(예상 값은 그대로 둔다).
   */
  reliable: boolean;
  /** reliable이고 이긴 팀의 예상 승률이 UPSET_THRESHOLD 미만이면 true. */
  upset: boolean;
  /** 1 − 이긴 팀의 예상 승률. 클수록 뜻밖의 결과다. */
  surprise: number;
}

/** 유효 확정 경기마다의 경기 전 예상(경기 ID → 예상). 한쪽 팀이 빈 경기는 MMR 계산처럼 건너뛴다. */
export function matchExpectations(
  matches: readonly MatchView[],
  options: Partial<RatingOptions> = {},
): Map<string, MatchExpectation> {
  const { placementGames } = { ...DEFAULT_RATING_OPTIONS, ...options };
  // history의 순번이 곧 그 경기 전에 치른 경기 수다.
  const before = new Map<string, { rating: number; games: number }>();
  for (const person of computeRatings(matches, options).values()) {
    person.history.forEach((point, games) => {
      before.set(`${point.matchId}|${person.participantId}`, { rating: point.before, games });
    });
  }
  const expectations = new Map<string, MatchExpectation>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    const ratingsA: number[] = [];
    const ratingsB: number[] = [];
    let reliable = false;
    let missing = false;
    for (const r of match.roster) {
      const point = before.get(`${match.id}|${r.participantId}`);
      if (!point) {
        missing = true;
        break;
      }
      (r.team === "A" ? ratingsA : ratingsB).push(point.rating);
      if (point.games >= placementGames) reliable = true;
    }
    if (missing || ratingsA.length === 0 || ratingsB.length === 0) continue;
    const avg = (ratings: number[]) => ratings.reduce((s, v) => s + v, 0) / ratings.length;
    const expectedA = expectedScore(avg(ratingsA), avg(ratingsB));
    const winnerTeam = match.winnerTeam!;
    const winnerExpected = winnerTeam === "A" ? expectedA : 1 - expectedA;
    expectations.set(match.id, {
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
  return expectations;
}

/** 경계값 0.4 자체는 이변이 아니다(미만만). */
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
  const tally: PersonUpsets = { upsetWins: 0, upsetLosses: 0, underdogGames: 0, underdogWins: 0 };
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e?.reliable) continue;
    const me = match.roster.find((r) => r.participantId === participantId);
    if (!me) continue;
    const won = me.team === e.winnerTeam;
    if (e.upset) {
      if (won) tally.upsetWins += 1;
      else tally.upsetLosses += 1;
    }
    if (e.favoriteTeam !== null && e.favoriteTeam !== me.team) {
      tally.underdogGames += 1;
      if (won) tally.underdogWins += 1;
    }
  }
  return tally;
}

/** 범위 안 사람별 이변 승 횟수(0회인 사람은 없다). 시즌 시상이 쓴다. */
export function upsetWinsByPerson(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
): Map<string, number> {
  const wins = new Map<string, number>();
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e?.upset) continue;
    for (const r of match.roster) {
      if (r.team === e.winnerTeam) wins.set(r.participantId, (wins.get(r.participantId) ?? 0) + 1);
    }
  }
  return wins;
}

export interface FairnessReport {
  /** 판정 가능한(reliable) 범위 안 경기 수. 아래 값의 분모다. */
  games: number;
  /** 예상 승률이 45~55% 안인 경기 수. */
  balanced: number;
  /** 조금 치우친 경기 수(45~55% 밖이지만 35~65% 안). balanced + slight + lopsided = games. */
  slight: number;
  /** 많이 치우친 경기 수(65% 초과 또는 35% 미만). */
  lopsided: number;
  /** |예상 승률 − 50%|의 평균(0~0.5). 경기가 없으면 0. */
  avgDeviation: number;
  /** 우세 팀이 있던(정확히 50%가 아닌) 경기 수. */
  favoriteGames: number;
  /** 그중 우세 팀이 실제로 이긴 경기 수(예측 적중). */
  favoriteWins: number;
  upsets: number;
}

/** 편성 공정성. 범위 안 유효 경기 중 판정 가능한 경기만 센다(모두 배치 중인 경기는 예상이 50% 근처라 뺀다). */
export function fairnessReport(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
): FairnessReport {
  const report: FairnessReport = {
    games: 0,
    balanced: 0,
    slight: 0,
    lopsided: 0,
    avgDeviation: 0,
    favoriteGames: 0,
    favoriteWins: 0,
    upsets: 0,
  };
  let deviation = 0;
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e?.reliable) continue;
    report.games += 1;
    const d = Math.abs(e.expectedA - 0.5);
    deviation += d;
    // 소수 오차(0.55 − 0.5 = 0.05000…1)로 경계가 빠지지 않게 아주 작은 여유를 둔다.
    if (d <= BALANCED_MARGIN + 1e-9) report.balanced += 1;
    else if (d <= LOPSIDED_MARGIN + 1e-9) report.slight += 1;
    else report.lopsided += 1;
    if (e.favoriteTeam !== null) {
      report.favoriteGames += 1;
      if (e.favoriteTeam === e.winnerTeam) report.favoriteWins += 1;
    }
    if (e.upset) report.upsets += 1;
  }
  report.avgDeviation = report.games > 0 ? deviation / report.games : 0;
  return report;
}

export type FairnessVerdict = "good" | "ok" | "poor";

/** 균형 경기 비율로 한 줄 판정. 화면 머리글 문구와 색이 이 값을 따른다. 경기가 없으면 "ok". */
export function fairnessVerdict(report: FairnessReport): FairnessVerdict {
  if (report.games === 0) return "ok";
  const share = report.balanced / report.games;
  return share >= FAIRNESS_GOOD ? "good" : share >= FAIRNESS_OK ? "ok" : "poor";
}
