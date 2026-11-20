import { describe, expect, it } from "vitest";
import type { Combo } from "../src/shared/bestCombos";
import type { Draft } from "../src/shared/draft";
import { POSITIONS, type Team } from "../src/shared/types";
import { comboMarks } from "../src/web/screens/prep/comboMarks";

// 팀 짜기 편성판의 콤비 배지(prep/comboMarks.ts): 같은 팀에 함께 선 콤비만, 둘 이상이면 쌍마다 색 번호.
// comboMarks는 초안의 people·slots만 읽어서 그 둘만 채운다. 사람 키는 "k0"~"k9", 참가자 ID는 "p0"~"p9".
// k0~k4가 블루팀(A) 탑~서폿, k5~k9가 레드팀(B) 탑~서폿.

function draftOf(teamOf: (i: number) => Team = (i) => (i < 5 ? "A" : "B")): Draft {
  const people = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, name: `사람${i}`, participantId: `p${i}` }));
  const slots = people.map((p, i) => ({ key: p.key, team: teamOf(i), position: POSITIONS[i % 5]!, locked: false }));
  return { people, slots } as unknown as Draft;
}

/** 서로 꼽은 쌍들 → bestCombos 결과 모양(두 사람 모두에게 같은 값). */
function combosOf(...pairs: [number, number][]): Map<string, Combo> {
  const combos = new Map<string, Combo>();
  for (const [a, b] of pairs) {
    const together = { wins: 9, games: 10 };
    combos.set(`p${a}`, { partnerId: `p${b}`, together, synergy: 20 });
    combos.set(`p${b}`, { partnerId: `p${a}`, together, synergy: 20 });
  }
  return combos;
}

const nameOf = (key: string) => `사람${key.slice(1)}`;

describe("팀 짜기 콤비 배지", () => {
  it("콤비가 한 쌍이면 두 사람에게 같은 설명, 색은 없다", () => {
    const marks = comboMarks(draftOf(), combosOf([0, 3]), nameOf);
    expect([...marks.keys()].sort()).toEqual(["k0", "k3"]);
    expect(marks.get("k0")).toEqual({
      hue: null,
      title: "사람0·사람3의 최고의 콤비 · 같은 팀 10경기 승률 90% · 두 사람 평균보다 +20%p",
    });
    expect(marks.get("k3")).toEqual(marks.get("k0"));
  });

  it("다른 팀에 선 콤비는 표시하지 않고 색 수에도 세지 않는다", () => {
    const marks = comboMarks(draftOf(), combosOf([0, 3], [1, 6]), nameOf);
    expect([...marks.keys()].sort()).toEqual(["k0", "k3"]);
    expect(marks.get("k0")!.hue).toBeNull();
  });

  it("같은 팀에 두 쌍, 상대 팀에 한 쌍이면 쌍마다 다른 색, 같은 쌍은 같은 색(블루팀 위 라인부터 번호)", () => {
    const marks = comboMarks(draftOf(), combosOf([7, 9], [1, 4], [0, 2]), nameOf);
    const hue = (i: number) => marks.get(`k${i}`)!.hue;
    expect([hue(0), hue(2)]).toEqual([1, 1]);
    expect([hue(1), hue(4)]).toEqual([2, 2]);
    expect([hue(7), hue(9)]).toEqual([3, 3]);
    expect(marks.has("k3")).toBe(false);
    expect(marks.get("k7")!.title).toMatch(/^사람7·사람9의 최고의 콤비/);
  });

  it("참가자 ID가 없는 사람(새 이름)은 콤비가 될 수 없다", () => {
    const draft = draftOf();
    draft.people[3] = { ...draft.people[3]!, participantId: null };
    expect(comboMarks(draft, combosOf([0, 3]), nameOf).size).toBe(0);
  });
});
