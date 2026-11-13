import type { AttendanceReport } from "./attendance";
import { ABSENT_DAYS } from "./attendance";
import { addDays, dailyCounts, rankRace, ratingRank, teammatePairs, topBy, WEEKDAY_LABEL, weekdayOf } from "./graphs";
import { championName } from "./champions";
import { LANE_RIVAL_MIN, laneRivals, laneRivalSummary } from "./headToHead";
import { compareMetrics, countedChronological, mainLine, synergyPoints } from "./insights";
import {
  binomialChance,
  isCounted,
  localDate,
  PLACEMENT_GAMES_DEFAULT,
  personDetail,
  personRecords,
  rateGapChance,
  ratePercent,
  sideTotals,
  SMALL_SAMPLE,
  type Tally,
} from "./stats";
import { shownRating, type RatingTable } from "./rating";
import { POSITIONS, type MatchView, type Position } from "./types";
import {
  BALANCED_MMR_GAP,
  fairnessReport,
  fairnessVerdict,
  FAIRNESS_MIN_GAMES,
  personUpsets,
  UPSET_MMR_GAP,
  type MatchExpectation,
} from "./upset";

/**
 * 그래프 분석의 "분석 코멘트": 이미 계산한 기록 수치를 정해 둔 규칙으로 읽어 판단형 한국어 문장을 만든다(외부 AI 없음).
 * 쓰는 곳: src/web/screens/Graphs.tsx(고른 플레이어 → playerCommentary, 고르지 않음 → groupCommentary).
 * 데이터는 범위가 적용된 경기(matchesInScope)와 모임 전체 누적으로 만든 MMR(rating.ts)·경기 전 예상(upset.ts)·참석(attendance.ts)이다.
 */

export type RemarkTone = "good" | "warn" | "neutral";

export interface Remark {
  /** 근거 수치를 괄호로 붙인 문장. */
  text: string;
  tone: RemarkTone;
  /** 어느 수치를 읽었는지. 화면은 문장 아래 작은 글씨로 보인다(터치 화면에서는 title 풍선이 뜨지 않아 2026-11-10에 바꿈). */
  basis?: string;
}

export interface Commentary {
  /** 한 줄 총평. 경기가 없으면 빈 문자열. */
  summary: string;
  /** 우선순위 순 문장. */
  remarks: Remark[];
  /**
   * 코칭: 위 수치에서 "다음에 해 볼 것"을 우선순위대로 COACHING_MAX개까지 고른다(2026-11-12 사용자 요청, 외부 AI 없이 규칙으로).
   * 근거 수치는 문장 괄호와 basis에 둔다. 경기가 없으면 없다.
   */
  coaching?: Remark[];
}

// ─ 개인 코멘트 임계값 ─
/** 개인 문장 최대 수. 늘리면 카드가 길어져 아래 그래프가 밀린다(2026-11-12 규칙을 늘리며 6 → 8). */
export const PLAYER_REMARK_MAX = 8;
/** 범위 안 경기가 이보다 적으면 "아직 판단하기 일러요"를 앞에 두고 문장을 FEW_GAMES_REMARKS개로 줄인다. 올리면 신규 멤버 코멘트가 더 오래 짧다. */
export const FEW_GAMES = 10;
/** 자료 부족일 때 첫 문장 뒤에 남기는 문장 수. */
export const FEW_GAMES_REMARKS = 2;
/** 표본이 이만큼 되면 단정("~해요"), 모자라면 "~로 보여요". 낮추면 적은 경기에도 단정적으로 말한다. */
export const SURE_GAMES = 15;
/** 강점·약점 라인으로 비교할 최소 라인 경기 수(색을 칠하는 기준과 같게). */
export const LINE_MIN_GAMES = SMALL_SAMPLE;
/** 강점·약점 라인의 최소 승률 차(%p). 내리면 거의 모든 사람이 "약점 라인"을 갖게 된다. */
export const LINE_GAP = 15;
/** 가장 많이 선 라인이 포지션 기록의 이 비율 이상이면 "거의 전담". 내리면 두 라인을 오가는 사람도 전담으로 불린다. */
export const MAIN_LINE_SHARE = 0.8;
/** 총평에 "{라인} 중심의"를 붙이는 주 라인 비율. 이보다 낮으면 "여러 라인을 고루 서는". */
export const MAIN_LINE_FOCUS = 0.4;
/** 최근 흐름 비교에 쓰는 최근 경기 수. */
export const RECENT_GAMES = 10;
/** 최근 승률이 누적과 이만큼(%p) 다르면 상승·하락 구간. 내리면 몇 판 운에도 흐름이 바뀐다고 말한다. */
export const FLOW_GAP = 15;
/** 이만큼 이어지는 연승·연패만 문장에 붙인다(홈 화면 연승 표시는 3부터라 한 단계 더 엄격하게). */
export const STREAK_NOTE = 4;
/** 최근 10경기 MMR 변화가 이 이상이면 "빠르게 오르고/떨어지고". 1경기 변화가 보통 ±10~20이라 30은 이긴 판이 두세 판 많은 정도. */
export const MMR_MOVE = 30;
/** 최고점보다 이만큼 낮으면 "회복 구간". 낮추면 잠깐 진 사람도 회복 구간이 된다. */
export const MMR_PEAK_GAP = 60;
/** 총평 "상위권"의 MMR 순위 기준(배치 마친 사람 중 위쪽 비율). */
export const TOP_RANK_SHARE = 0.3;
/** 총평 등급의 승률 경계(%): 상위권 이상 · 중위권 이상 · 그 아래 "성장 중". */
export const TIER_TOP_RATE = 60;
export const TIER_MID_RATE = 45;
/** 약팀(경기 직전 팀 평균 MMR이 낮았던 쪽)이었던 경기가 이만큼 있어야 이변 성향을 말한다. */
export const UNDERDOG_MIN_GAMES = 8;
/** 약팀일 때 승률이 이 이상(%)이면 "이변을 자주 만드는 유형". 예상상 40%대가 정상이라 45%면 기대보다 잘 버틴 것이다. */
export const UNDERDOG_RATE = 45;
/** 이변 패 − 이변 승이 이 이상이면 "강팀일 때 방심". */
export const UPSET_LOSS_EXCESS = 3;
/** 잘 맞는 동료는 시너지가 이 이상(%p)일 때만 말한다. 내리면 혼자 승률과 다를 바 없는 동료도 "가장 강해요"가 된다. */
export const BUDDY_SYNERGY_MIN = 5;
/** 어려운 상대는 그 상대 승률이 내 승률보다 이만큼(%p) 이상 낮을 때만 말한다. */
export const RIVAL_GAP = 10;
/** 진영 비교에 쓰는 진영별 최소 경기 수(개인). */
export const SIDE_MIN_GAMES = 8;
/** 블루·레드 승률 차(%p)가 이 이상이면 진영 편차로 말한다(개인·모임 공통). */
export const SIDE_GAP = 15;
/** 출석률 문장을 쓰는 최소 모임 날 수. 낮추면 처음 온 사람이 "1일, 100%" 고정 멤버가 된다. */
export const ATTEND_MIN_DAYS = 5;
/** 출석률이 이 이상(%)이면 "고정 멤버". */
export const ATTEND_LOYAL_RATE = 90;

/** 진 다음 판·이긴 다음 판을 비교하는 최소 표본(각각). 같은 날 바로 다음 경기만 센다. */
export const AFTER_RESULT_MIN = 8;
/** 진 다음 판 승률과 이긴 다음 판 승률의 차(%p)가 이 이상이면 말한다. */
export const AFTER_RESULT_GAP = 15;
/** 모임 날 "초반"으로 보는 그날 자기 경기 수(첫 두 판). */
export const EARLY_GAMES = 2;
/** 초반·후반 비교의 최소 표본(각각). */
export const DAY_PART_MIN = 8;
/** 초반·후반 승률 차(%p)가 이 이상이면 말한다. */
export const DAY_PART_GAP = 15;
/** 경기 전 예상 우세 팀(팀 평균 MMR이 높던 쪽)이던 판의 최소 수. */
export const FAVORED_MIN = 8;
/** 우세 판 승률이 이 미만이면 "유리한 판을 놓친다"(%). 50%면 예상이 아무 뜻이 없던 셈이다. */
export const FAVORED_POOR = 50;
/** 우세 판 승률이 이 이상이면 "유리한 판을 잘 지킨다"(%). */
export const FAVORED_GOOD = 70;
/** 맞라인 천적·먹잇감을 말하는 최소 맞대결 수(화면의 LANE_RIVAL_MIN보다 엄격하게). */
export const LANE_FOCUS_MIN = Math.max(LANE_RIVAL_MIN, 4);
/** 맞라인 승률이 이 이하면 천적(%). */
export const LANE_HARD_RATE = 25;
/** 맞라인 승률이 이 이상이면 먹잇감(%). */
export const LANE_EASY_RATE = 75;
/** 챔피언 문장을 쓰는 최소 사용 판 수. */
export const CHAMP_MIN_GAMES = 5;
/** 이 이상(%)이면 "잘 풀리는 챔피언". */
export const CHAMP_GOOD_RATE = 60;
/** 이 이하(%)면 "안 풀리는 챔피언". */
export const CHAMP_POOR_RATE = 40;
/** MMR 2~N위가 1위를 이 점수 안으로 쫓으면 "1위까지 n점"을 쓴다. */
export const CHASE_RANK = 3;
export const CHASE_GAP = 50;
/** 최다 연승 기록을 말하는 최소 연승. */
export const STREAK_RECORD_MIN = 3;
/** 서폿 비중이 이 이상이면 "서폿을 자주 맡는다"(개인). */
export const SUPPORT_SHARE = 0.4;
/** 서폿 비중을 따지는 최소 포지션 기록 경기 수. */
export const SUPPORT_MIN_GAMES = 10;

