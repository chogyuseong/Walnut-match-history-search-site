import { MAX_NAME_LENGTH, cleanName } from "./names";
import { personRecords, PLACEMENT_GAMES_DEFAULT, ratePercent } from "./stats";
import type { MatchView, Settings, TitleBand } from "./types";

/**
 * 칭호(docs/P2 P2-11).
 * - 배치 완료자(누적 경기가 배치 경기 수 이상, 모임 설정·기본 10)에게만 붙는다.
 * - 누적 승률 구간으로 정하고, 범위(오늘·시즌·연도) 필터로 바뀌지 않는다.
 * - 구간과 이름은 모임 설정이다. 아래 기본 이름은 기존 서비스의 이름을 확인하지 못해 넣은 임시 이름이다.
 */
export const DEFAULT_TITLE_BANDS: readonly TitleBand[] = [
  { minRate: 65, name: "전장의 지배자" },
  { minRate: 55, name: "승리 설계자" },
  // 50~55% 구간(2026-11-06 사용자 요청으로 추가). "든든한 전우"는 45~50%로 좁혔다.
  { minRate: 50, name: "떠오르는 강자" },
  { minRate: 45, name: "든든한 전우" },
  { minRate: 35, name: "끈질긴 전사" },
  { minRate: 0, name: "불굴의 개척자" },
];

export const MAX_TITLE_BANDS = 8;
export const MAX_TITLE_NAME_LENGTH = 12;

/** 설정에서 칭호 구간을 꺼낸다. 한 번도 저장하지 않았으면 기본값, 빈 배열로 저장했으면 빈 배열이다. */
export function titleBandsOf(settings: Pick<Settings, "titleBands">): readonly TitleBand[] {
  return settings.titleBands === undefined ? DEFAULT_TITLE_BANDS : settings.titleBands;
}

/**
 * 칭호 구간 값을 검사하고 높은 구간부터 정렬해 돌려준다. 틀리면 이유를 돌려준다.
 * 서버 저장과 화면 입력이 같은 규칙을 쓴다.
 */
export function parseTitleBands(
  value: unknown,
): { ok: true; bands: TitleBand[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length > MAX_TITLE_BANDS) {
    return { ok: false, message: `칭호는 0~${MAX_TITLE_BANDS}개까지 정할 수 있습니다.` };
  }
  const bands: TitleBand[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return { ok: false, message: "칭호 형식이 올바르지 않습니다." };
    }
    const entry = raw as Record<string, unknown>;
    if (Object.keys(entry).some((k) => k !== "minRate" && k !== "name")) {
      return { ok: false, message: "칭호 형식이 올바르지 않습니다." };
    }
    const { minRate } = entry;
    if (typeof minRate !== "number" || !Number.isInteger(minRate) || minRate < 0 || minRate > 100) {
      return { ok: false, message: "칭호 경계는 0~100 사이의 정수(%)여야 합니다." };
    }
    if (typeof entry.name !== "string") {
      return { ok: false, message: "칭호 이름이 올바르지 않습니다." };
    }
    const name = cleanName(entry.name);
    const length = [...name].length;
    if (length === 0 || length > Math.min(MAX_TITLE_NAME_LENGTH, MAX_NAME_LENGTH)) {
      return { ok: false, message: `칭호 이름은 1~${MAX_TITLE_NAME_LENGTH}자여야 합니다.` };
    }
    bands.push({ minRate, name });
  }
  bands.sort((a, b) => b.minRate - a.minRate);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i]!.minRate === bands[i - 1]!.minRate) {
      return { ok: false, message: "같은 경계를 가진 칭호가 두 개 있습니다." };
    }
  }
  return { ok: true, bands };
}

/**
 * 누적 승·패로 칭호를 고른다. 경계는 "이상"이다(정확히 65%면 65% 이상 구간).
 * 화면에 보이는 정수 승률(ratePercent, 0.5%는 올림)로 비교한다: "65%"로 보이는 64.5%는 65% 이상 구간이다
 * (2026-11-08. 예전에는 정확한 분수로 비교해 "65%"로 보이는데 아래 구간 칭호가 붙을 수 있었다).
 * 가장 낮은 경계보다 낮으면 칭호가 없다.
 */
export function titleFor(wins: number, games: number, bands: readonly TitleBand[]): TitleBand | null {
  if (games <= 0) return null;
  const sorted = [...bands].sort((a, b) => b.minRate - a.minRate);
  const pct = ratePercent(wins, games);
  return sorted.find((band) => pct >= band.minRate) ?? null;
}

