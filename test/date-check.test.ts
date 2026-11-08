import { describe, expect, it } from "vitest";
import { dateFindings, shiftYears } from "../src/shared/dateCheck";

// 날짜 점검(src/shared/dateCheck.ts): 입력 순서와 견줘 연도가 밀린 묶음, 같은 시각, 미래 날짜를 찾는다.
const day = (s: string) => Date.parse(s + "T12:00:00.000Z");
type Row = { key: string; order: number; date: string; people?: string[] };
const pick = (r: Row) => ({ key: r.key, order: r.order, at: day(r.date), people: r.people ?? [] });
const NOW = day("2026-11-08");

describe("연도 묶음", () => {
  it("12월 → 1월에서 해를 안 넘긴 묶음을 찾고 +1을 제안한다", () => {
    const rows: Row[] = [
      { key: "a", order: 1, date: "2025-11-20" },
      { key: "b", order: 2, date: "2025-12-27" },
      { key: "c", order: 3, date: "2025-01-03" }, // 2026이어야 함
      { key: "d", order: 4, date: "2025-02-10" },
      { key: "e", order: 5, date: "2026-03-01" }, // 기준(12-27)보다 뒤 → 묶음 끝
    ];
    const f = dateFindings(rows, pick, NOW);
    expect(f.yearRuns).toHaveLength(1);
    expect(f.yearRuns[0]!.items.map((r) => r.key)).toEqual(["c", "d"]);
    expect(f.yearRuns[0]!.years).toBe(1);
    expect(f.yearRuns[0]!.before!.key).toBe("b");
    expect(f.checked).toBe(5);
  });

  it("반년 안의 되돌아감(같은 달 정정 입력)은 묶음이 아니다", () => {
    const rows: Row[] = [
      { key: "a", order: 1, date: "2026-05-01" },
      { key: "b", order: 2, date: "2026-04-20" },
      { key: "c", order: 3, date: "2026-05-03" },
    ];
    expect(dateFindings(rows, pick, NOW).yearRuns).toHaveLength(0);
  });

  it("아직 오지 않은 날짜는 미래 목록과 −1 묶음에 든다", () => {
    const rows: Row[] = [
      { key: "a", order: 1, date: "2026-11-01" },
      { key: "b", order: 2, date: "2026-12-25" },
    ];
    const f = dateFindings(rows, pick, NOW);
    expect(f.future.map((r) => r.key)).toEqual(["b"]);
    expect(f.yearRuns).toHaveLength(1);
    expect(f.yearRuns[0]!.years).toBe(-1);
    expect(f.yearRuns[0]!.before).toBeNull();
  });
});

describe("같은 시각", () => {
  it("시각이 같은 경기를 묶고, 열 명까지 같으면 중복 가능성으로 표시한다", () => {
    const rows: Row[] = [
      { key: "a", order: 1, date: "2026-10-01", people: ["p1", "p2"] },
      { key: "b", order: 2, date: "2026-10-01", people: ["p2", "p1"] },
      { key: "c", order: 3, date: "2026-10-02", people: ["p1", "p3"] },
      { key: "d", order: 4, date: "2026-10-02", people: ["p4", "p5"] },
    ];
    const f = dateFindings(rows, pick, NOW);
    expect(f.sameTime).toHaveLength(2);
    expect(f.sameTime[0]!.items.map((r) => r.key)).toEqual(["a", "b"]);
    expect(f.sameTime[0]!.sameRoster).toBe(true);
    expect(f.sameTime[1]!.sameRoster).toBe(false);
  });
});

describe("연도 옮기기", () => {
  it("한 해 뒤·앞으로, 2월 29일은 28일로", () => {
    expect(shiftYears("2025-01-03T03:00:00.000Z", 1)).toBe("2026-01-03T03:00:00.000Z");
    expect(shiftYears("2026-03-01T15:30:00.000Z", -1)).toBe("2025-03-01T15:30:00.000Z");
    expect(shiftYears("2024-02-29T12:00:00.000Z", 1)).toBe("2025-02-28T12:00:00.000Z");
  });
});
