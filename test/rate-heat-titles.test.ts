import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE_BANDS, titleGrade, titleGradeFor } from "../src/shared/titles";
import type { TitleBand } from "../src/shared/types";

// 승률 색 단계(src/web/format.ts의 rateHeat·heatClass·rateTier)와 칭호 등급 대응(src/shared/titles.ts).

/**
 * 색 단계 함수는 화면 코드(src/web/format.ts, DOM 타입을 쓴다)에 있다. 서버 타입 검사(tsconfig.json)가
 * 화면 파일까지 끌어오지 않도록 실행 시점에 불러오고 필요한 모양만 적는다.
 */
interface FormatModule {
  rateHeat(wins: number, games: number): number | null;
  heatClass(wins: number, games: number): string;
  rateTier(wins: number, games: number): string;
  RATE_HEAT_MIN_GAMES: number;
  RATE_HEAT_HOT: readonly number[];
  RATE_HEAT_COLD: readonly number[];
}
const loadFormat = (): Promise<FormatModule> => {
  const path = "../src/web/format";
  return import(/* @vite-ignore */ path) as Promise<FormatModule>;
};

describe("승률 색 단계", () => {
  it("구간 숫자: 45~55% 기준, 55·60·65·70 / 45·40·35·30, 5경기부터", async () => {
    const f = await loadFormat();
    expect(f.RATE_HEAT_HOT).toEqual([55, 60, 65, 70]);
    expect(f.RATE_HEAT_COLD).toEqual([45, 40, 35, 30]);
    expect(f.RATE_HEAT_MIN_GAMES).toBe(5);
  });

  it("경계와 그 바로 위아래(1000경기로 0.1%p 단위)", async () => {
    const { rateHeat } = await loadFormat();
    const at = (pct: number) => rateHeat(Math.round(pct * 10), 1000);
    // 높은 쪽: 55는 기준, 55 초과부터 붉어진다. 60·65·70은 "이상".
    expect(at(54.9)).toBe(0);
    expect(at(55)).toBe(0);
    expect(at(55.1)).toBe(1);
    expect(at(59.9)).toBe(1);
    expect(at(60)).toBe(2);
    expect(at(64.9)).toBe(2);
    expect(at(65)).toBe(3);
    expect(at(69.9)).toBe(3);
    expect(at(70)).toBe(4);
    expect(at(70.1)).toBe(4);
    expect(at(100)).toBe(4);
    // 낮은 쪽: 45는 기준, 45 미만부터 가라앉는다. 40·35·30은 "이하".
    expect(at(45.1)).toBe(0);
    expect(at(45)).toBe(0);
    expect(at(44.9)).toBe(-1);
    expect(at(40.1)).toBe(-1);
    expect(at(40)).toBe(-2);
    expect(at(35.1)).toBe(-2);
    expect(at(35)).toBe(-3);
    expect(at(30.1)).toBe(-3);
    expect(at(30)).toBe(-4);
    expect(at(29.9)).toBe(-4);
    expect(at(0)).toBe(-4);
    expect(at(50)).toBe(0);
  });

  it("나누어떨어지지 않는 승률도 곱셈으로 정확히 비교한다", async () => {
    const { rateHeat } = await loadFormat();
    expect(rateHeat(7, 10)).toBe(4); // 정확히 70%
    expect(rateHeat(11, 20)).toBe(0); // 정확히 55%
    expect(rateHeat(9, 20)).toBe(0); // 정확히 45%
    expect(rateHeat(3, 10)).toBe(-4); // 정확히 30%
  });

  it("5경기 미만은 색 없음(null, 클래스 없음, 글자는 굵기만)", async () => {
    const { rateHeat, heatClass, rateTier } = await loadFormat();
    for (let games = 0; games < 5; games++) {
      for (let wins = 0; wins <= games; wins++) {
        expect(rateHeat(wins, games)).toBeNull();
        expect(heatClass(wins, games)).toBe("");
        expect(rateTier(wins, games)).toBe("rate");
      }
    }
    expect(rateHeat(5, 5)).toBe(4);
    expect(rateHeat(0, 5)).toBe(-4);
  });

  it("단조성: 같은 경기 수에서 승수가 늘면 단계가 내려가지 않는다", async () => {
    const { rateHeat } = await loadFormat();
    for (const games of [5, 6, 7, 9, 10, 13, 20, 33, 40, 60, 101]) {
      let prev = -Infinity;
      for (let wins = 0; wins <= games; wins++) {
        const heat = rateHeat(wins, games)!;
        expect(heat).toBeGreaterThanOrEqual(prev);
        prev = heat;
      }
    }
  });

  it("클래스 이름: 막대·글자가 같은 이름을 쓴다", async () => {
    const { heatClass, rateTier } = await loadFormat();
    expect(heatClass(8, 10)).toBe("heat-h4");
    expect(heatClass(56, 100)).toBe("heat-h1");
    expect(heatClass(5, 10)).toBe("heat-0");
    expect(heatClass(44, 100)).toBe("heat-l1");
    expect(heatClass(2, 10)).toBe("heat-l4");
    expect(rateTier(8, 10)).toBe("rate heat-h4");
    expect(rateTier(5, 10)).toBe("rate heat-0");
    expect(rateTier(1, 10)).toBe("rate heat-l4");
  });
});

