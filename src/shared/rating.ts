import { countedChronological } from "./insights";
import { PLACEMENT_GAMES_DEFAULT, PLACEMENT_GAMES_MAX, PLACEMENT_GAMES_MIN, placementGamesOf } from "./stats";
import type { MatchView, Settings } from "./types";

/**
 * MMR("내전 점수"). 랭킹·개인 통계·그래프 분석·두 사람 비교·이변 판정(upset.ts)이 쓴다. 저장하지 않고 기기에서 매번 계산한다.
 *
 * 2026-11-12에 팀 평균 Elo(경기마다 K만큼 오르내림)에서 "전체 기록 일괄 계산"으로 바꿨다. 실제 모임 522경기로 비교하니
 * Elo는 같은 결과라도 경기 순서만 바뀌면 점수가 ±96점 흔들렸고, 홀수·짝수 경기로 따로 낸 점수의 상관(재현성)이 0.59였다.
 * 이 방식은 순서 운 ±50점, 재현성 0.84다(연승 가중·최근 가중 포함). 자세한 비교는 docs/구현현황.md.
 *
 * 모형: 사람마다 실력 θ가 있고, 팀 A가 이길 확률 = 1 / (1 + e^−(A팀 θ 평균 − B팀 θ 평균)).
 * 화면 점수 = 시작값 + θ × 400/ln10. 그래서 점수로 쓰면 Elo와 같은 식 1 / (1 + 10^((상대 − 우리) / 400))이 된다.
 * θ는 지금까지의 확정 경기 결과를 한꺼번에 가장 잘 설명하는 값이다(벌점 붙은 최대우도. Bradley–Terry·농구 RAPM과 같은 원리).
 * 팀원과 상대가 누구였는지를 모든 경기에 걸쳐 동시에 감안하므로, 늘 약한 팀원과 묶이는 사람도 제 실력만큼 올라간다.
 *   - 가상 경기(RATING_PRIOR_GAMES): 모두 평균 팀과 반반 비긴 가상 경기를 안고 시작한다. 몇 판 운 좋게 이긴 사람이 튀지 않는다.
 *   - 최근 가중(RATING_HALF_LIFE): 모임 경기가 그만큼 쌓이면 예전 결과는 절반 무게. 실력이 바뀐 사람이 따라잡는다.
 *     오래 쉬면 결과 무게가 줄어 점수가 시작값 쪽으로 천천히 돌아온다.
 *   - 연승·연패 가중: 같은 결과가 run번째 이어진 경기는 그 사람 몫의 무게에 streakMultiplier(run)를 곱한다(사용자 요청: 역전의 재미).
 *
 * 경기 기록(history): 경기를 하나 넣을 때마다 그 경기의 열 명만 다른 사람을 고정한 채 함께 다시 맞춘다. 그 직전 값이
 * before, 맞춘 값이 after라 한 사람의 기록은 이어진다(다음 경기 before = 이번 after). 경기 전 예상 승률은 before로 구한다.
 * 지금 MMR(rating)은 마지막에 모두를 끝까지 함께 맞춘 값이다. 다른 경기 결과로 예전 상대가 다시 평가된 몫이 들어가
 * 마지막 경기의 after와 다를 수 있다(안 뛴 날에도 점수가 움직이는 이유).
 * 대상·순서: 유효 확정 경기(isCounted)를 경기 시각 → 경기 번호 순(countedChronological). 같은 입력이면 늘 같은 결과다.
 * 참가자는 명단의 참가자 ID 그대로 센다(personRecords와 같다).
 */

/** 시작 MMR 기본값. 모든 점수를 같이 옮길 뿐이라 바꿔도 순위·예상 승률은 그대로이고 보이는 숫자와 티어 이름표만 달라진다. */
export const RATING_START = 1200;
/** 모두가 안고 시작하는 "평균 팀과 반반 비긴" 가상 경기 수. 키우면 점수 폭이 좁아지고 판수 적은 사람이 시작값에 더 오래 머문다. */
export const RATING_PRIOR_GAMES = 20;
/** 최근 가중 반감기(모임 전체 경기 수). 줄이면 한 판 변화가 커져 역전이 쉽지만 운을 더 탄다(100이면 재현성 0.68). */
export const RATING_HALF_LIFE = 200;

