import { type AttendanceReport, ABSENT_DAYS } from "./attendance";
import { ratingRank, topBy } from "./graphs";
import { championName } from "./champions";
import { laneRivals, laneRivalSummary } from "./headToHead";
import { confirmedBuddy } from "./bestCombos";
import { compareMetrics, countedChronological, mainLine } from "./insights";
import {
  binomialChance,
  PLACEMENT_GAMES_DEFAULT,
  personDetail,
  personRecords,
  rateGapChance,
  ratePercent,
  SMALL_SAMPLE,
  type Tally,
} from "./stats";
import { shownRating, type RatingTable } from "./rating";
import { POSITIONS, type MatchView, type Position, type RosterEntry } from "./types";
import { personUpsets, UPSET_MMR_GAP, type MatchExpectation } from "./upset";
import {
  type RemarkTone,
  type Remark,
  type EvidenceMatch,
  type EvidenceGroup,
  type Commentary,
  beyondChance,
  chanceNote,
  without,
  LANE_NAME,
  withJosa,
  withRo,
  rateOf,
  judged,
} from "./commentary";
import { playerCoaching } from "./playerCoaching";
import { favoredTally, afterResults, dayParts, championTallies, chaseLeader } from "./playerTallies";
import {
  PLAYER_REMARK_MAX,
  FEW_GAMES,
  FEW_GAMES_REMARKS,
  LINE_MIN_GAMES,
  LINE_GAP,
  MAIN_LINE_SHARE,
  MAIN_LINE_FOCUS,
  RECENT_GAMES,
  FLOW_GAP,
  STREAK_NOTE,
  MMR_MOVE,
  MMR_PEAK_GAP,
  TOP_RANK_SHARE,
  TIER_TOP_RATE,
  TIER_MID_RATE,
  UNDERDOG_MIN_GAMES,
  UNDERDOG_RATE,
  UPSET_LOSS_EXCESS,
  RIVAL_GAP,
  SIDE_MIN_GAMES,
  SIDE_GAP,
  ATTEND_MIN_DAYS,
  ATTEND_LOYAL_RATE,
  AFTER_RESULT_MIN,
  AFTER_RESULT_GAP,
  EARLY_GAMES,
  DAY_PART_MIN,
  DAY_PART_GAP,
  FAVORED_MIN,
  FAVORED_POOR,
  FAVORED_GOOD,
  LANE_FOCUS_MIN,
  LANE_HARD_RATE,
  LANE_EASY_RATE,
  CHAMP_MIN_GAMES,
  CHAMP_GOOD_RATE,
  CHAMP_POOR_RATE,
  CHASE_RANK,
  CHASE_GAP,
  STREAK_RECORD_MIN,
  SUPPORT_SHARE,
  SUPPORT_MIN_GAMES,
} from "./commentaryRules";

/**
 * 고른 플레이어의 분석 코멘트: 총평 한 줄과 우선순위 순 문장, 코칭(playerCoaching.ts).
 * 쓰는 곳: src/web/screens/Graphs.tsx(플레이어를 골랐을 때). 문턱 값은 commentaryRules.ts.
 */

/**
 * 총평 유형 표.
 * 등급: 승률 TIER_TOP_RATE%↑ 그리고 MMR 상위 TOP_RANK_SHARE = 상위권 · 승률 TIER_MID_RATE% 이상 = 중위권 · 그 아래 = 성장 중.
 * 앞말: 최근 10경기 MMR 변화가 ±MMR_MOVE 안이면 "안정형". 뒷말: 최근 흐름(상승·하락·보합).
 */
const TIER_TEXT = { top: "상위권", mid: "중위권", growing: "성장 중" } as const;
const FLOW_TEXT = { up: "최근 상승세", down: "최근 주춤", flat: "최근은 숨 고르기" } as const;

export type Flow = keyof typeof FLOW_TEXT;

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

/**
 * 이 사람이 뛴 유효 확정 경기 중 pick이 고른 것, 최근 경기부터. personDetail과 같은 대상(isCounted + 명단에 있음)이라
 * 같은 조건으로 고르면 개수가 그 집계의 경기 수와 같다. note는 이 사람의 승패다.
 */
