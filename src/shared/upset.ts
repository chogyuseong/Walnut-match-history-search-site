import { computeRatings, DEFAULT_RATING_OPTIONS, expectedScore, type RatingOptions } from "./rating";
import { isCounted } from "./stats";
import type { MatchView, Side, Team } from "./types";

/**
 * 이변 지수와 편성 공정성(2026-11-09). 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관).
 * 쓰는 곳: 경기 카드·경기 상세의 이변 배지와 예상 %, 개인 통계·그래프 분석의 이변 승·섞기 공정성, 분석 코멘트,
 * 시즌 시상 "이변 메이커", 준비 화면 예상 승률 판(forecast.ts가 같은 보정값을 가져간다).
 *
 * - 경기 전 예상 승률: 그 경기 직전 각 팀원의 MMR(rating.ts의 history.before, 첫 경기면 시작값) 평균으로
 *   팀 A가 이길 확률을 Elo 식(expectedScore)으로 구한 뒤, 이 모임 지난 경기로 보정한다(아래).
 *   MMR 계산과 같은 순서·같은 경기(유효 확정 경기)를 쓴다.
 * - MMR은 범위와 무관한 모임 전체 누적이므로 예상 승률도 누적 기준이다. 범위(시즌·연도·오늘)는 집계할 경기만 고른다.
 *
 * 보정 p' = σ(a·logit(p) + b·s): 실제 모임 522경기를 검증하니 MMR 예상 62%인 경기를 실제로는 약 53% 이겼고,
 * 어떤 MMR 방식도 "늘 50%"(Brier 0.25)보다 낫지 않았다(0.2576). 팀을 티어로 맞춰 짜서 MMR 차가 실제 전력 차보다
 * 과장되는 것으로 본다. 그래서 그 모임의 경기 전 예상과 실제 결과로 두 수를 맞춘다.
 *   - a(scale): 원래 예상의 로짓에 곱하는 배율. 1이면 그대로, 1보다 작으면 50% 쪽으로 줄인다(과신을 덜어낸다).
 *   - b(blueEdge): 블루 진영 몫(로짓 단위). s는 팀 A가 블루면 +1, 레드면 −1, 진영을 모르면 0.
 * 맞춤은 모임 전체 기록으로 한 번 하고 모든 경기에 같은 a·b를 쓴다. MMR 자체가 전체 기록 일괄 계산이라 새 경기가
 * 들어오면 지난 경기의 예상도 바뀌는 것과 같은 방식이다. 대신 지난 경기의 "경기 전 예상"에는 그 뒤 경기로 배운
 * a·b가 섞인다(미래 정보). 경기 상세에 "지금 기록으로 다시 계산한 값"이라고 적는 까닭이고, 그때 화면에 떴던 값과 다를 수 있다.
 * 경기마다 그 앞 경기로만 맞추면 미래 정보는 없지만, 초반 경기는 보정이 없어 같은 MMR 차라도 경기마다 %가 달라지고
 * 준비 화면 %와 이변 판정 기준이 어긋난다(화면 %와 이변 기준을 같은 숫자로 두기로 했다).
 */

/**
 * 이변 기준: 이긴 팀의 경기 전 예상 승률(보정 뒤)이 이 값 미만이면 이변이다(임시값).
 * 보정 전(a = 1, 진영 몫 0)이면 팀 평균 MMR 차가 약 70점 이상일 때다. a가 작을수록 같은 40%에 닿으려면 MMR 차가
 * 더 벌어져야 해서 이변이 드물어진다. 45~55%는 "균형"으로 보므로 그보다 한 단계 더 벌어진 경우만 이변으로 쳐서
 * 이변이 너무 흔해지지 않게 했다.
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

/**
 * 보정 재료로 쓸 판정 가능(reliable) 경기의 최소 수. 이보다 적으면 보정하지 않는다(a = 1, b = 0).
 * 낮추면 작은 모임도 일찍 보정되지만 몇 판의 운으로 a·b가 크게 흔들리고, 높이면 그만큼 오래 과신한 %를 보여 준다.
 */
export const CALIBRATION_MIN_GAMES = 50;
/**
 * a를 1 쪽, b를 0 쪽으로 당기는 가상 경기 수. "보정이 필요 없다"고 말하는 경기를 이만큼 안고 시작한다고 보면 된다.
 * 키우면 경기가 적은 모임의 a·b가 덜 움직이고(원래 예상에 가깝게), 줄이면 실제 결과를 더 바로 따른다.
 * 최소 경기 수(50)에서 실제 경기와 가상 경기의 무게가 5:3이다.
 */
