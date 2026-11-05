import { describe, expect, it } from "vitest";
import {
  addConstraint,
  applyTeams,
  createDraft,
  draftFromMatch,
  isCompleteDraft,
  parseStoredDraft,
  removeConstraint,
  replacePerson,
  rerollPositions,
  swapPeople,
  toggleLock,
  undoDraft,
  violatedConstraints,
  type Draft,
  type DraftPerson,
} from "../src/shared/draft";
import { parseNameList } from "../src/shared/names";
import { recommendTeams, type RecommendPerson } from "../src/shared/recommend";
import {
  drawCandidates,
  drawStatus,
  drawSupport,
  repeatSupporterIds,
  supporterKey,
  type RotationContext,
} from "../src/shared/rotation";
import { personRecords, placements, PLACEMENT_GAMES } from "../src/shared/stats";
import {
  sideOfTeam,
  teamASideFromWinner,
  type MatchView,
  type Position,
  type Team,
} from "../src/shared/types";

// 괄호 안 번호는 docs/P4 P4-5의 검증 시나리오 번호다.

const now = "2026-11-05T00:00:00.000Z";

function people(n = 10): DraftPerson[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `p:id${i}`,
    name: `참가자${i}`,
    participantId: `id${i}`,
  }));
}

/** id0~4는 팀 A, id5~9는 팀 B인 초안. */
function fixedDraft(seed = 7): Draft {
  const teamOf: Record<string, Team> = {};
  people().forEach((p, i) => {
    teamOf[p.key] = i < 5 ? "A" : "B";
  });
  return createDraft(people(), { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
}

function ctx(used: string[] = [], eventCount = used.length, cycleId = "c1"): RotationContext {
  return { enabled: true, cycleId, usedIds: new Set(used), eventCount };
}

function positionOf(draft: Draft, key: string): Position {
  return draft.slots.find((s) => s.key === key)!.position;
}

describe("이름 입력", () => {
  it("줄바꿈·탭·쉼표로 나누고 공백과 빈 줄을 정리한다", () => {
    const parsed = parseNameList("  김용호 \n\n조규성\t박서연,  이  민재 ");
    expect(parsed.names).toEqual(["김용호", "조규성", "박서연", "이 민재"]);
  });

  it("중복은 한 번만 넣고 알려준다", () => {
    const parsed = parseNameList("Faker\nfaker\n김용호\n김용호");
    expect(parsed.names).toEqual(["Faker", "김용호"]);
    expect(parsed.duplicates).toEqual(["faker", "김용호"]);
  });

  it("20자를 넘는 이름은 넣지 않고 알려준다", () => {
    const long = "가".repeat(21);
    const parsed = parseNameList(`${long}\n김용호`);
    expect(parsed.names).toEqual(["김용호"]);
    expect(parsed.tooLong).toEqual([long]);
  });
});

describe("진영 대응", () => {
  it("승리 팀의 진영에서 팀 A의 진영을 구한다", () => {
    expect(teamASideFromWinner("A", "red")).toBe("red");
    expect(teamASideFromWinner("B", "red")).toBe("blue");
    expect(teamASideFromWinner("B", "unknown")).toBe("unknown");
  });

  it("두 팀의 진영은 항상 반대이거나 둘 다 미상이다", () => {
    expect(sideOfTeam("A", "blue")).toBe("blue");
    expect(sideOfTeam("B", "blue")).toBe("red");
    expect(sideOfTeam("B", "unknown")).toBe("unknown");
    expect(sideOfTeam("A", null)).toBeNull();
  });
});

describe("초안", () => {
  it("팀당 5명, 팀 내 포지션 중복 없이 만들어진다", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const draft = createDraft(people(), { groupId: null, baseLiveVersion: null, seed, now });
      expect(isCompleteDraft(draft)).toBe(true);
    }
  });

  it("같은 시드는 같은 편성을 만든다", () => {
    const a = createDraft(people(), { groupId: null, baseLiveVersion: null, seed: 42, now });
    const b = createDraft(people(), { groupId: null, baseLiveVersion: null, seed: 42, now });
    expect(a.slots).toEqual(b.slots);
  });

  it("포지션을 다시 뽑아도 고정한 사람은 그대로다", () => {
    let draft = fixedDraft();
    const lockedKey = "p:id2";
    const lockedPosition = positionOf(draft, lockedKey);
    draft = toggleLock(draft, lockedKey);
    for (let i = 0; i < 20; i++) {
      draft = rerollPositions(draft);
      expect(positionOf(draft, lockedKey)).toBe(lockedPosition);
      expect(isCompleteDraft(draft)).toBe(true);
    }
  });

  it("두 사람의 자리를 맞바꾸고 직전 편성으로 되돌릴 수 있다", () => {
    const draft = fixedDraft();
    const swapped = swapPeople(draft, "p:id0", "p:id7");
    expect(swapped.slots.find((s) => s.key === "p:id0")!.team).toBe("B");
    expect(swapped.slots.find((s) => s.key === "p:id7")!.team).toBe("A");
    expect(isCompleteDraft(swapped)).toBe(true);
    expect(undoDraft(swapped).slots).toEqual(draft.slots);
  });

  it("추천 팀을 적용하면 팀 구성이 그대로 반영된다", () => {
    const draft = fixedDraft();
    const teamA = ["p:id0", "p:id2", "p:id4", "p:id6", "p:id8"];
    const applied = applyTeams(draft, teamA);
    expect(
      applied.slots
        .filter((s) => s.team === "A")
        .map((s) => s.key)
        .sort(),
    ).toEqual([...teamA].sort());
    expect(isCompleteDraft(applied)).toBe(true);
    expect(undoDraft(applied).slots).toEqual(draft.slots);
  });

  it("형식이 다른 보관 초안은 버린다", () => {
    const draft = fixedDraft();
    expect(parseStoredDraft(JSON.stringify(draft))).toEqual(draft);
    expect(parseStoredDraft(JSON.stringify({ ...draft, formatVersion: 99 }))).toBeNull();
    expect(parseStoredDraft("{깨진 값")).toBeNull();
    expect(parseStoredDraft(null)).toBeNull();
  });
});

