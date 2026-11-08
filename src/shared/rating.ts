import { countedChronological } from "./insights";
import { PLACEMENT_GAMES } from "./stats";
import type { MatchView } from "./types";

/**
 * 결과 기반 MMR("내전 점수", 2026-11-08). 승률이 반영하지 못하는 "상대가 누구였는지"를 Elo 방식으로 담는다.
 *
 * - 저장하지 않고 기기에서 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관한 순수 로직).
 * - 유효 확정 경기(isCounted)만 쓴다. 결과 대기·진행 중·취소·전적 제외 경기는 건너뛴다.
 * - 범위(오늘·시즌·연도)와 무관하게 모임 전체 누적으로 계산한다(배치와 같은 원칙).
 * - 순서는 경기 시각 → 경기 번호(insights.byPlayedAt). 같은 입력이면 늘 같은 결과다.
 * - 참가자는 명단의 참가자 ID 그대로 센다(personRecords와 같다). 중복 참가자 합치기는 서버가 명단의 ID를
 *   남은 사람으로 옮겨 두므로, 합친 뒤의 스냅숏에서는 합쳐진 사람의 경기가 처음부터 남은 사람의 것으로 계산된다.
 *
 * 규칙: 시작 1000. 팀 MMR = 팀원 MMR 평균. 기대 승률 E = 1 / (1 + 10^((R상대 − R내) / 400)).
 * 변화 Δ = K × (S − E)(S: 이기면 1, 지면 0). K는 사람마다: 이 경기 전 확정 경기 수가 배치 기준(10) 미만이면 40, 그 뒤 20.
 * 같은 팀원은 (S − E)가 같으므로 K가 같은 사람끼리는 변화도 같다. 열 명의 K가 모두 같으면 두 팀 변화의 합은 0이다.
 * 소수는 그대로 저장하고 화면에는 반올림한 정수로 보여준다.
 */

export const RATING_START = 1000;
/** 배치 중(누적 확정 경기 PLACEMENT_GAMES 미만) K. */
export const RATING_K_PLACEMENT = 40;
/** 배치 뒤 K. */
export const RATING_K = 20;
/** 최근 변화 합을 볼 경기 수. */
export const RATING_RECENT_GAMES = 10;

export interface RatingPoint {
  matchId: string;
  before: number;
  after: number;
}

export interface PersonRating {
  participantId: string;
  /** 지금 MMR(소수 포함). */
  rating: number;
  /** 계산에 들어간 확정 경기 수(배치 판수와 같다). */
  games: number;
  /** 지금까지의 최고 MMR. 시작값 1000을 포함한다(지기만 했으면 1000). */
  peak: number;
  /** 최근 10경기(그보다 적으면 그만큼)의 변화 합. */
  delta10: number;
  /** 경기마다의 변화. 오래된 경기부터. */
  history: RatingPoint[];
}

export type RatingTable = Map<string, PersonRating>;

/** 팀 평균 a가 팀 평균 b를 상대로 이길 기대 확률. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** 이 경기 전 확정 경기 수로 정하는 K. */
export function kFactor(gamesBefore: number): number {
  return gamesBefore < PLACEMENT_GAMES ? RATING_K_PLACEMENT : RATING_K;
}

/** 모든 유효 확정 경기로 사람별 MMR을 계산한다. O(경기 수 × 10). */
export function computeRatings(matches: readonly MatchView[]): RatingTable {
  const table: RatingTable = new Map();
  const get = (participantId: string): PersonRating => {
    let person = table.get(participantId);
    if (!person) {
      person = { participantId, rating: RATING_START, games: 0, peak: RATING_START, delta10: 0, history: [] };
      table.set(participantId, person);
    }
    return person;
  };

  for (const match of countedChronological(matches)) {
    const a = match.roster.filter((r) => r.team === "A").map((r) => get(r.participantId));
    const b = match.roster.filter((r) => r.team === "B").map((r) => get(r.participantId));
    // 한쪽 팀이 비어 있는 이상한 경기(이관 자료 등)는 비교할 상대가 없으므로 건너뛴다.
    if (a.length === 0 || b.length === 0) continue;
    const avg = (team: PersonRating[]) => team.reduce((sum, p) => sum + p.rating, 0) / team.length;
    const avgA = avg(a);
    const avgB = avg(b);
    const expectA = expectedScore(avgA, avgB);
    const scoreA = match.winnerTeam === "A" ? 1 : 0;
    // 팀 평균을 먼저 다 구한 뒤 바꾼다(같은 경기 안에서 바뀐 값이 다른 사람 계산에 섞이지 않게).
    const apply = (team: PersonRating[], diff: number) => {
      for (const person of team) {
        const before = person.rating;
        const after = before + kFactor(person.games) * diff;
        person.rating = after;
        person.games += 1;
        if (after > person.peak) person.peak = after;
        person.history.push({ matchId: match.id, before, after });
      }
    };
    apply(a, scoreA - expectA);
    apply(b, 1 - scoreA - (1 - expectA));
  }

  for (const person of table.values()) {
    person.delta10 = person.history
      .slice(-RATING_RECENT_GAMES)
      .reduce((sum, point) => sum + (point.after - point.before), 0);
  }
  return table;
}

/** 사람별 지금 MMR만(랭킹 정렬용). */
export function ratingValues(table: RatingTable): Map<string, number> {
  const values = new Map<string, number>();
  for (const [id, person] of table) values.set(id, person.rating);
  return values;
}

/** 화면에 쓰는 정수 MMR. */
export function shownRating(rating: number): number {
  return Math.round(rating);
}

/** 부호를 붙인 정수 변화: "+12" · "−5" · "0". */
export function signedDelta(delta: number): string {
  const value = Math.round(delta);
  if (value > 0) return `+${value}`;
  if (value < 0) return `−${-value}`;
  return "0";
}

/**
 * MMR 단계(화면 글자용 작은 구분). 색은 쓰지 않는다(승률 색 단계와 겹치지 않게).
 * 반올림한 정수 기준: 1200 이상 · 1100대 · 1000대 · 900대 · 900 미만.
 */
export function ratingBandOf(rating: number): string {
  const value = shownRating(rating);
  if (value >= 1200) return "1200 이상";
  if (value >= 1100) return "1100대";
  if (value >= 1000) return "1000대";
  if (value >= 900) return "900대";
  return "900 미만";
}

export interface RatingTrendPoint {
  /** 몇 번째 경기(1부터). 0은 첫 경기 전(시작값). */
  game: number;
  rating: number;
}

/** MMR 추이. 시작값(0경기째)부터 그리고, 점이 maxPoints보다 많으면 고르게 솎되 마지막 점은 남긴다. */
export function ratingTrend(history: readonly RatingPoint[], maxPoints = 120): RatingTrendPoint[] {
  if (history.length === 0) return [];
  const points: RatingTrendPoint[] = [{ game: 0, rating: history[0]!.before }];
  const step = Math.max(1, Math.ceil(history.length / maxPoints));
  history.forEach((point, i) => {
    const game = i + 1;
    if (game % step === 0 || game === history.length) points.push({ game, rating: point.after });
  });
  return points;
}
