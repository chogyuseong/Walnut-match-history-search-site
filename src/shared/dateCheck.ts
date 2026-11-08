import { FUTURE_TOLERANCE_MS } from "./backfill";
import { DEFAULT_TIME_ZONE, safeTimeZone } from "./stats";

/**
 * 날짜 점검(2026-11-08). 사용자가 날짜·연도를 잘못 넣은 경기를 찾아 알려 준다. 아무것도 바꾸지 않는 순수 계산이다.
 * 저장된 경기(MatchView)와 가져오기 미리보기 줄(시트·기존 사이트) 모두에 쓰려고 입력을 작게 잡는다:
 *   order  : 입력 순서(경기 번호 또는 줄 번호). 날짜가 아니라 이 순서를 "맥락"으로 본다.
 *   at     : 경기 시각(ms). 날짜만 있으면 그 날 정오로 잡는다.
 *   people : 참가자 식별자(ID 또는 이름). 같은 시각 + 같은 열 명이면 중복 입력 가능성이 높다.
 *
 * 찾는 것
 * - future    : 아직 오지 않은 시각(1분 여유).
 * - sameTime  : 시각이 정확히 같은 경기 둘 이상. 열 명까지 같으면 sameRoster.
 * - yearRuns  : 입력 순서는 뒤인데 날짜가 반년 넘게 앞으로 돌아간 자리부터, 돌아가기 전 날짜를 다시 넘기기 전까지의 묶음.
 *               보통 "12월 → 1월에서 해를 안 넘긴" 경우라 연도 +1을 제안한다. 미래 경기 묶음에는 -1을 제안한다.
 */
export interface DateItem {
  key: string;
  order: number;
  at: number;
  people: readonly string[];
}

export interface SameTimeGroup<T> {
  at: number;
  items: T[];
  /** 모든 경기의 참가자 집합이 같다(중복 입력일 가능성). */
  sameRoster: boolean;
}

export interface YearRun<T> {
  items: T[];
  /** 제안하는 연도 이동. +1: 한 해 뒤로, -1: 한 해 앞으로. */
  years: 1 | -1;
  /** 묶음 바로 앞 경기(비교 기준). 미래 묶음은 null. */
  before: T | null;
}

export interface DateFindings<T> {
  future: T[];
  sameTime: SameTimeGroup<T>[];
  yearRuns: YearRun<T>[];
  /** 점검한 경기 수. */
  checked: number;
}

const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1000;

export function dateFindings<T>(
  items: readonly T[],
  pick: (item: T) => DateItem,
  now: number = Date.now(),
): DateFindings<T> {
  const rows = items.map((item) => ({ item, d: pick(item) })).sort((a, b) => a.d.order - b.d.order);

  const future = rows.filter((r) => r.d.at > now + FUTURE_TOLERANCE_MS).map((r) => r.item);

  // 같은 시각
  const byAt = new Map<number, typeof rows>();
  for (const r of rows) {
    const list = byAt.get(r.d.at) ?? [];
    list.push(r);
    byAt.set(r.d.at, list);
  }
  const sameTime: SameTimeGroup<T>[] = [];
  for (const [at, list] of byAt) {
    if (list.length < 2) continue;
    const sets = list.map((r) => [...new Set(r.d.people)].sort().join("\u0000"));
    const sameRoster = sets.every((s) => s === sets[0] && s !== "");
    sameTime.push({ at, items: list.map((r) => r.item), sameRoster });
  }
  sameTime.sort((a, b) => a.at - b.at);

  // 연도 묶음: 반년 넘게 뒤로 돌아간 자리부터, 돌아가기 전 날짜(기준)를 다시 넘기기 전까지.
  const yearRuns: YearRun<T>[] = [];
  const pastRows = rows.filter((r) => r.d.at <= now + FUTURE_TOLERANCE_MS);
  let i = 1;
  while (i < pastRows.length) {
    const prev = pastRows[i - 1]!;
    const cur = pastRows[i]!;
    if (prev.d.at - cur.d.at > HALF_YEAR_MS) {
      const base = prev.d.at;
      const run: T[] = [];
      let j = i;
      while (j < pastRows.length && pastRows[j]!.d.at < base) {
        run.push(pastRows[j]!.item);
        j++;
      }
      yearRuns.push({ items: run, years: 1, before: prev.item });
      i = j;
    } else {
      i++;
    }
  }
  if (future.length > 0) yearRuns.push({ items: future, years: -1, before: null });

  return { future, sameTime, yearRuns, checked: rows.length };
}

/** 그 시각이 timeZone에서 보이는 벽시계 시각을 UTC로 가정한 밀리초(초·밀리초 포함). */
function wallClockMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const floorSecond = Math.floor(ms / 1000) * 1000;
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) + (ms - floorSecond);
}

/**
 * 연도를 옮긴 시각(ISO). 모임 시간대(timeZone)의 날짜·시각을 그대로 두고 해만 옮긴다
 * (2025-02-28T22:00Z는 한국 날짜 2025-03-01이므로 -1년 → 한국 2024-03-01 07:00). 예전에는 UTC 날짜로 옮겨
 * 한국 날짜가 2024-02-29가 되는 것처럼 날짜가 하루 어긋날 수 있었다(2026-11-08).
 * 2월 29일이 없는 해로 가면 2월 28일로 둔다. timeZone을 주지 않으면 기본 시간대(Asia/Seoul).
 */
export function shiftYears(iso: string, years: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const wall = new Date(wallClockMs(ms, timeZone));
  const month = wall.getUTCMonth();
  const day = wall.getUTCDate();
  const year = wall.getUTCFullYear() + years;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  wall.setUTCFullYear(year, month, Math.min(day, last));
  const wanted = wall.getTime();
  // 벽시계 시각 → UTC: 시차를 구해 두 번 맞춘다(zonedTimeToUtc와 같은 방법, 초·밀리초를 지킨다).
  let guess = wanted - (wallClockMs(ms, timeZone) - ms);
  for (let i = 0; i < 2; i++) guess += wanted - wallClockMs(guess, timeZone);
  return new Date(guess).toISOString();
}
