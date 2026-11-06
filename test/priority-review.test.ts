import { describe, expect, it } from "vitest";
import {
  adjustedRate,
  balanceCheck,
  changedSuggestions,
  priorityMismatches,
  suggestPriorities,
} from "../src/shared/priorityReview";
import type { GroupWeights, MatchState, MatchView, ParticipantView, RosterEntry } from "../src/shared/types";

// 티어 자동 제안·티어 점검(src/shared/priorityReview.ts). 순수 계산만.

let no = 0;
function match(teamA: string[], teamB: string[], winner: "A" | "B", state: MatchState = "confirmed"): MatchView {
  no += 1;
  const roster: RosterEntry[] = [
    ...teamA.map((id) => ({ participantId: id, team: "A" as const, position: null })),
    ...teamB.map((id) => ({ participantId: id, team: "B" as const, position: null })),
  ];
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: null,
    state,
    source: "backfill",
    startedAt: null,
    endedAt: null,
    playedAt: `2026-01-01T00:00:${String(no % 60).padStart(2, "0")}.000Z`,
    confirmedAt: null,
    winnerTeam: state === "confirmed" ? winner : null,
    teamASide: null,
    version: 1,
    roster,
  };
}

const person = (id: string, skillGroup: number | null = null, extra: Partial<ParticipantView> = {}): ParticipantView => ({
  id,
  name: `이름${id}`,
  status: "active",
  skillGroup,
  ...extra,
});

/** 사람별 (경기 수, 승 수)를 정확히 맞추는 경기 목록. 상대는 기록이 집계되지 않아도 되는 더미(x)다. */
function recordsOf(spec: Record<string, [number, number]>): MatchView[] {
  const list: MatchView[] = [];
  for (const [id, [games, wins]] of Object.entries(spec)) {
    for (let i = 0; i < games; i++) list.push(match([id], [`x-${id}`], i < wins ? "A" : "B"));
  }
  return list;
}

