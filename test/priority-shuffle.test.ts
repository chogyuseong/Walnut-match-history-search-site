import { describe, expect, it } from "vitest";
import {
  addConstraint,
  createDraft,
  isCompleteDraft,
  setDraftSide,
  toggleLock,
  undoDraft,
  violatedConstraints,
  type Draft,
  type DraftPerson,
} from "../src/shared/draft";
import {
  priorityCounts,
  priorityTolerance,
  shuffleTeamsByPriority,
  teamShuffleText,
  type PriorityMap,
} from "../src/shared/priority";
import { recommendTeams } from "../src/shared/recommend";
import type { Team } from "../src/shared/types";

// 우선순위(skillGroup)와 "팀까지 올랜덤"(src/shared/priority.ts).

const now = "2026-11-06T00:00:00.000Z";
const W: [number, number, number, number] = [4, 3, 2, 1];

function people(): DraftPerson[] {
  return Array.from({ length: 10 }, (_, i) => ({ key: `p:id${i}`, name: `참가자${i}`, participantId: `id${i}` }));
}

function base(seed: number): Draft {
  const teamOf: Record<string, Team> = {};
  people().forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
  return createDraft(people(), { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
}

/** 순서대로 id0, id1, … 에 순위를 준다. */
function priorities(values: (number | null)[]): PriorityMap {
  return Object.fromEntries(values.map((v, i) => [`p:id${i}`, v]));
}

const teamOf = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!.team;
const teamKeys = (d: Draft, team: Team) => d.slots.filter((s) => s.team === team).map((s) => s.key).sort();

const LAYOUTS: (number | null)[][] = [
  [1, 1, 2, 2, 2, 3, 3, 4, 4, 4],
  [1, 2, 3, 4, null, null, null, null, null, null],
  [1, 1, 1, 2, 2, 2, 3, 3, 3, 4],
  [1, null, null, null, null, null, null, null, null, null],
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 2],
  [1, 2, 2, 3, 3, 3, 4, 4, 4, 4],
  [4, 4, 4, 4, 4, 4, 4, 4, 4, 1],
];

describe("팀까지 올랜덤: 순위 균형", () => {
  it("여러 배치 × 시드 300개: 10명·5:5·팀 안 포지션 5개, 모든 순위 칸에서 인원 차 ≤ 1", () => {
    for (const layout of LAYOUTS) {
      const map = priorities(layout);
      for (let seed = 1; seed <= 300; seed++) {
        const before = base(seed);
        const { draft } = shuffleTeamsByPriority(before, map, W);
        expect(isCompleteDraft(draft)).toBe(true);
        expect(draft.slots.map((s) => s.key).sort()).toEqual(before.slots.map((s) => s.key).sort());
        for (const c of priorityCounts(draft, map)) expect(Math.abs(c.a - c.b), `${layout} seed ${seed}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("1순위 두 명은 항상 다른 팀이다", () => {
    const map = priorities([1, 1, 2, 2, 3, 3, null, null, 4, 4]);
    let d = base(7);
    for (let i = 0; i < 500; i++) {
      d = shuffleTeamsByPriority(d, map, W).draft;
      expect(teamOf(d, "p:id0")).not.toBe(teamOf(d, "p:id1"));
    }
  });

  it("남는 한 명들이 한 팀에 몰리지 않는다: 1·2·3·4순위 한 명씩 + 미지정 6명이면 1·4순위와 2·3순위가 같은 팀", () => {
    // 미지정 가중치 = 지정된 사람 가중치(4,3,2,1)의 중앙값 2.5. 합 차 최소는 {4,1} vs {3,2}.
    const map = priorities([1, 2, 3, 4, null, null, null, null, null, null]);
    for (let seed = 1; seed <= 200; seed++) {
      const { draft } = shuffleTeamsByPriority(base(seed), map, W);
      expect(teamOf(draft, "p:id0")).toBe(teamOf(draft, "p:id3"));
      expect(teamOf(draft, "p:id1")).toBe(teamOf(draft, "p:id2"));
      expect(teamOf(draft, "p:id0")).not.toBe(teamOf(draft, "p:id1"));
    }
  });

  it("허용 폭은 가장 작은 가중치 간격이다", () => {
    expect(priorityTolerance([4, 3, 2, 1])).toBe(1);
    expect(priorityTolerance([10, 6, 3, 1])).toBe(2);
    expect(priorityTolerance([1, 1, 1, 1])).toBe(0);
  });

  it("후보가 하나로 굳지 않는다: 같은 배치에서 여러 번 누르면 팀 A 구성이 여러 가지로 나온다", () => {
    for (const layout of LAYOUTS) {
      const map = priorities(layout);
      let d = base(3);
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        d = shuffleTeamsByPriority(d, map, W).draft;
        seen.add(teamKeys(d, "A").join(","));
      }
      expect(seen.size, String(layout)).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("팀까지 올랜덤: 지정자 없음 · 조건 · 결정성 · 되돌리기", () => {
  it("우선순위를 정한 사람이 없으면 126개 분할이 모두 후보(완전 무작위 5:5)이고 문구가 다르다", () => {
    const result = shuffleTeamsByPriority(base(5), {}, W);
    expect(result.assigned).toBe(0);
    expect(result.candidates).toBe(126);
    expect(teamShuffleText(result)).toBe("우선순위를 정한 사람이 없어 무작위로 나눴어요.");
  });

  it("알림 문구는 순위별 인원을 적는다", () => {
    const map = priorities([1, 1, 2, 2, 2, null, null, null, null, null]);
    const result = shuffleTeamsByPriority(base(9), map, W);
    const text = teamShuffleText(result);
    expect(text).toMatch(/^1순위 1:1 · 2순위 [12]:[12] · 미지정 [23]:[23](으로|로) 나눴어요\.$/);
    // 받침에 맞는 조사: 마지막 숫자가 3이면 "으로", 2면 "로".
    expect(text.endsWith(":3으로 나눴어요.") || text.endsWith(":2로 나눴어요.")).toBe(true);
  });

  it("같은 팀·다른 팀 조건을 지킬 수 있으면 지킨다", () => {
    const map = priorities([1, 1, 2, 2, 3, 3, 4, 4, null, null]);
    for (let seed = 1; seed <= 200; seed++) {
      let d = base(seed);
      d = addConstraint(d, { kind: "same", a: "p:id0", b: "p:id2" });
      d = addConstraint(d, { kind: "different", a: "p:id4", b: "p:id9" });
      const result = shuffleTeamsByPriority(d, map, W);
      expect(result.constraintsKept).toBe(true);
      expect(violatedConstraints(result.draft)).toEqual([]);
      for (const c of priorityCounts(result.draft, map)) expect(Math.abs(c.a - c.b)).toBeLessThanOrEqual(1);
    }
  });

  it("조건이 순위 균형과 부딪히면 순위 균형을 먼저 지키고 조건을 어겼다고 알린다", () => {
    // 1순위 두 명을 같은 팀으로 묶는 조건은 순위 균형과 함께 지킬 수 없다.
    const map = priorities([1, 1, 2, 2, 3, 3, 4, 4, null, null]);
    for (let seed = 1; seed <= 100; seed++) {
      const d = addConstraint(base(seed), { kind: "same", a: "p:id0", b: "p:id1" });
      const result = shuffleTeamsByPriority(d, map, W);
      expect(result.constraintsKept).toBe(false);
      expect(teamOf(result.draft, "p:id0")).not.toBe(teamOf(result.draft, "p:id1"));
      expect(violatedConstraints(result.draft)).toHaveLength(1);
      // 조건 자체는 지우지 않는다.
      expect(result.draft.constraints).toEqual(d.constraints);
      expect(teamShuffleText(result)).toContain("조건을 모두 지키는 편성이 없어");
    }
  });

  it("같은 시드·같은 입력이면 같은 결과이고, 실행 뒤 시드가 전진한다", () => {
    const map = priorities([1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    const a = shuffleTeamsByPriority(base(11), map, W);
    const b = shuffleTeamsByPriority(base(11), map, W);
    expect(a).toEqual(b);
    expect(a.draft.seed).not.toBe(base(11).seed);
  });

  it("진영·조건은 남기고 추첨 기록은 비우며, 직전 편성으로 정확히 되돌린다", () => {
    const map = priorities([1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    let d = setDraftSide(base(13), "red");
    d = addConstraint(d, { kind: "different", a: "p:id2", b: "p:id3" });
    d = { ...d, draws: { A: { fingerprint: "x", inKey: "p:id0", outKey: "p:id1", fromPosition: "top" } } };
    const { draft } = shuffleTeamsByPriority(d, map, W);
    expect(draft.teamASide).toBe("red");
    expect(draft.constraints).toEqual(d.constraints);
    expect(draft.draws).toEqual({});
    expect(draft.previousSlots).toBe(d.slots);
    expect(undoDraft(draft).slots).toEqual(d.slots);
  });

  it("포지션 고정은 유지하고, 같은 팀에서 겹치면 applyTeams처럼 뒤 사람의 고정을 푼다", () => {
    const map = priorities([1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    for (let seed = 1; seed <= 200; seed++) {
      let d = base(seed);
      // 팀 A와 B의 탑을 둘 다 고정한다. 같은 팀이 되면 하나는 풀려야 한다.
      const tops = d.slots.filter((s) => s.position === "top").map((s) => s.key);
      for (const k of tops) d = toggleLock(d, k);
      const { draft } = shuffleTeamsByPriority(d, map, W);
      const after = tops.map((k) => draft.slots.find((s) => s.key === k)!);
      if (after[0]!.team !== after[1]!.team) {
        expect(after.every((s) => s.locked && s.position === "top")).toBe(true);
      } else {
        expect(after.filter((s) => s.locked)).toHaveLength(1);
        expect(after.find((s) => s.locked)!.position).toBe("top");
      }
    }
  });
});

describe("팀까지 올랜덤: 치우침", () => {
  it("우선순위가 없으면 각 사람이 팀 A에 갈 비율이 50% 근처이고, 두 사람이 같은 팀일 비율은 4/9 근처다", () => {
    const N = 6000;
    const inA = new Array<number>(10).fill(0);
    let together = 0;
    let d = base(21);
    for (let i = 0; i < N; i++) {
      d = shuffleTeamsByPriority(d, {}, W).draft;
      for (let k = 0; k < 10; k++) if (teamOf(d, `p:id${k}`) === "A") inA[k]!++;
      if (teamOf(d, "p:id0") === teamOf(d, "p:id1")) together++;
    }
    for (const n of inA) expect(Math.abs(n / N - 0.5)).toBeLessThan(0.03);
    expect(Math.abs(together / N - 4 / 9)).toBeLessThan(0.03);
  });

  it("순위가 있어도 같은 순위 안에서 누가 어느 팀에 갈지는 고르다", () => {
    // 2순위 세 명(id2·id3·id4): 각자 1순위 id0과 같은 팀일 비율이 같아야 한다.
    const map = priorities([1, 1, 2, 2, 2, 3, 3, 4, 4, 4]);
    const N = 6000;
    const withTop = [0, 0, 0];
    for (let seed = 1; seed <= N; seed++) {
      const { draft } = shuffleTeamsByPriority(base(seed), map, W);
      for (let k = 0; k < 3; k++) if (teamOf(draft, `p:id${k + 2}`) === teamOf(draft, "p:id0")) withTop[k]!++;
    }
    const mean = withTop.reduce((s, n) => s + n, 0) / 3 / N;
    for (const n of withTop) expect(Math.abs(n / N - mean)).toBeLessThan(0.03);
    // 각 사람이 팀 A에 갈 비율도 반반이다(이름표를 시드로 정한다).
    let id0A = 0;
    for (let seed = 1; seed <= N; seed++) if (teamOf(shuffleTeamsByPriority(base(seed), map, W).draft, "p:id0") === "A") id0A++;
    expect(Math.abs(id0A / N - 0.5)).toBeLessThan(0.03);
  });
});

describe("팀 추천 문구도 우선순위로 부른다", () => {
  it("지정자 없음 / 1순위 인원", () => {
    const none = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, skillGroup: null }));
    expect(recommendTeams(none, W, 1)[0]!.reason).toBe("우선순위를 정한 사람이 없어 무작위로 나눴어요.");
    const some = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, skillGroup: (i % 4) + 1 }));
    expect(recommendTeams(some, W, 1)[0]!.reason).toMatch(/^우선순위 합계 차 \d+ · 1순위 \d:\d$/);
  });
});
