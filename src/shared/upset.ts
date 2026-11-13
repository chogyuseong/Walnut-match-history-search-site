import { computeRatings, DEFAULT_RATING_OPTIONS, expectedScore, type RatingOptions } from "./rating";
import { isCounted } from "./stats";
import type { MatchView, Side, Team } from "./types";

/**
 * 이변 지수와 편성 공정성. 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관).
 * 쓰는 곳: 경기 카드·경기 상세의 이변 배지와 예상 %, 개인 통계·그래프 분석의 이변 승·섞기 공정성·최대 이변 카드,
 * 분석 코멘트, 시즌 시상 "이변 메이커", 준비 화면 예상 승률 판(forecast.ts가 같은 보정값을 가져간다).
 *
 * 한 경기에서 두 가지를 낸다. 둘의 기준이 다르다는 점이 이 파일의 핵심이다.
 * - 판정(이변·우세 팀·균형·많이 치우침): 경기 직전 팀 평균 MMR 차(ratingGapA)로만 한다. 모든 모임이 같은 점수 기준을 쓴다.
 *   "같은 MMR 300점 차 역전이 어떤 모임에서는 이변, 어떤 모임에서는 아님"이 되면 모임끼리 비교도 설명도 안 된다는 사용자 결정
 *   ("확률은 정직하게, 판정은 모든 모임에 같은 자로")을 따른다. 보정을 넣었을 때 실제 모임(a ≈ 0.25)은 이긴 팀 예상이 40% 아래로
 *   가는 일이 드물어 이변 배지가 거의 사라지고 대부분이 "균형"이 됐다.
 * - 표시용 예상 승률(expectedA): 같은 차를 Elo 식(expectedScore)으로 확률로 바꾼 뒤 이 모임 지난 경기로 보정한 값(아래).
 *   경기 상세의 "경기 전 예상 n% : m%"와 준비 화면 %가 이 값이다. 판정에는 쓰지 않는다.
 * 그래서 경기 상세에 "예상 52%"인데 이변 배지가 붙을 수 있다(MMR 차는 컸지만 이 모임에서는 그 차가 잘 안 맞았다는 뜻).
 *
 * - 팀 평균 MMR: 그 경기 직전 각 팀원의 MMR(rating.ts의 history.before, 첫 경기면 시작값) 평균. MMR 계산과 같은 순서·같은 경기
 *   (유효 확정 경기)를 쓴다. before는 그 앞 경기까지로 맞춘 값이라 판정은 뒤에 들어온 경기로 바뀌지 않는다.
 * - MMR은 범위와 무관한 모임 전체 누적이므로 판정도 누적 기준이다. 범위(시즌·연도·오늘)는 집계할 경기만 고른다.
 *
 * 표시 보정 p' = σ(a·logit(p) + b·s): 실제 모임 522경기를 검증하니 MMR 예상 62%인 경기를 실제로는 약 53% 이겼고,
 * 어떤 MMR 방식도 "늘 50%"(Brier 0.25)보다 낫지 않았다(0.2576). 팀을 티어로 맞춰 짜서 MMR 차가 실제 전력 차보다
 * 과장되는 것으로 본다. 그래서 그 모임의 경기 전 예상과 실제 결과로 두 수를 맞춘다.
 *   - a(scale): 원래 예상의 로짓에 곱하는 배율. 1이면 그대로, 1보다 작으면 50% 쪽으로 줄인다(과신을 덜어낸다).
 *   - b(blueEdge): 블루 진영 몫(로짓 단위). s는 팀 A가 블루면 +1, 레드면 −1, 진영을 모르면 0.
 * 맞춤은 모임 전체 기록으로 한 번 하고 모든 경기에 같은 a·b를 쓴다. 그래서 지난 경기의 표시 %에는 그 뒤 경기로 배운 a·b가
 * 섞인다(미래 정보). 경기 상세에 "지금 기록으로 다시 계산한 값"이라고 적는 까닭이다. 판정은 a·b를 쓰지 않으므로 이 영향이 없다.
 * 경기 수 문턱은 없다: 가상 경기 벌점이 a를 1, b를 0 쪽으로 당겨서 기록이 적으면 저절로 조금만 보정되고 쌓일수록 실제 쪽으로
 * 옮겨 간다. 예전처럼 50경기에서 갑자기 켜면 그 한 경기로 모든 %가 한꺼번에 바뀌었다.
 */

