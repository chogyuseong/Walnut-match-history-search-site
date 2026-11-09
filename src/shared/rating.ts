import { countedChronological } from "./insights";
import { PLACEMENT_GAMES_DEFAULT, PLACEMENT_GAMES_MAX, PLACEMENT_GAMES_MIN, placementGamesOf } from "./stats";
import type { MatchView, Settings } from "./types";

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
 * 규칙: 시작값·K·배치 경기 수는 모임 설정(ratingOptionsOf, 기본 1200 · 50/30 · 10). 팀 MMR = 팀원 MMR 평균. 기대 승률 E = 1 / (1 + 10^((R상대 − R내) / 400)).
 * 변화 Δ = K × (S − E)(S: 이기면 1, 지면 0). K는 사람마다: 이 경기 전 확정 경기 수가 배치 경기 수(모임 설정, 기본 10) 미만이면 배치 중 K, 그 뒤 K.
 * 여기에 연속성 가중(아래)을 곱해 Δ = K × 가중치 × (S − E)가 된다.
 * 같은 팀원은 (S − E)가 같으므로 K와 가중치가 같은 사람끼리는 변화도 같다. 열 명의 K·가중치가 모두 같을 때만
 * 두 팀 변화의 합이 0이고, 사람마다 배치 여부나 연속 기록이 다르면 합이 0이 아니어도 된다.
 * 소수는 그대로 저장하고 화면에는 반올림한 정수로 보여준다.
 *
 * 연속성 가중: "그냥 이긴 것과 연승으로 이긴 것, 그냥 진 것과 연패한 것이 달라야 한다"는 요구로 넣었다.
 * 체스·바둑의 Elo에는 연승 가산이 없다. 대신 Glicko-2가 결과가 한쪽으로 몰리는 사람의 변동성을 키워 점수를 더 크게
 * 움직이는 생각을 단순화해, 직전까지 같은 방향으로 이어진 결과 수(streakBefore)에 이번 결과를 더한 run으로
 * K에 곱할 가중치를 정한다. run이 STREAK_K_START(3) 미만이면 1배, 그 뒤 1 + (run − 1) × STREAK_K_STEP이고 STREAK_K_MAX에서 멈춘다
 * (run 1~5: 1 · 1 · 1.25 · 1.375 · 1.5).
 * 방향이 바뀌면 run은 1로 돌아간다. STREAK_K_MAX를 1로 두면 연속성 가중 없이 예전 Elo와 같다.
 */

/** 시작 MMR 기본값. 모든 점수를 같이 옮길 뿐이라 바꿔도 순위·예상 승률은 그대로이고 보이는 숫자와 티어 이름표만 달라진다. */
export const RATING_START = 1200;
/** 배치 중(누적 확정 경기가 배치 경기 수 미만) K 기본값. 키우면 첫 몇 판으로 제자리를 빨리 찾지만 운도 크게 탄다. */
export const RATING_K_PLACEMENT = 50;
/** 배치 뒤 K 기본값. 키우면 같은 승패에도 사람 사이 점수 차가 더 벌어진다. */
export const RATING_K = 30;

/** MMR 계산 설정. 화면은 ratingOptionsOf(모임 설정)으로 만들어 넘긴다. */
export interface RatingOptions {
  placementGames: number;
  start: number;
  kPlacement: number;
  k: number;
}

export const DEFAULT_RATING_OPTIONS: RatingOptions = {
  placementGames: PLACEMENT_GAMES_DEFAULT,
  start: RATING_START,
  kPlacement: RATING_K_PLACEMENT,
  k: RATING_K,
};

export type RatingSettingKey = "placementGames" | "ratingStart" | "ratingKPlacement" | "ratingK";

/** 설정 화면 칸과 서버 검사가 같이 쓰는 이름·범위(정수). */
export const RATING_SETTING_RANGES: Record<RatingSettingKey, { label: string; min: number; max: number }> = {
  placementGames: { label: "배치 경기 수", min: PLACEMENT_GAMES_MIN, max: PLACEMENT_GAMES_MAX },
  ratingStart: { label: "MMR 시작 점수", min: 600, max: 3000 },
  ratingKPlacement: { label: "배치 중 변화 폭(K)", min: 1, max: 100 },
  ratingK: { label: "배치 뒤 변화 폭(K)", min: 1, max: 100 },
};

export const RATING_SETTING_KEYS = Object.keys(RATING_SETTING_RANGES) as RatingSettingKey[];

/** 모임 설정의 MMR 계산값. 저장한 적 없는 항목은 기본값이다. */
export function ratingOptionsOf(settings: Pick<Settings, RatingSettingKey>): RatingOptions {
  return {
    placementGames: placementGamesOf(settings),
    start: settings.ratingStart ?? RATING_START,
    kPlacement: settings.ratingKPlacement ?? RATING_K_PLACEMENT,
    k: settings.ratingK ?? RATING_K,
  };
}
/** 최근 변화 합을 볼 경기 수. */
export const RATING_RECENT_GAMES = 10;
/** 가중이 붙기 시작하는 연속 결과 수. 낮추면 짧은 연승·연패에도 점수가 크게 움직인다. */
export const STREAK_K_START = 3;
/** run이 하나 늘 때마다 더하는 배수. 키우면 상한에 더 빨리 닿는다. */
export const STREAK_K_STEP = 0.125;
/** 가중치 상한. 1로 두면 연속성 가중 없음. 키우면 긴 연승·연패의 점수 변화가 커지고 예상 승률이 더 출렁인다. */
export const STREAK_K_MAX = 1.5;