/**
 * 우연 문턱. 같은 실력이어도 지금만큼의 차이가 날 확률(stats.ts binomialChance·rateGapChance)이
 * CHANCE_LIMIT ÷ 후보 수보다 작을 때만 승률 비교 문장을 쓴다.
 * 후보 중 가장 극단을 고르는 규칙(라인·동료·상대·맞라인·챔피언)은 후보가 많을수록 누군가는 우연히 튀므로 후보 수로 나눈다.
 * 거르기 전에는 맞라인 상대가 8명이면 "4판 1승 이하 천적"이 동전 던지기만으로 약 95% 확률로 나왔다.
 * 한 사람 코멘트에는 승률 비교 규칙이 PLAYER_COMPARISON_RULES개 있어 규칙 수로도 나눈다. 그래서 0.10은
 * "실력 차가 전혀 없는 사람의 코멘트에 우연 문장이 하나라도 섞일 확률이 10% 안"이라는 뜻이다.
 * 규칙마다 10%씩 허용하던 첫 안은 동전 던지기 모임(26명·500경기)에서 사람당 0.5개꼴로 우연 문장을 냈다.
 * 올리면 문장이 늘고 우연도 섞인다. 걸러진 자리는 비워 둔다(다른 문장으로 억지로 채우지 않는다).
 */
export const CHANCE_LIMIT = 0.1;
/**
 * 개인 코멘트의 승률 비교 규칙 수: 라인 강약·최근 흐름·동료·상대·진영·우세 판·진 다음 판·초반·후반·맞라인·챔피언.
 * 규칙을 더하거나 빼면 이 수도 고친다(늘리면 규칙마다 문턱이 엄해진다).
 */
export const PLAYER_COMPARISON_RULES = 10;

/** 우연으로 보기 어려운지. candidates: 그 규칙이 극단을 고른 후보 수. rules: 같은 코멘트 안의 비교 규칙 수. */
function beyondChance(chance: number, candidates = 1, rules = PLAYER_COMPARISON_RULES): boolean {
  return chance < CHANCE_LIMIT / (rules * Math.max(1, candidates));
}

/** 근거 줄 꼬리: "우연 가능성 3%". 1% 미만은 0%로 보이지 않게 따로 쓴다. */
function chanceNote(chance: number): string {
  const percent = Math.round(chance * 100);
  return percent < 1 ? " · 우연 가능성 1% 미만" : ` · 우연 가능성 ${percent}%`;
}

/** 전체에서 한 묶음을 뺀 나머지(예: 이 동료와 함께가 아닌 경기). */
function without(total: Tally, part: Tally): Tally {
  return { games: total.games - part.games, wins: total.wins - part.wins };
}

/** 코칭 줄 최대 수(개인·모임). 늘리면 카드가 길어지고 덜 중요한 권유까지 섞인다. */
export const COACHING_MAX = 3;
/** 예상 우세 팀 승률(%)이 이 이상이면 팀 차이가 크다고 보고 섞기를 권한다(모임 코칭). */
export const PREDICT_TOO_HIGH = 70;

// ─ 모임 코멘트 임계값 ─
/** 모임 문장 최대 수(2026-11-12 규칙을 늘리며 5 → 7). */
export const GROUP_REMARK_MAX = 7;
/**
 * 예상 우세 팀 승률(%)이 이 이상이면 문장 점이 "좋음" 색이다. 문장은 숫자만 쓴다(2026-11-10 F5).
 * 예전에는 "MMR이 실력을 잘 반영"이라고 썼지만 판정 10경기에서 6승 이상은 동전 던지기로도 약 38% 나온다(이항 분포).
 */
export const PREDICT_GOOD = 60;
/** 이 미만이면 문장 점이 "주의" 색이다. 50%면 동전 던지기와 같다. */
export const PREDICT_POOR = 55;
/** 모임 진영 편차를 말하는 최소 진영 확인 경기 수. 적으면 몇 판 차이로 15%p가 쉽게 난다. */
export const GROUP_SIDE_MIN_GAMES = 20;
/** 상위 몇 명의 순위 변동을 보는지. */
export const RANK_WATCH = 5;
/** 이만큼 이상 오른 사람만 순위 변동으로 말한다. */
export const RANK_JUMP = 3;
/** 활동 비교 창(일). 최근 이 기간과 바로 앞 같은 기간의 경기 수를 비교한다. */
export const ACTIVITY_WINDOW_DAYS = 28;
/** 경기 수가 이 비율 이상 늘거나 줄면 활동 변화로 말한다. */
export const ACTIVITY_CHANGE = 0.3;
/** 앞 기간 경기가 이보다 적으면 비교하지 않는다(1 → 2를 "두 배"라 하지 않게). */
export const ACTIVITY_MIN_GAMES = 5;
/**
 * 두 사람이 함께 나온 경기 중 같은 팀이었던 비율이 이 이상이면 "자주 같은 팀".
 * 무작위로 섞으면 4/9(약 44%)라, 전체 경기 대비 40%(처음 안)로 재면 열 명 고정 모임에서는 거의 늘 걸린다.
 * 그래서 함께 나온 경기를 분모로 두고 우연보다 확실히 높은 60%로 잡았다. 내리면 우연한 뭉침도 경고한다.
 */
export const PAIR_SHARE = 0.6;
/** 뭉침을 따지는 최소 함께 나온 경기 수. */
export const PAIR_MIN_GAMES = 10;
/** 배치 마친 사람 MMR 최고·최저 차가 이 이상이면 격차를 말한다. 600 넘게 벌어지면 같은 티어 가중치로는 맞추기 어렵다. */
export const MMR_SPREAD_WIDE = 400;
/** MMR 격차를 말하는 최소 배치 완료 인원. */
export const MMR_SPREAD_MIN_PEOPLE = 4;
/** 한 사람이 자기 경기의 이 비율 이상을 서폿으로 서면 "서폿 쏠림"(모임). */
export const GROUP_SUPPORT_SHARE = 0.5;
/** 새로 온 사람이 이 수 이상이면 말한다(최근 ACTIVITY_WINDOW_DAYS일). */
export const NEWCOMER_MIN = 2;
/** 이 이상 연승 중인 사람을 모임 문장으로 쓴다. */
export const GROUP_STREAK = 5;
/** 챔피언 기록률(%)이 이 미만이면 기록을 권한다. */
export const CHAMP_RECORD_LOW = 30;
/** 챔피언 기록률을 따지는 최소 경기 수. */
export const CHAMP_RECORD_MIN_GAMES = 20;
/** 요일 문장을 쓰는 최소 모임 날 수. */
export const WEEKDAY_MIN_DAYS = 5;
/** 이변 경기 비율이 이 이상이면 "이변이 많은 편". */
export const UPSET_SHARE = 0.2;

/** 라인 이름. 웹의 POSITION_LABEL과 같다(shared는 web을 import하지 않는다). */
const LANE_NAME: Record<Position, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

/**
 * 총평 유형 표.
 * 등급: 승률 TIER_TOP_RATE%↑ 그리고 MMR 상위 TOP_RANK_SHARE = 상위권 · 승률 TIER_MID_RATE% 이상 = 중위권 · 그 아래 = 성장 중.
 * 앞말: 최근 10경기 MMR 변화가 ±MMR_MOVE 안이면 "안정형". 뒷말: 최근 흐름(상승·하락·보합).
 */
const TIER_TEXT = { top: "상위권", mid: "중위권", growing: "성장 중" } as const;
const FLOW_TEXT = { up: "최근 상승세", down: "최근 주춤", flat: "최근은 숨 고르기" } as const;

type Flow = keyof typeof FLOW_TEXT;

/** 받침으로 끝나게 읽히는 숫자: 영·일·삼·육·칠·팔. 이름 끝 숫자("사람01")의 조사에 쓴다. */
const DIGIT_WITH_CODA = "013678";

/** 받침 유무에 맞는 조사. 한글·숫자가 아니면 받침 없는 쪽. */
function josa(word: string, withCoda: string, withoutCoda: string): string {
  const last = word.at(-1) ?? "";
  const code = last.charCodeAt(0) - 0xac00;
  const coda = code >= 0 && code <= 11171 ? code % 28 !== 0 : DIGIT_WITH_CODA.includes(last) && last !== "";
  return word + (coda ? withCoda : withoutCoda);
}

/** 받침 ㄹ로 끝나게 읽히는 숫자: 일·칠·팔. "(으)로"는 받침 ㄹ 뒤에서 "로"다. */
const DIGIT_WITH_RIEUL = "178";

/** "으로/로": 받침이 없거나 ㄹ이면 "로"(아리로, 카밀로, +1로), 그 밖의 받침이면 "으로"(+80으로, 탈론으로). */
function withRo(word: string): string {
  const last = word.at(-1) ?? "";
  const code = last.charCodeAt(0) - 0xac00;
  const final = code >= 0 && code <= 11171 ? code % 28 : -1;
  const rieul = final === 8 || DIGIT_WITH_RIEUL.includes(last);
  const coda = final > 0 || (final === -1 && DIGIT_WITH_CODA.includes(last) && last !== "");
  return word + (coda && !rieul ? "으로" : "로");
}

function rateOf(tally: Tally): number {
  return ratePercent(tally.wins, tally.games);
}

/** 표본이 SURE_GAMES 이상이면 단정, 아니면 "~로 보여요". */
function judged(games: number, sure: string, hedged: string): string {
  return games >= SURE_GAMES ? sure : hedged;
}

