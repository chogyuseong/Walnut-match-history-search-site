import type { AttendanceReport } from "./attendance";
import { ABSENT_DAYS } from "./attendance";
import { addDays, dailyCounts, rankRace, ratingRank, teammatePairs, topBy, WEEKDAY_LABEL, weekdayOf } from "./graphs";
import { compareMetrics, countedChronological, mainLine, synergyPoints } from "./insights";
import { PLACEMENT_GAMES_DEFAULT, isCounted, localDate, personDetail, personRecords, ratePercent, sideTotals, SMALL_SAMPLE, type Tally } from "./stats";
import { shownRating, type RatingTable } from "./rating";
import { POSITIONS, type MatchView, type Position } from "./types";
import {
  BALANCED_MARGIN,
  fairnessReport,
  fairnessVerdict,
  FAIRNESS_MIN_GAMES,
  personUpsets,
  UPSET_THRESHOLD,
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
   * 코칭 한 줄: 위 수치에서 "다음에 해 볼 것"을 하나 고른다(2026-11-12 사용자 요청, 외부 AI 없이 규칙으로).
   * 근거 수치는 문장 괄호와 basis에 둔다. 경기가 없으면 없다.
   */
  coaching?: Remark;
}

// ─ 개인 코멘트 임계값 ─
/** 개인 문장 최대 수. 늘리면 카드가 길어져 아래 그래프가 밀린다. */
export const PLAYER_REMARK_MAX = 6;
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
/** 약팀(경기 전 예상 50% 미만)이었던 경기가 이만큼 있어야 이변 성향을 말한다. */
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