export const CALIBRATION_PRIOR_GAMES = 30;
/** 반반 경기 한 판이 주는 정보 p(1 − p)(p = 0.5). 가상 경기 n판의 벌점 무게 = n × 이 값. */
const INFO_PER_EVEN_GAME = 0.25;
/** 뉴턴법 반복 상한과 멈추는 걸음 크기(로짓 단위). 벌점이 있어 대개 다섯 번 안에 멈춘다. */
const CALIBRATION_ITERS_MAX = 25;
const CALIBRATION_TOLERANCE = 1e-10;

/** 이 모임 기록으로 맞춘 보정값. 준비 화면 근거 줄("이 모임 n경기로 보정")도 이 값을 쓴다. */
export interface ExpectationCalibration {
  /** a: 원래 예상의 로짓에 곱하는 배율. */
  scale: number;
  /** b: 블루 진영 몫(로짓 단위). 양수면 블루가 더 이긴다. */
  blueEdge: number;
  /** 맞춤 재료로 쓴 판정 가능 경기 수. */
  games: number;
  /** games가 CALIBRATION_MIN_GAMES 이상이라 보정했는지. false면 원래 예상 그대로다. */
  applied: boolean;
}

export const UNCALIBRATED: ExpectationCalibration = { scale: 1, blueEdge: 0, games: 0, applied: false };

