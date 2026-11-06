import { describe, expect, it } from "vitest";
import {
  addConstraint,
  applyTeams,
  createDraft,
  draftFromMatch,
  isCompleteDraft,
  keepMatchPositions,
  normalizeDraftSide,
  parseStoredDraft,
  randomDraftSide,
  rerollPositions,
  swapSides,
  toggleLock,
  undoDraft,
  type Draft,
  type DraftPerson,
} from "../src/shared/draft";
import {
  allAssignedTeams,
  drawCandidates,
  drawSupport,
  fairRepeatSupporterIds,
  fairSupportPool,
  repeatSupporterIds,
  resetCountsReady,
  rotationContext,
  shuffleDraft,
  supportCountOf,
  supporterKey,
  supportTeamState,
  type RotationContext,
} from "../src/shared/rotation";
import { presetWinnerSide, TEAMS, type MatchView, type Snapshot, type Team } from "../src/shared/types";

// 팀 섞기 2종(올랜덤, 올랜덤 + 서포터 공평하게), 서포터 횟수 규칙, 준비 화면 진영 선택.

const now = "2026-11-06T00:00:00.000Z";

function people(): DraftPerson[] {
  return Array.from({ length: 10 }, (_, i) => ({ key: `p:id${i}`, name: `참가자${i}`, participantId: `id${i}` }));
}