describe("다음 판 준비 (26)", () => {
  const match: MatchView = {
    id: "m1",
    matchNo: 3,
    sessionId: "s1",
    state: "confirmed",
    source: "live",
    startedAt: now,
    endedAt: now,
    playedAt: now,
    confirmedAt: now,
    winnerTeam: "A",
    teamASide: "red",
    version: 2,
    roster: fixedDraft().slots.map((s) => ({
      participantId: s.key.slice(2),
      team: s.team,
      position: s.position,
    })),
  };

  it("같은 팀으로 만들고 경기 ID·승패·진영·추첨 기록은 복사하지 않는다", () => {
    const draft = draftFromMatch(match, (id) => `이름-${id}`, {
      groupId: "g",
      baseLiveVersion: 5,
      seed: 3,
      now,
    });
    for (const entry of match.roster) {
      expect(draft.slots.find((s) => s.key === `p:${entry.participantId}`)!.team).toBe(entry.team);
    }
    expect(draft.origin).toBe("same-teams");
    expect(draft.draws).toEqual({});
    expect(isCompleteDraft(draft)).toBe(true);
    const text = JSON.stringify(draft);
    for (const forbidden of ["m1", "winnerTeam", "teamASide", "red", "confirmed", "requestId"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("포지션 유지를 고르면 포지션까지 같다", () => {
    const draft = draftFromMatch(match, (id) => id, {
      groupId: "g",
      baseLiveVersion: 5,
      seed: 3,
      now,
      keepPositions: true,
    });
    for (const entry of match.roster) {
      expect(positionOf(draft, `p:${entry.participantId}`)).toBe(entry.position);
    }
  });
});

describe("서포터 추첨", () => {
  it("차례를 쓴 사람은 팀을 옮겨도 후보에서 빠진다 (16)", () => {
    let draft = fixedDraft();
    // id0이 팀 A에서 차례를 썼다. id0을 팀 B의 서포터가 아닌 사람과 맞바꾼다.
    const targetB = draft.slots.find((s) => s.team === "B" && s.position !== "support")!.key;
    draft = swapPeople(draft, "p:id0", targetB);
    expect(draft.slots.find((s) => s.key === "p:id0")!.team).toBe("B");
    const { candidates } = drawCandidates(draft, "B", ctx(["id0"]));
    expect(candidates).not.toContain("p:id0");
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("새 서포터와 기존 서포터의 포지션만 바뀌고 나머지는 그대로다", () => {
    const draft = fixedDraft();
    const before = supporterKey(draft, "A")!;
    const result = drawSupport(draft, ["A"], ctx());
    const record = result.draft.draws.A!;
    expect(record.outKey).toBe(before);
    expect(positionOf(result.draft, record.inKey)).toBe("support");
    expect(positionOf(result.draft, record.outKey)).toBe(record.fromPosition);
    for (const slot of draft.slots) {
      if (slot.key === record.inKey || slot.key === record.outKey) continue;
      expect(result.draft.slots.find((s) => s.key === slot.key)).toEqual(slot);
    }
  });

  it("다시 눌러도, 보관했다 다시 읽어도 같은 결과다 (17)", () => {
    const first = drawSupport(fixedDraft(), ["A"], ctx());
    const again = drawSupport(first.draft, ["A"], ctx());
    expect(again.outcomes[0]!.kind).toBe("kept");
    expect(again.draft.slots).toEqual(first.draft.slots);
    const reloaded = parseStoredDraft(JSON.stringify(first.draft))!;
    const afterReload = drawSupport(reloaded, ["A"], ctx());
    expect(afterReload.draft.slots).toEqual(first.draft.slots);
  });

  it("되돌린 뒤 다시 누르면 새로 뽑지 않고 같은 결과를 다시 적용한다", () => {
    const first = drawSupport(fixedDraft(), ["A"], ctx());
    const undone = undoDraft(first.draft);
    expect(drawStatus(undone, "A", ctx())).toBe("reapplicable");
    const again = drawSupport(undone, ["A"], ctx());
    expect(again.draft.slots).toEqual(first.draft.slots);
  });

  it("참가자를 바꾸면 그 팀의 추첨만 다시 확인 대상이 된다 (18)", () => {
    const drawn = drawSupport(fixedDraft(), ["A", "B"], ctx()).draft;
    expect(drawStatus(drawn, "A", ctx())).toBe("applied");
    expect(drawStatus(drawn, "B", ctx())).toBe("applied");
    // 팀 B에서 추첨과 무관한 사람을 바꾼다.
    const record = drawn.draws.B!;
    const bystander = drawn.slots.find(
      (s) => s.team === "B" && s.key !== record.inKey && s.key !== record.outKey,
    )!.key;
    const changed = replacePerson(drawn, bystander, {
      key: "p:new",
      name: "새사람",
      participantId: "new",
    });
    expect(drawStatus(changed, "A", ctx())).toBe("applied");
    expect(drawStatus(changed, "B", ctx())).toBe("stale");
  });

  it("표시 이름이 바뀌어도 추첨은 유지된다 (19)", () => {
    const drawn = drawSupport(fixedDraft(), ["A", "B"], ctx()).draft;
    const renamed: Draft = {
      ...drawn,
      people: drawn.people.map((p) => ({ ...p, name: `${p.name}-바뀜` })),
    };
    expect(drawStatus(renamed, "A", ctx())).toBe("applied");
    expect(drawStatus(renamed, "B", ctx())).toBe("applied");
  });

  it("포지션 고정을 바꾸면 그 팀의 추첨이 다시 확인 대상이 된다", () => {
    const drawn = drawSupport(fixedDraft(), ["A", "B"], ctx()).draft;
    const record = drawn.draws.A!;
    const bystander = drawn.slots.find(
      (s) => s.team === "A" && s.key !== record.inKey && s.key !== record.outKey,
    )!.key;
    const locked = toggleLock(drawn, bystander);
    expect(drawStatus(locked, "A", ctx())).toBe("stale");
    expect(drawStatus(locked, "B", ctx())).toBe("applied");
  });

  it("차례가 다른 경로로 소비되면 되돌려도 무효 추첨이 되살아나지 않는다 (20)", () => {
    const first = drawSupport(fixedDraft(), ["A"], ctx());
    const picked = first.draft.draws.A!.inKey;
    const undone = undoDraft(first.draft);
    // 그 사이 다른 경기에서 뽑혔던 사람의 차례가 소비됐다.
    const after = ctx([picked.slice(2)], 1);
    expect(drawStatus(undone, "A", after)).toBe("stale");
    const redraw = drawSupport(undone, ["A"], after);
    expect(redraw.outcomes[0]!.kind).toBe("drawn");
    expect(redraw.draft.draws.A!.inKey).not.toBe(picked);
  });

  it("새 순환이 시작되면 이전 추첨은 다시 확인 대상이 된다", () => {
    const drawn = drawSupport(fixedDraft(), ["A"], ctx()).draft;
    expect(drawStatus(drawn, "A", ctx([], 0, "c2"))).toBe("stale");
  });

  it("한 팀만 후보가 있으면 아무것도 바꾸지 않고 선택을 묻는다 (21)", () => {
    const draft = fixedDraft();
    // 팀 B의 서포터가 아닌 네 명이 모두 차례를 썼다.
    const usedB = draft.slots
      .filter((s) => s.team === "B" && s.position !== "support")
      .map((s) => s.key.slice(2));
    const result = drawSupport(draft, ["A", "B"], ctx(usedB));
    expect(result.needsChoice).toBe("A");
    expect(result.draft).toBe(draft);
    expect(result.outcomes.find((o) => o.team === "B")).toMatchObject({
      kind: "blocked",
      block: "no-candidates",
    });
    // 사용자가 팀 A만 적용을 고르면 팀 A만 바뀐다.
    const onlyA = drawSupport(draft, ["A"], ctx(usedB));
    expect(onlyA.needsChoice).toBeNull();
    expect(onlyA.draft.draws.A).toBeDefined();
    expect(onlyA.draft.draws.B).toBeUndefined();
  });

  it("둘 다 후보가 없으면 원인만 돌려준다", () => {
    const draft = fixedDraft();
    const used = draft.slots.filter((s) => s.position !== "support").map((s) => s.key.slice(2));
    const result = drawSupport(draft, ["A", "B"], ctx(used));
    expect(result.needsChoice).toBeNull();
    expect(result.draft).toBe(draft);
    expect(result.outcomes.every((o) => o.kind === "blocked")).toBe(true);
  });

  it("서포터가 고정돼 있으면 무시하지 않고 막힌 이유를 알려준다", () => {
    const draft = fixedDraft();
    const locked = toggleLock(draft, supporterKey(draft, "A")!);
    expect(drawCandidates(locked, "A", ctx()).block).toBe("supporter-locked");
    const result = drawSupport(locked, ["A"], ctx());
    expect(result.draft).toBe(locked);
  });

  it("다른 자리에 고정된 사람은 서포터로 뽑히지 않는다", () => {
    let draft = fixedDraft();
    const nonSupport = draft.slots.filter((s) => s.team === "A" && s.position !== "support");
    for (const slot of nonSupport.slice(0, 3)) draft = toggleLock(draft, slot.key);
    const { candidates } = drawCandidates(draft, "A", ctx());
    expect(candidates).toEqual([nonSupport[3]!.key]);
  });

  it("이미 차례를 쓴 사람이 서포터 자리에 있으면 시작 전에 알 수 있다", () => {
    const draft = fixedDraft();
    const supporterA = supporterKey(draft, "A")!.slice(2);
    expect(repeatSupporterIds(draft, ctx([supporterA]))).toEqual([supporterA]);
    expect(repeatSupporterIds(draft, ctx())).toEqual([]);
    expect(repeatSupporterIds(draft, { ...ctx([supporterA]), enabled: false })).toEqual([]);
  });
});

describe("팀 추천", () => {
  function rec(groups: (number | null)[]): RecommendPerson[] {
    return groups.map((skillGroup, i) => ({ key: `k${i}`, skillGroup }));
  }
  const weights: [number, number, number, number] = [4, 3, 2, 1];

  it("126개 분할 중에서 고르고 두 팀은 겹치지 않는 5명씩이다", () => {
    const candidates = recommendTeams(rec([1, 1, 2, 2, 3, 3, 4, 4, null, null]), weights, 1, 200);
    expect(candidates).toHaveLength(126);
    const unique = new Set(candidates.map((c) => [...c.teamA].sort().join(",")));
    expect(unique.size).toBe(126);
    for (const c of candidates) {
      expect(c.teamA).toHaveLength(5);
      expect(c.teamB).toHaveLength(5);
      expect(new Set([...c.teamA, ...c.teamB]).size).toBe(10);
    }
  });

  it("가중치 합의 차가 가장 작은 분할이 먼저 나온다", () => {
    const candidates = recommendTeams(rec([1, 1, 2, 2, 3, 3, 4, 4, 2, 3]), weights, 1, 126);
    // 가중치 합이 25(홀수)라 가능한 최소 차는 1이다.
    expect(candidates[0]!.sumDiff).toBe(1);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.sumDiff).toBeGreaterThanOrEqual(candidates[i - 1]!.sumDiff);
    }
  });

  it("합계가 같으면 최상위 그룹 인원이 고르게 나뉜 분할이 먼저다", () => {
    const [best] = recommendTeams(rec([1, 1, 2, 2, 3, 3, 4, 4, 2, 3]), weights, 1);
    expect(Math.abs(best!.topCount[0] - best!.topCount[1])).toBe(0);
  });

  it("미지정은 낮은 실력으로 취급하지 않고 양팀에 나눈다", () => {
    const [best] = recommendTeams(rec([1, 1, 1, 1, 4, 4, 4, 4, null, null]), weights, 1);
    expect(best!.sumDiff).toBe(0);
    expect(best!.unassignedCount).toEqual([1, 1]);
  });

  it("같은 시드는 같은 추천을 만든다", () => {
    const input = rec([null, null, null, null, null, null, null, null, null, null]);
    expect(recommendTeams(input, weights, 9)).toEqual(recommendTeams(input, weights, 9));
    expect(recommendTeams(input, weights, 9)[0]!.reason).toContain("무작위");
  });
});

describe("배치와 승패", () => {
  function match(index: number, state: MatchView["state"], winner: Team | null): MatchView {
    return {
      id: `m${index}`,
      matchNo: index,
      sessionId: "s",
      state,
      source: "live",
      startedAt: now,
      endedAt: now,
      playedAt: now,
      confirmedAt: now,
      winnerTeam: winner,
      teamASide: winner ? "unknown" : null,
      version: 1,
      roster: Array.from({ length: 10 }, (_, i) => ({
        participantId: `id${i}`,
        team: i < 5 ? ("A" as const) : ("B" as const),
        position: null,
      })),
    };
  }

  it("0판·9판·10판 경계 (31)", () => {
    const nine = Array.from({ length: 9 }, (_, i) => match(i, "confirmed", "A"));
    expect(placements([]).get("id0")).toBeUndefined();
    expect(placements(nine).get("id0")).toEqual({ games: 9, done: false });
    const ten = [...nine, match(9, "confirmed", "B")];
    expect(placements(ten).get("id0")).toEqual({ games: PLACEMENT_GAMES, done: true });
  });

  it("제외하면 9판으로 돌아가고 복구하면 다시 10판이다 (32)", () => {
    const ten = Array.from({ length: 10 }, (_, i) => match(i, "confirmed", "A"));
    const excluded = ten.map((m, i) => (i === 3 ? { ...m, state: "excluded" as const } : m));
    expect(placements(excluded).get("id0")).toEqual({ games: 9, done: false });
    expect(placements(ten).get("id0")!.done).toBe(true);
  });

  it("대기·취소·진행 중 경기는 세지 않는다 (28)", () => {
    const matches = [
      match(1, "confirmed", "A"),
      match(2, "awaiting_result", null),
      match(3, "canceled", null),
      match(4, "in_progress", null),
    ];
    expect(personRecords(matches).get("id0")).toMatchObject({ games: 1, wins: 1, losses: 0 });
  });

  it("진영 미상이어도 개인 승패는 집계된다", () => {
    const records = personRecords([match(1, "confirmed", "B")]);
    expect(records.get("id0")).toMatchObject({ games: 1, wins: 0, losses: 1 });
    expect(records.get("id9")).toMatchObject({ games: 1, wins: 1, losses: 0 });
  });
});

describe("같은 팀·다른 팀 조건", () => {
  function rec(groups: (number | null)[]): RecommendPerson[] {
    return groups.map((skillGroup, i) => ({ key: `k${i}`, skillGroup }));
  }
  const weights: [number, number, number, number] = [4, 3, 2, 1];
  const input = rec([1, 1, 2, 2, 3, 3, 4, 4, 2, 3]);

  it("추천 후보는 모두 조건을 만족한다", () => {
    const constraints = [
      { kind: "same" as const, a: "k0", b: "k1" },
      { kind: "different" as const, a: "k2", b: "k3" },
    ];
    const candidates = recommendTeams(input, weights, 5, 200, constraints);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThan(126);
    for (const c of candidates) {
      const a = new Set(c.teamA);
      expect(a.has("k0")).toBe(a.has("k1"));
      expect(a.has("k2")).not.toBe(a.has("k3"));
    }
  });

  it("조건이 서로 모순이면 후보가 없다", () => {
    const contradictory = [
      { kind: "same" as const, a: "k0", b: "k1" },
      { kind: "different" as const, a: "k0", b: "k1" },
    ];
    expect(recommendTeams(input, weights, 5, 3, contradictory)).toEqual([]);
    // 여섯 명을 한 팀으로 묶으라는 조건도 만족할 수 없다.
    const sixTogether = [1, 2, 3, 4, 5].map((i) => ({ kind: "same" as const, a: "k0", b: `k${i}` }));
    expect(recommendTeams(input, weights, 5, 3, sixTogether)).toEqual([]);
  });

  it("같은 두 사람의 조건은 새 조건으로 바뀌고, 지금 편성이 어긴 조건을 알려준다", () => {
    let draft = fixedDraft();
    draft = addConstraint(draft, { kind: "same", a: "p:id0", b: "p:id1" });
    expect(violatedConstraints(draft)).toEqual([]);
    draft = addConstraint(draft, { kind: "different", a: "p:id1", b: "p:id0" });
    expect(draft.constraints).toEqual([{ kind: "different", a: "p:id1", b: "p:id0" }]);
    expect(violatedConstraints(draft)).toHaveLength(1);
    expect(removeConstraint(draft, 0).constraints).toEqual([]);
  });

  it("사람을 교체하면 그 사람에게 걸린 조건이 함께 지워진다", () => {
    let draft = fixedDraft();
    draft = addConstraint(draft, { kind: "same", a: "p:id0", b: "p:id1" });
    draft = addConstraint(draft, { kind: "different", a: "p:id2", b: "p:id7" });
    const replaced = replacePerson(draft, "p:id0", { key: "p:new", name: "새사람", participantId: "new" });
    expect(replaced.constraints).toEqual([{ kind: "different", a: "p:id2", b: "p:id7" }]);
  });

  it("조건이 없는 예전 보관 초안도 그대로 읽는다", () => {
    const draft = fixedDraft();
    expect(draft.constraints).toBeUndefined();
    expect(violatedConstraints(parseStoredDraft(JSON.stringify(draft))!)).toEqual([]);
  });
});
