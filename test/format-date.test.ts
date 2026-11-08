import { afterEach, describe, expect, it, vi } from "vitest";

// 날짜 표기 통일(2026-11-08): 올해는 연도 없이, 올해가 아니면 연도를 붙인다. 기간은 "7월 1일 ~ 8월 31일".
// 화면 코드(src/web/format.ts, DOM 타입을 쓴다)는 서버 타입 검사(tsconfig.json) 밖이라 동적으로 읽는다(rate-heat-titles.test.ts와 같은 방법).
type Fmt = {
  formatDate: (iso: string | null | undefined, timeZone?: string) => string;
  formatRange: (a: string | null | undefined, b: string | null | undefined, timeZone?: string) => string;
};
const path = "../src/web/format";
const { formatDate, formatRange } = (await import(/* @vite-ignore */ path)) as Fmt;

describe("formatDate·formatRange", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("올해는 연도를 쓰지 않고, 다른 해는 연도를 쓴다", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T03:00:00.000Z"));
    expect(formatDate("2026-11-07T09:00:00.000Z")).toBe("11월 7일");
    expect(formatDate("2025-11-07T09:00:00.000Z")).toBe("2025년 11월 7일");
    // 모임 시간대 기준: UTC 12월 31일 16시는 서울로 1월 1일.
    expect(formatDate("2025-12-31T16:00:00.000Z")).toBe("1월 1일");
    // 날짜만 있는 값은 시간대와 상관없이 그 날짜 그대로.
    expect(formatDate("2026-07-01", "America/Los_Angeles")).toBe("7월 1일");
    expect(formatDate(null)).toBe("");
  });

  it("기간: 같은 해면 앞에만(올해가 아니면) 연도, 해가 다르면 양쪽에 연도", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T03:00:00.000Z"));
    expect(formatRange("2026-07-01", "2026-08-31")).toBe("7월 1일 ~ 8월 31일");
    expect(formatRange("2025-07-01", "2025-08-31")).toBe("2025년 7월 1일 ~ 8월 31일");
    expect(formatRange("2025-12-01", "2026-01-31")).toBe("2025년 12월 1일 ~ 2026년 1월 31일");
    expect(formatRange("2026-07-01", "")).toBe("7월 1일 ~");
  });
});