export interface PlayerCommentaryInput {
  /** 범위가 적용된 경기. */
  scoped: readonly MatchView[];
  participantId: string;
  nameOf: (id: string) => string;
  /** computeRatings(모임 전체 경기). */
  ratings: RatingTable;
  /** matchExpectations(모임 전체 경기). */
  expectations: ReadonlyMap<string, MatchExpectation>;
  /** attendanceReport(scoped). */
  attendance: AttendanceReport;
  /** 누적 경기 수(standings). 동료·상대 비교의 누적 기준에 쓴다. */
  cumulative: ReadonlyMap<string, { games: number }>;
  /** 모임 시간대. 모임 날 초반·후반, 진 다음 판(같은 날)을 가를 때 쓴다. 없으면 UTC. */
  timeZone?: string;
  /** placementGamesOf(모임 설정). 없으면 기본값. */
  placementGames?: number;
}

/** 고른 플레이어의 코멘트. 규칙 순서가 곧 우선순위다(라인 → 흐름 → MMR → 이변 → 동료·상대 → 진영 → 참석). */
export function playerCommentary(input: PlayerCommentaryInput): Commentary {
  const { scoped, participantId: id, nameOf, placementGames = PLACEMENT_GAMES_DEFAULT } = input;
  const detail = personDetail(scoped, id, nameOf);
  const games = detail.summary.games;
  if (games === 0) return { summary: "", remarks: [] };
  const remarks: Remark[] = [];

  // 1. 강점·약점 라인 / 전담.
  const positioned = POSITIONS.reduce((n, p) => n + (detail.byPosition[p]?.games ?? 0), 0);
  const main = mainLine(detail.byPosition);
  const mainShare = main ? main.tally.games / positioned : 0;
  if (main && mainShare >= MAIN_LINE_SHARE) {
    remarks.push({
      text: `거의 ${LANE_NAME[main.position]} 전담이에요(경기의 ${ratePercent(main.tally.games, positioned)}%, 승률 ${rateOf(main.tally)}%).`,
      tone: "neutral",
      basis: "라인별 경기 수",
    });
  }
  let strong: { position: Position; tally: Tally } | null = null;
  let weak: { position: Position; tally: Tally } | null = null;
  if (!(main && mainShare >= MAIN_LINE_SHARE)) {
    const lines = POSITIONS.flatMap((p) => {
      const tally = detail.byPosition[p];
      return tally && tally.games >= LINE_MIN_GAMES ? [{ position: p, tally }] : [];
    });
    // 같은 승률이면 경기가 많은 쪽을 고른다(sort는 안정 정렬이라 그다음은 라인 순서).
    const ranked = [...lines].sort((a, b) => rateOf(b.tally) - rateOf(a.tally) || b.tally.games - a.tally.games);
    const best = ranked[0];
    const worst = ranked.at(-1);
    // 가장 좋은 라인과 가장 나쁜 라인을 골랐으니 견줄 수 있던 라인 쌍 수만큼 우연 문턱을 엄하게 한다.
    const linePairs = (lines.length * (lines.length - 1)) / 2;
    const lineChance = best && worst && best !== worst ? rateGapChance(best.tally, worst.tally) : 1;
    if (best && worst && best !== worst && rateOf(best.tally) - rateOf(worst.tally) >= LINE_GAP && beyondChance(lineChance, linePairs)) {
      strong = best;
      weak = worst;
      const bestName = LANE_NAME[best.position];
      const worstName = LANE_NAME[worst.position];
      remarks.push({
        text:
          judged(best.tally.games, `${bestName}에서 가장 강해요`, `${bestName}에서 가장 강한 편으로 보여요`) +
          `(${rateOf(best.tally)}%, ${best.tally.games}경기). ` +
          judged(worst.tally.games, `${josa(worstName, "은", "는")} 약점이에요`, `${josa(worstName, "은", "는")} 약점으로 보여요`) +
          `(${rateOf(worst.tally)}%, ${worst.tally.games}경기).`,
        tone: "good",
        basis: `라인별 승률(${LINE_MIN_GAMES}경기 이상 라인)${chanceNote(lineChance)}`,
      });
    }
  }

  // 2. 최근 흐름 대 누적(+ 긴 연승·연패).
  const recent = detail.recent10;
  let flow: Flow = "flat";
  const streak = detail.currentStreak;
  const streakNote =
    Math.abs(streak) >= STREAK_NOTE ? ` 지금 ${Math.abs(streak)}${streak > 0 ? "연승" : "연패"} 중이에요.` : "";
  // 최근 10경기는 누적의 일부라, 우연 여부는 최근 10경기와 그 앞 경기들을 견준다.
  let flowChance = 1;
  if (recent.games >= RECENT_GAMES && games > RECENT_GAMES) {
    const gap = rateOf(recent) - rateOf(detail.summary);
    flowChance = rateGapChance(recent, without(detail.summary, recent));
    flow = !beyondChance(flowChance) ? "flat" : gap >= FLOW_GAP ? "up" : gap <= -FLOW_GAP ? "down" : "flat";
  }
  if (flow !== "flat") {
    const up = flow === "up";
    remarks.push({
      text: `최근 ${RECENT_GAMES}경기는 누적보다 ${up ? "높아 상승" : "낮아 하락"} 구간이에요(${rateOf(recent)}% vs ${rateOf(detail.summary)}%).${streakNote}`,
      tone: up ? "good" : "warn",
      basis: `최근 ${RECENT_GAMES}경기 승률과 범위 누적 승률${chanceNote(flowChance)}`,
    });
  } else if (streakNote) {
    remarks.push({ text: streakNote.trim(), tone: streak > 0 ? "good" : "warn", basis: "연승·연패" });
  }

  // 3. MMR 추세(누적 기준). 흐름 문장과 같은 방향의 "오르고/떨어지고"는 되풀이라 뺀다.
  const rating = input.ratings.get(id);
  const rank = ratingRank(input.ratings, id, placementGames);
  if (rating && rating.games < placementGames) {
    remarks.push({
      text: `아직 배치 중(${rating.games}/${placementGames})이라 MMR은 참고만 해요.`,
      tone: "neutral",
      basis: "누적 경기 수",
    });
  } else if (rating) {
    const delta = Math.round(rating.delta10);
    const peakGap = Math.round(rating.peak - rating.rating);
    const parts: string[] = [];
    let tone: RemarkTone = "neutral";
    if (delta >= MMR_MOVE && flow !== "up") {
      parts.push(`최근 10경기 MMR이 ${withRo(`+${delta}`)} 빠르게 오르고 있어요.`);
      tone = "good";
    } else if (delta <= -MMR_MOVE && flow !== "down") {
      parts.push(`최근 10경기 MMR이 ${withRo(`−${-delta}`)} 떨어지고 있어요.`);
      tone = "warn";
    }
    if (peakGap >= MMR_PEAK_GAP) {
      parts.push(`최고점(${shownRating(rating.peak)})보다 ${peakGap} 아래라 회복 구간이에요.`);
    }
    if (parts.length > 0) remarks.push({ text: parts.join(" "), tone, basis: "누적 MMR 변화·최고점" });
  }

  // 4. 이변 성향.
  const upsets = personUpsets(input.expectations, scoped, id);
  if (upsets.underdogGames >= UNDERDOG_MIN_GAMES && ratePercent(upsets.underdogWins, upsets.underdogGames) >= UNDERDOG_RATE) {
    remarks.push({
      text: `약팀일 때도 ${ratePercent(upsets.underdogWins, upsets.underdogGames)}%를 이겨 이변을 자주 만드는 유형이에요(${upsets.underdogGames}경기).`,
      tone: "good",
      basis: "팀 평균 MMR이 낮았던 경기",
    });
  } else if (upsets.upsetLosses - upsets.upsetWins >= UPSET_LOSS_EXCESS) {
    remarks.push({
      text: `팀 평균 MMR이 ${UPSET_MMR_GAP}점 이상 높은 강팀으로 진 경기가 ${upsets.upsetLosses}회로, 약팀으로 이긴 ${upsets.upsetWins}회보다 많아요.`,
      tone: "warn",
      basis: "이변 승·패",
    });
  }

  // 5. 잘 맞는 동료·어려운 상대(개인 통계와 같은 compareMetrics). 혼자 승률과 별 차이 없으면 말하지 않는다.
  const compare = compareMetrics(detail, input.cumulative);
  const synergy = compare.buddy
    ? synergyPoints(compare.buddy, detail.summary, personRecords(scoped).get(compare.buddy.participantId) ?? { games: 0, wins: 0 })
    : null;
  // 동료·상대는 기준 경기 수를 넘는 짝 중 가장 극단을 고른 것이라, 그 짝 수만큼 우연 문턱을 엄하게 한다.
  // 견주는 쪽은 "그 사람과 함께(맞서) 뛴 경기"와 "그 밖의 내 경기"다.
  const buddyCandidates = compare.synergy.filter((p) => p.games >= SMALL_SAMPLE).length;
  const rivalCandidates = compare.versus.filter((p) => p.games >= SMALL_SAMPLE).length;
  const buddyChance = compare.buddy ? rateGapChance(compare.buddy, without(detail.summary, compare.buddy)) : 1;
  const rivalChance = compare.rival ? rateGapChance(compare.rival, without(detail.summary, compare.rival)) : 1;
  const buddy =
    synergy !== null && synergy >= BUDDY_SYNERGY_MIN && beyondChance(buddyChance, buddyCandidates) ? compare.buddy : null;
  const rival =
    compare.rival && rateOf(detail.summary) - rateOf(compare.rival) >= RIVAL_GAP && beyondChance(rivalChance, rivalCandidates)
      ? compare.rival
      : null;
  const pairParts: string[] = [];
  if (buddy && rival && buddy.participantId === rival.participantId) {
    // 같은 사람이 동료이자 상대면 한 문장으로: 편이 갈리면 결과가 뒤집힌다는 뜻이다.
    pairParts.push(
      `${josa(nameOf(buddy.participantId), "과", "와")}는 같은 팀이면 ${rateOf(buddy)}%, 상대 팀이면 ${rateOf(rival)}%라 ` +
        `함께일 때 확실히 강해요(시너지 +${synergy}%p).`,
    );
  } else {
    if (buddy) {
      pairParts.push(
        `${josa(nameOf(buddy.participantId), "과", "와")} 같은 팀일 때 ` +
          judged(buddy.games, "가장 강해요", "가장 강한 편으로 보여요") +
          `(${rateOf(buddy)}%, 시너지 +${synergy}%p).`,
      );
    }
    if (rival) {
      pairParts.push(
        `${josa(nameOf(rival.participantId), "을", "를")} 상대로는 ` +
          judged(rival.games, "약해요", "약한 편으로 보여요") +
          `(${rateOf(rival)}%, ${rival.games}경기).`,
      );
    }
  }
  if (pairParts.length > 0) {
    remarks.push({
      text: pairParts.join(" "),
      tone: "neutral",
      basis: `같은 팀·상대 팀 전적(누적 30경기 이상인 사람끼리)${chanceNote(Math.max(buddy ? buddyChance : 0, rival ? rivalChance : 0))}`,
    });
  }

  // 6. 진영.
  const { blue, red } = detail.bySide;
  const sideChance = rateGapChance(blue, red);
  const sideSkewed =
    blue.games >= SIDE_MIN_GAMES &&
    red.games >= SIDE_MIN_GAMES &&
    Math.abs(rateOf(blue) - rateOf(red)) >= SIDE_GAP &&
    beyondChance(sideChance);
  if (sideSkewed) {
    const blueBetter = rateOf(blue) > rateOf(red);
    const [hi, lo] = blueBetter ? [blue, red] : [red, blue];
    remarks.push({
      text:
        judged(Math.min(blue.games, red.games), `${blueBetter ? "블루" : "레드"}에서 유독 강해요`, `${blueBetter ? "블루" : "레드"}에서 더 강한 편으로 보여요`) +
        `(${rateOf(hi)}% vs ${rateOf(lo)}%).`,
      tone: "neutral",
      basis: `진영별 승률${chanceNote(sideChance)}`,
    });
  }

  // 6-1. 유리한 판 관리: 경기 전 예상 우세 팀이던 판(배치 마친 사람이 있는 판).
  // 우연 여부는 50%(예상이 아무 뜻 없는 경우)와 견준다. 우세 판의 실제 기대는 50%보다 조금 높아 "놓친다" 쪽은 보수적이다.
  const favored = favoredTally(input.expectations, scoped, id);
  const favoredChance = binomialChance(favored.wins, favored.games);
  const favoredPoor = favored.games >= FAVORED_MIN && rateOf(favored) < FAVORED_POOR && beyondChance(favoredChance);
  const favoredGood = favored.games >= FAVORED_MIN && rateOf(favored) >= FAVORED_GOOD && beyondChance(favoredChance);
  if (favoredPoor || favoredGood) {
    const rate = rateOf(favored);
    if (favoredPoor) {
      remarks.push({
        text: `경기 전 우세하던 판의 승률이 ${rate}%라 유리한 판을 자주 놓쳐요(${favored.games}경기).`,
        tone: "warn",
        basis: `경기 전 예상 우세 팀이던 경기${chanceNote(favoredChance)}`,
      });
    } else {
      remarks.push({
        text: `경기 전 우세하던 판은 ${rate}%를 이겨 유리한 판을 잘 지켜요(${favored.games}경기).`,
        tone: "good",
        basis: `경기 전 예상 우세 팀이던 경기${chanceNote(favoredChance)}`,
      });
    }
  }

  // 6-2. 진 다음 판(같은 날 바로 다음 경기).
  const timeZone = input.timeZone ?? "UTC";
  const after = afterResults(scoped, id, timeZone);
  const tiltChance = rateGapChance(after.afterLoss, after.afterWin);
  // 우연으로 설명되는 차이는 0으로 본다. 아래 코칭도 이 값을 그대로 쓴다.
  const tilt =
    after.afterLoss.games >= AFTER_RESULT_MIN && after.afterWin.games >= AFTER_RESULT_MIN && beyondChance(tiltChance)
      ? rateOf(after.afterLoss) - rateOf(after.afterWin)
      : 0;
  if (Math.abs(tilt) >= AFTER_RESULT_GAP) {
    remarks.push({
      text:
        tilt < 0
          ? `진 다음 판 승률이 ${rateOf(after.afterLoss)}%로, 이긴 다음 판(${rateOf(after.afterWin)}%)보다 낮아요.`
          : `진 다음 판에 오히려 강해요(${rateOf(after.afterLoss)}% vs 이긴 다음 판 ${rateOf(after.afterWin)}%).`,
      tone: tilt < 0 ? "warn" : "good",
      basis: `같은 날 바로 다음 경기의 승률${chanceNote(tiltChance)}`,
    });
  }

  // 6-3. 모임 날 초반(첫 두 판)·후반.
  const parts = dayParts(scoped, id, timeZone);
  const dayChance = rateGapChance(parts.early, parts.late);
  const dayGap =
    parts.early.games >= DAY_PART_MIN && parts.late.games >= DAY_PART_MIN && beyondChance(dayChance)
      ? rateOf(parts.early) - rateOf(parts.late)
      : 0;
  if (Math.abs(dayGap) >= DAY_PART_GAP) {
    remarks.push({
      text:
        dayGap > 0
          ? `모임 날 첫 ${EARLY_GAMES}판이 강하고 그 뒤로 내려가요(${rateOf(parts.early)}% → ${rateOf(parts.late)}%).`
          : `모임 날 첫 ${EARLY_GAMES}판보다 뒤로 갈수록 강해요(${rateOf(parts.early)}% → ${rateOf(parts.late)}%).`,
      tone: "neutral",
      basis: `모임 날 자기 경기 순서(첫 ${EARLY_GAMES}판 대 그 뒤)${chanceNote(dayChance)}`,
    });
  }

  // 6-4. 맞라인 천적·먹잇감.
  // 후보 = 맞대결 기준을 넘는 모든 맞라인 상대(라인 구분 없이). 그중 극단 하나를 고르니 그 수만큼 문턱을 엄하게 한다.
  const rivals = laneRivals(scoped, id);
  const duelCandidates = rivals.filter((r) => r.games >= LANE_FOCUS_MIN).length;
  const duelReal = (r: { wins: number; games: number }) => beyondChance(binomialChance(r.wins, r.games), duelCandidates);
  const duels = laneRivalSummary(rivals, LANE_FOCUS_MIN);
  const hardest = topBy(
    duels.flatMap((d) =>
      d.hardest && ratePercent(d.hardest.wins, d.hardest.games) <= LANE_HARD_RATE && duelReal(d.hardest) ? [d.hardest] : [],
    ),
    (r) => r.games - r.wins,
    (r) => nameOf(r.opponentId),
  );
  const easiest = topBy(
    duels.flatMap((d) =>
      d.easiest && ratePercent(d.easiest.wins, d.easiest.games) >= LANE_EASY_RATE && duelReal(d.easiest) ? [d.easiest] : [],
    ),
    (r) => r.wins,
    (r) => nameOf(r.opponentId),
  );
  const duelChance = Math.max(
    hardest ? binomialChance(hardest.wins, hardest.games) : 0,
    easiest ? binomialChance(easiest.wins, easiest.games) : 0,
  );
  const duelParts: string[] = [];
  if (hardest) {
    duelParts.push(`${LANE_NAME[hardest.position]}에서 ${josa(nameOf(hardest.opponentId), "을", "를")} 만나면 ${hardest.wins}승 ${hardest.losses}패로 고전해요.`);
  }
  if (easiest) {
    duelParts.push(`${LANE_NAME[easiest.position]}에서 ${nameOf(easiest.opponentId)} 상대로는 ${easiest.wins}승 ${easiest.losses}패예요.`);
  }
  if (duelParts.length > 0) {
    remarks.push({
      text: duelParts.join(" "),
      tone: hardest ? "warn" : "good",
      basis: `맞라인 상대(${LANE_FOCUS_MIN}경기 이상)${chanceNote(duelChance)}`,
    });
  }

  // 6-5. 챔피언(기록한 경기만).
  // 챔피언은 그 사람의 평소 승률과 견준다(원래 잘하는 사람은 어떤 챔피언이든 60%가 나온다). 후보는 기준 판 수를 넘는 챔피언 수.
  const champs = championTallies(scoped, id);
  const usual = Math.min(0.99, Math.max(0.01, detail.summary.wins / detail.summary.games));
  const champCandidates = champs.filter((c) => c.games >= CHAMP_MIN_GAMES).length;
  const champChance = (c: Tally) => binomialChance(c.wins, c.games, usual);
  const champReal = (c: Tally) => beyondChance(champChance(c), champCandidates);
  const champBest = topBy(
    champs.filter((c) => c.games >= CHAMP_MIN_GAMES && rateOf(c) >= CHAMP_GOOD_RATE && champReal(c)),
    (c) => rateOf(c) * 1000 + c.games,
    (c) => c.key,
  );
  const champWorst = topBy(
    champs.filter((c) => c.games >= CHAMP_MIN_GAMES && rateOf(c) <= CHAMP_POOR_RATE && c.key !== champBest?.key && champReal(c)),
    (c) => -rateOf(c) * 1000 + c.games,
    (c) => c.key,
  );
  if (champBest || champWorst) {
    const bits: string[] = [];
    if (champBest) bits.push(`${withRo(championName(champBest.key))} ${champBest.games}판 ${rateOf(champBest)}%를 이겼어요.`);
    if (champWorst) bits.push(`${josa(championName(champWorst.key), "은", "는")} ${champWorst.games}판 ${rateOf(champWorst)}%예요.`);
    const shown = Math.max(champBest ? champChance(champBest) : 0, champWorst ? champChance(champWorst) : 0);
    remarks.push({
      text: bits.join(" "),
      tone: champBest ? "good" : "warn",
      basis: `기록한 챔피언(${CHAMP_MIN_GAMES}판 이상, 평소 승률과 비교)${chanceNote(shown)}`,
    });
  }

  // 6-6. 1위 추격·최다 연승.
  const leader = chaseLeader(input.ratings, id, placementGames);
  if (leader && rank && rank.rank >= 2 && rank.rank <= CHASE_RANK && leader.gap <= CHASE_GAP) {
    remarks.push({
      text: `MMR ${rank.rank}위로, 1위 ${nameOf(leader.id)}까지 ${leader.gap}점 남았어요.`,
      tone: "good",
      basis: "MMR 순위(누적, 배치 완료)",
    });
  }
  if (streak >= STREAK_RECORD_MIN && streak >= detail.longestWinStreak) {
    remarks.push({ text: `지금 ${streak}연승으로 이 범위 최다 연승 기록이에요.`, tone: "good", basis: "연승 기록" });
  } else if (streak >= STREAK_RECORD_MIN && detail.longestWinStreak - streak === 1) {
    remarks.push({ text: `1승만 더하면 최다 연승(${detail.longestWinStreak}) 타이예요.`, tone: "good", basis: "연승 기록" });
  }

  // 6-7. 서폿 비중(전담이면 1번 문장이 이미 말한다).
  const support = detail.byPosition.support?.games ?? 0;
  const supportHeavy =
    positioned >= SUPPORT_MIN_GAMES && support / positioned >= SUPPORT_SHARE && !(main?.position === "support" && mainShare >= MAIN_LINE_SHARE);
  if (supportHeavy) {
    remarks.push({
      text: `서폿을 자주 맡아요(경기의 ${ratePercent(support, positioned)}%).`,
      tone: "neutral",
      basis: "라인별 경기 수",
    });
  }

  // 7. 참석.
  const attend = input.attendance.people.get(id);
  if (attend && attend.missedSinceLast >= ABSENT_DAYS) {
    remarks.push({ text: `최근 모임 ${attend.missedSinceLast}번 연속으로 안 왔어요.`, tone: "warn", basis: "마지막 참석 뒤 모임 날" });
  } else if (attend && attend.eligibleDays >= ATTEND_MIN_DAYS && ratePercent(attend.days, attend.eligibleDays) >= ATTEND_LOYAL_RATE) {
    remarks.push({
      text: `거의 빠지지 않는 고정 멤버예요(${attend.days}일, ${ratePercent(attend.days, attend.eligibleDays)}%).`,
      tone: "good",
      basis: "출석률(첫 참석 날부터)",
    });
  }

  const coaching = playerCoaching({
    games,
    flow,
    streak,
    recent,
    total: detail.summary,
    main: main && mainShare >= MAIN_LINE_SHARE ? main : null,
    strong,
    weak,
    upsets,
    buddy: buddy && synergy !== null ? { name: nameOf(buddy.participantId), synergy } : null,
    tilt: tilt <= -AFTER_RESULT_GAP ? after : null,
    favoredPoor: favoredPoor ? favored : null,
    laneHard: hardest ? { line: LANE_NAME[hardest.position], name: nameOf(hardest.opponentId), wins: hardest.wins, losses: hardest.losses } : null,
    dayGap: Math.abs(dayGap) >= DAY_PART_GAP ? parts : null,
    champBest: champBest ? { name: championName(champBest.key), tally: champBest } : null,
    supportHeavy: supportHeavy ? ratePercent(support, positioned) : null,
    chase: leader && rank && rank.rank >= 2 && rank.rank <= CHASE_RANK && leader.gap <= CHASE_GAP ? { name: nameOf(leader.id), gap: leader.gap } : null,
    rival: rival ? { name: nameOf(rival.participantId), tally: rival } : null,
    side: sideSkewed ? { blue, red } : null,
    champWorst: champWorst ? { name: championName(champWorst.key), tally: champWorst } : null,
    absent: attend && attend.missedSinceLast >= ABSENT_DAYS ? attend.missedSinceLast : null,
    underdog:
      upsets.underdogGames >= UNDERDOG_MIN_GAMES && ratePercent(upsets.underdogWins, upsets.underdogGames) >= UNDERDOG_RATE
        ? { games: upsets.underdogGames, wins: upsets.underdogWins }
        : null,
    laneEasy: easiest ? { line: LANE_NAME[easiest.position], name: nameOf(easiest.opponentId), wins: easiest.wins, losses: easiest.losses } : null,
  });

  // 8. 자료 부족: 단정하지 않고 앞에 경고를 두고 문장을 줄인다.
  if (games < FEW_GAMES) {
    return {
      coaching,
      summary: "아직 자료가 적어 유형을 정하기 일러요",
      remarks: [
        { text: `경기가 ${games}개뿐이라 아직 판단하기 일러요.`, tone: "neutral", basis: "범위 안 경기 수" },
        ...remarks.slice(0, FEW_GAMES_REMARKS),
      ],
    };
  }

  // 총평: {라인 앞말} {안정형} {등급}, {흐름}.
  const rate = rateOf(detail.summary);
  const topRank = rank !== null && rank.rank <= Math.ceil(rank.total * TOP_RANK_SHARE);
  const tier = rate >= TIER_TOP_RATE && topRank ? TIER_TEXT.top : rate >= TIER_MID_RATE ? TIER_TEXT.mid : TIER_TEXT.growing;
  const lineLead = !main ? "" : mainShare >= MAIN_LINE_FOCUS ? `${LANE_NAME[main.position]} 중심의 ` : "여러 라인을 고루 서는 ";
  const steady = rating && rating.games >= placementGames && Math.abs(rating.delta10) < MMR_MOVE ? "안정형 " : "";
  return {
    // 흐름이 우연 거르기로 "보합"이 되었어도 긴 연승·연패 중이면 "숨 고르기"라고 하지 않는다(9연승 중인데 숨 고르기가 됐다).
    summary: `${lineLead}${steady}${tier}, ${
      flow === "flat" && Math.abs(streak) >= STREAK_NOTE
        ? `지금 ${Math.abs(streak)}${streak > 0 ? "연승" : "연패"} 중`
        : FLOW_TEXT[flow]
    }`,
    remarks: remarks.slice(0, PLAYER_REMARK_MAX),
    coaching,
  };
}