// ─ 모임 코멘트 임계값 ─
/** 모임 문장 최대 수. */
export const GROUP_REMARK_MAX = 5;
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
    if (best && worst && best !== worst && rateOf(best.tally) - rateOf(worst.tally) >= LINE_GAP) {
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
        basis: `라인별 승률(${LINE_MIN_GAMES}경기 이상 라인)`,
      });
    }
  }

  // 2. 최근 흐름 대 누적(+ 긴 연승·연패).
  const recent = detail.recent10;
  let flow: Flow = "flat";
  const streak = detail.currentStreak;
  const streakNote =
    Math.abs(streak) >= STREAK_NOTE ? ` 지금 ${Math.abs(streak)}${streak > 0 ? "연승" : "연패"} 중이에요.` : "";
  if (recent.games >= RECENT_GAMES && games > RECENT_GAMES) {
    const gap = rateOf(recent) - rateOf(detail.summary);
    flow = gap >= FLOW_GAP ? "up" : gap <= -FLOW_GAP ? "down" : "flat";
  }
  if (flow !== "flat") {
    const up = flow === "up";
    remarks.push({
      text: `최근 ${RECENT_GAMES}경기는 누적보다 ${up ? "높아 상승" : "낮아 하락"} 구간이에요(${rateOf(recent)}% vs ${rateOf(detail.summary)}%).${streakNote}`,
      tone: up ? "good" : "warn",
      basis: `최근 ${RECENT_GAMES}경기 승률과 범위 누적 승률`,
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
      parts.push(`최근 10경기 MMR이 +${delta}로 빠르게 오르고 있어요.`);
      tone = "good";
    } else if (delta <= -MMR_MOVE && flow !== "down") {
      parts.push(`최근 10경기 MMR이 −${-delta}로 떨어지고 있어요.`);
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
      basis: "경기 전 예상 승률 50% 미만이던 경기",
    });
  } else if (upsets.upsetLosses - upsets.upsetWins >= UPSET_LOSS_EXCESS) {
    remarks.push({
      text: `예상 승률 ${Math.round((1 - UPSET_THRESHOLD) * 100)}% 넘는 강팀으로 진 경기가 ${upsets.upsetLosses}회로, 약팀으로 이긴 ${upsets.upsetWins}회보다 많아요.`,
      tone: "warn",
      basis: "이변 승·패",
    });
  }

  // 5. 잘 맞는 동료·어려운 상대(개인 통계와 같은 compareMetrics). 혼자 승률과 별 차이 없으면 말하지 않는다.
  const compare = compareMetrics(detail, input.cumulative);
  const synergy = compare.buddy
    ? synergyPoints(compare.buddy, detail.summary, personRecords(scoped).get(compare.buddy.participantId) ?? { games: 0, wins: 0 })
    : null;
  const buddy = synergy !== null && synergy >= BUDDY_SYNERGY_MIN ? compare.buddy : null;
  const rival = compare.rival && rateOf(detail.summary) - rateOf(compare.rival) >= RIVAL_GAP ? compare.rival : null;
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
    remarks.push({ text: pairParts.join(" "), tone: "neutral", basis: "같은 팀·상대 팀 전적(누적 30경기 이상인 사람끼리)" });
  }

  // 6. 진영.
  const { blue, red } = detail.bySide;
  if (blue.games >= SIDE_MIN_GAMES && red.games >= SIDE_MIN_GAMES && Math.abs(rateOf(blue) - rateOf(red)) >= SIDE_GAP) {
    const blueBetter = rateOf(blue) > rateOf(red);
    const [hi, lo] = blueBetter ? [blue, red] : [red, blue];
    remarks.push({
      text:
        judged(Math.min(blue.games, red.games), `${blueBetter ? "블루" : "레드"}에서 유독 강해요`, `${blueBetter ? "블루" : "레드"}에서 더 강한 편으로 보여요`) +
        `(${rateOf(hi)}% vs ${rateOf(lo)}%).`,
      tone: "neutral",
      basis: "진영별 승률",
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
    summary: `${lineLead}${steady}${tier}, ${FLOW_TEXT[flow]}`,
    remarks: remarks.slice(0, PLAYER_REMARK_MAX),
    coaching,
  };
}

/**
 * 개인 코칭 한 줄. 위에서부터 먼저 맞는 하나만 쓴다(우선순위 = 지금 가장 손댈 만한 것).
 * 자료 부족 → 최근 하락·연패 → 라인 강약 → 한 라인 전담 → 강팀으로 진 경기 과다 → 잘 맞는 동료 → 유지.
 * 문장은 "해 보세요"로 권하기만 하고 결과를 장담하지 않는다(수치는 과거 기록일 뿐이다).
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
}): Remark {
  if (c.games < FEW_GAMES) {
    return {
      text: `${FEW_GAMES - c.games}경기를 더 하면 강한 라인·약한 라인을 짚어 드릴 수 있어요. 여러 라인을 고루 서 보세요.`,
      tone: "neutral",
      basis: "범위 안 경기 수",
    };
  }
  const anchor = c.strong ?? c.main;
  if (c.flow === "down" || c.streak <= -STREAK_NOTE) {
    const why = c.streak <= -STREAK_NOTE ? `${-c.streak}연패 중` : `최근 ${RECENT_GAMES}경기 ${rateOf(c.recent)}%`;
    return {
      text: anchor
        ? `흐름이 내려가 있어요(${why}). 다음 판은 가장 잘 풀린 ${LANE_NAME[anchor.position]}부터 맡아 감을 되찾아 보세요(${rateOf(anchor.tally)}%).`
        : `흐름이 내려가 있어요(${why}). 다음 판은 가장 익숙한 라인부터 맡아 감을 되찾아 보세요.`,
      tone: "warn",
      basis: "최근 승률·연패와 라인별 승률",
    };
  }
  if (c.strong && c.weak) {
    const strongName = LANE_NAME[c.strong.position];
    const weakName = LANE_NAME[c.weak.position];
    return {
      text: `라인을 고를 수 있으면 ${josa(strongName, "을", "를")} 먼저 맡아 보세요. ${josa(weakName, "은", "는")} 부담이 덜한 판에서 연습해 보세요(${strongName} ${rateOf(c.strong.tally)}% · ${weakName} ${rateOf(c.weak.tally)}%).`,
      tone: "good",
      basis: `라인별 승률(${LINE_MIN_GAMES}경기 이상 라인)`,
    };
  }
  if (c.main) {
    return {
      text: `거의 ${LANE_NAME[c.main.position]}만 맡고 있어요. 다른 라인도 가끔 서 두면 팀 짤 때 선택지가 넓어져요.`,
      tone: "neutral",
      basis: "라인별 경기 수",
    };
  }
  if (c.upsets.upsetLosses - c.upsets.upsetWins >= UPSET_LOSS_EXCESS) {
    return {
      text: `이길 만하던 판을 놓친 경우가 많아요(강팀으로 진 경기 ${c.upsets.upsetLosses}회). 앞설 때 무리한 싸움을 줄여 보세요.`,
      tone: "warn",
      basis: "이변 승·패",
    };
  }
  if (c.buddy) {
    return {
      text: `${josa(c.buddy.name, "과", "와")} 같은 팀일 때 특히 잘 풀려요(시너지 +${c.buddy.synergy}%p). 같은 팀이 되면 합을 맞춰 적극적으로 움직여 보세요.`,
      tone: "good",
      basis: "같은 팀 전적",
    };
  }
  return {
    text: `지금 흐름을 그대로 이어 가 보세요(최근 ${RECENT_GAMES}경기 ${rateOf(c.recent)}%, 범위 누적 ${rateOf(c.total)}%).`,
    tone: "neutral",
    basis: "최근·누적 승률",
  };
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

/** 모임 전체 코멘트. 규칙 순서가 곧 우선순위다(공정성 → 진영 → 순위 변동 → 활동 → 뭉침 → 이변). */
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
    const low = Math.round((0.5 - BALANCED_MARGIN) * 100);
    const high = Math.round((0.5 + BALANCED_MARGIN) * 100);
    const head =
      `판정 ${fairness.games}경기 중 ${fairness.balanced}경기가 예상 ${low}~${high}%였어요` +
      `(균형 경기 ${ratePercent(fairness.balanced, fairness.games)}%).`;
    const tail =
      predict === null
        ? ""
        : ` 예상 우세 팀이 ${fairness.favoriteGames}경기 중 ${fairness.favoriteWins}경기 이겼어요(${predict}%).`;
    remarks.push({
      text: head + tail,
      tone: verdict === "poor" || (predict !== null && predict < PREDICT_POOR) ? "warn" : verdict === "good" ? "good" : "neutral",
      basis: `경기 전 예상 승률(판정 ${fairness.games}경기)`,
    });
  }

  // 2. 진영 편차. 레드는 100 − 블루(다른 화면과 같은 규칙).
  const sides = sideTotals(scoped);
  let sideSkew = false;
  if (sides.known >= GROUP_SIDE_MIN_GAMES) {
    const blueRate = ratePercent(sides.blueWins, sides.known);
    const redRate = 100 - blueRate;
    if (Math.abs(blueRate - redRate) >= SIDE_GAP) {
      sideSkew = true;
      const blueHigh = blueRate > redRate;
      remarks.push({
        text: `${blueHigh ? "블루" : "레드"} 승률이 눈에 띄게 높아요(${blueHigh ? blueRate : redRate}%, ${sides.known}경기). 진영 랜덤을 자주 쓰는 게 좋아요.`,
        tone: "warn",
        basis: "진영별 승률(진영 미상 제외)",
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

  // 6. 이변 비율.
  if (fairReady && fairness.upsets / fairness.games >= UPSET_SHARE) {
    remarks.push({
      text: `판정 ${fairness.games}경기 중 ${fairness.upsets}경기가 이변이었어요(${ratePercent(fairness.upsets, fairness.games)}%).`,
      tone: "neutral",
      basis: "경기 전 예상 40% 미만 팀의 승리",
    });
  }

  // 총평: 치우친 곳이 있으면 그것을, 없으면 섞기 수치를 짧게(판정 낱말 없이).
  // "손질 필요"라고 단정하지 않는다. 편성 판정은 MMR로 낸 예상 승률에서 나온 참고 지표라 실제 체감과 다를 수 있다.
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
   * 모임 코칭 한 줄. 판정 경기 부족 → 진영 치우침 → 균형 경기 적음 → 자주 뭉치는 쌍 → 유지 순으로 하나만.
   * 고칠 수 있는 운영 행동(진영 랜덤, 티어 가중치, 팀 추천)을 권한다.
   */
  function groupCoaching(): Remark {
    if (!fairReady) {
      return {
        text: `결과를 빠짐없이 입력해 주세요. 판정할 수 있는 경기가 ${FAIRNESS_MIN_GAMES}개가 되면 섞기 분석을 시작해요(지금 ${fairness.games}개).`,
        tone: "neutral",
        basis: "판정 가능한 경기 수",
      };
    }
    if (sideSkew) {
      return {
        text: "다음 내전부터 진영을 랜덤으로 정해 보세요. 한쪽 진영 승률이 눈에 띄게 높아요.",
        tone: "warn",
        basis: "진영별 승률(진영 미상 제외)",
      };
    }
    if (verdict === "poor") {
      return {
        text: `균형 경기가 ${ratePercent(fairness.balanced, fairness.games)}%로 적어요. 티어 배정과 티어 가중치를 다시 맞춰 보거나 팀 추천으로 섞어 보세요.`,
        tone: "warn",
        basis: `경기 전 예상 승률(판정 ${fairness.games}경기)`,
      };
    }
    if (pair && pair.share >= PAIR_SHARE) {
      const names = [nameOf(pair.a), nameOf(pair.b)].sort((x, y) => x.localeCompare(y, "ko"));
      return {
        text: `${names[0]}·${josa(names[1]!, "을", "를")} 가끔 다른 팀으로 나눠 보세요(같은 팀 ${ratePercent(pair.n, pair.both)}%).`,
        tone: "neutral",
        basis: "함께 나온 경기 중 같은 팀 비율",
      };
    }
    return {
      text: "지금처럼 티어로 팀을 나누고 결과를 바로 입력해 두세요. 기록이 쌓일수록 분석이 정확해져요.",
      tone: "neutral",
      basis: "섞기·진영·뭉침 지표에 치우침 없음",
    };
  }
}