/** id0~4 팀 A, id5~9 팀 B. */
function fixedDraft(seed = 7): Draft {
  const teamOf: Record<string, Team> = {};
  people().forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
  return createDraft(people(), { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
}

/** 참가자 ID → 횟수로 문맥을 만든다. 1회 이상이면 첫 차례(used)를 쓴 사람이다. */
function ctxOf(counts: Record<string, number> = {}, cycleId = "c1"): RotationContext {
  const map = new Map(Object.entries(counts));
  return {
    enabled: true,
    cycleId,
    usedIds: new Set([...map].filter(([, n]) => n > 0).map(([id]) => id)),
    eventCount: [...map.values()].reduce((a, b) => a + b, 0),
    counts: map,
  };
}

const teamOf = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!.team;
const slotOf = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!;
const positionOf = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!.position;
const teamKeys = (d: Draft, team: Team) => d.slots.filter((s) => s.team === team).map((s) => s.key);

describe("서포터 횟수 계산", () => {
  it("활성 주기의 used + repeat 사건을 사람별로 센다(무효 사건은 스냅숏에 없다)", () => {
    const ctx = rotationContext(true, {
      cycleId: "c1",
      events: [
        { matchId: "m1", participantId: "id0", kind: "used" },
        { matchId: "m2", participantId: "id0", kind: "repeat" },
        { matchId: "m3", participantId: "id0", kind: "repeat" },
        { matchId: "m1", participantId: "id5", kind: "used" },
      ],
    });
    const d = fixedDraft();
    expect(supportCountOf(d, "p:id0", ctx)).toBe(3);
    expect(supportCountOf(d, "p:id5", ctx)).toBe(1);
    expect(supportCountOf(d, "p:id1", ctx)).toBe(0);
    // 주기가 없으면(새 내전·초기화 직후) 모두 0.
    expect(supportCountOf(d, "p:id0", rotationContext(true, null))).toBe(0);
    // 아직 참가자 ID가 없는 새 이름도 0.
    const fresh: Draft = { ...d, people: d.people.map((p) => (p.key === "p:id1" ? { ...p, participantId: null } : p)) };
    expect(supportCountOf(fresh, "p:id1", ctx)).toBe(0);
  });
});

describe("서포터 고르기 규칙", () => {
  it("팀에서 고정 아니고 아직 안 간 사람(0회)만 후보다", () => {
    const d = fixedDraft();
    const ctx = ctxOf({ id0: 2, id1: 1, id2: 1, id3: 0, id4: 3 });
    expect(fairSupportPool(d, "A", ctx).keys).toEqual(["p:id3"]);
    // 예전에는 최소 횟수(1회)인 사람 모두가 후보였다. 이제 0회만 후보다.
    const ctx2 = ctxOf({ id0: 2, id1: 1, id2: 0, id3: 0, id4: 3 });
    expect(fairSupportPool(d, "A", ctx2).keys.sort()).toEqual(["p:id2", "p:id3"]);
  });

  it("모두 0회면 누구나 후보, 모두 1회 이상이면 후보가 없고 그 팀은 all-assigned다", () => {
    const d = fixedDraft();
    expect(fairSupportPool(d, "A", ctxOf()).keys).toHaveLength(5);
    expect(drawCandidates(d, "A", ctxOf()).candidates).toHaveLength(4);
    const allOnce = ctxOf({ id0: 1, id1: 2, id2: 1, id3: 1, id4: 1 });
    expect(fairSupportPool(d, "A", allOnce).keys).toEqual([]);
    expect(supportTeamState(d, "A", allOnce)).toBe("all-assigned");
    expect(drawCandidates(d, "A", allOnce)).toEqual({ candidates: [], block: "all-assigned" });
    // 팀 B는 아무도 안 갔다.
    expect(supportTeamState(d, "B", allOnce)).toBe("ready");
  });

  it("안 간 사람이 지금 서포터뿐이거나 나머지 안 간 사람이 모두 고정이면 only-current(all-assigned와 구분)", () => {
    const d = fixedDraft();
    const supA = supporterKey(d, "A")!;
    const others = teamKeys(d, "A").filter((k) => k !== supA);
    const onlySup = ctxOf(Object.fromEntries(others.map((k) => [k.slice(2), 1])));
    expect(supportTeamState(d, "A", onlySup)).toBe("only-current");
    expect(allAssignedTeams(d, onlySup)).toEqual([]);
    // 지금 서포터는 이미 갔고, 안 간 사람(others[0])은 포지션 고정.
    const locked = toggleLock(d, others[0]!);
    const lockedZero = ctxOf({ [supA.slice(2)]: 1, ...Object.fromEntries(others.slice(1).map((k) => [k.slice(2), 1])) });
    expect(supportTeamState(locked, "A", lockedZero)).toBe("only-current");
    expect(drawCandidates(locked, "A", lockedZero).block).toBe("only-current");
  });

  it("고정한 사람은 후보가 아니고, 서포터 자리 고정이면 그 사람만", () => {
    let d = fixedDraft();
    const nonSupport = d.slots.filter((s) => s.team === "A" && s.position !== "support").map((s) => s.key);
    d = toggleLock(d, nonSupport[0]!);
    const ctx = ctxOf({ [nonSupport[0]!.slice(2)]: 0, [nonSupport[1]!.slice(2)]: 1 });
    expect(fairSupportPool(d, "A", ctx).keys).not.toContain(nonSupport[0]);
    expect(fairSupportPool(d, "A", ctx).keys).not.toContain(nonSupport[1]);
    const supporter = supporterKey(d, "A")!;
    const lockedSupport = toggleLock(fixedDraft(), supporter);
    expect(fairSupportPool(lockedSupport, "A", ctxOf({ [supporter.slice(2)]: 9 }))).toEqual({
      keys: [supporter],
      locked: true,
    });
    expect(supportTeamState(lockedSupport, "A", ctxOf({ [supporter.slice(2)]: 0 }))).toBe("supporter-locked");
  });
});

describe("서포터만 바꾸기", () => {
  it("안 간 사람(0회) 중에서만 뽑고, 지금 서포터와 포지션만 맞바꾸며 다른 사람은 그대로다(여러 시드)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const d = fixedDraft(seed);
      const supA = supporterKey(d, "A")!;
      // 팀 A: 지금 서포터 말고 두 명이 0회, 나머지는 1~2회. 팀 B는 모두 1회(그대로 둔다).
      const others = teamKeys(d, "A").filter((k) => k !== supA);
      const zeros = [others[seed % 4]!, others[(seed + 1) % 4]!];
      const counts: Record<string, number> = { [supA.slice(2)]: 1 };
      for (const k of others) counts[k.slice(2)] = zeros.includes(k) ? 0 : 1 + (seed % 2);
      for (const k of teamKeys(d, "B")) counts[k.slice(2)] = 1;
      const result = drawSupport(d, ["A", "B"], ctxOf(counts));
      const record = result.draft.draws.A!;
      expect(zeros).toContain(record.inKey);
      expect(positionOf(result.draft, record.inKey)).toBe("support");
      expect(positionOf(result.draft, supA)).toBe(record.fromPosition);
      // 나머지 8명은 그대로다.
      for (const slot of d.slots) {
        if (slot.key === record.inKey || slot.key === supA) continue;
        expect(result.draft.slots.find((s) => s.key === slot.key)).toEqual(slot);
      }
    }
  });

  it("지금 서포터도 0회면 다른 0회인 사람으로 바뀐다(누르면 바뀌는 것이 보인다)", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const d = fixedDraft(seed);
      const result = drawSupport(d, ["A"], ctxOf());
      expect(result.draft.draws.A!.inKey).not.toBe(supporterKey(d, "A"));
    }
  });

  it("한 팀이 모두 배정받았으면 그 팀은 그대로, 다른 팀만 바로 바꾸고 알릴 팀을 돌려준다", () => {
    const d = fixedDraft();
    const allA = Object.fromEntries(teamKeys(d, "A").map((k) => [k.slice(2), 1]));
    const result = drawSupport(d, ["A", "B"], ctxOf(allA));
    expect(result.allAssigned).toEqual(["A"]);
    expect(result.outcomes.find((o) => o.team === "A")).toMatchObject({ kind: "blocked", block: "all-assigned" });
    expect(result.draft.slots.filter((s) => s.team === "A")).toEqual(d.slots.filter((s) => s.team === "A"));
    expect(result.draft.draws.B).toBeDefined();
    expect(positionOf(result.draft, result.draft.draws.B!.inKey)).toBe("support");
  });

  it("두 팀 모두 배정받았으면 아무것도 바꾸지 않고 두 팀을 알린다", () => {
    const d = fixedDraft();
    const all = ctxOf(Object.fromEntries(people().map((p) => [p.participantId!, 1])));
    const result = drawSupport(d, ["A", "B"], all);
    expect(result.draft).toBe(d);
    expect(result.allAssigned).toEqual(["A", "B"]);
  });

  it("지금 서포터가 팀에서 유일하게 안 간 사람이면 바꾸지 않고 only-current로 알린다", () => {
    const d = fixedDraft();
    const supA = supporterKey(d, "A")!;
    const counts: Record<string, number> = {};
    for (const k of teamKeys(d, "A")) counts[k.slice(2)] = k === supA ? 0 : 1;
    const result = drawSupport(d, ["A"], ctxOf(counts));
    expect(result.draft).toBe(d);
    expect(result.outcomes[0]).toMatchObject({ kind: "blocked", block: "only-current" });
    expect(result.allAssigned).toEqual([]);
  });

  // 2026-11-06 변경: 누를 때마다 새로 뽑는다(예전에는 같은 조건이면 같은 결과를 유지했다).
  it("다시 누르면 두 팀 모두 아직 안 간 다른 사람으로 바뀐다. 이미 간 사람은 계속 뽑히지 않는다", () => {
    const d = fixedDraft();
    const ctx = ctxOf({ id0: 1 });
    const sup = (draft: Draft, team: "A" | "B") =>
      draft.slots.find((s) => s.team === team && s.position === "support")!.key;
    let current = drawSupport(d, ["A", "B"], ctx).draft;
    for (let i = 0; i < 12; i++) {
      const next = drawSupport(current, ["A", "B"], ctx);
      expect(next.outcomes.every((o) => o.kind === "drawn")).toBe(true);
      for (const team of ["A", "B"] as const) {
        expect(sup(next.draft, team)).not.toBe(sup(current, team));
        expect(sup(next.draft, team)).not.toBe("p:id0");
      }
      // 팀 구성은 그대로이고, 팀마다 두 사람의 포지션만 바뀐다.
      expect(next.draft.slots.map((s) => `${s.key}:${s.team}`)).toEqual(current.slots.map((s) => `${s.key}:${s.team}`));
      expect(next.draft.slots.filter((s, idx) => s.position !== current.slots[idx]!.position)).toHaveLength(4);
      current = next.draft;
    }
    // 같은 편성·같은 시드에서 누르면 결과가 같다(결정적).
    expect(drawSupport(current, ["A", "B"], ctx).draft.slots).toEqual(drawSupport(current, ["A", "B"], ctx).draft.slots);
  });
});

