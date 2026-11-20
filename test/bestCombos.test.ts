import { describe, expect, it } from "vitest";
import { bestCombos } from "../src/shared/bestCombos";
import type { MatchView, Position, Team } from "../src/shared/types";

// 열 명(p0~p9)이 모든 경기에 나온다. 묶음 셋:
//   함께: p0·p1이 같은 팀(A = p0~p4)이고 90% 이긴다.
//   p0만: p0이 p2·p3·p4·p9와 A, p1은 B. 반반.
//   p1만: p1이 p2·p3·p4·p5와 A, p0은 B. 반반.
// 그러면 p0의 같은 팀 승률 1위는 p1, p1의 1위는 p0이고(서로 꼽음), p2는 p0을 꼽지만 p0은 p2를 꼽지 않는다.
const LINES: Position[] = ["top", "jungle", "mid", "adc", "support"];

function match(no: number, teamA: number[], teamB: number[], winner: Team): MatchView {
  const playedAt = new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: null,
    state: "confirmed",
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: playedAt,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((i, k) => ({ participantId: `p${i}`, team: "A" as const, position: LINES[k] ?? null })),
      ...teamB.map((i, k) => ({ participantId: `p${i}`, team: "B" as const, position: LINES[k] ?? null })),
    ],
  };
}

const BLOCK = 40;
const nameOf = (id: string) => `사람${id.slice(1).padStart(2, "0")}`;

function cumulativeOf(matches: MatchView[]) {
  const games = new Map<string, { games: number }>();
  for (const m of matches) for (const r of m.roster) games.set(r.participantId, { games: (games.get(r.participantId)?.games ?? 0) + 1 });
  return games;
}

function comboGroup(): MatchView[] {
  const together = Array.from({ length: BLOCK }, (_, i) =>
    match(i + 1, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], i % 10 === 0 ? "B" : "A"),
  );
  const p0Only = Array.from({ length: BLOCK }, (_, i) =>
    match(BLOCK + i + 1, [0, 2, 3, 4, 9], [1, 5, 6, 7, 8], i % 2 === 0 ? "A" : "B"),
  );
  const p1Only = Array.from({ length: BLOCK }, (_, i) =>
    match(2 * BLOCK + i + 1, [1, 2, 3, 4, 5], [0, 6, 7, 8, 9], i % 2 === 0 ? "A" : "B"),
  );
  return [...together, ...p0Only, ...p1Only];
}

describe("최고의 콤비", () => {
  it("서로가 서로의 잘 맞는 동료인 두 사람만 콤비이고, 둘 다 키로 들어 있다", () => {
    const matches = comboGroup();
    const combos = bestCombos(matches, cumulativeOf(matches), nameOf);
    expect([...combos.keys()].sort()).toEqual(["p0", "p1"]);
    expect(combos.get("p0")).toMatchObject({ partnerId: "p1", together: { games: BLOCK, wins: 36 } });
    expect(combos.get("p1")?.partnerId).toBe("p0");
    // 같은 팀 90% − 두 사람 평균 63%(76/120) = +27%p. 두 사람에게 같은 값이다.
    expect(combos.get("p0")?.synergy).toBe(27);
    expect(combos.get("p1")?.synergy).toBe(27);
  });

  it("한쪽만 꼽으면 콤비가 아니다", () => {
    const matches = comboGroup();
    const combos = bestCombos(matches, cumulativeOf(matches), nameOf);
    // p2의 같은 팀 1위는 p0(70%)이지만 p0은 p1을 꼽는다.
    expect(combos.has("p2")).toBe(false);
  });

  it("누적 기준(30경기)을 못 넘으면 셈하지 않는다", () => {
    const matches = comboGroup().slice(0, 29);
    expect(bestCombos(matches, cumulativeOf(matches), nameOf).size).toBe(0);
  });

  it("같은 팀일 때 별 차이가 없으면(우연 범위) 콤비가 아니다", () => {
    // 모두 늘 반반이면 누구와 함께여도 승률이 비슷하다.
    const matches = Array.from({ length: 3 * BLOCK }, (_, i) =>
      match(i + 1, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], i % 2 === 0 ? "A" : "B"),
    );
    expect(bestCombos(matches, cumulativeOf(matches), nameOf).size).toBe(0);
  });
});