/** θ(로지스틱 단위) 1을 화면 점수로. */
const POINTS_PER_LOGIT = 400 / Math.LN10;
/** 반반 경기 한 판이 5대5 한 사람의 θ에 주는 정보 p(1 − p) / 5² (p = 0.5). 가상 경기 n판 = 벌점 n × 이 값. */
const INFO_PER_GAME = 0.25 / 25;
const PRIOR = RATING_PRIOR_GAMES * INFO_PER_GAME;
/**
 * 최근 가중이 이보다 작은 옛 경기는 계산에서 뺀다(반감기 200이면 약 1330경기 전). 오래된 모임도 계산량이 경기 수에 비례하게
 * 묶어 두는 값이라, 낮추면 더 먼 과거까지 보지만 큰 모임에서 느려진다.
 */
const MIN_DECAY = 0.01;
/** 한 사람을 한 번에 움직이는 상한(로지스틱 단위, 약 174점). 표본이 거의 없는 첫 경기에서 뉴턴 걸음이 지나치게 크지 않게. */
const MAX_MOVE = 1;
/**
 * 경기마다 그 경기의 열 명을 함께 맞출 때의 반복 상한과 멈추는 기준. 뉴턴법은 남은 오차가 걸음의 제곱 정도로 줄어,
 * 가장 크게 움직인 사람이 1점 미만이면 남은 오차는 0.01점 안팎이라 거기서 멈춘다.
 */
const MATCH_ITERS_MAX = 4;
const MATCH_TOLERANCE = 1;
/** 마지막에 지금 MMR을 끝까지 맞추는 기준·상한. 순위는 이 값으로 매긴다. */
const FINAL_TOLERANCE = 0.01;
const FINAL_SWEEPS_MAX = 3000;

/** MMR 계산 설정. 화면은 ratingOptionsOf(모임 설정)으로 만들어 넘긴다. 배치 경기 수는 계산에는 쓰지 않고 배치·티어·이변 판정에 쓴다. */
export interface RatingOptions {
  placementGames: number;
  start: number;
}

export const DEFAULT_RATING_OPTIONS: RatingOptions = {
  placementGames: PLACEMENT_GAMES_DEFAULT,
  start: RATING_START,
};

export type RatingSettingKey = "placementGames" | "ratingStart" | "ratingKPlacement" | "ratingK";

/**
 * 서버 검사가 쓰는 이름·범위(정수). K 둘은 Elo 시절 설정이라 계산에 쓰지 않지만, 이미 저장된 설정·백업·열려 있던
 * 옛 화면의 저장이 거절되지 않게 받기만 한다. 설정 화면은 RATING_EDITABLE_KEYS만 보여 준다.
 */
export const RATING_SETTING_RANGES: Record<RatingSettingKey, { label: string; min: number; max: number }> = {
  placementGames: { label: "배치 경기 수", min: PLACEMENT_GAMES_MIN, max: PLACEMENT_GAMES_MAX },
  ratingStart: { label: "MMR 시작 점수", min: 600, max: 3000 },
  ratingKPlacement: { label: "배치 중 변화 폭(K)", min: 1, max: 100 },
  ratingK: { label: "배치 뒤 변화 폭(K)", min: 1, max: 100 },
};

export const RATING_SETTING_KEYS = Object.keys(RATING_SETTING_RANGES) as RatingSettingKey[];
/** 모임 탭 "MMR 설정"에서 고칠 수 있는 칸. */
export const RATING_EDITABLE_KEYS: RatingSettingKey[] = ["placementGames", "ratingStart"];

/** 모임 설정의 MMR 계산값. 저장한 적 없는 항목은 기본값이다. */
export function ratingOptionsOf(settings: Pick<Settings, RatingSettingKey>): RatingOptions {
  return {
    placementGames: placementGamesOf(settings),
    start: settings.ratingStart ?? RATING_START,
  };
}
/** 최근 변화를 볼 경기 수. */
export const RATING_RECENT_GAMES = 10;
/** 가중이 붙기 시작하는 연속 결과 수. 낮추면 짧은 연승·연패에도 점수가 크게 움직인다. */
export const STREAK_K_START = 3;
/** run이 하나 늘 때마다 더하는 배수. 키우면 상한에 더 빨리 닿는다. */
export const STREAK_K_STEP = 0.125;
/** 가중치 상한. 1로 두면 연속성 가중 없음(그때 순서 운이 ±0점으로 사라진다). 키우면 긴 연승·연패의 영향이 커진다. */
export const STREAK_K_MAX = 1.5;