describe("칭호 등급(구간 순서 → 다섯 등급)", () => {
  const grades = (count: number) => Array.from({ length: count }, (_, i) => titleGrade(i, count));

  it("구간 1~8개", () => {
    expect(grades(1)).toEqual([3]);
    expect(grades(2)).toEqual([1, 5]);
    expect(grades(3)).toEqual([1, 3, 5]);
    expect(grades(4)).toEqual([1, 2, 4, 5]);
    expect(grades(5)).toEqual([1, 2, 3, 4, 5]);
    expect(grades(6)).toEqual([1, 2, 3, 3, 4, 5]);
    expect(grades(7)).toEqual([1, 2, 2, 3, 4, 4, 5]);
    expect(grades(8)).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
  });

  it("어느 개수든 맨 위는 가장 높은 등급, 아래로 갈수록 내려가지 않는다", () => {
    for (let count = 1; count <= 8; count++) {
      const g = grades(count) as number[];
      for (let i = 1; i < g.length; i++) expect(g[i]).toBeGreaterThanOrEqual(g[i - 1]!);
      if (count > 1) {
        expect(g[0]).toBe(1);
        expect(g[g.length - 1]).toBe(5);
      }
    }
  });

  it("빈 배열·범위 밖은 등급 없음", () => {
    expect(grades(0)).toEqual([]);
    expect(titleGrade(0, 0)).toBeNull();
    expect(titleGrade(-1, 5)).toBeNull();
    expect(titleGrade(5, 5)).toBeNull();
    expect(titleGrade(0.5, 5)).toBeNull();
    expect(titleGradeFor(7, 10, [])).toBeNull();
  });

  it("누적 승·패로 고른 칭호의 등급(기본 다섯 구간, 이름과 무관)", () => {
    expect(titleGradeFor(13, 20, DEFAULT_TITLE_BANDS)).toBe(1); // 65%
    expect(titleGradeFor(12, 20, DEFAULT_TITLE_BANDS)).toBe(2); // 60%
    expect(titleGradeFor(10, 20, DEFAULT_TITLE_BANDS)).toBe(3); // 50%
    expect(titleGradeFor(8, 20, DEFAULT_TITLE_BANDS)).toBe(4); // 40%
    expect(titleGradeFor(2, 20, DEFAULT_TITLE_BANDS)).toBe(5); // 10%
    expect(titleGradeFor(0, 0, DEFAULT_TITLE_BANDS)).toBeNull();
    // 순서가 섞여 들어와도 높은 경계부터 센다. 이름을 바꿔도 같다.
    const shuffled: TitleBand[] = [
      { minRate: 0, name: "가" },
      { minRate: 60, name: "나" },
      { minRate: 40, name: "다" },
    ];
    expect(titleGradeFor(7, 10, shuffled)).toBe(1);
    expect(titleGradeFor(5, 10, shuffled)).toBe(3);
    expect(titleGradeFor(1, 10, shuffled)).toBe(5);
    // 가장 낮은 경계보다 낮으면 칭호도 등급도 없다.
    expect(titleGradeFor(1, 10, [{ minRate: 50, name: "하나" }])).toBeNull();
    expect(titleGradeFor(5, 10, [{ minRate: 50, name: "하나" }])).toBe(3);
  });
});