describe("서포터 횟수 초기화 버튼(준비 화면)", () => {
  it("두 팀 중 하나라도 모두 배정받았을 때만 켜지고, 초기화(새 주기, 횟수 0) 뒤에는 다시 꺼진다", () => {
    const d = fixedDraft();
    expect(resetCountsReady(d, ctxOf())).toBe(false);
    const someA = ctxOf({ id0: 1, id1: 1, id2: 1, id3: 1 });
    expect(resetCountsReady(d, someA)).toBe(false);
    const allA = ctxOf({ id0: 1, id1: 1, id2: 1, id3: 1, id4: 2 });
    expect(resetCountsReady(d, allA)).toBe(true);
    // 라인을 섞어도 팀원은 그대로라 켜진 채다. 팀 추천 적용 등으로 팀원이 바뀌면 초안에서 다시 계산한다.
    for (let seed = 1; seed <= 20; seed++) {
      expect(resetCountsReady(shuffleDraft(fixedDraft(seed), { fairSupport: false }, allA), allA)).toBe(true);
    }
    const split = applyTeams(d, ["p:id0", "p:id1", "p:id5", "p:id6", "p:id7"]);
    expect(resetCountsReady(split, allA)).toBe(false);
    // 초기화 = 새 주기, 사건 없음 → 횟수 0 → 꺼진다.
    const afterReset = rotationContext(true, { cycleId: "c2", events: [] });
    expect(resetCountsReady(d, afterReset)).toBe(false);
    // 순환을 끈 모임에서는 켜지지 않는다.
    expect(resetCountsReady(d, { ...allA, enabled: false })).toBe(false);
  });
});