export interface RatingPoint {
  matchId: string;
  before: number;
  after: number;
  /** 이번 결과까지 같은 방향으로 이어진 결과 수(이번 포함, 1부터). */
  run: number;
  /** 이 경기에서 K에 곱한 연속성 가중치. */
  multiplier: number;
}

export interface PersonRating {
  participantId: string;
  /** 지금 MMR(소수 포함). */
  rating: number;
  /** 계산에 들어간 확정 경기 수(배치 판수와 같다). */
  games: number;
  /** 지금까지의 최고 MMR. 시작값을 포함한다(지기만 했으면 시작값). */
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
export function kFactor(gamesBefore: number, options: RatingOptions = DEFAULT_RATING_OPTIONS): number {
  return gamesBefore < options.placementGames ? options.kPlacement : options.k;
}

/** 같은 방향으로 run번째 이어진 결과에 곱할 K 가중치. */
export function streakMultiplier(run: number, max: number = STREAK_K_MAX): number {
  if (run < STREAK_K_START) return 1;
  return Math.min(max, 1 + (run - 1) * STREAK_K_STEP);
}

/** 모든 유효 확정 경기로 사람별 MMR을 계산한다. O(경기 수 × 10). 빠진 설정은 기본값. */
export function computeRatings(matches: readonly MatchView[], options: Partial<RatingOptions> = {}): RatingTable {
  const opts: RatingOptions = { ...DEFAULT_RATING_OPTIONS, ...options };
  const table: RatingTable = new Map();
  const get = (participantId: string): PersonRating => {
    let person = table.get(participantId);
    if (!person) {
      person = { participantId, rating: opts.start, games: 0, peak: opts.start, delta10: 0, history: [] };
      table.set(participantId, person);
    }
    return person;
  };

  // 사람별 직전까지의 연속 결과: 양수는 연승 수, 음수는 연패 수, 0은 아직 경기 없음.
  const streaks = new Map<string, number>();

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
    const apply = (team: PersonRating[], won: boolean, diff: number) => {
      for (const person of team) {
        const streakBefore = streaks.get(person.participantId) ?? 0;
        const sameWay = won ? streakBefore > 0 : streakBefore < 0;
        const run = sameWay ? Math.abs(streakBefore) + 1 : 1;
        streaks.set(person.participantId, won ? run : -run);
        const multiplier = streakMultiplier(run);
        const before = person.rating;
        const after = before + kFactor(person.games, opts) * multiplier * diff;
        person.rating = after;
        person.games += 1;
        if (after > person.peak) person.peak = after;
        person.history.push({ matchId: match.id, before, after, run, multiplier });
      }
    };
    apply(a, scoreA === 1, scoreA - expectA);
    apply(b, scoreA === 0, 1 - scoreA - (1 - expectA));
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
 * 반올림한 정수 기준, 시작값 s에서: s+200 이상 · s+100대 · s대 · s−100대 · s−100 미만.
 */
export function ratingBandOf(rating: number, start: number = RATING_START): string {
  const value = shownRating(rating);
  if (value >= start + 200) return `${start + 200} 이상`;
  if (value >= start + 100) return `${start + 100}대`;
  if (value >= start) return `${start}대`;
  if (value >= start - 100) return `${start - 100}대`;
  return `${start - 100} 미만`;
}

export type RatingTierKey = "diamond" | "platinum" | "gold" | "silver" | "bronze";

export interface RatingTier {
  key: RatingTierKey;
  name: string;
  /** 인원 요약 같은 좁은 자리에 쓰는 짧은 이름. */
  short: string;
  /** 이 점수(반올림한 정수) 이상이면 이 티어다. */
  min: number;
}

/**
 * MMR 구간 이름표. 출처: LoL 시즌 2 Elo 구간(시즌 2 종료 기준). 높은 구간부터 본다.
 * 시작값 설정과 무관하게 숫자를 고정한다(사용자 요청: 시즌 2와 "동일하게"). 시작값을 바꾸면 처음 놓이는 티어가 달라진다.
 */
export const RATING_TIERS: readonly RatingTier[] = [
  { key: "diamond", name: "다이아몬드", short: "다이아", min: 2200 },
  { key: "platinum", name: "플래티넘", short: "플래", min: 1900 },
  { key: "gold", name: "골드", short: "골드", min: 1520 },
  { key: "silver", name: "실버", short: "실버", min: 1250 },
  { key: "bronze", name: "브론즈", short: "브론즈", min: -Infinity },
];

/** 티어 이름표 도움말 한 줄. 화면마다 같은 문장을 쓴다. */
export const RATING_TIER_HELP = "MMR 구간 이름은 리그 오브 레전드 시즌 2 Elo 구간을 그대로 따랐어요(1250·1520·1900·2200).";

/** MMR의 티어. 배치 중이면 null(점수가 아직 크게 흔들려 이름을 붙이지 않는다). 보이는 정수로 비교한다. */
export function ratingTierOf(rating: number, placed: boolean): RatingTier | null {
  if (!placed) return null;
  const value = shownRating(rating);
  return RATING_TIERS.find((tier) => value >= tier.min)!;
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
