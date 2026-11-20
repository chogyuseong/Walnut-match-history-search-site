import { addDays, dailyCounts, rankRace, teammatePairs, topBy, WEEKDAY_LABEL, weekdayOf } from "./graphs";
import { countedChronological } from "./insights";
import { binomialChance, isCounted, localDate, PLACEMENT_GAMES_DEFAULT, ratePercent, sideTotals } from "./stats";
import { shownRating, type RatingTable } from "./rating";
import type { MatchView } from "./types";
import {
  BALANCED_MMR_GAP,
  fairnessReport,
  fairnessVerdict,
  FAIRNESS_MIN_GAMES,
  UPSET_MMR_GAP,
  type MatchExpectation,
} from "./upset";
import { type Remark, type EvidenceMatch, type Commentary, beyondChance, chanceNote, withJosa } from "./commentary";
import {
  SIDE_GAP,
  SUPPORT_MIN_GAMES,
  COACHING_MAX,
  PREDICT_TOO_HIGH,
  GROUP_REMARK_MAX,
  PREDICT_POOR,
  GROUP_SIDE_MIN_GAMES,
  RANK_WATCH,
  RANK_JUMP,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_CHANGE,
  ACTIVITY_MIN_GAMES,
  PAIR_SHARE,
  PAIR_MIN_GAMES,
  MMR_SPREAD_WIDE,
  MMR_SPREAD_MIN_PEOPLE,
  GROUP_SUPPORT_SHARE,
  NEWCOMER_MIN,
  GROUP_STREAK,
  CHAMP_RECORD_LOW,
  CHAMP_RECORD_MIN_GAMES,
  WEEKDAY_MIN_DAYS,
  UPSET_SHARE,
} from "./commentaryRules";

/**
 * 모임 전체의 분석 코멘트: 섞기 공정성·진영·순위 변동·활동·뭉침 등 문장과 모임 코칭.
 * 쓰는 곳: src/web/screens/Graphs.tsx(플레이어를 고르지 않았을 때). 문턱 값은 commentaryRules.ts.
 */

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

/** 편성 균형 문장의 근거: fairnessReport가 센 판정 경기(예상이 reliable)를 팀 평균 MMR 차가 큰 것부터. */
function judgedByGap(expectations: ReadonlyMap<string, MatchExpectation>, scoped: readonly MatchView[]): EvidenceMatch[] {
  return scoped
    .flatMap((match) => {
      const e = expectations.get(match.id);
      return e?.reliable ? [{ matchId: match.id, gap: Math.abs(e.ratingGapA) }] : [];
    })
    .sort((a, b) => b.gap - a.gap)
    .map(({ matchId, gap }) => ({ matchId, note: `MMR 차 ${shownRating(gap)}점` }));
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
      evidence: [{ label: "MMR 차가 큰 경기부터", matches: judgedByGap(input.expectations, scoped) }],
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
          text: `${withJosa(nameOf(newLeader), "이", "가")} 마지막 모임에서 MMR 1위로 올라섰어요(전에는 ${nameOf(oldLeader)}).`,
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
            text: `${withJosa(nameOf(climber.id), "이", "가")} 마지막 모임에서 ${climber.jump}계단 올라 ${climber.now}위예요.`,
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
      text: `${names[0]}·${withJosa(names[1]!, "이", "가")} 자주 같은 팀이에요(함께 나온 ${pair.both}경기 중 ${pair.n}회, ${ratePercent(pair.n, pair.both)}%). 모임 설정 "팀 추천"의 최근 조합 피하기를 켜 두면 더 섞여요.`,
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
      text: `${withJosa(nameOf(supporter.id), "이", "가")} 서폿을 많이 맡아요(자기 경기의 ${Math.round(supporter.share * 100)}%).`,
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
    remarks.push({ text: `${withJosa(nameOf(hot.id), "이", "가")} ${hot.streak}연승 중이에요.`, tone: "good", basis: "사람별 현재 연승" });
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
        text: `${names[0]}·${withJosa(names[1]!, "을", "를")} 가끔 다른 팀으로 나눠 보세요(같은 팀 ${ratePercent(pair.n, pair.both)}%).`,
        tone: "neutral",
        basis: "함께 나온 경기 중 같은 팀 비율",
      });
    }
    if (hot) {
      tips.push({
        text: `${withJosa(nameOf(hot.id), "이", "가")} ${hot.streak}연승 중이에요. 다음 판은 상대 팀에 강한 사람을 넣어 균형을 맞춰 보세요.`,
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