/** 한 사람의 누적 기준 상태. 어느 화면에서 보든 이 값 하나를 쓴다(docs/P4 시나리오 35). */
export interface Standing {
  /** 누적 유효 확정 경기 수(배치 판수). */
  games: number;
  wins: number;
  losses: number;
  /** 배치 완료(누적 경기가 배치 경기 수 이상). */
  done: boolean;
  /** 배치 완료자만 칭호가 있다. */
  title: string | null;
}

/**
 * 모든 사람의 누적 기준 배치·칭호. 범위가 적용되지 않은 모임 전체 경기를 넘겨야 한다.
 * 대기·취소·제외 경기는 세지 않으므로 제외하면 9/10으로 돌아가고 칭호가 사라진다.
 */
export function standings(
  allMatches: readonly MatchView[],
  bands: readonly TitleBand[],
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): Map<string, Standing> {
  const result = new Map<string, Standing>();
  for (const [id, record] of personRecords(allMatches)) {
    const done = record.games >= placementGames;
    result.set(id, {
      games: record.games,
      wins: record.wins,
      losses: record.losses,
      done,
      title: done ? (titleFor(record.wins, record.games, bands)?.name ?? null) : null,
    });
  }
  return result;
}

/** 칭호 구간을 사람이 읽는 범위 글로 바꾼다. 예: "55% 이상 65% 미만". */
export function bandRangeText(bands: readonly TitleBand[], index: number): string {
  const sorted = [...bands].sort((a, b) => b.minRate - a.minRate);
  const band = sorted[index];
  if (!band) return "";
  const upper = index > 0 ? sorted[index - 1]!.minRate : null;
  if (band.minRate === 0 && upper !== null) return `${upper}% 미만`;
  if (upper === null) return `${band.minRate}% 이상`;
  return `${band.minRate}% 이상 ${upper}% 미만`;
}

/**
 * 칭호 등급(색·엠블럼). 1이 가장 높은 구간(최상), TITLE_GRADE_COUNT(8)가 가장 낮은 구간이다.
 * 이름이 아니라 구간의 순서로 정하므로 운영자가 이름·경계·구간 수를 바꿔도 동작한다.
 *
 * 구조(바꾸기 쉽게 세 층으로 나눈다):
 *   자료(TitleBand: 이름·경계) → 등급(titleGrade: 순수 함수, 숫자 1~8) → 보이는 것(web: CSS 토큰 --title-N, 엠블럼 표 TITLE_EMBLEMS)
 * 화면은 등급 번호만 안다. 나중에 Riot API 티어 같은 바깥 자료로 칭호를 정하게 되더라도
 * "바깥 티어 → TitleGrade" 함수 하나를 여기에 더하면 되고, 화면·CSS·엠블럼은 그대로 쓴다.
 * 등급 수를 바꾸려면 TITLE_GRADE_COUNT·TitleGrade·CSS 토큰(--title-1~N과 .grade-N 규칙, 테마마다)·엠블럼 표를 함께 바꾼다
 * (단위 테스트 rate-heat-titles.test.ts가 개수와 "구간마다 다른 등급"을, theme-contrast.test.ts가 색 대비·밝기 순서를 확인한다).
 */
export const TITLE_GRADE_COUNT = 8;
export type TitleGrade = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const TITLE_GRADES: readonly TitleGrade[] = [1, 2, 3, 4, 5, 6, 7, 8];

/**
 * 위에서 index번째(0부터) 구간의 등급. 구간 count개를 여덟 등급에 고르게 벌려 놓는다:
 * 1개면 가운데(4), 2개 이상이면 맨 위는 1·맨 아래는 8이고 그 사이는 비율대로 반올림한다.
 * count ≤ MAX_TITLE_BANDS(8)이면 이웃 구간의 값 차가 1 이상이라 **구간마다 등급(색)이 모두 다르다**
 * (예전 다섯 등급 때는 기본 6구간의 가운데 둘이 같은 색이었다. 2026-11-08).
 * 예: 2개 → 1·8, 3개 → 1·5·8, 4개 → 1·3·6·8, 5개 → 1·3·5·6·8, 6개 → 1·2·4·5·7·8, 7개 → 1·2·3·5·6·7·8, 8개 → 1~8.
 */
export function titleGrade(index: number, count: number): TitleGrade | null {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count <= 0 || index < 0 || index >= count) {
    return null;
  }
  if (count === 1) return 4;
  return (1 + Math.round((index * (TITLE_GRADE_COUNT - 1)) / (count - 1))) as TitleGrade;
}

/** 누적 승·패로 칭호의 등급을 고른다. 칭호가 없으면 null. */
export function titleGradeFor(wins: number, games: number, bands: readonly TitleBand[]): TitleGrade | null {
  const band = titleFor(wins, games, bands);
  if (!band) return null;
  const sorted = [...bands].sort((a, b) => b.minRate - a.minRate);
  return titleGrade(sorted.indexOf(band), sorted.length);
}
