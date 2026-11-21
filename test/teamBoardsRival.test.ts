import { describe, expect, it } from "vitest";
import type { Draft } from "../src/shared/draft";
import type { LaneRival } from "../src/shared/headToHead";
import { POSITIONS, type MatchView, type Position } from "../src/shared/types";
import { hardestLaneRivals, rivalMarks } from "../src/web/screens/prep/rivalMarks";

// 팀 짜기 편성판의 "어려운 상대" 배지(prep/rivalMarks.ts). 사람 키 "k0"~"k9", 참가자 ID "p0"~"p9".
// k0~k4가 블루팀(A) 탑~서폿, k5~k9가 레드팀(B) 탑~서폿이라 k0과 k5가 탑 맞라인이다.

function draftOf(): Draft {
  const people = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, name: `사람${i}`, participantId: `p${i}` }));
  const slots = people.map((p, i) => ({ key: p.key, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5]!, locked: false }));
  return { people, slots } as unknown as Draft;
}

function rival(position: Position, opponentId: string, wins: number, losses: number): LaneRival {
  return { position, opponentId, games: wins + losses, wins, losses };
}

/** 확정 경기 하나: a가 블루 탑, b가 레드 탑, aWon이면 블루 승. 나머지 자리는 비워 둔다(맞라인 셈에 쓰이지 않는다). */
function topDuel(a: string, b: string, aWon: boolean): MatchView {
  return {
    state: "confirmed",
    winnerTeam: aWon ? "A" : "B",
    roster: [
      { participantId: a, team: "A", position: "top" },
      { participantId: b, team: "B", position: "top" },
    ],
  } as unknown as MatchView;
}

describe("팀 짜기 어려운 상대 배지", () => {
  it("맞은편 같은 라인 사람이 그 라인의 가장 어려운 상대일 때만 붙는다", () => {
    const hardest = new Map([
      ["p0", new Map([["top" as Position, rival("top", "p5", 1, 3)]])],
      // p1의 정글 천적은 p9인데 지금 맞은편은 p6이라 붙지 않는다.
      ["p1", new Map([["jungle" as Position, rival("jungle", "p9", 0, 3)]])],
      // p2가 원딜에서 p7에게 약해도 지금은 미드에 서 있어 붙지 않는다.
      ["p2", new Map([["adc" as Position, rival("adc", "p7", 0, 4)]])],
    ]);
    // 배지는 강한 쪽(맞은편 k5)에 붙는다.
    const marks = rivalMarks(draftOf(), hardest);
    expect([...marks.keys()]).toEqual(["k5"]);
    expect(marks.get("k5")).toEqual({ weakerKey: "k0", rival: rival("top", "p5", 1, 3) });
  });

  it("경기 기록에서 지는 쪽만 고르고, 배치 중인 상대는 뺀다", () => {
    const matches = [topDuel("p0", "p5", false), topDuel("p0", "p5", false), topDuel("p0", "p5", true)];
    const done = new Map([
      ["p0", { done: true }],
      ["p5", { done: true }],
    ]);
    const hardest = hardestLaneRivals(matches, ["p0", "p5"], done);
    expect(hardest.get("p0")?.get("top")).toEqual(rival("top", "p5", 1, 2));
    expect(hardest.has("p5")).toBe(false);
    expect([...rivalMarks(draftOf(), hardest).keys()]).toEqual(["k5"]);

    const placing = new Map([["p0", { done: true }], ["p5", { done: false }]]);
    expect(hardestLaneRivals(matches, ["p0"], placing).size).toBe(0);
  });

  it("세 경기보다 적게 만났으면 붙지 않는다", () => {
    const matches = [topDuel("p0", "p5", false), topDuel("p0", "p5", false)];
    const done = new Map([["p5", { done: true }]]);
    expect(hardestLaneRivals(matches, ["p0"], done).size).toBe(0);
  });
});