describe("라인 섞기(올랜덤)", () => {
  const kinds = [false, true] as const;

  it("두 가지 모두 5:5, 팀 안 포지션이 겹치지 않는다(여러 시드)", () => {
    for (const fairSupport of kinds) {
      for (let seed = 1; seed <= 40; seed++) {
        const next = shuffleDraft(fixedDraft(seed), { fairSupport }, ctxOf({ id0: 1, id6: 2 }));
        expect(isCompleteDraft(next)).toBe(true);
        expect(next.draws).toEqual({});
      }
    }
  });

  it("같은 시드면 같은 결과, 섞을 때마다 시드가 바뀌어 다른 라인이 나온다. 팀원은 절대 바뀌지 않는다", () => {
    for (const fairSupport of kinds) {
      const a = shuffleDraft(fixedDraft(11), { fairSupport }, ctxOf());
      const b = shuffleDraft(fixedDraft(11), { fairSupport }, ctxOf());
      expect(a.slots).toEqual(b.slots);
      expect(a.seed).not.toBe(fixedDraft(11).seed);
      const seen = new Set<string>();
      let d = fixedDraft(11);
      for (let i = 0; i < 10; i++) {
        d = shuffleDraft(d, { fairSupport }, ctxOf());
        expect(teamKeys(d, "A").sort()).toEqual(teamKeys(fixedDraft(11), "A").sort());
        seen.add(JSON.stringify(d.slots.map((s) => s.position)));
      }
      expect(seen.size).toBeGreaterThan(3);
    }
  });

  it("올랜덤은 포지션 다시 뽑기(rerollPositions)와 같은 동작이다. 팀 조건은 섞기에 쓰지 않는다(팀 추천에만)", () => {
    let d = fixedDraft(5);
    // 지금 편성과 어긋난 조건이 있어도 섞기는 팀을 나누지 않는다.
    d = addConstraint(d, { kind: "same", a: "p:id0", b: "p:id9" });
    for (let seed = 1; seed <= 20; seed++) {
      const next = shuffleDraft({ ...d, seed }, { fairSupport: false }, ctxOf());
      expect(next).toEqual(rerollPositions({ ...d, seed }));
      expect(teamOf(next, "p:id0")).not.toBe(teamOf(next, "p:id9"));
    }
  });

  it("고정한 사람은 섞어도 포지션을 지키고 고정이 풀리지 않는다", () => {
    let d = fixedDraft();
    const topA = d.slots.find((s) => s.team === "A" && s.position === "top")!.key;
    const supB = d.slots.find((s) => s.team === "B" && s.position === "support")!.key;
    d = toggleLock(toggleLock(d, topA), supB);
    for (let seed = 1; seed <= 60; seed++) {
      for (const fairSupport of kinds) {
        const next = shuffleDraft({ ...d, seed }, { fairSupport }, ctxOf());
        expect(slotOf(next, topA)).toMatchObject({ position: "top", locked: true, team: "A" });
        expect(slotOf(next, supB)).toMatchObject({ position: "support", locked: true, team: "B" });
        expect(isCompleteDraft(next)).toBe(true);
      }
    }
  });

  it("서포터 공평하게: 섞인 팀에 안 간 사람이 있으면 서포터는 그중 한 명, 없으면 무작위 그대로 두고 알린다(여러 시드)", () => {
    // id0~4는 이미 2번, id5~7은 1번, id8·id9는 0번.
    const ctx = ctxOf({ id0: 2, id1: 2, id2: 2, id3: 2, id4: 2, id5: 1, id6: 1, id7: 1 });
    let sawFull = false;
    for (let seed = 1; seed <= 60; seed++) {
      const next = shuffleDraft(fixedDraft(seed), { fairSupport: true }, ctx)!;
      for (const team of TEAMS) {
        const hasZero = teamKeys(next, team).some((k) => supportCountOf(next, k, ctx) === 0);
        const supporter = supporterKey(next, team)!;
        if (hasZero) {
          expect(supportCountOf(next, supporter, ctx)).toBe(0);
        } else {
          sawFull = true;
          expect(allAssignedTeams(next, ctx)).toContain(team);
        }
      }
    }
    expect(sawFull).toBe(true);
  });

  it("올랜덤은 횟수를 보지 않는다: 많이 간 사람도 서포터가 될 수 있다", () => {
    const ctx = ctxOf({ id0: 5, id1: 5, id2: 5, id3: 5, id4: 5 });
    let sawRepeat = false;
    for (let seed = 1; seed <= 40 && !sawRepeat; seed++) {
      const next = shuffleDraft(fixedDraft(seed), { fairSupport: false }, ctx)!;
      sawRepeat = TEAMS.some((t) => supportCountOf(next, supporterKey(next, t)!, ctx) === 5);
    }
    expect(sawRepeat).toBe(true);
  });

  it("서포터 공평하게: 모두 0회면 누구나 서포터가 될 수 있고, 모두 1회 이상이면 올랜덤과 같은 결과다", () => {
    const supporters = new Set<string>();
    for (let seed = 1; seed <= 60; seed++) {
      const next = shuffleDraft(fixedDraft(seed), { fairSupport: true }, ctxOf())!;
      supporters.add(supporterKey(next, "A")!);
    }
    expect(supporters.size).toBeGreaterThan(4);
    const allOnce = ctxOf(Object.fromEntries(people().map((p) => [p.participantId!, 1])));
    for (let seed = 1; seed <= 10; seed++) {
      const fair = shuffleDraft(fixedDraft(seed), { fairSupport: true }, allOnce)!;
      const plain = shuffleDraft(fixedDraft(seed), { fairSupport: false }, allOnce)!;
      expect(fair.slots).toEqual(plain.slots);
      expect(allAssignedTeams(fair, allOnce)).toEqual(["A", "B"]);
    }
  });

  it("서포터 자리에 고정된 사람은 공평하게 섞어도 그대로 서포터다", () => {
    const d = fixedDraft();
    const sup = supporterKey(d, "A")!;
    const locked = toggleLock(d, sup);
    for (let seed = 1; seed <= 20; seed++) {
      const next = shuffleDraft({ ...locked, seed }, { fairSupport: true }, ctxOf({ [sup.slice(2)]: 9 }))!;
      expect(positionOf(next, sup)).toBe("support");
    }
  });

  it("섞기 → 서포터만 바꾸기 → 다시 섞기를 이어서 눌러도 같은 규칙으로 동작한다", () => {
    const ctx = ctxOf({ id0: 1, id1: 1, id5: 2 });
    let d = shuffleDraft(fixedDraft(3), { fairSupport: true }, ctx)!;
    // 공평하게 섞은 직후: 팀마다 서포터가 이미 안 간 사람이다. 서포터만 바꾸기는 다른 안 간 사람으로만 바꾼다.
    const drawn = drawSupport(d, ["A", "B"], ctx);
    for (const outcome of drawn.outcomes) {
      if (outcome.kind === "drawn") {
        expect(supportCountOf(drawn.draft, outcome.record!.inKey, ctx)).toBe(0);
      }
    }
    d = drawn.draft;
    const again = shuffleDraft(d, { fairSupport: true }, ctx)!;
    expect(isCompleteDraft(again)).toBe(true);
    expect(again.draws).toEqual({});
  });

  it("직전 편성으로 되돌릴 수 있다", () => {
    const d = fixedDraft();
    const next = shuffleDraft(d, { fairSupport: true }, ctxOf())!;
    expect(undoDraft(next).slots).toEqual(d.slots);
  });
});