/**
 * 개인 코칭. 위에서부터 맞는 것을 차례로 담아 COACHING_MAX개까지 쓴다(앞일수록 지금 가장 손댈 만한 것).
 * 경고(진 다음 판 → 흐름 하락 → 우세 판 놓침 → 맞라인 천적 → 결석) → 라인·시간·챔피언·진영 활용 → 장점 살리기 → 유지.
 * 문장은 "해 보세요"로 권하기만 하고 결과를 장담하지 않는다(수치는 과거 기록일 뿐이다).
 * 자료가 적으면(FEW_GAMES 미만) 다른 권유 없이 그 한 줄만 쓴다.
 */
function playerCoaching(c: {
  games: number;
  flow: Flow;
  streak: number;
  recent: Tally;
  total: Tally;
  main: { position: Position; tally: Tally } | null;
  strong: { position: Position; tally: Tally } | null;
  weak: { position: Position; tally: Tally } | null;
  upsets: { upsetWins: number; upsetLosses: number };
  buddy: { name: string; synergy: number } | null;
  tilt: { afterLoss: Tally; afterWin: Tally } | null;
  favoredPoor: Tally | null;
  laneHard: { line: string; name: string; wins: number; losses: number } | null;
  dayGap: { early: Tally; late: Tally } | null;
  champBest: { name: string; tally: Tally } | null;
  supportHeavy: number | null;
  chase: { name: string; gap: number } | null;
  rival: { name: string; tally: Tally } | null;
  side: { blue: Tally; red: Tally } | null;
  champWorst: { name: string; tally: Tally } | null;
  absent: number | null;
  underdog: Tally | null;
  laneEasy: { line: string; name: string; wins: number; losses: number } | null;
}): Remark[] {
  if (c.games < FEW_GAMES) {
    return [
      {
        text: `${FEW_GAMES - c.games}경기를 더 하면 강한 라인·약한 라인을 짚어 드릴 수 있어요. 여러 라인을 고루 서 보세요.`,
        tone: "neutral",
        basis: "범위 안 경기 수",
      },
    ];
  }
  const tips: Remark[] = [];
  const anchor = c.strong ?? c.main;
  // ─ 지금 고칠 것 ─
  if (c.tilt) {
    tips.push({
      text: `진 다음 판이 약해요(${rateOf(c.tilt.afterLoss)}% vs 이긴 다음 판 ${rateOf(c.tilt.afterWin)}%). 지고 나면 한 판 쉬거나 가장 편한 라인으로 다시 시작해 보세요.`,
      tone: "warn",
      basis: "같은 날 바로 다음 경기의 승률",
    });
  } else if (c.flow === "down" || c.streak <= -STREAK_NOTE) {
    // 진 다음 판 권유와 내용이 겹쳐 둘 중 하나만 쓴다.
    const why = c.streak <= -STREAK_NOTE ? `${-c.streak}연패 중` : `최근 ${RECENT_GAMES}경기 ${rateOf(c.recent)}%`;
    tips.push({
      text: anchor
        ? `흐름이 내려가 있어요(${why}). 다음 판은 가장 잘 풀린 ${LANE_NAME[anchor.position]}부터 맡아 감을 되찾아 보세요(${rateOf(anchor.tally)}%).`
        : `흐름이 내려가 있어요(${why}). 다음 판은 가장 익숙한 라인부터 맡아 감을 되찾아 보세요.`,
      tone: "warn",
      basis: "최근 승률·연패와 라인별 승률",
    });
  }
  if (c.favoredPoor) {
    tips.push({
      text: `우세하던 판을 ${rateOf(c.favoredPoor)}%만 이겼어요. 앞설 때는 무리한 싸움을 줄이고 오브젝트부터 챙겨 보세요.`,
      tone: "warn",
      basis: "경기 전 예상 우세 팀이던 경기",
    });
  } else if (c.upsets.upsetLosses - c.upsets.upsetWins >= UPSET_LOSS_EXCESS) {
    tips.push({
      text: `이길 만하던 판을 놓친 경우가 많아요(강팀으로 진 경기 ${c.upsets.upsetLosses}회). 앞설 때 무리한 싸움을 줄여 보세요.`,
      tone: "warn",
      basis: "이변 승·패",
    });
  }
  if (c.laneHard) {
    tips.push({
      text: `${c.laneHard.line}에서 ${josa(c.laneHard.name, "을", "를")} 만나면 ${c.laneHard.wins}승 ${c.laneHard.losses}패예요. 맞라인이 되면 무리하지 말고 정글 도움을 요청하거나 라인을 바꿔 보세요.`,
      tone: "warn",
      basis: `맞라인 상대(${LANE_FOCUS_MIN}경기 이상)`,
    });
  } else if (c.rival) {
    tips.push({
      text: `${josa(c.rival.name, "을", "를")} 상대로 ${rateOf(c.rival.tally)}%예요(${c.rival.tally.games}경기). 상대 팀에 있으면 어느 라인인지 먼저 보고 맞라인을 피하거나 도움을 받아 보세요.`,
      tone: "warn",
      basis: "상대 팀 전적(누적 30경기 이상인 사람끼리)",
    });
  }
  if (c.absent !== null) {
    tips.push({
      text: `최근 모임 ${c.absent}번 연속으로 안 왔어요. 다음 모임에 나와 감을 이어 가 보세요.`,
      tone: "warn",
      basis: "마지막 참석 뒤 모임 날",
    });
  }
  // ─ 잘 풀리는 것 활용 ─
  if (c.strong && c.weak) {
    const strongName = LANE_NAME[c.strong.position];
    const weakName = LANE_NAME[c.weak.position];
    tips.push({
      text: `라인을 고를 수 있으면 ${josa(strongName, "을", "를")} 먼저 맡아 보세요. ${josa(weakName, "은", "는")} 부담이 덜한 판에서 연습해 보세요(${strongName} ${rateOf(c.strong.tally)}% · ${weakName} ${rateOf(c.weak.tally)}%).`,
      tone: "good",
      basis: `라인별 승률(${LINE_MIN_GAMES}경기 이상 라인)`,
    });
  }
  if (c.dayGap) {
    const earlyStrong = rateOf(c.dayGap.early) > rateOf(c.dayGap.late);
    tips.push({
      text: earlyStrong
        ? `모임 날 뒤로 갈수록 승률이 내려가요(${rateOf(c.dayGap.early)}% → ${rateOf(c.dayGap.late)}%). ${EARLY_GAMES + 1}판째부터는 쉬어 가며 집중해 보세요.`
        : `모임 날 첫 판들이 약해요(${rateOf(c.dayGap.early)}% → ${rateOf(c.dayGap.late)}%). 첫 판 전에 연습 모드로 몸을 풀어 보세요.`,
      tone: "neutral",
      basis: `모임 날 자기 경기 순서(첫 ${EARLY_GAMES}판 대 그 뒤)`,
    });
  }
  if (c.champBest) {
    tips.push({
      text: `${withRo(c.champBest.name)} ${c.champBest.tally.games}판 ${rateOf(c.champBest.tally)}%를 이겼어요. 중요한 판에는 ${josa(c.champBest.name, "을", "를")} 먼저 꺼내 보세요.`,
      tone: "good",
      basis: `기록한 챔피언(${CHAMP_MIN_GAMES}판 이상)`,
    });
  }
  if (c.champWorst) {
    tips.push({
      text: `${josa(c.champWorst.name, "은", "는")} ${c.champWorst.tally.games}판 ${rateOf(c.champWorst.tally)}%예요. 내전에서는 잠시 내려놓고 연습 모드에서 손에 익혀 보세요.`,
      tone: "warn",
      basis: `기록한 챔피언(${CHAMP_MIN_GAMES}판 이상)`,
    });
  }
  if (c.side) {
    const blueBetter = rateOf(c.side.blue) > rateOf(c.side.red);
    tips.push({
      text: `${blueBetter ? "블루" : "레드"}에서 더 잘 풀려요(블루 ${rateOf(c.side.blue)}% · 레드 ${rateOf(c.side.red)}%). 진영을 고를 수 있는 날에는 ${blueBetter ? "블루" : "레드"}를 골라 보세요.`,
      tone: "neutral",
      basis: "진영별 승률",
    });
  }
  if (c.main) {
    tips.push({
      text: `거의 ${LANE_NAME[c.main.position]}만 맡고 있어요. 다른 라인도 가끔 서 두면 팀 짤 때 선택지가 넓어져요.`,
      tone: "neutral",
      basis: "라인별 경기 수",
    });
  }
  if (c.supportHeavy !== null) {
    tips.push({
      text: `서폿을 경기의 ${c.supportHeavy}% 맡았어요. 다른 라인도 서 보고 싶으면 준비 화면의 "서포터 공평하게"를 켜 달라고 해 보세요.`,
      tone: "neutral",
      basis: "라인별 경기 수",
    });
  }
  // ─ 장점 살리기 ─
  if (c.chase) {
    tips.push({
      text: `1위 ${c.chase.name}까지 MMR ${c.chase.gap}점이에요. 몇 판만 이기면 뒤집을 수 있어요.`,
      tone: "good",
      basis: "MMR 순위(누적, 배치 완료)",
    });
  }
  if (c.streak >= STREAK_NOTE) {
    tips.push({
      text: `${c.streak}연승 중이에요. 지금 맡는 라인과 챔피언을 바꾸지 말고 이어 가 보세요.`,
      tone: "good",
      basis: "연승",
    });
  }
  if (c.laneEasy) {
    tips.push({
      text: `${c.laneEasy.line}에서 ${c.laneEasy.name} 상대로 ${c.laneEasy.wins}승 ${c.laneEasy.losses}패예요. 맞라인이 되면 초반에 적극적으로 우위를 가져가 보세요.`,
      tone: "good",
      basis: `맞라인 상대(${LANE_FOCUS_MIN}경기 이상)`,
    });
  }
  if (c.underdog) {
    tips.push({
      text: `약팀일 때도 ${rateOf(c.underdog)}%를 이겼어요(${c.underdog.games}경기). 불리한 판이어도 끝까지 한타를 노려 보세요.`,
      tone: "good",
      basis: "팀 평균 MMR이 낮았던 경기",
    });
  }
  if (c.buddy) {
    tips.push({
      text: `${josa(c.buddy.name, "과", "와")} 같은 팀일 때 특히 잘 풀려요(시너지 +${c.buddy.synergy}%p). 같은 팀이 되면 합을 맞춰 적극적으로 움직여 보세요.`,
      tone: "good",
      basis: "같은 팀 전적",
    });
  }
  if (tips.length === 0) {
    tips.push({
      text: `지금 흐름을 그대로 이어 가 보세요(최근 ${RECENT_GAMES}경기 ${rateOf(c.recent)}%, 범위 누적 ${rateOf(c.total)}%).`,
      tone: "neutral",
      basis: "최근·누적 승률",
    });
  }
  return tips.slice(0, COACHING_MAX);
}