/** 맞춤 재료 한 판: 경기 직전 원래 예상(팀 A 승), 팀 A 진영, 실제 승리 팀. */
export interface CalibrationSample {
  expectedA: number;
  teamASide: Side | null;
  winnerTeam: Team;
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const blueSign = (side: Side | null) => (side === "blue" ? 1 : side === "red" ? -1 : 0);

/**
 * 벌점 붙은 최대우도로 a·b를 푼다(2변수 로지스틱 회귀, 뉴턴법). 벌점은 ½·κ·((a − 1)²·v + b²),
 * κ = 가상 경기 수 × 반반 경기 정보, v = 재료 경기 로짓 제곱의 평균. v를 곱해 a의 벌점도 "이 모임 예상 분포를 가진
 * 가상 경기 n판"만큼의 무게가 되게 했다(예상이 모두 50% 근처인 모임은 a를 알아낼 정보와 벌점이 함께 작아진다).
 */
export function fitExpectationCalibration(samples: readonly CalibrationSample[]): ExpectationCalibration {
  if (samples.length < CALIBRATION_MIN_GAMES) return { ...UNCALIBRATED, games: samples.length };
  const logits = samples.map((s) => logit(s.expectedA));
  const sides = samples.map((s) => blueSign(s.teamASide));
  const aWon = samples.map((s) => (s.winnerTeam === "A" ? 1 : 0));
  const prior = CALIBRATION_PRIOR_GAMES * INFO_PER_EVEN_GAME;
  // 예상이 모두 정확히 50%면 배율은 결과에 아무 영향이 없어 v가 0이 된다. 그때는 무게 1로 a를 1에 묶어 둔다.
  const spread = logits.reduce((sum, l) => sum + l * l, 0) / logits.length || 1;
  let scale = 1;
  let blueEdge = 0;
  for (let iter = 0; iter < CALIBRATION_ITERS_MAX; iter++) {
    // g는 기울기, h는 음의 헤세 행렬(벌점 덕에 늘 양의 정부호라 2×2를 그대로 푼다).
    let gA = -prior * spread * (scale - 1);
    let gB = -prior * blueEdge;
    let hAA = prior * spread;
    let hAB = 0;
    let hBB = prior;
    logits.forEach((l, i) => {
      const s = sides[i]!;
      const q = sigmoid(scale * l + blueEdge * s);
      const miss = aWon[i]! - q;
      const w = q * (1 - q);
      gA += miss * l;
      gB += miss * s;
      hAA += w * l * l;
      hAB += w * l * s;
      hBB += w * s * s;
    });
    const det = hAA * hBB - hAB * hAB;
    const stepA = (hBB * gA - hAB * gB) / det;
    const stepB = (hAA * gB - hAB * gA) / det;
    scale += stepA;
    blueEdge += stepB;
    if (Math.max(Math.abs(stepA), Math.abs(stepB)) < CALIBRATION_TOLERANCE) break;
  }
  return { scale, blueEdge, games: samples.length, applied: true };
}

/** 원래 예상(팀 A 승)을 보정한 값. 보정하지 않는 모임이면 원래 값을 소수 오차 없이 그대로 돌려준다. */
export function calibrateExpectation(
  expectedA: number,
  teamASide: Side | null,
  calibration: ExpectationCalibration,
): number {
  if (!calibration.applied) return expectedA;
  return sigmoid(calibration.scale * logit(expectedA) + calibration.blueEdge * blueSign(teamASide));
}

export interface MatchExpectation {
  matchId: string;
  /** 팀 A가 이길 경기 전 예상 확률(0~1, 이 모임 기록으로 보정한 값). */
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

interface PreMatch extends CalibrationSample {
  matchId: string;
  reliable: boolean;
}

/** 보정 전 경기 전 예상(유효 확정 경기마다). 한쪽 팀이 빈 경기는 MMR 계산처럼 건너뛴다. */
function preMatchExpectations(matches: readonly MatchView[], options: Partial<RatingOptions>): PreMatch[] {
  const { placementGames } = { ...DEFAULT_RATING_OPTIONS, ...options };
  // history의 순번이 곧 그 경기 전에 치른 경기 수다.
  const before = new Map<string, { rating: number; games: number }>();
  for (const person of computeRatings(matches, options).values()) {
    person.history.forEach((point, games) => {
      before.set(`${point.matchId}|${person.participantId}`, { rating: point.before, games });
    });
  }
  const pre: PreMatch[] = [];
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
    pre.push({
      matchId: match.id,
      expectedA: expectedScore(avg(ratingsA), avg(ratingsB)),
      teamASide: match.teamASide,
      winnerTeam: match.winnerTeam!,
      reliable,
    });
  }
  return pre;
}

interface ExpectationFit {
  expectations: Map<string, MatchExpectation>;
  calibration: ExpectationCalibration;
}

// 같은 경기 배열(스냅숏)이면 화면마다 다시 맞추지 않는다(rating.ts computeRatings와 같은 방식).
// 배치 경기 수가 재료 경기를, 시작값이 MMR 표를 정하므로 둘로 나눠 둔다. 돌려준 값은 여러 화면이 같이 보므로 읽기만 한다.
const fitCache = new WeakMap<readonly MatchView[], Map<string, ExpectationFit>>();

function expectationFit(matches: readonly MatchView[], options: Partial<RatingOptions>): ExpectationFit {
  const { placementGames, start } = { ...DEFAULT_RATING_OPTIONS, ...options };
  const key = `${placementGames}|${start}`;
  let byOptions = fitCache.get(matches);
  if (!byOptions) fitCache.set(matches, (byOptions = new Map()));
  const cached = byOptions.get(key);
  if (cached) return cached;

  const pre = preMatchExpectations(matches, options);
  // 모두 배치 중인 경기는 MMR이 시작값 근처라 재료에서 뺀다(이변 판정에서 빼는 것과 같은 이유).
  const calibration = fitExpectationCalibration(pre.filter((p) => p.reliable));
  const expectations = new Map<string, MatchExpectation>();
  for (const p of pre) {
    const expectedA = calibrateExpectation(p.expectedA, p.teamASide, calibration);
    const winnerExpected = p.winnerTeam === "A" ? expectedA : 1 - expectedA;
    expectations.set(p.matchId, {
      matchId: p.matchId,
      expectedA,
      teamASide: p.teamASide,
      winnerTeam: p.winnerTeam,
      favoriteTeam: expectedA > 0.5 ? "A" : expectedA < 0.5 ? "B" : null,
      reliable: p.reliable,
      upset: isUpset(winnerExpected, p.reliable),
      surprise: 1 - winnerExpected,
    });
  }
  const fit = { expectations, calibration };
  byOptions.set(key, fit);
  return fit;
}

/** 유효 확정 경기마다의 경기 전 예상(경기 ID → 예상, 보정 뒤). 이변 판정을 쓰는 화면은 모두 이 값을 거친다. */
export function matchExpectations(
  matches: readonly MatchView[],
  options: Partial<RatingOptions> = {},
): ReadonlyMap<string, MatchExpectation> {
  return expectationFit(matches, options).expectations;
}

/** 이 모임 기록으로 맞춘 보정값. matches는 스냅숏의 모임 전체 경기를 그대로 넘긴다(좁혀 넣으면 다른 a·b가 나온다). */
export function expectationCalibration(
  matches: readonly MatchView[],
  options: Partial<RatingOptions> = {},
): ExpectationCalibration {
  return expectationFit(matches, options).calibration;
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