describe("시작 전 반복 확인", () => {
  it("팀 모두가 갔으면 공평한 반복(묻지 않음), 아직 안 간 사람(고정 아님)이 있으면 확인을 묻는다", () => {
    const d = fixedDraft();
    const supA = supporterKey(d, "A")!.slice(2);
    const allOnceA = Object.fromEntries(teamKeys(d, "A").map((k) => [k.slice(2), 1]));
    expect(fairRepeatSupporterIds(d, ctxOf(allOnceA))).toEqual([supA]);
    expect(repeatSupporterIds(d, ctxOf(allOnceA))).toEqual([]);
    const unfair = { [supA]: 1 };
    expect(repeatSupporterIds(d, ctxOf(unfair))).toEqual([supA]);
    expect(fairRepeatSupporterIds(d, ctxOf(unfair))).toEqual([]);
    expect(repeatSupporterIds(d, { ...ctxOf(unfair), enabled: false })).toEqual([]);
    // 서포터가 2회, 나머지가 모두 1회여도 팀 모두가 갔으므로 묻지 않는다(예전에는 더 적게 간 사람이 있어 물었다).
    const allA = { ...allOnceA, [supA]: 2 };
    expect(repeatSupporterIds(d, ctxOf(allA))).toEqual([]);
    expect(fairRepeatSupporterIds(d, ctxOf(allA))).toEqual([supA]);
    // 안 간 사람이 포지션 고정뿐이면 묻지 않는다.
    const zeroKey = teamKeys(d, "A").find((k) => k.slice(2) !== supA)!;
    const lockedZero = toggleLock(d, zeroKey);
    const counts = { ...allOnceA, [zeroKey.slice(2)]: 0 };
    expect(repeatSupporterIds(lockedZero, ctxOf(counts))).toEqual([]);
  });
});

