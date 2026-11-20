import { LANE_RIVAL_MIN } from "./headToHead";
import { SMALL_SAMPLE } from "./stats";

/**
 * 분석 코멘트의 문턱 값: 몇 경기부터 말할지, 승률 차가 얼마면 말할지, 문장을 몇 개까지 쓸지.
 * 개인(playerCommentary.ts·playerCoaching.ts·playerTallies.ts)과 모임(groupCommentary.ts)이 함께 쓴다.
 * 값을 바꾸면 test/commentary.test.ts의 문구·개수 검사를 함께 본다.
 */

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

/** 코칭 줄 최대 수(개인·모임). 늘리면 카드가 길어지고 덜 중요한 권유까지 섞인다. */
export const COACHING_MAX = 3;
/** 예상 우세 팀 승률(%)이 이 이상이면 팀 차이가 크다고 보고 섞기를 권한다(모임 코칭). */
export const PREDICT_TOO_HIGH = 70;

// ─ 모임 코멘트 임계값 ─
/** 모임 문장 최대 수(2026-11-12 규칙을 늘리며 5 → 7). */
export const GROUP_REMARK_MAX = 7;
/**
 * 예상 우세 팀 승률(%)이 이 미만이면 섞기 공정성 문장의 점이 "주의" 색이다. 50%면 동전 던지기와 같다.
 * "좋음" 색은 승률이 아니라 균형 판정(fairnessVerdict)으로만 정한다: 판정 10경기에서 6승 이상은 동전 던지기로도
 * 약 38% 나와서(이항 분포) 높은 적중률을 칭찬할 근거가 못 된다. 문장은 숫자만 쓴다.
 */
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