export interface RatingPoint {
  matchId: string;
  /** 이 경기 직전 MMR(그 앞 경기까지로 맞춘 값). 경기 전 예상 승률은 이 값으로 구한다. */
  before: number;
  /** 이 경기를 넣고 다시 맞춘 MMR. */
  after: number;
  /** 이번 결과까지 같은 방향으로 이어진 결과 수(이번 포함, 1부터). */
  run: number;
  /** 이 경기의 이 사람 몫에 곱한 연속성 가중치. */
  multiplier: number;
}

export interface PersonRating {
  participantId: string;
  /** 지금 MMR(소수 포함). */
  rating: number;
  /** 계산에 들어간 확정 경기 수(배치 판수와 같다). */
  games: number;
  /** 지금까지의 최고 MMR(경기 직후 값과 지금 값 중). 시작값을 포함한다. */
  peak: number;
  /** 최근 10경기(그보다 적으면 그만큼) 동안의 변화: 지금 MMR − 그 첫 경기 직전 MMR. 사이의 재평가도 들어간다. */
  delta10: number;
  /** 경기마다의 변화. 오래된 경기부터. */
  history: RatingPoint[];
}

export type RatingTable = Map<string, PersonRating>;

/** 팀 평균 a가 팀 평균 b를 상대로 이길 기대 확률. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** 같은 방향으로 run번째 이어진 결과에 곱할 가중치. */
export function streakMultiplier(run: number, max: number = STREAK_K_MAX): number {
  if (run < STREAK_K_START) return 1;
  return Math.min(max, 1 + (run - 1) * STREAK_K_STEP);
}

// 같은 경기 배열(스냅숏)이면 화면마다 다시 계산하지 않는다. 시작값만 결과를 바꾸므로 시작값으로 나눠 둔다.
// 돌려준 표는 여러 화면이 같이 보므로 고치지 않고 읽기만 한다.
const tableCache = new WeakMap<readonly MatchView[], Map<number, RatingTable>>();

/** 모든 유효 확정 경기로 사람별 MMR을 계산한다. 빠진 설정은 기본값. */
export function computeRatings(matches: readonly MatchView[], options: Partial<RatingOptions> = {}): RatingTable {
  const start = options.start ?? RATING_START;
  let byStart = tableCache.get(matches);
  if (!byStart) tableCache.set(matches, (byStart = new Map()));
  let table = byStart.get(start);
  if (!table) byStart.set(start, (table = fitRatings(matches, start)));
  return table;
}

