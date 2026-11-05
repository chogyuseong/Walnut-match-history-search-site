import { MAX_NAME_LENGTH, cleanName } from "./names";
import { personRecords, PLACEMENT_GAMES } from "./stats";
import type { MatchView, Settings, TitleBand } from "./types";

/**
 * 칭호(docs/P2 P2-11).
 * - 배치 완료자(누적 10경기 이상)에게만 붙는다.
 * - 누적 승률 구간으로 정하고, 범위(오늘·시즌·연도) 필터로 바뀌지 않는다.
 * - 구간과 이름은 모임 설정이다. 아래 기본 이름은 기존 서비스의 이름을 확인하지 못해 넣은 임시 이름이다.
 */
export const DEFAULT_TITLE_BANDS: readonly TitleBand[] = [
  { minRate: 65, name: "전장의 지배자" },
  { minRate: 55, name: "승리 설계자" },
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
 * 소수 오차를 피하려고 승률을 나누지 않고 곱해서 비교한다.
 * 가장 낮은 경계보다 낮으면 칭호가 없다.
 */
export function titleFor(wins: number, games: number, bands: readonly TitleBand[]): TitleBand | null {
  if (games <= 0) return null;
  const sorted = [...bands].sort((a, b) => b.minRate - a.minRate);
  return sorted.find((band) => wins * 100 >= band.minRate * games) ?? null;
}

/** 한 사람의 누적 기준 상태. 어느 화면에서 보든 이 값 하나를 쓴다(docs/P4 시나리오 35). */
export interface Standing {
  /** 누적 유효 확정 경기 수(배치 판수). */
  games: number;
  wins: number;
  losses: number;
  /** 배치 완료(누적 10경기 이상). */
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
): Map<string, Standing> {
  const result = new Map<string, Standing>();
  for (const [id, record] of personRecords(allMatches)) {
    const done = record.games >= PLACEMENT_GAMES;
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
