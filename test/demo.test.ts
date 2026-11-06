import { describe, expect, it } from "vitest";
import { buildDemoSnapshot, DEMO_GROUP_NAME } from "../src/shared/demo";
import { personForms, rankAndSearch, trends } from "../src/shared/insights";
import { seasonSummary } from "../src/shared/seasonAwards";
import { seriesScore } from "../src/shared/series";
import { isCounted, matchesInScope, personDetail, personRecords, placements } from "../src/shared/stats";
import { standings, titleBandsOf } from "../src/shared/titles";

// 예시 모임(#/demo)의 합성 데이터(src/shared/demo.ts).

describe("예시 모임 합성 데이터", () => {
  const snapshot = buildDemoSnapshot();
  const nameOf = (id: string) => snapshot.participants.find((p) => p.id === id)?.name ?? "?";

  it("결정적이다: 몇 번을 만들어도 같고, 지금 시각에 따라 바뀌지 않는다", () => {
    expect(JSON.stringify(buildDemoSnapshot())).toBe(JSON.stringify(snapshot));
    // 다른 시드는 다른 결과(시드가 실제로 쓰인다).
    expect(JSON.stringify(buildDemoSnapshot({ seed: 7 }))).not.toBe(JSON.stringify(snapshot));
  });

  it("구성: 수십~백여 경기, 시즌 2개, 메모·시리즈 약간, 조회 응답 모양", () => {
    expect(snapshot.role).toBe("viewer");
    expect(snapshot.group.name).toBe(DEMO_GROUP_NAME);
    expect(snapshot.matches.length).toBeGreaterThanOrEqual(50);
    expect(snapshot.matches.length).toBeLessThanOrEqual(150);
    expect(snapshot.seasons).toHaveLength(2);
    for (const season of snapshot.seasons) {
      expect(matchesInScope(snapshot, { kind: "season", seasonId: season.id }).length).toBeGreaterThan(10);
    }
    const memos = snapshot.matches.filter((m) => m.memo);
    expect(memos.length).toBeGreaterThan(0);
    expect(memos.length).toBeLessThan(snapshot.matches.length / 4);
    expect(snapshot.series?.length ?? 0).toBeGreaterThan(0);
    // 시리즈는 같은 사람들로 이뤄진 판만 묶었다(점수에 다 들어간다).
    for (const s of snapshot.series ?? []) {
      const score = seriesScore(s, snapshot.matches);
      expect(score.games.every((g) => g.status === "counted")).toBe(true);
    }
    // 모든 경기는 확정이고 10명, 팀마다 5명.
    for (const m of snapshot.matches) {
      expect(isCounted(m)).toBe(true);
      expect(m.roster).toHaveLength(10);
      expect(m.roster.filter((r) => r.team === "A")).toHaveLength(5);
    }
    // 경기 번호는 1부터 빠짐없이, 시각은 오래된 것부터.
    expect(snapshot.matches.map((m) => m.matchNo)).toEqual(snapshot.matches.map((_, i) => i + 1));
  });

  it("티어·기피 라인·서포터 보정값을 넣지 않는다", () => {
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("skillGroup");
    expect(text).not.toContain("avoidPositions");
    expect(text).not.toContain("adjustments");
    expect(text).not.toContain("viewToken");
    for (const p of snapshot.participants) {
      expect(Object.keys(p).sort()).toEqual(["id", "name", "status"]);
    }
  });

  it("이름은 사람 이름처럼 보이지 않는 가짜 이름이고 겹치지 않는다", () => {
    const names = snapshot.participants.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    // 흔한 한국 성씨 + 두 글자(실제 사람 이름 꼴)를 쓰지 않는다.
    for (const name of names) expect(name).not.toMatch(/^[김이박최정강조윤장임한오서신권황안송류홍][가-힣]{2}$/);
  });

  it("통계 함수가 오류 없이 계산한다(랭킹·개인·흐름·시즌 요약·칭호)", () => {
    const records = personRecords(snapshot.matches);
    expect(records.size).toBeGreaterThanOrEqual(16);
    const { ranked } = rankAndSearch([...records.values()], placements(snapshot.matches), nameOf, "rate", "");
    expect(ranked[0]!.rank).toBe(1);
    const first = snapshot.participants[0]!;
    const detail = personDetail(snapshot.matches, first.id, nameOf);
    expect(detail).toBeTruthy();
    expect(trends(snapshot.matches, nameOf)).toBeTruthy();
    expect(personForms(snapshot.matches).size).toBeGreaterThan(0);
    expect(standings(snapshot.matches, titleBandsOf(snapshot.group.settings)).size).toBeGreaterThan(0);
    for (const season of snapshot.seasons) {
      const summary = seasonSummary(snapshot, { kind: "season", seasonId: season.id }, nameOf, new Date("2026-11-06T00:00:00Z"));
      expect(summary).toBeTruthy();
    }
    expect(seasonSummary(snapshot, { kind: "year", year: 2026 }, nameOf, new Date("2026-11-06T00:00:00Z"))).toBeTruthy();
  });

  it("측정용으로 경기 수를 정해 만들 수 있다", () => {
    expect(buildDemoSnapshot({ matches: 500 }).matches).toHaveLength(500);
  });
});