describe("준비 화면 진영(팀 A = 블루팀)", () => {
  it("새 초안·지난 경기에서 만든 초안은 팀 A가 블루다(지난 경기에서 A가 레드였어도)", () => {
    expect(fixedDraft().teamASide).toBe("blue");
    const match = liveMatch(fixedDraft(), "red");
    expect(draftFromMatch(match, (id) => id, { groupId: "g", baseLiveVersion: 1, seed: 3, now }).teamASide).toBe("blue");
  });

  it("진영 바꾸기: 블루팀 5명과 레드팀 5명이 서로 바뀌고 팀 A는 계속 블루, 두 번 누르면 원래대로", () => {
    let d = toggleLock(fixedDraft(), "p:id0");
    d = { ...d, draws: { A: { fingerprint: "x", inKey: "p:id1", outKey: "p:id2", fromPosition: "top" } } };
    const blue = teamKeys(d, "A").sort();
    const red = teamKeys(d, "B").sort();
    const swapped = swapSides(d);
    expect(swapped.teamASide).toBe("blue");
    expect(teamKeys(swapped, "A").sort()).toEqual(red);
    expect(teamKeys(swapped, "B").sort()).toEqual(blue);
    // 라인·고정·서포터 추첨 기록은 사람을 따라간다.
    for (const s of d.slots) {
      expect(slotOf(swapped, s.key).position).toBe(s.position);
      expect(slotOf(swapped, s.key).locked).toBe(s.locked);
    }
    expect(swapped.draws).toEqual({ B: d.draws.A });
    expect(swapSides(swapped)).toEqual(d);
  });

  it("섞기·추천·라인 다시 뽑기 뒤에도 팀 A는 블루다", () => {
    const d = fixedDraft();
    expect(shuffleDraft(d, { fairSupport: true }, ctxOf())!.teamASide).toBe("blue");
    expect(shuffleDraft(d, { fairSupport: false }, ctxOf())!.teamASide).toBe("blue");
    expect(applyTeams(d, teamKeys(d, "B")).teamASide).toBe("blue");
    expect(rerollPositions(d).teamASide).toBe("blue");
  });

  it("진영 랜덤은 시드로 정해지고, 반반으로 두 팀을 맞바꾸거나 그대로 둔다(팀 A는 항상 블루)", () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const d = fixedDraft(seed);
      const next = randomDraftSide(d);
      expect(next.teamASide).toBe("blue");
      expect(next.seed).not.toBe(d.seed);
      if (next.slots.every((s, i) => s.team === d.slots[i]!.team)) {
        expect(next.slots).toEqual(d.slots);
        outcomes.add("same");
      } else {
        expect(next.slots).toEqual(swapSides(d).slots);
        outcomes.add("swapped");
      }
    }
    expect([...outcomes].sort()).toEqual(["same", "swapped"]);
    expect(randomDraftSide(fixedDraft(5))).toEqual(randomDraftSide(fixedDraft(5)));
  });

  it("예전 초안을 읽으면 팀 A = 블루로 맞춘다: red는 두 팀을 맞바꾸고, 없음은 자리 그대로 블루", () => {
    const d = toggleLock(fixedDraft(), "p:id3");
    const { teamASide: _side, ...legacyNone } = d;
    // 예전 "팀 A 레드": 블루였던 쪽은 팀 B(id5~9). 읽으면 그 5명이 팀 A(블루)가 된다.
    const fromRed = parseStoredDraft(JSON.stringify({ ...legacyNone, teamASide: "red" }))!;
    expect(fromRed.teamASide).toBe("blue");
    expect(teamKeys(fromRed, "A").sort()).toEqual(teamKeys(d, "B").sort());
    expect(fromRed.slots).toEqual(swapSides(d).slots);
    // 예전 "나중에 정하기": 자리 그대로 팀 A를 블루로.
    const fromNone = parseStoredDraft(JSON.stringify(legacyNone))!;
    expect(fromNone.teamASide).toBe("blue");
    expect(fromNone.slots).toEqual(d.slots);
    // 이미 블루인 초안은 그대로 다시 읽힌다(형식 번호도 그대로).
    expect(parseStoredDraft(JSON.stringify(d))).toEqual(d);
    expect(normalizeDraftSide(d)).toBe(d);
  });

  it("포지션 유지는 지난 경기 팀·포지션으로 맞추되 팀 조건을 지우지 않고, 팀 A는 블루, 되돌릴 수 있다", () => {
    const base = fixedDraft();
    const match = { ...liveMatch(base, "red"), state: "confirmed" as const, winnerTeam: "A" as const };
    let d = draftFromMatch(match, (id) => id, { groupId: "g", baseLiveVersion: 1, seed: 9, now });
    d = addConstraint(d, { kind: "same", a: "p:id0", b: "p:id1" });
    const kept = keepMatchPositions(d, match, (id) => id, now);
    for (const r of match.roster) expect(positionOf(kept, `p:${r.participantId}`)).toBe(r.position);
    expect(kept.teamASide).toBe("blue");
    expect(kept.constraints).toEqual(d.constraints);
    expect(undoDraft(kept).slots).toEqual(d.slots);
  });

  it("결과 입력 창은 고른 승리 팀의 진영을 미리 고른다(정하지 않았거나 미상이면 없음)", () => {
    expect(presetWinnerSide("A", "blue")).toBe("blue");
    expect(presetWinnerSide("B", "blue")).toBe("red");
    expect(presetWinnerSide("A", "unknown")).toBeNull();
    expect(presetWinnerSide("A", null)).toBeNull();
  });

  it("명단 텍스트는 블루팀·레드팀으로 쓴다(실력 그룹은 넣지 않는다)", async () => {
    const format = await webFormat();
    const text = format.draftRosterText(fixedDraft());
    expect(text).toContain("● 블루팀");
    expect(text).toContain("■ 레드팀");
    expect(text).not.toMatch(/팀 [AB]/);
  });
});