/**
 * 이변 기준(점): 이긴 팀의 경기 직전 팀 평균 MMR이 진 팀보다 이만큼 이상 낮으면 이변이다.
 * 보정 전 기준(이긴 팀 Elo 예상 40% 미만)과 같은 선으로 잡았다: 400 × log10(0.6 / 0.4) ≈ 70.4점 → 70.
 * 올리면 이변이 드물어지고, 내리면 "균형"(BALANCED_MMR_GAP)과 가까워져 흔해진다. 모든 모임에 같이 적용된다.
 */
export const UPSET_MMR_GAP = 70;
/**
 * 균형 경기(점): 두 팀 평균 MMR 차가 이 값 이내(끝 포함). 예상 45~55%와 같은 선: 400 × log10(0.55 / 0.45) ≈ 34.9점 → 35.
 */
export const BALANCED_MMR_GAP = 35;
/**
 * 많이 치우친 경기(점): 차가 이 값을 넘으면. BALANCED_MMR_GAP 초과~이 값 이하는 "조금 치우침".
 * 예상 35%/65%와 같은 선: 400 × log10(0.65 / 0.35) ≈ 107.5점 → 108. 올리면 "많이 치우침" 띠가 짧아지고 "조금 치우침"이 길어진다.
 */
export const LOPSIDED_MMR_GAP = 108;
/** 편성 공정성은 판정 가능한 경기가 이만큼 이상일 때만 보여 준다(기본 배치 판수와 같은 값, 배치 설정과는 무관). */
export const FAIRNESS_MIN_GAMES = 10;
/** 균형 경기 비율의 구간 경계(good·ok·poor). 그래프 분석은 이 구간을 숫자로만 쓴다("균형 경기 60% 이상"). */
export const FAIRNESS_GOOD = 0.6;
export const FAIRNESS_OK = 0.4;

/**
 * a를 1 쪽, b를 0 쪽으로 당기는 가상 경기 수. "보정이 필요 없다"고 말하는 경기를 이만큼 안고 시작한다고 보면 된다.
 * 실제 경기가 이 수보다 적으면 가상 경기 쪽 무게가 더 커서 보정이 절반도 안 들어간다(준비 화면 "기록이 적어 조금만 보정").
 * 키우면 경기가 적은 모임의 a·b가 덜 움직이고(원래 예상에 가깝게), 줄이면 몇 판의 운에도 크게 흔들린다.
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
  /** 맞춤 재료로 쓴 판정 가능 경기 수. 0이면 a = 1, b = 0(원래 예상 그대로)이다. */
  games: number;
}

export const UNCALIBRATED: ExpectationCalibration = { scale: 1, blueEdge: 0, games: 0 };

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
  if (samples.length === 0) return UNCALIBRATED;
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
  return { scale, blueEdge, games: samples.length };
}

/** 원래 예상(팀 A 승)을 보정한 값. a = 1, b = 0이면 로짓을 오가며 생기는 소수 오차 없이 원래 값을 그대로 돌려준다. */
export function calibrateExpectation(
  expectedA: number,
  teamASide: Side | null,
  calibration: ExpectationCalibration,
): number {
  if (calibration.scale === 1 && calibration.blueEdge === 0) return expectedA;
  return sigmoid(calibration.scale * logit(expectedA) + calibration.blueEdge * blueSign(teamASide));
}

export interface MatchExpectation {
  matchId: string;
  /** 경기 직전 팀 평균 MMR 차(팀 A − 팀 B, 보정 없는 원래 값). 판정은 모두 이 값으로 한다. */
  ratingGapA: number;
  /** 팀 A가 이길 경기 전 예상 확률(0~1, 이 모임 기록으로 보정한 값). 표시용이고 판정에는 쓰지 않는다. */
  expectedA: number;
  teamASide: Side | null;
  winnerTeam: Team;
  /** 팀 평균 MMR이 높았던 팀(예상 우세 팀). 차가 정확히 0이면 null. */
  favoriteTeam: Team | null;
  /**
   * 열 명 중 배치(누적 경기가 배치 경기 수 이상)를 마친 사람이 한 명이라도 있으면 true.
   * 모두 배치 중이면 MMR이 아직 시작값 근처라 예상이 의미가 적어 이변·공정성 판정에서 뺀다(예상 값은 그대로 둔다).
   */
  reliable: boolean;
  /** reliable이고 winnerDeficit이 UPSET_MMR_GAP 이상이면 true. */
  upset: boolean;
  /** 이긴 팀 평균 MMR이 진 팀보다 낮았던 점수(이긴 팀이 높았으면 음수). 클수록 뜻밖의 결과다(최대 이변 카드의 순위). */
  winnerDeficit: number;
}