function myEvidence(
  scoped: readonly MatchView[],
  id: string,
  pick: (match: MatchView, me: RosterEntry) => boolean,
): EvidenceMatch[] {
  return countedChronological(scoped)
    .flatMap((match) => {
      const me = match.roster.find((r) => r.participantId === id);
      return me && pick(match, me) ? [{ matchId: match.id, note: match.winnerTeam === me.team ? "승" : "패" }] : [];
    })
    .reverse();
}

/** other가 같은 팀(sameTeam) 또는 상대 팀으로 함께 나온 경기를 고른다. personDetail의 synergy·versus와 같은 조건. */
function withOther(other: string, sameTeam: boolean) {
  return (match: MatchView, me: RosterEntry) =>
    match.roster.some((r) => r.participantId === other && (r.team === me.team) === sameTeam);
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
          judged(worst.tally.games, `${withJosa(worstName, "은", "는")} 약점이에요`, `${withJosa(worstName, "은", "는")} 약점으로 보여요`) +
          `(${rateOf(worst.tally)}%, ${worst.tally.games}경기).`,
        tone: "good",
        basis: `라인별 승률(${LINE_MIN_GAMES}경기 이상 라인)${chanceNote(lineChance)}`,
        evidence: [best, worst].map((line) => ({
          label: LANE_NAME[line.position],
          matches: myEvidence(scoped, id, (_, me) => me.position === line.position),
        })),
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
  // 동료 판정은 confirmedBuddy(bestCombos.ts). 최고의 콤비 배지는 개인 통계 타일 기준이라 이것보다 넉넉하다.
  const compare = compareMetrics(detail, input.cumulative);
  const confirmed = confirmedBuddy(detail, input.cumulative, personRecords(scoped));
  const buddy = confirmed?.pair ?? null;
  const synergy = confirmed?.synergy ?? null;
  const buddyChance = confirmed?.chance ?? 1;
  // 상대도 기준 경기 수를 넘는 짝 중 가장 극단을 고른 것이라, 그 짝 수만큼 우연 문턱을 엄하게 한다.
  const rivalCandidates = compare.versus.filter((p) => p.games >= SMALL_SAMPLE).length;
  const rivalChance = compare.rival ? rateGapChance(compare.rival, without(detail.summary, compare.rival)) : 1;
  const rival =
    compare.rival && rateOf(detail.summary) - rateOf(compare.rival) >= RIVAL_GAP && beyondChance(rivalChance, rivalCandidates)
      ? compare.rival
      : null;
  const pairParts: string[] = [];
  const pairEvidence: EvidenceGroup[] = [];
  if (buddy) {
    pairEvidence.push({
      label: `${withJosa(nameOf(buddy.participantId), "과", "와")} 같은 팀`,
      matches: myEvidence(scoped, id, withOther(buddy.participantId, true)),
    });
  }
  if (rival) {
    pairEvidence.push({
      label: `${nameOf(rival.participantId)} 상대`,
      matches: myEvidence(scoped, id, withOther(rival.participantId, false)),
    });
  }
  if (buddy && rival && buddy.participantId === rival.participantId) {
    // 같은 사람이 동료이자 상대면 한 문장으로: 편이 갈리면 결과가 뒤집힌다는 뜻이다.
    pairParts.push(
      `${withJosa(nameOf(buddy.participantId), "과", "와")}는 같은 팀이면 ${rateOf(buddy)}%, 상대 팀이면 ${rateOf(rival)}%라 ` +
        `함께일 때 확실히 강해요(시너지 +${synergy}%p).`,
    );
  } else {
    if (buddy) {
      pairParts.push(
        `${withJosa(nameOf(buddy.participantId), "과", "와")} 같은 팀일 때 ` +
          judged(buddy.games, "가장 강해요", "가장 강한 편으로 보여요") +
          `(${rateOf(buddy)}%, 시너지 +${synergy}%p).`,
      );
    }
    if (rival) {
      pairParts.push(
        `${withJosa(nameOf(rival.participantId), "을", "를")} 상대로는 ` +
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
      evidence: pairEvidence,
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
    duelParts.push(`${LANE_NAME[hardest.position]}에서 ${withJosa(nameOf(hardest.opponentId), "을", "를")} 만나면 ${hardest.wins}승 ${hardest.losses}패로 고전해요.`);
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
    if (champWorst) bits.push(`${withJosa(championName(champWorst.key), "은", "는")} ${champWorst.games}판 ${rateOf(champWorst)}%예요.`);
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
