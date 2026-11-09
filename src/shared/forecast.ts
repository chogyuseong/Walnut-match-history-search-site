import type { Draft } from "./draft";
import { laneMatchups, type LaneMatchup } from "./prepTools";
import { DEFAULT_RATING_OPTIONS, expectedScore, type RatingOptions, type RatingTable } from "./rating";
import { fractionPercent, personRecordsByLine, type Tally } from "./stats";
import { POSITIONS, TEAMS, type MatchView, type Position, type Team } from "./types";

/**
 * 준비 화면 예상 승률 판(2026-11-09 추가). 작성 중인 편성(Draft)으로 블루(팀 A)·레드(팀 B)의 예상 승률과 그 이유(라인별 MMR 우위)를 구한다.
 * 쓰는 곳: src/web/screens/prep/ForecastSection.tsx. 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·DB 무관).
 * 식은 경기 전 예상(upset.ts matchExpectations)과 같다: 팀 MMR = 팀원 지금 MMR 평균, 경기 없는 사람은 시작값(모임 설정),
 * 예상 = expectedScore(Elo). 신뢰 여부도 같은 규칙(열 명 중 배치를 마친 사람이 한 명이라도 있으면 신뢰).
 */

/**
 * 라인 우위 최소 MMR 차(임시값). 두 사람 MMR 차의 절댓값이 이 값 미만이면 "비슷"으로 본다.
 * 25점은 1:1 Elo 기대 승률로 약 53.6%다. 올리면 우위 표시가 드물어지고, 내리면 작은 차이도 우위로 잡힌다.
 */
export const LANE_EDGE_MIN = 25;
/**
 * "팽팽" 기준: 블루 예상 승률(정수 %)이 50%에서 이 값 이내(45~55%, 끝 포함)면 팽팽하다고 쓴다.
 * upset.ts BALANCED_MARGIN과 같은 값이라 그래프 분석의 "균형 경기"와 뜻이 맞는다. 바꾸면 두 화면이 달라진다.
 */
export const EVEN_MARGIN = 0.05;

/** 반반(50%). 한 팀이 비었을 때의 예상, 유리한 팀을 가르는 기준. */
const EVEN_PROB = 0.5;
/** 100%. 레드 % = 100 − 블루 %. */
export const FULL_PERCENT = 100;

/** 요약 문장의 라인 이름. 웹의 POSITION_LABEL과 같다(shared는 web을 import하지 않는다). */
const LANE_NAME: Record<Position, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

export interface ForecastPerson {
  /** 초안 키("p:참가자ID" 또는 "n:이름키"). */
  key: string;
  /** 참가자 연결이 있으면 그 ID, 임시 사람이면 null. */
  participantId: string | null;
  /** 지금 MMR(소수 포함). 연결 없거나 경기가 없으면 시작값. */
  rating: number;
  /** 누적 확정 경기 수(배치 판단). 연결 없으면 0. */
  games: number;
  /** 그 라인에서 뛴 전적(personRecordsByLine). 연결 없으면 0경기. */
  line: Tally;
}

export interface TeamForecast {
  /** 팀원 MMR 평균. 팀원이 없으면 시작값. */
  average: number;
  /** 편성에 들어간 사람 수. */
  size: number;
  /** 참가자 연결은 있지만 누적 경기가 배치 경기 수 미만인 사람 수. */
  placement: number;
  /** 참가자 연결이 없어 시작값으로 친 사람 수. */
  unknown: number;
}

export interface LaneForecast extends LaneMatchup {
  /** 블루(팀 A) 사람. 빈 슬롯이면 null. */
  blue: ForecastPerson | null;
  /** 레드(팀 B) 사람. */
  red: ForecastPerson | null;
  /** 블루 MMR − 레드 MMR. 한쪽이 비었으면 null. */
  edge: number | null;
  /** 우위 팀. |edge| < LANE_EDGE_MIN이거나 한쪽이 비었으면 null. */
  edgeTeam: Team | null;
}

export interface DraftForecast {
  teams: Record<Team, TeamForecast>;
  /** 팀 A(블루)가 이길 예상 확률(0~1). 한 팀이 비었으면 0.5. */
  expectedA: number;
  /** 편성된 사람 중 배치를 마친 사람이 한 명이라도 있으면 true(upset.ts와 같은 규칙). */
  reliable: boolean;
  /** 탑~서폿 순서의 다섯 줄. */
  lanes: LaneForecast[];
  /** 팀별 MMR 우위 라인(탑→서폿 순서). 요약 문장의 재료. */
  reasons: Record<Team, Position[]>;
}

/**
 * ratings는 computeRatings(snapshot.matches) 그대로(모임 전체 누적) 넘긴다. matches를 시즌 등으로 좁혀 넣으면
 * 라인 전적과 맞대결만 좁아지고 MMR은 그대로라 두 숫자의 기준이 어긋난다.
 */