/** 팀 평균 MMR이 높았던(예상 우세) 판의 성적(배치 마친 사람이 있는 판만, upset.ts reliable). */
function favoredTally(expectations: ReadonlyMap<string, MatchExpectation>, scoped: readonly MatchView[], id: string): Tally {
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
function afterResults(scoped: readonly MatchView[], id: string, timeZone: string): { afterLoss: Tally; afterWin: Tally } {
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
function dayParts(scoped: readonly MatchView[], id: string, timeZone: string): { early: Tally; late: Tally } {
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
function championTallies(scoped: readonly MatchView[], id: string): (Tally & { key: string })[] {
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
function chaseLeader(ratings: RatingTable, id: string, placementGames: number): { id: string; gap: number } | null {
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

export interface GroupCommentaryInput {
  /** 모임 전체 경기(순위 변동의 누적 MMR에 쓴다). */
  allMatches: readonly MatchView[];
  /** 범위가 적용된 경기. */
  scoped: readonly MatchView[];
  nameOf: (id: string) => string;
  ratings: RatingTable;
  expectations: ReadonlyMap<string, MatchExpectation>;
  timeZone: string;
  /** placementGamesOf(모임 설정). 없으면 기본값. */
  placementGames?: number;
}

/** 모임 전체 코멘트. 규칙 순서가 곧 우선순위다(공정성 → 진영 → 순위 변동 → 활동 → 뭉침 → 이변 → MMR 격차 → 서폿 쏠림 → 새로 온 사람 → 연승 → 챔피언 기록률). */
export function groupCommentary(input: GroupCommentaryInput): Commentary {
  const { scoped, nameOf, timeZone } = input;
  const counted = scoped.filter(isCounted);
  if (counted.length === 0) return { summary: "", remarks: [] };
  const remarks: Remark[] = [];

  // 1. 섞기 공정성 + 예측 적중.
  const fairness = fairnessReport(input.expectations, scoped);
  const fairReady = fairness.games >= FAIRNESS_MIN_GAMES;
  const verdict = fairnessVerdict(fairness);
  const predict = fairness.favoriteGames > 0 ? ratePercent(fairness.favoriteWins, fairness.favoriteGames) : null;
  if (fairReady) {
    // 사실만 쓴다(2026-11-10 F5): "공정해요"·"MMR이 실력을 잘 반영" 같은 판정은 표본 수가 말해 주는 것보다 많이 말한다.
    const head =
      `판정 ${fairness.games}경기 중 ${fairness.balanced}경기가 팀 평균 MMR 차 ${BALANCED_MMR_GAP}점 이내였어요` +
      `(균형 경기 ${ratePercent(fairness.balanced, fairness.games)}%).`;
    const tail =
      predict === null
        ? ""
        : ` 예상 우세 팀이 ${fairness.favoriteGames}경기 중 ${fairness.favoriteWins}경기 이겼어요(${predict}%).`;
    remarks.push({
      text: head + tail,
      tone: verdict === "poor" || (predict !== null && predict < PREDICT_POOR) ? "warn" : verdict === "good" ? "good" : "neutral",
      basis: `경기 직전 팀 평균 MMR 차(판정 ${fairness.games}경기)`,
    });
  }

  // 2. 진영 편차. 레드는 100 − 블루(다른 화면과 같은 규칙).
  const sides = sideTotals(scoped);
  let sideSkew = false;
  if (sides.known >= GROUP_SIDE_MIN_GAMES) {
    const blueRate = ratePercent(sides.blueWins, sides.known);
    const redRate = 100 - blueRate;
    const groupSideChance = binomialChance(sides.blueWins, sides.known);
    // 모임 문장 중 승률 비교는 진영 하나뿐이라 규칙 수로 나누지 않는다.
    if (Math.abs(blueRate - redRate) >= SIDE_GAP && beyondChance(groupSideChance, 1, 1)) {
      sideSkew = true;
      const blueHigh = blueRate > redRate;
      remarks.push({
        text: `${blueHigh ? "블루" : "레드"} 승률이 눈에 띄게 높아요(${blueHigh ? blueRate : redRate}%, ${sides.known}경기). 진영 랜덤을 자주 쓰는 게 좋아요.`,
        tone: "warn",
        basis: `진영별 승률(진영 미상 제외)${chanceNote(groupSideChance)}`,
      });
    }
  }

  // 3. 상위권 변동: 마지막 모임 날 직전 시점과 마지막 시점의 MMR 순위를 비교한다.
  const rated = new Set<string>();
  for (const person of input.ratings.values()) for (const point of person.history) rated.add(point.matchId);
  const timeline = countedChronological(scoped).filter((m) => rated.has(m.id));
  const lastMatch = timeline.at(-1);
  if (lastMatch) {
    const race = rankRace(input.allMatches, input.ratings, scoped, timeZone, input.placementGames);
    const lastDate = localDate(lastMatch.playedAt, timeZone);
    const lastDayGames = timeline.filter((m) => localDate(m.playedAt, timeZone) === lastDate).length;
    const end = race.labels.length - 1;
    const before = race.unit === "day" ? end - 1 : end - lastDayGames;
    if (before >= 0) {
      const leader = (i: number) => race.series.find((s) => s.ranks[i] === 1)?.participantId;
      const newLeader = leader(end);
      const oldLeader = leader(before);
      if (newLeader && oldLeader && newLeader !== oldLeader) {
        remarks.push({
          text: `${josa(nameOf(newLeader), "이", "가")} 마지막 모임에서 MMR 1위로 올라섰어요(전에는 ${nameOf(oldLeader)}).`,
          tone: "good",
          basis: "MMR 순위(누적)",
        });
      } else {
        const climbers = race.series.flatMap((s) => {
          const now = s.ranks[end];
          const then = s.ranks[before];
          return now != null && then != null && now <= RANK_WATCH && then - now >= RANK_JUMP
            ? [{ id: s.participantId, now, jump: then - now }]
            : [];
        });
        const climber = topBy(climbers, (c) => c.jump, (c) => nameOf(c.id));
        if (climber) {
          remarks.push({
            text: `${josa(nameOf(climber.id), "이", "가")} 마지막 모임에서 ${climber.jump}계단 올라 ${climber.now}위예요.`,
            tone: "good",
            basis: "MMR 순위(누적)",
          });
        }
      }
    }
  }

  // 4. 활동: 마지막 모임 날 기준 최근 4주 대 그 전 4주, 변화가 작으면 가장 많이 모이는 요일.
  let activityDrop: { prev: number; recent: number } | null = null;
  const counts = dailyCounts(scoped, timeZone);
  const dates = [...counts.keys()].sort();
  const anchor = dates.at(-1);
  if (anchor) {
    const recentStart = addDays(anchor, -(ACTIVITY_WINDOW_DAYS - 1));
    const prevStart = addDays(anchor, -(2 * ACTIVITY_WINDOW_DAYS - 1));
    let recentGames = 0;
    let prevGames = 0;
    const byWeekday = WEEKDAY_LABEL.map(() => 0);
    for (const [date, n] of counts) {
      if (date >= recentStart) recentGames += n;
      else if (date >= prevStart) prevGames += n;
      byWeekday[weekdayOf(date)]! += n;
    }
    const change = prevGames >= ACTIVITY_MIN_GAMES ? (recentGames - prevGames) / prevGames : 0;
    if (change <= -ACTIVITY_CHANGE) activityDrop = { prev: prevGames, recent: recentGames };
    if (Math.abs(change) >= ACTIVITY_CHANGE) {
      remarks.push({
        text: `최근 4주 경기가 그 전 4주보다 ${change > 0 ? "늘었어요" : "줄었어요"}(${prevGames} → ${recentGames}).`,
        tone: change > 0 ? "good" : "warn",
        basis: "날짜별 경기 수(마지막 모임 날 기준)",
      });
    } else if (dates.length >= WEEKDAY_MIN_DAYS) {
      const total = byWeekday.reduce((a, b) => a + b, 0);
      const busiest = byWeekday.indexOf(Math.max(...byWeekday));
      const share = ratePercent(byWeekday[busiest]!, total);
      // 요일이 늘 같은 모임(100%)에는 "늘 금요일"이 새 정보가 아니라 쓰지 않는다. 여러 요일에 흩어진 모임에서만.
      if (share < 100) {
        remarks.push({
          text: `${WEEKDAY_LABEL[busiest]}요일에 가장 많이 모여요(경기의 ${share}%).`,
          tone: "neutral",
          basis: "요일별 경기 수",
        });
      }
    }
  }

  // 5. 뭉침: 함께 나온 경기 중 같은 팀 비율이 가장 높은 쌍.
  const together = new Map<string, number>();
  for (const match of counted) {
    const ids = match.roster.map((r) => r.participantId).sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) together.set(`${ids[i]}|${ids[j]}`, (together.get(`${ids[i]}|${ids[j]}`) ?? 0) + 1);
    }
  }
  const pairs = teammatePairs(counted).flatMap((p) => {
    const both = together.get(`${p.a}|${p.b}`) ?? 0;
    return both >= PAIR_MIN_GAMES ? [{ ...p, both, share: p.n / both }] : [];
  });
  const pair = topBy(pairs, (p) => p.share, (p) => nameOf(p.a) + nameOf(p.b));
  if (pair && pair.share >= PAIR_SHARE) {
    const names = [nameOf(pair.a), nameOf(pair.b)].sort((x, y) => x.localeCompare(y, "ko"));
    remarks.push({
      text: `${names[0]}·${josa(names[1]!, "이", "가")} 자주 같은 팀이에요(함께 나온 ${pair.both}경기 중 ${pair.n}회, ${ratePercent(pair.n, pair.both)}%). 모임 설정 "팀 추천"의 최근 조합 피하기를 켜 두면 더 섞여요.`,
      tone: "warn",
      basis: "함께 나온 경기 중 같은 팀 비율(무작위면 약 44%)",
    });
  }

  // 5-1. 이변 비율(새로 넣은 문장들보다 앞에 둔다: 상한에 밀려 빠지지 않게).
  if (fairReady && fairness.upsets / fairness.games >= UPSET_SHARE) {
    remarks.push({
      text: `판정 ${fairness.games}경기 중 ${fairness.upsets}경기가 이변이었어요(${ratePercent(fairness.upsets, fairness.games)}%).`,
      tone: "neutral",
      basis: `팀 평균 MMR이 ${UPSET_MMR_GAP}점 이상 낮은 팀의 승리`,
    });
  }

  // 5-2. MMR 격차(배치 마친 사람, 누적).
  let mmrSpread: { people: number; lo: number; hi: number } | null = null;
  const placedRatings = [...input.ratings.values()].filter((p) => p.games >= (input.placementGames ?? PLACEMENT_GAMES_DEFAULT));
  if (placedRatings.length >= MMR_SPREAD_MIN_PEOPLE) {
    const hi = Math.max(...placedRatings.map((p) => shownRating(p.rating)));
    const lo = Math.min(...placedRatings.map((p) => shownRating(p.rating)));
    if (hi - lo >= MMR_SPREAD_WIDE) {
      mmrSpread = { people: placedRatings.length, lo, hi };
      remarks.push({
        text: `배치를 마친 ${placedRatings.length}명의 MMR이 ${lo}~${hi}점으로 ${hi - lo}점 벌어져 있어요.`,
        tone: "neutral",
        basis: "MMR(누적, 배치 완료)",
      });
    }
  }

  // 5-3. 서폿 쏠림: 자기 경기의 절반 이상을 서폿으로 선 사람.
  const supportLoad = supportShares(counted).filter((s) => s.positioned >= SUPPORT_MIN_GAMES && s.share >= GROUP_SUPPORT_SHARE);
  const supporter = topBy(supportLoad, (s) => s.share, (s) => nameOf(s.id));
  if (supporter) {
    remarks.push({
      text: `${josa(nameOf(supporter.id), "이", "가")} 서폿을 많이 맡아요(자기 경기의 ${Math.round(supporter.share * 100)}%).`,
      tone: "warn",
      basis: "사람별 라인 경기 수",
    });
  }

  // 5-4. 새로 온 사람(최근 ACTIVITY_WINDOW_DAYS일에 첫 경기).
  const firstDay = new Map<string, string>();
  for (const match of countedChronological(input.allMatches)) {
    const day = localDate(match.playedAt, timeZone);
    for (const r of match.roster) if (!firstDay.has(r.participantId)) firstDay.set(r.participantId, day);
  }
  // 모임이 이 창보다 오래됐을 때만 센다. 생긴 지 4주가 안 된 모임은 모두가 "새로 온 사람"이라 뜻이 없다.
  const windowStart = anchor ? addDays(anchor, -(ACTIVITY_WINDOW_DAYS - 1)) : null;
  const firstDays = [...firstDay.values()];
  const newcomers =
    windowStart && firstDays.some((d) => d < windowStart) ? firstDays.filter((d) => d >= windowStart).length : 0;
  if (newcomers >= NEWCOMER_MIN) {
    remarks.push({ text: `최근 4주에 새로 온 사람이 ${newcomers}명이에요.`, tone: "good", basis: "사람별 첫 경기 날" });
  }

  // 5-5. 연승 행진.
  const streaks = currentStreaks(counted);
  const hot = topBy(streaks.filter((s) => s.streak >= GROUP_STREAK), (s) => s.streak, (s) => nameOf(s.id));
  if (hot) {
    remarks.push({ text: `${josa(nameOf(hot.id), "이", "가")} ${hot.streak}연승 중이에요.`, tone: "good", basis: "사람별 현재 연승" });
  }

  // 5-6. 챔피언 기록률.
  const seats = counted.reduce((n, m) => n + m.roster.length, 0);
  const withChamp = counted.reduce((n, m) => n + m.roster.filter((r) => r.champion).length, 0);
  const champRate = seats > 0 ? ratePercent(withChamp, seats) : 0;
  const champLow = counted.length >= CHAMP_RECORD_MIN_GAMES && champRate < CHAMP_RECORD_LOW;
  if (champLow) {
    remarks.push({
      text: `챔피언 기록이 ${champRate}%뿐이에요. 챔피언을 기록하면 사람별 주력 챔피언 분석이 생겨요.`,
      tone: "neutral",
      basis: "경기 명단 중 챔피언을 고른 비율",
    });
  }

  // 총평: 치우친 곳이 있으면 그것을, 없으면 섞기 수치를 짧게(판정 낱말 없이).
  // "손질 필요"라고 단정하지 않는다. 편성 판정은 팀 평균 MMR 차에서 나온 참고 지표라 실제 체감과 다를 수 있다.
  const fixes = [sideSkew ? "진영" : "", fairReady && verdict === "poor" ? "편성" : ""].filter(Boolean);
  let summary: string;
  if (fixes.length > 0) summary = `${fixes.join("·")} 치우침 · 살펴볼 만해요`;
  else if (!fairReady) summary = "경기가 더 쌓이면 섞기 판단이 가능해요";
  else {
    const balancedShare = `균형 경기 ${ratePercent(fairness.balanced, fairness.games)}%`;
    summary = predict === null ? balancedShare : `${balancedShare} · 예상 우세 팀 승률 ${predict}%`;
  }
  return { summary, remarks: remarks.slice(0, GROUP_REMARK_MAX), coaching: groupCoaching() };

  /**
   * 모임 코칭: 판정 경기 부족이면 그 한 줄만. 아니면 진영 → 균형 경기 → 예상 우세 팀 승률 과다 → MMR 격차 → 서폿 쏠림 →
   * 뭉침 → 연승 행진 → 경기 수 감소 → 챔피언 기록 → 새로 온 사람 순으로 담아 COACHING_MAX개까지.
   * 고칠 수 있는 운영 행동(진영 랜덤, 티어 가중치, 팀 추천, 서포터 공평하게, 챔피언 기록)을 권한다.
   */
  function groupCoaching(): Remark[] {
    if (!fairReady) {
      return [
        {
          text: `결과를 빠짐없이 입력해 주세요. 판정할 수 있는 경기가 ${FAIRNESS_MIN_GAMES}개가 되면 섞기 분석을 시작해요(지금 ${fairness.games}개).`,
          tone: "neutral",
          basis: "판정 가능한 경기 수",
        },
      ];
    }
    const tips: Remark[] = [];
    if (sideSkew) {
      tips.push({
        text: "다음 내전부터 진영을 랜덤으로 정해 보세요. 한쪽 진영 승률이 눈에 띄게 높아요.",
        tone: "warn",
        basis: "진영별 승률(진영 미상 제외)",
      });
    }
    if (verdict === "poor") {
      tips.push({
        text: `균형 경기가 ${ratePercent(fairness.balanced, fairness.games)}%로 적어요. 티어 배정과 티어 가중치를 다시 맞춰 보거나 팀 추천으로 섞어 보세요.`,
        tone: "warn",
        basis: `경기 직전 팀 평균 MMR 차(판정 ${fairness.games}경기)`,
      });
    }
    if (predict !== null && predict >= PREDICT_TOO_HIGH) {
      tips.push({
        text: `경기 전 우세하던 팀이 ${predict}%를 이겨요. 팀을 짠 뒤 예상 승률 판에서 팀 평균 MMR이 ${UPSET_MMR_GAP}점 이상 벌어지면 한두 명을 바꿔 보세요.`,
        tone: "warn",
        basis: `예상 우세 팀 승률(${fairness.favoriteGames}경기)`,
      });
    }
    if (mmrSpread) {
      tips.push({
        text: `MMR이 ${mmrSpread.lo}~${mmrSpread.hi}점으로 ${mmrSpread.hi - mmrSpread.lo}점 벌어져 있어요. 상위 티어 가중치를 더 크게 두면 강한 사람이 한 팀에 몰리지 않아요.`,
        tone: "neutral",
        basis: "MMR(누적, 배치 완료)",
      });
    }
    if (supporter) {
      tips.push({
        text: `서폿이 ${nameOf(supporter.id)}에게 몰려 있어요(${Math.round(supporter.share * 100)}%). 준비 화면의 "서포터 공평하게"로 돌아가며 맡아 보세요.`,
        tone: "warn",
        basis: "사람별 라인 경기 수",
      });
    }
    if (pair && pair.share >= PAIR_SHARE) {
      const names = [nameOf(pair.a), nameOf(pair.b)].sort((x, y) => x.localeCompare(y, "ko"));
      tips.push({
        text: `${names[0]}·${josa(names[1]!, "을", "를")} 가끔 다른 팀으로 나눠 보세요(같은 팀 ${ratePercent(pair.n, pair.both)}%).`,
        tone: "neutral",
        basis: "함께 나온 경기 중 같은 팀 비율",
      });
    }
    if (hot) {
      tips.push({
        text: `${josa(nameOf(hot.id), "이", "가")} ${hot.streak}연승 중이에요. 다음 판은 상대 팀에 강한 사람을 넣어 균형을 맞춰 보세요.`,
        tone: "neutral",
        basis: "사람별 현재 연승",
      });
    }
    if (activityDrop) {
      tips.push({
        text: `최근 4주 경기가 줄었어요(${activityDrop.prev} → ${activityDrop.recent}). 조회 링크로 지난 기록을 공유하며 다음 모임을 잡아 보세요.`,
        tone: "neutral",
        basis: "날짜별 경기 수(마지막 모임 날 기준)",
      });
    }
    if (champLow) {
      tips.push({
        text: `결과를 입력할 때 챔피언도 골라 두세요(지금 ${champRate}%). 사람별 주력 챔피언 분석이 생겨요.`,
        tone: "neutral",
        basis: "경기 명단 중 챔피언을 고른 비율",
      });
    }
    if (newcomers >= NEWCOMER_MIN) {
      tips.push({
        text: `최근 4주에 ${newcomers}명이 새로 왔어요. 새로 온 사람의 티어를 정해 두면 팀이 더 고르게 나뉘어요.`,
        tone: "neutral",
        basis: "사람별 첫 경기 날",
      });
    }
    if (tips.length === 0) {
      tips.push({
        text: "지금처럼 티어로 팀을 나누고 결과를 바로 입력해 두세요. 기록이 쌓일수록 분석이 정확해져요.",
        tone: "neutral",
        basis: "섞기·진영·뭉침 지표에 치우침 없음",
      });
    }
    return tips.slice(0, COACHING_MAX);
  }
}

/** 사람별 서폿 비중(포지션 기록이 있는 경기 기준). */
function supportShares(counted: readonly MatchView[]): { id: string; positioned: number; share: number }[] {
  const byId = new Map<string, { positioned: number; support: number }>();
  for (const match of counted) {
    for (const r of match.roster) {
      if (r.position === null) continue;
      const s = byId.get(r.participantId) ?? { positioned: 0, support: 0 };
      s.positioned += 1;
      if (r.position === "support") s.support += 1;
      byId.set(r.participantId, s);
    }
  }
  return [...byId.entries()].map(([id, s]) => ({ id, positioned: s.positioned, share: s.support / s.positioned }));
}

/** 사람별 지금 이어지는 연승 수(지면 0). 범위 안 유효 경기를 시각 순서로 본다. */
function currentStreaks(counted: readonly MatchView[]): { id: string; streak: number }[] {
  const streak = new Map<string, number>();
  for (const match of countedChronological(counted)) {
    for (const r of match.roster) streak.set(r.participantId, r.team === match.winnerTeam ? (streak.get(r.participantId) ?? 0) + 1 : 0);
  }
  return [...streak.entries()].map(([id, n]) => ({ id, streak: n }));
}
