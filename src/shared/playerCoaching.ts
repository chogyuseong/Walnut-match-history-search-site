import type { Tally } from "./stats";
import type { Position } from "./types";
import { type Remark, LANE_NAME, withJosa, withRo, rateOf } from "./commentary";
import type { Flow } from "./playerCommentary";
import {
  FEW_GAMES,
  LINE_MIN_GAMES,
  RECENT_GAMES,
  STREAK_NOTE,
  UPSET_LOSS_EXCESS,
  EARLY_GAMES,
  LANE_FOCUS_MIN,
  CHAMP_MIN_GAMES,
  COACHING_MAX,
} from "./commentaryRules";

/**
 * 개인 코칭: 고른 플레이어 코멘트 아래 "다음에 해 볼 것" 줄. playerCommentary.ts가 계산한 판정을 받아 권유만 고른다.
 * 쓰는 곳: 그래프 분석(Graphs.tsx)의 분석 코멘트 카드, playerCommentary를 거쳐서.
 */

/**
 * 개인 코칭. 위에서부터 맞는 것을 차례로 담아 COACHING_MAX개까지 쓴다(앞일수록 지금 가장 손댈 만한 것).
 * 경고(진 다음 판 → 흐름 하락 → 우세 판 놓침 → 맞라인 천적 → 결석) → 라인·시간·챔피언·진영 활용 → 장점 살리기 → 유지.
 * 문장은 "해 보세요"로 권하기만 하고 결과를 장담하지 않는다(수치는 과거 기록일 뿐이다).
 * 자료가 적으면(FEW_GAMES 미만) 다른 권유 없이 그 한 줄만 쓴다.
 */
export function playerCoaching(c: {
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
      text: `${c.laneHard.line}에서 ${withJosa(c.laneHard.name, "을", "를")} 만나면 ${c.laneHard.wins}승 ${c.laneHard.losses}패예요. 맞라인이 되면 무리하지 말고 정글 도움을 요청하거나 라인을 바꿔 보세요.`,
      tone: "warn",
      basis: `맞라인 상대(${LANE_FOCUS_MIN}경기 이상)`,
    });
  } else if (c.rival) {
    tips.push({
      text: `${withJosa(c.rival.name, "을", "를")} 상대로 ${rateOf(c.rival.tally)}%예요(${c.rival.tally.games}경기). 상대 팀에 있으면 어느 라인인지 먼저 보고 맞라인을 피하거나 도움을 받아 보세요.`,
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
      text: `라인을 고를 수 있으면 ${withJosa(strongName, "을", "를")} 먼저 맡아 보세요. ${withJosa(weakName, "은", "는")} 부담이 덜한 판에서 연습해 보세요(${strongName} ${rateOf(c.strong.tally)}% · ${weakName} ${rateOf(c.weak.tally)}%).`,
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
      text: `${withRo(c.champBest.name)} ${c.champBest.tally.games}판 ${rateOf(c.champBest.tally)}%를 이겼어요. 중요한 판에는 ${withJosa(c.champBest.name, "을", "를")} 먼저 꺼내 보세요.`,
      tone: "good",
      basis: `기록한 챔피언(${CHAMP_MIN_GAMES}판 이상)`,
    });
  }
  if (c.champWorst) {
    tips.push({
      text: `${withJosa(c.champWorst.name, "은", "는")} ${c.champWorst.tally.games}판 ${rateOf(c.champWorst.tally)}%예요. 내전에서는 잠시 내려놓고 연습 모드에서 손에 익혀 보세요.`,
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
      text: `${withJosa(c.buddy.name, "과", "와")} 같은 팀일 때 특히 잘 풀려요(시너지 +${c.buddy.synergy}%p). 같은 팀이 되면 합을 맞춰 적극적으로 움직여 보세요.`,
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