interface PreMatch extends CalibrationSample {
  matchId: string;
  ratingGapA: number;
  reliable: boolean;
}

/** 경기 직전 팀 평균 MMR 차와 보정 전 예상(유효 확정 경기마다). 한쪽 팀이 빈 경기는 MMR 계산처럼 건너뛴다. */
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
      ratingGapA: avg(ratingsA) - avg(ratingsB),
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
    const winnerDeficit = p.winnerTeam === "A" ? -p.ratingGapA : p.ratingGapA;
    expectations.set(p.matchId, {
      matchId: p.matchId,
      ratingGapA: p.ratingGapA,
      expectedA: calibrateExpectation(p.expectedA, p.teamASide, calibration),
      teamASide: p.teamASide,
      winnerTeam: p.winnerTeam,
      favoriteTeam: p.ratingGapA > 0 ? "A" : p.ratingGapA < 0 ? "B" : null,
      reliable: p.reliable,
      upset: isUpset(winnerDeficit, p.reliable),
      winnerDeficit,
    });
  }
  const fit = { expectations, calibration };
  byOptions.set(key, fit);
  return fit;
}

/** 유효 확정 경기마다의 경기 전 예상(경기 ID → MMR 차·판정·보정한 표시 %). 이변 판정을 쓰는 화면은 모두 이 값을 거친다. */
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

/** 경계값 자체(정확히 70점 낮음)도 이변이다("70점 이상 낮은 팀이 이기면"). 모임의 보정값은 들어오지 않는다. */
export function isUpset(winnerDeficit: number, reliable: boolean): boolean {
  return reliable && winnerDeficit >= UPSET_MMR_GAP;
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
  /** 약팀(팀 평균 MMR이 낮았던 쪽)이었던 판정 가능 경기 수. */
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
  /** 팀 평균 MMR 차가 BALANCED_MMR_GAP(35점) 이내인 경기 수. */
  balanced: number;
  /** 조금 치우친 경기 수(35점 초과 108점 이하). balanced + slight + lopsided = games. */
  slight: number;
  /** 많이 치우친 경기 수(LOPSIDED_MMR_GAP, 108점 초과). */
  lopsided: number;
  /** 팀 평균 MMR 차(절댓값)의 평균, 점. 경기가 없으면 0. */
  avgGap: number;
  /** 우세 팀이 있던(MMR 차가 0이 아닌) 경기 수. */
  favoriteGames: number;
  /** 그중 우세 팀이 실제로 이긴 경기 수(예측 적중). */
  favoriteWins: number;
  upsets: number;
}

/** 편성 공정성(팀 평균 MMR 차 기준). 범위 안 유효 경기 중 판정 가능한 경기만 센다(모두 배치 중이면 MMR이 시작값 근처라 뺀다). */
export function fairnessReport(
  expectations: ReadonlyMap<string, MatchExpectation>,
  scoped: readonly MatchView[],
): FairnessReport {
  const report: FairnessReport = {
    games: 0,
    balanced: 0,
    slight: 0,
    lopsided: 0,
    avgGap: 0,
    favoriteGames: 0,
    favoriteWins: 0,
    upsets: 0,
  };
  let gapSum = 0;
  for (const match of scoped) {
    const e = expectations.get(match.id);
    if (!e?.reliable) continue;
    report.games += 1;
    const gap = Math.abs(e.ratingGapA);
    gapSum += gap;
    if (gap <= BALANCED_MMR_GAP) report.balanced += 1;
    else if (gap <= LOPSIDED_MMR_GAP) report.slight += 1;
    else report.lopsided += 1;
    if (e.favoriteTeam !== null) {
      report.favoriteGames += 1;
      if (e.favoriteTeam === e.winnerTeam) report.favoriteWins += 1;
    }
    if (e.upset) report.upsets += 1;
  }
  report.avgGap = report.games > 0 ? gapSum / report.games : 0;
  return report;
}

export type FairnessVerdict = "good" | "ok" | "poor";

/** 균형 경기 비율로 한 줄 판정. 화면 머리글 문구와 색이 이 값을 따른다. 경기가 없으면 "ok". */
export function fairnessVerdict(report: FairnessReport): FairnessVerdict {
  if (report.games === 0) return "ok";
  const share = report.balanced / report.games;
  return share >= FAIRNESS_GOOD ? "good" : share >= FAIRNESS_OK ? "ok" : "poor";
}