describe("팀 이름 규칙(format.ts teamName)", () => {
  it("진영이 정해져 있으면 블루팀·레드팀, A가 레드면 A가 레드팀, 모르면 팀 A·B", async () => {
    const { teamName, teamBoxClass, winnerText } = await webFormat();
    expect([teamName("A", "blue"), teamName("B", "blue")]).toEqual(["블루팀", "레드팀"]);
    expect([teamName("A", "red"), teamName("B", "red")]).toEqual(["레드팀", "블루팀"]);
    for (const side of [null, undefined, "unknown"] as const) {
      expect([teamName("A", side), teamName("B", side)]).toEqual(["팀 A", "팀 B"]);
      expect(teamBoxClass("A", side)).toBe("team");
    }
    expect([teamBoxClass("A", "red"), teamBoxClass("B", "red")]).toEqual(["team side-red", "team side-blue"]);
    expect(winnerText("B", "red")).toBe("블루팀 승");
    expect(winnerText("A", "unknown")).toBe("팀 A 승 · 진영 미상");
    expect(winnerText("B", null, "승리")).toBe("팀 B 승리 · 진영 미상");
  });

  it("경기 명단 텍스트도 같은 규칙을 따른다", async () => {
    const { matchRosterText } = await webFormat();
    const d = fixedDraft();
    const snapshot = {
      group: { name: "모임", timezone: "Asia/Seoul" },
      serverTime: now,
      participants: people().map((p) => ({ id: p.participantId!, name: p.name, status: "active" })),
    } as unknown as Snapshot;
    const red = matchRosterText(snapshot, liveMatch(d, "red"), null);
    expect(red.indexOf("● 레드팀")).toBeGreaterThan(-1);
    expect(red.indexOf("■ 블루팀")).toBeGreaterThan(red.indexOf("● 레드팀"));
    const unknown = matchRosterText(snapshot, liveMatch(d, null), null);
    expect(unknown).toContain("● 팀 A");
    expect(unknown).toContain("■ 팀 B");
    expect(unknown).not.toMatch(/블루|레드/);
  });
});

/** 초안의 명단으로 만든 진행 중 경기. */
function liveMatch(d: Draft, teamASide: MatchView["teamASide"]): MatchView {
  return {
    id: "m1",
    matchNo: 1,
    sessionId: "s1",
    state: "in_progress",
    source: "live",
    startedAt: now,
    endedAt: null,
    playedAt: now,
    confirmedAt: null,
    winnerTeam: null,
    teamASide,
    version: 1,
    roster: d.slots.map((s) => ({ participantId: s.key.slice(2), team: s.team, position: s.position })),
  };
}

interface WebFormat {
  draftRosterText(draft: Draft): string;
  matchRosterText(snapshot: Snapshot, match: MatchView, link: string | null): string;
  teamName(team: Team, teamASide: MatchView["teamASide"] | undefined): string;
  teamBoxClass(team: Team, teamASide: MatchView["teamASide"] | undefined): string;
  winnerText(team: Team, teamASide: MatchView["teamASide"] | undefined, verb?: string): string;
}

/** 화면 코드(src/web/format.ts)는 서버 타입 검사 밖이라 동적으로 읽는다. */
async function webFormat(): Promise<WebFormat> {
  const path = "../src/web/format";
  return (await import(/* @vite-ignore */ path)) as WebFormat;
}