describe("티어 제안", () => {
  it("보정 승률 = (승 + 5) / (경기 + 10)", () => {
    expect(adjustedRate(10, 10)).toBeCloseTo(0.75);
    expect(adjustedRate(0, 10)).toBeCloseTo(0.25);
    expect(adjustedRate(60, 100)).toBeCloseTo(65 / 110);
    expect(adjustedRate(0, 0)).toBe(0.5);
  });

  it("배치 완료(10경기 이상)만 대상: 9경기는 기록이 적어 제안 없음, 10경기는 대상. 딱 5명이면 제안한다", () => {
    const parts = ["a", "b", "c", "d", "e", "f"].map((id) => person(id));
    const result = suggestPriorities(
      parts,
      recordsOf({ a: [10, 9], b: [10, 7], c: [10, 5], d: [10, 3], e: [10, 1], f: [9, 9] }),
    );
    expect(result.ready).toBe(true);
    expect(result.eligible).toBe(5);
    const f = result.rows.find((r) => r.participantId === "f")!;
    expect(f.status).toBe("few-games");
    expect(f.suggested).toBeNull();
    expect(result.rows.map((r) => [r.participantId, r.suggested])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
      ["f", null],
    ]);
  });

  it("대상이 5명 미만(4명)이면 아무도 제안하지 않는다. 보관·합쳐진 사람·전적 제외 경기는 세지 않는다", () => {
    const parts = [
      person("a"),
      person("b"),
      person("c"),
      person("g"),
      person("d", null, { status: "archived" }),
      person("e", null, { status: "archived", mergedInto: "a" }),
    ];
    const matches = [
      ...recordsOf({ a: [12, 6], b: [12, 6], c: [12, 6], g: [12, 6], d: [12, 6], e: [12, 6] }),
      // f는 확정 9경기 + 전적 제외 3경기 → 9경기라 대상 아님.
      ...recordsOf({ f: [9, 5] }),
      match(["f"], ["y"], "A", "excluded"),
      match(["f"], ["y"], "A", "excluded"),
      match(["f"], ["y"], "A", "canceled"),
    ];
    const result = suggestPriorities([...parts, person("f")], matches);
    expect(result.ready).toBe(false);
    expect(result.eligible).toBe(4);
    expect(result.rows.every((r) => r.suggested === null)).toBe(true);
    expect(result.rows.map((r) => r.participantId).sort()).toEqual(["a", "b", "c", "f", "g"]);
    expect(result.rows.find((r) => r.participantId === "f")!.games).toBe(9);
    expect(changedSuggestions(result)).toEqual([]);
  });

  it("보정: 10전 10승(보정 75%)보다 100전 80승(보정 77%)이 위, 10전 0승(25%)보다 100전 15승(18%)이 아래", () => {
    const parts = ["hot", "vet", "mid", "cold", "weak"].map((id) => person(id));
    const result = suggestPriorities(
      parts,
      recordsOf({ hot: [10, 10], vet: [100, 80], mid: [10, 5], cold: [10, 0], weak: [100, 15] }),
    );
    expect(result.rows.map((r) => r.participantId)).toEqual(["vet", "hot", "mid", "cold", "weak"]);
    expect(result.rows.map((r) => r.suggested)).toEqual([1, 2, 3, 4, 5]);
  });

  it("5등분: i번째는 floor(i×5/n)+1티어(10명이면 2명씩, 7명·12명은 경계대로)", () => {
    const tiersOf = (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, "0")}`);
      const spec = Object.fromEntries(ids.map((id, i) => [id, [20, 19 - i] as [number, number]]));
      return suggestPriorities(ids.map((id) => person(id)), recordsOf(spec)).rows.map((r) => r.suggested);
    };
    expect(tiersOf(10)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    // 7명: 0·0.71·1.43·2.14·2.86·3.57·4.29 → 내림 + 1
    expect(tiersOf(7)).toEqual([1, 1, 2, 3, 3, 4, 5]);
    // 12명: i×5/12 = 0·0.42·0.83·1.25·1.67·2.08·2.5·2.92·3.33·3.75·4.17·4.58
    expect(tiersOf(12)).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5]);
    // 어느 인원이든 1티어와 5티어가 모두 나오고 티어는 줄 순서대로 내려가기만 한다.
    for (let n = 5; n <= 20; n++) {
      const tiers = tiersOf(n) as number[];
      expect(tiers[0]).toBe(1);
      expect(tiers[n - 1]).toBe(5);
      for (let i = 1; i < n; i++) expect(tiers[i]! - tiers[i - 1]!).toBeGreaterThanOrEqual(0);
      expect(new Set(tiers).size).toBe(5);
    }
  });

  it("동점이 티어 경계에 걸리면 앞사람 티어를 함께 받는다(10명, 2·3번째가 동점이면 둘 다 1티어)", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    // p1·p2가 같은 성적(경계: i=1은 1티어, i=2는 원래 2티어).
    const wins = [19, 17, 17, 15, 13, 11, 9, 7, 5, 3];
    const spec = Object.fromEntries(ids.map((id, i) => [id, [20, wins[i]!] as [number, number]]));
    const result = suggestPriorities(ids.map((id) => person(id)), recordsOf(spec));
    expect(result.rows.map((r) => r.suggested)).toEqual([1, 1, 1, 2, 3, 3, 4, 4, 5, 5]);
  });

  it("동점: 보정 승률이 같으면 경기 수 많은 순 → ID 순, 똑같은 성적은 같은 티어. 입력 순서가 달라도 결과가 같다", () => {
    // b·c는 같은 경기·같은 승(완전 동점), d는 경기 수는 적지만 보정 승률이 같다(모두 50%).
    const spec: Record<string, [number, number]> = {
      a: [10, 9],
      c: [20, 10],
      b: [20, 10],
      d: [10, 5], // 보정 승률 50%로 b·c와 같지만 경기가 적어 뒤
      e: [10, 0],
    };
    const parts = ["e", "d", "c", "b", "a"].map((id) => person(id));
    const first = suggestPriorities(parts, recordsOf(spec));
    expect(first.rows.map((r) => r.participantId)).toEqual(["a", "b", "c", "d", "e"]);
    // n=5: 순서 0..4 → 1,2,3,4,5 이지만 b·c·d는 보정 승률이 같아 b의 티어(2)를 함께 받는다.
    expect(first.rows.map((r) => r.suggested)).toEqual([1, 2, 2, 2, 5]);
    const again = suggestPriorities([...parts].reverse(), recordsOf(spec).reverse());
    expect(again).toEqual(first);
  });

  it("달라지는 사람만 바뀜 목록에 든다", () => {
    const parts = [person("a", 1), person("b", 5), person("c", null), person("d", 4), person("e", 5)];
    const result = suggestPriorities(
      parts,
      recordsOf({ a: [10, 9], b: [10, 7], c: [10, 5], d: [10, 3], e: [10, 1] }),
    );
    expect(changedSuggestions(result).map((r) => r.participantId)).toEqual(["b", "c"]);
  });
});

describe("티어 점검", () => {
  const weights: GroupWeights = [5, 4, 3, 2, 1];

  it("합이 높은 팀이 이긴 비율과 합이 같았던 경기 수. 확정 경기만 센다", () => {
    const parts = [person("t1", 1), person("t2", 2), person("u1", 4), person("u2", 4), person("n1"), person("n2")];
    const matches = [
      match(["t1", "t2"], ["u1", "u2"], "A"), // A 합 9 > B 4, A 승
      match(["t1", "t2"], ["u1", "u2"], "A"),
      match(["u1", "u2"], ["t1", "t2"], "A"), // 낮은 팀 승
      match(["t1", "u1"], ["t2", "u2"], "B"), // 7 vs 6 → A가 높고 B 승
      match(["t1", "u2"], ["t2", "u1"], "A"), // 7 vs 6 → A 승
      match(["n1", "u1"], ["n2", "u2"], "A"), // 미지정 = 중앙값 → 같음
      match(["t1", "t2"], ["u1", "u2"], "A", "excluded"),
      match(["t1", "t2"], ["u1", "u2"], "A", "awaiting_result"),
    ];
    const check = balanceCheck(parts, matches, weights);
    expect(check).toEqual({ uneven: 5, higherWon: 3, even: 1, small: false });
  });

  it("5경기 미만이면 자료 적음", () => {
    const parts = [person("t1", 1), person("u1", 4)];
    const check = balanceCheck(parts, [match(["t1"], ["u1"], "A"), match(["t1"], ["u1"], "B")], weights);
    expect(check).toEqual({ uneven: 2, higherWon: 1, even: 0, small: true });
    expect(balanceCheck([person("a"), person("b")], [match(["a"], ["b"], "A")], weights)).toEqual({
      uneven: 0,
      higherWon: 0,
      even: 1,
      small: true,
    });
  });

  it("티어와 성적이 2단계 이상 다른 사람과, 배치 완료인데 아직 안 정한 사람", () => {
    const parts = [person("a", 5), person("b", 3), person("c", 2), person("d", 1), person("e", null), person("f", null)];
    const result = suggestPriorities(
      parts,
      recordsOf({ a: [10, 10], b: [10, 7], c: [10, 4], d: [10, 1], e: [10, 5], f: [3, 3] }),
    );
    // 순서 a b e c d — n=5: floor(i*5/5)+1 = 1,2,3,4,5. b(3→2)는 한 단계 차이라 빠지고 c(2→4)는 딱 두 단계라 든다.
    const list = priorityMismatches(result);
    expect(list.map((m) => [m.kind, m.row.participantId, m.row.current, m.row.suggested])).toEqual([
      ["far", "a", 5, 1],
      ["unset", "e", null, 3],
      ["far", "c", 2, 4],
      ["far", "d", 1, 5],
    ]);
  });
});
