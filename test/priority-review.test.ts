import { describe, expect, it } from "vitest";
import {
  adjustedRate,
  balanceCheck,
  changedSuggestions,
  priorityMismatches,
  suggestPriorities,
} from "../src/shared/priorityReview";
import type { MatchState, MatchView, ParticipantView, RosterEntry } from "../src/shared/types";

// 우선순위 자동 제안·순위 점검(src/shared/priorityReview.ts). 순수 계산만.

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

describe("우선순위 제안", () => {
  it("보정 승률 = (승 + 5) / (경기 + 10)", () => {
    expect(adjustedRate(10, 10)).toBeCloseTo(0.75);
    expect(adjustedRate(0, 10)).toBeCloseTo(0.25);
    expect(adjustedRate(60, 100)).toBeCloseTo(65 / 110);
    expect(adjustedRate(0, 0)).toBe(0.5);
  });

  it("배치 완료(10경기 이상)만 대상: 9경기는 기록이 적어 제안 없음, 10경기는 대상", () => {
    const parts = ["a", "b", "c", "d", "e"].map((id) => person(id));
    const result = suggestPriorities(parts, recordsOf({ a: [10, 9], b: [10, 6], c: [10, 4], d: [10, 1], e: [9, 9] }));
    expect(result.ready).toBe(true);
    expect(result.eligible).toBe(4);
    const e = result.rows.find((r) => r.participantId === "e")!;
    expect(e.status).toBe("few-games");
    expect(e.suggested).toBeNull();
    expect(result.rows.map((r) => [r.participantId, r.suggested])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", null],
    ]);
  });

  it("대상이 4명 미만이면 아무도 제안하지 않는다. 보관·합쳐진 사람·전적 제외 경기는 세지 않는다", () => {
    const parts = [
      person("a"),
      person("b"),
      person("c"),
      person("d", null, { status: "archived" }),
      person("e", null, { status: "archived", mergedInto: "a" }),
    ];
    const matches = [
      ...recordsOf({ a: [12, 6], b: [12, 6], c: [12, 6], d: [12, 6], e: [12, 6] }),
      // f는 확정 9경기 + 전적 제외 3경기 → 9경기라 대상 아님.
      ...recordsOf({ f: [9, 5] }),
      match(["f"], ["y"], "A", "excluded"),
      match(["f"], ["y"], "A", "excluded"),
      match(["f"], ["y"], "A", "canceled"),
    ];
    const result = suggestPriorities([...parts, person("f")], matches);
    expect(result.ready).toBe(false);
    expect(result.eligible).toBe(3);
    expect(result.rows.every((r) => r.suggested === null)).toBe(true);
    expect(result.rows.map((r) => r.participantId).sort()).toEqual(["a", "b", "c", "f"]);
    expect(result.rows.find((r) => r.participantId === "f")!.games).toBe(9);
    expect(changedSuggestions(result)).toEqual([]);
  });

  it("보정: 10전 10승(보정 75%)보다 100전 80승(보정 77%)이 위, 10전 0승(25%)보다 100전 15승(18%)이 아래", () => {
    const parts = ["hot", "vet", "cold", "weak"].map((id) => person(id));
    const result = suggestPriorities(parts, recordsOf({ hot: [10, 10], vet: [100, 80], cold: [10, 0], weak: [100, 15] }));
    expect(result.rows.map((r) => r.participantId)).toEqual(["vet", "hot", "cold", "weak"]);
    expect(result.rows.map((r) => r.suggested)).toEqual([1, 2, 3, 4]);
  });

  it("4등분: i번째는 floor(i×4/n)+1순위(10명이면 3·2·3·2명)", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const spec = Object.fromEntries(ids.map((id, i) => [id, [20, 19 - i] as [number, number]]));
    const result = suggestPriorities(ids.map((id) => person(id)), recordsOf(spec));
    expect(result.rows.map((r) => r.suggested)).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 4, 4]);
  });

  it("동점: 보정 승률이 같으면 경기 수 많은 순 → ID 순, 똑같은 성적은 같은 순위. 입력 순서가 달라도 결과가 같다", () => {
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
    // n=5: 순서 0..4 → 1,1,2,3,4 이지만 b·c·d는 보정 승률이 같아 b의 순위(1)를 함께 받는다.
    expect(first.rows.map((r) => r.suggested)).toEqual([1, 1, 1, 1, 4]);
    const again = suggestPriorities([...parts].reverse(), recordsOf(spec).reverse());
    expect(again).toEqual(first);
  });

  it("달라지는 사람만 바뀜 목록에 든다", () => {
    const parts = [person("a", 1), person("b", 4), person("c", null), person("d", 4)];
    const result = suggestPriorities(parts, recordsOf({ a: [10, 9], b: [10, 6], c: [10, 4], d: [10, 1] }));
    expect(changedSuggestions(result).map((r) => r.participantId)).toEqual(["b", "c"]);
  });
});

describe("순위 점검", () => {
  const weights: [number, number, number, number] = [4, 3, 2, 1];

  it("합이 높은 팀이 이긴 비율과 합이 같았던 경기 수. 확정 경기만 센다", () => {
    const parts = [person("t1", 1), person("t2", 2), person("u1", 4), person("u2", 4), person("n1"), person("n2")];
    const matches = [
      match(["t1", "t2"], ["u1", "u2"], "A"), // A 합 7 > B 2, A 승
      match(["t1", "t2"], ["u1", "u2"], "A"),
      match(["u1", "u2"], ["t1", "t2"], "A"), // 낮은 팀 승
      match(["t1", "u1"], ["t2", "u2"], "B"), // 5 vs 4 → A가 높고 B 승
      match(["t1", "u2"], ["t2", "u1"], "A"), // 5 vs 4 → A 승
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

  it("순위와 성적이 2단계 이상 다른 사람과, 배치 완료인데 아직 안 정한 사람", () => {
    const parts = [person("a", 4), person("b", 2), person("c", 1), person("d", 1), person("e", null), person("f", null)];
    const result = suggestPriorities(
      parts,
      recordsOf({ a: [10, 10], b: [10, 7], c: [10, 4], d: [10, 1], e: [10, 5], f: [3, 3] }),
    );
    // 순서 a(1) b(1) e(2) c(3) d(4) — n=5: floor(i*4/5)+1 = 1,1,2,3,4. b는 한 단계 차이라 빠진다.
    const list = priorityMismatches(result);
    expect(list.map((m) => [m.kind, m.row.participantId, m.row.current, m.row.suggested])).toEqual([
      ["far", "a", 4, 1],
      ["unset", "e", null, 2],
      ["far", "c", 1, 3],
      ["far", "d", 1, 4],
    ]);
  });
});