function fitRatings(matches: readonly MatchView[], start: number): RatingTable {
  // 한쪽 팀이 비어 있는 이상한 경기(이관 자료 등)는 비교할 상대가 없으므로 건너뛴다.
  const timeline = countedChronological(matches).filter(
    (m) => m.roster.some((r) => r.team === "A") && m.roster.some((r) => r.team === "B"),
  );
  const people: string[] = [];
  const indexOf = new Map<string, number>();
  // 경기를 평평한 배열로 편다: 경기 j의 자리는 offsets[j]..offsets[j + 1]. 자리마다 사람 번호·팀 계수(±1/팀 인원)·연속 가중.
  const offsets = new Int32Array(timeline.length + 1);
  const seats = timeline.reduce((n, m) => n + m.roster.length, 0);
  const who = new Int32Array(seats);
  const gameOf = new Int32Array(seats);
  const coef = new Float64Array(seats);
  const streakWeight = new Float64Array(seats);
  const runs = new Int32Array(seats);
  const aWon = new Uint8Array(timeline.length);
  /** 사람별 자리 번호(경기 순). */
  const seatsOf: number[][] = [];
  const streaks = new Map<number, number>(); // 직전까지: 양수 연승 수, 음수 연패 수
  let seat = 0;
  timeline.forEach((match, j) => {
    offsets[j] = seat;
    aWon[j] = match.winnerTeam === "A" ? 1 : 0;
    const sizeA = match.roster.filter((r) => r.team === "A").length;
    const sizeB = match.roster.length - sizeA;
    for (const r of match.roster) {
      let k = indexOf.get(r.participantId);
      if (k === undefined) {
        k = people.length;
        indexOf.set(r.participantId, k);
        people.push(r.participantId);
        seatsOf.push([]);
      }
      const won = (r.team === "A") === (match.winnerTeam === "A");
      const before = streaks.get(k) ?? 0;
      const run = (won ? before > 0 : before < 0) ? Math.abs(before) + 1 : 1;
      streaks.set(k, won ? run : -run);
      who[seat] = k;
      gameOf[seat] = j;
      coef[seat] = r.team === "A" ? 1 / sizeA : -1 / sizeB;
      runs[seat] = run;
      streakWeight[seat] = streakMultiplier(run);
      seatsOf[k]!.push(seat);
      seat += 1;
    }
  });
  offsets[timeline.length] = seat;

  // decay[d] = d경기 전 결과의 최근 가중.
  const decay: number[] = [];
  for (let d = 0; d <= timeline.length; d++) {
    const w = 0.5 ** (d / RATING_HALF_LIFE);
    if (w < MIN_DECAY) break;
    decay.push(w);
  }

  const theta = new Float64Array(people.length);
  /** 경기마다 A팀 θ 평균 − B팀 θ 평균. 한 사람을 움직일 때마다 그 사람 경기만 고쳐 둔다. */
  const lin = new Float64Array(timeline.length);
  // 사람마다 지금 맞추는 구간(오래돼 빠진 경기 뒤 ~ 지금 경기)에 드는 자리의 시작·끝(seatsOf 안 위치).
  const from = new Int32Array(people.length);
  const to = new Int32Array(people.length);

  /** 사람 k의 자리 중 최근 가중 창에서 빠진 옛 경기를 건너뛴다. */
  const dropOld = (k: number, upto: number) => {
    const oldest = upto - decay.length + 1;
    const mine = seatsOf[k]!;
    while (from[k]! < to[k]! && gameOf[mine[from[k]!]!]! < oldest) from[k] = from[k]! + 1;
  };
  /** 사람 k를 move만큼 옮기고 그 사람 경기의 팀 차이(lin)를 고친다. */
  const shift = (k: number, move: number) => {
    theta[k] = theta[k]! + move;
    const mine = seatsOf[k]!;
    for (let i = from[k]!; i < to[k]!; i++) {
      const s = mine[i]!;
      lin[gameOf[s]!] = lin[gameOf[s]!]! + coef[s]! * move;
    }
  };

  /**
   * 모두를 경기 0..upto(최근 가중 창 안)로 한 번 맞춘다. 사람을 한 명씩 차례로, 다른 사람은 고정한 채 그 사람의 식만
   * 뉴턴법으로 푼다(가우스–자이델). 모두를 한꺼번에 움직이면 늘 같이 뛰는 팀원 다섯이 같은 쪽으로 다섯 배 넘게 가서 발산한다.
   * 가장 크게 움직인 사람의 변화를 점수로 돌려준다.
   */
  const sweep = (upto: number): number => {
    let largest = 0;
    for (let k = 0; k < people.length; k++) {
      dropOld(k, upto);
      const mine = seatsOf[k]!;
      let grad = PRIOR * theta[k]!;
      let curv = PRIOR;
      for (let i = from[k]!; i < to[k]!; i++) {
        const s = mine[i]!;
        const j = gameOf[s]!;
        const w = streakWeight[s]! * decay[upto - j]!;
        const p = 1 / (1 + Math.exp(-lin[j]!));
        const c = coef[s]!;
        grad += w * (p - aWon[j]!) * c;
        curv += w * p * (1 - p) * c * c;
      }
      const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, -grad / curv));
      if (move === 0) continue;
      shift(k, move);
      largest = Math.max(largest, Math.abs(move));
    }
    return largest * POINTS_PER_LOGIT;
  };

  /** 이번 경기 묶음 안에서의 순번(사람 번호 → 0..9). 묶음 밖은 −1. */
  const slot = new Int32Array(people.length).fill(-1);
  /**
   * 경기 j를 넣은 뒤 그 경기의 사람들만 함께 맞춘다(다른 사람 고정, 열 명 연립 뉴턴법). 한 명씩 맞추면 같은 기록의
   * 팀원이 맞추는 순서 때문에 몇십 점씩 갈라졌다. 연속 가중이 사람마다 달라 식이 대칭이 아니므로 가우스 소거로 푼다.
   */
  const fitMatch = (j: number) => {
    const members: number[] = [];
    for (let s = offsets[j]!; s < offsets[j + 1]!; s++) {
      slot[who[s]!] = members.length;
      members.push(who[s]!);
    }
    const n = members.length;
    for (let iter = 0; iter < MATCH_ITERS_MAX; iter++) {
      const jac = new Float64Array(n * n);
      const rhs = new Float64Array(n);
      members.forEach((k, row) => {
        dropOld(k, j);
        const mine = seatsOf[k]!;
        let grad = PRIOR * theta[k]!;
        jac[row * n + row] = PRIOR;
        for (let i = from[k]!; i < to[k]!; i++) {
          const s = mine[i]!;
          const g = gameOf[s]!;
          const w = streakWeight[s]! * decay[j - g]!;
          const p = 1 / (1 + Math.exp(-lin[g]!));
          const c = coef[s]!;
          grad += w * (p - aWon[g]!) * c;
          const bend = w * p * (1 - p) * c;
          for (let t = offsets[g]!; t < offsets[g + 1]!; t++) {
            const col = slot[who[t]!]!;
            if (col >= 0) jac[row * n + col] = jac[row * n + col]! + bend * coef[t]!;
          }
        }
        rhs[row] = -grad;
      });
      const moves = solveLinear(jac, rhs, n);
      let largest = 0;
      members.forEach((k, row) => {
        const move = Math.max(-MAX_MOVE, Math.min(MAX_MOVE, moves[row]!));
        shift(k, move);
        largest = Math.max(largest, Math.abs(move));
      });
      if (largest * POINTS_PER_LOGIT < MATCH_TOLERANCE) break;
    }
    for (const k of members) slot[k] = -1;
  };

  const points = (k: number) => start + theta[k]! * POINTS_PER_LOGIT;
  const histories: RatingPoint[][] = people.map(() => []);
  timeline.forEach((match, j) => {
    const before: number[] = [];
    let line = 0;
    for (let s = offsets[j]!; s < offsets[j + 1]!; s++) {
      before.push(points(who[s]!));
      line += coef[s]! * theta[who[s]!]!;
      to[who[s]!] = to[who[s]!]! + 1;
    }
    lin[j] = line;
    fitMatch(j);
    for (let s = offsets[j]!; s < offsets[j + 1]!; s++) {
      histories[who[s]!]!.push({
        matchId: match.id,
        before: before[s - offsets[j]!]!,
        after: points(who[s]!),
        run: runs[s]!,
        multiplier: streakWeight[s]!,
      });
    }
  });
  if (timeline.length > 0) {
    for (let i = 0; i < FINAL_SWEEPS_MAX; i++) if (sweep(timeline.length - 1) < FINAL_TOLERANCE) break;
  }

  const table: RatingTable = new Map();
  people.forEach((participantId, k) => {
    const history = histories[k]!;
    const rating = points(k);
    const recent = history[Math.max(0, history.length - RATING_RECENT_GAMES)]!;
    table.set(participantId, {
      participantId,
      rating,
      games: history.length,
      peak: Math.max(start, rating, ...history.map((p) => p.after)),
      delta10: rating - recent.before,
      history,
    });
  });
  return table;
}

/** n×n 연립방정식 a·x = b(행 우선 배열)를 부분 피벗 가우스 소거로 푼다. a·b는 고쳐 쓴다. 열 명짜리라 따로 빠르게 짤 필요가 없다. */
function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array {
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = r;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c]!;
        a[col * n + c] = a[pivot * n + c]!;
        a[pivot * n + c] = t;
      }
      const t = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / a[col * n + col]!;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c] = a[r * n + c]! - f * a[col * n + c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r]!;
    for (let c = r + 1; c < n; c++) sum -= a[r * n + c]! * x[c]!;
    x[r] = sum / a[r * n + r]!;
  }
  return x;
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