export function draftForecast(
  draft: Draft,
  ratings: RatingTable,
  matches: readonly MatchView[],
  options: Partial<RatingOptions> = {},
): DraftForecast {
  const { placementGames, start } = { ...DEFAULT_RATING_OPTIONS, ...options };
  const idOf = new Map(draft.people.map((p) => [p.key, p.participantId]));
  const lineRecords = new Map(POSITIONS.map((pos) => [pos, personRecordsByLine(matches, pos)]));

  const personOf = (key: string, position: Position): ForecastPerson => {
    const participantId = idOf.get(key) ?? null;
    const rated = participantId ? ratings.get(participantId) : undefined;
    const record = participantId ? lineRecords.get(position)!.get(participantId) : undefined;
    return {
      key,
      participantId,
      rating: rated?.rating ?? start,
      games: rated?.games ?? 0,
      line: { games: record?.games ?? 0, wins: record?.wins ?? 0 },
    };
  };

  // 빈 슬롯은 평균에서 빠진다(0이나 시작값으로 채우지 않는다). 아홉 명일 때도 남은 사람끼리 비교하는 편이 덜 엉뚱하다.
  const teams = {} as Record<Team, TeamForecast>;
  let reliable = false;
  for (const team of TEAMS) {
    const members = draft.slots.filter((s) => s.team === team).map((s) => personOf(s.key, s.position));
    const ratingSum = members.reduce((acc, m) => acc + m.rating, 0);
    if (members.some((m) => m.games >= placementGames)) reliable = true;
    teams[team] = {
      average: members.length > 0 ? ratingSum / members.length : start,
      size: members.length,
      placement: members.filter((m) => m.participantId !== null && m.games < placementGames).length,
      unknown: members.filter((m) => m.participantId === null).length,
    };
  }
  const bothFilled = teams.A.size > 0 && teams.B.size > 0;
  const expectedA = bothFilled ? expectedScore(teams.A.average, teams.B.average) : EVEN_PROB;

  const reasons: Record<Team, Position[]> = { A: [], B: [] };
  const lanes = laneMatchups(draft, matches).map((matchup): LaneForecast => {
    const blue = matchup.leftKey ? personOf(matchup.leftKey, matchup.position) : null;
    const red = matchup.rightKey ? personOf(matchup.rightKey, matchup.position) : null;
    const edge = blue && red ? blue.rating - red.rating : null;
    const edgeTeam = edge === null || Math.abs(edge) < LANE_EDGE_MIN ? null : edge > 0 ? "A" : "B";
    if (edgeTeam) reasons[edgeTeam].push(matchup.position);
    return { ...matchup, blue, red, edge, edgeTeam };
  });

  return { teams, expectedA, reliable: reliable && bothFilled, lanes, reasons };
}

/** 레드 쪽은 따로 반올림하지 않고 FULL_PERCENT − 이 값으로 쓴다. 따로 반올림하면 합이 99나 101이 될 수 있다. */
export function forecastBluePercent(forecast: Pick<DraftForecast, "expectedA">): number {
  return fractionPercent(forecast.expectedA);
}

/** 소수가 아니라 화면에 보이는 정수 %로 판정한다. 그래야 "팽팽해요(56%)" 같은 문장이 나오지 않는다. */
export function isEvenForecast(forecast: Pick<DraftForecast, "expectedA">): boolean {
  return Math.abs(forecastBluePercent(forecast) - fractionPercent(EVEN_PROB)) <= fractionPercent(EVEN_MARGIN);
}

export function favoriteOf(forecast: Pick<DraftForecast, "expectedA">): Team | null {
  if (isEvenForecast(forecast)) return null;
  return forecast.expectedA > EVEN_PROB ? "A" : "B";
}

/**
 * 예: "블루팀이 유리해요(58%) · 미드·원딜 MMR 우위, 레드팀은 정글 우위".
 * 조사 "이/은"을 고정으로 붙였다. 팀 이름이 "팀"으로 끝나지 않게 바뀌면 josa()로 바꿔야 한다.
 */
export function forecastSummaryText(forecast: DraftForecast, teamNames: readonly [string, string]): string {
  if (!forecast.reliable) return "아직 MMR이 쌓이지 않아 예상이 정확하지 않아요";
  const blue = forecastBluePercent(forecast);
  const fav = favoriteOf(forecast);
  if (fav === null) return `팽팽해요(${Math.max(blue, FULL_PERCENT - blue)}%)`;
  const other: Team = fav === "A" ? "B" : "A";
  const nameOf = (t: Team) => (t === "A" ? teamNames[0] : teamNames[1]);
  const laneNames = (positions: Position[]) => positions.map((p) => LANE_NAME[p]).join("·");
  const verdict = `${nameOf(fav)}이 유리해요(${fav === "A" ? blue : FULL_PERCENT - blue}%)`;
  const edgeNotes: string[] = [];
  if (forecast.reasons[fav].length > 0) edgeNotes.push(`${laneNames(forecast.reasons[fav])} MMR 우위`);
  if (forecast.reasons[other].length > 0) edgeNotes.push(`${nameOf(other)}은 ${laneNames(forecast.reasons[other])} 우위`);
  return edgeNotes.length > 0 ? `${verdict} · ${edgeNotes.join(", ")}` : verdict;
}
