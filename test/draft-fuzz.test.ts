import { describe, expect, it } from "vitest";
import {
  addConstraint,
  applyTeams,
  createDraft,
  HISTORY_MAX,
  historyOf,
  isCompleteDraft,
  parseStoredDraft,
  randomDraftSide,
  redoDraft,
  removeConstraint,
  rerollPositions,
  rngFromSeed,
  shuffle,
  swapPeople,
  swapSides,
  toggleLock,
  undoDraft,
  violatedConstraints,
  type AvoidMap,
  type Draft,
  type DraftPerson,
  type DraftSlot,
} from "../src/shared/draft";
import { avoidViolations } from "../src/shared/avoid";
import {
  allAssignedTeams,
  drawSupport,
  fairRepeatSupporterIds,
  repeatSupporterIds,
  resetCountsReady,
  rotationContext,
  shuffleDraft,
  supportCountOf,
  supporterKey,
  supportTeamState,
  type RotationContext,
} from "../src/shared/rotation";
import { priorityCounts, shuffleTeamsByPriority, type PriorityMap } from "../src/shared/priority";
import { POSITIONS, TEAMS, type GroupWeights, type Position, type RotationView, type Team } from "../src/shared/types";

// 준비 화면의 라인 섞기·서포터·고정·조건·되돌리기를 무작위 순서로 수천 번 눌러 보고 매 단계 불변식을 확인한다.
// 팀까지 올랜덤(티어 균형)도 조작 목록에 넣는다. 순수 로직만 쓴다(화면 점검은 e2e). 시드가 같으면 결과가 같으므로 실패하면 시드로 그대로 재현된다.

const now = "2026-11-06T00:00:00.000Z";

function people(withNewName: boolean): DraftPerson[] {
  return Array.from({ length: 10 }, (_, i) =>
    withNewName && i === 9
      ? { key: "n:새이름", name: "새이름", participantId: null }
      : { key: `p:id${i}`, name: `참가자${i}`, participantId: `id${i}` },
  );
}

/**
 * 무작위 서포터 횟수 문맥. counts는 표시·규칙에 쓰는 횟수(사건 수 + 직접 넣은 보정값),
 * usedIds는 서버가 반복 확인에 쓰는 'used' 사건이 있는 사람이다. 보정값 때문에 둘이 어긋날 수 있다.
 */
function randomCtx(rng: () => number): RotationContext {
  // 절반은 스냅숏 모양(사건 + 서포터 횟수 직접 입력의 보정값)을 만들어 rotationContext가 합산하게 한다.
  if (rng() < 0.5) {
    const events: RotationView["events"] = [];
    const adjustments: NonNullable<RotationView["adjustments"]> = [];
    for (let i = 0; i < 10; i++) {
      const n = Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) events.push({ matchId: `m${k}`, participantId: `id${i}`, kind: k === 0 ? "used" : "repeat" });
      const delta = rng() < 0.4 ? Math.floor(rng() * 5) - 2 : 0;
      if (delta !== 0) adjustments.push({ participantId: `id${i}`, delta });
    }
    return rotationContext(true, { cycleId: rng() < 0.85 ? "c1" : null, events, adjustments });
  }
  const counts = new Map<string, number>();
  const usedIds = new Set<string>();
  const style = rng();
  for (let i = 0; i < 10; i++) {
    const r = rng();
    // style에 따라 0회가 많은 문맥, 대부분 1회 이상인 문맥을 섞는다.
    const n = style < 0.3 ? (r < 0.7 ? 0 : 1) : style < 0.7 ? Math.floor(r * 3) : r < 0.15 ? 0 : 1 + Math.floor(r * 2);
    if (n > 0) counts.set(`id${i}`, n);
    // 대부분은 횟수와 사건이 맞지만, 보정으로 어긋난 사람도 만든다.
    const mismatch = rng() < 0.15;
    if ((n > 0) !== mismatch) usedIds.add(`id${i}`);
  }
  return { enabled: true, cycleId: rng() < 0.9 ? "c1" : null, usedIds, eventCount: usedIds.size, counts };
}

type Op =
  | "teamShuffle"
  | "shuffle"
  | "shuffleFair"
  | "draw"
  | "reroll"
  | "applyTeams"
  | "swapSides"
  | "legacySide"
  | "randomSide"
  | "undo"
  | "redo"
  | "lock"
  | "constraint"
  | "removeConstraint"
  | "swapPeople";

const OPS: Op[] = [
  "teamShuffle",
  "shuffle",
  "shuffleFair",
  "draw",
  "reroll",
  "applyTeams",
  "swapSides",
  "legacySide",
  "randomSide",
  "undo",
  "redo",
  "lock",
  "constraint",
  "removeConstraint",
  "swapPeople",
];

const slotOf = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!;
const keysOf = (slots: readonly DraftSlot[]) => slots.map((s) => s.key).sort();

/** 고정이 풀린 사람은 팀 추천 적용에서 같은 팀의 앞사람과 고정 포지션이 겹친 경우뿐이다. */
function checkLocksAfterRegroup(before: Draft, after: Draft, where: string) {
  const order = before.slots.map((s) => s.key);
  for (const b of before.slots) {
    if (!b.locked) continue;
    const a = slotOf(after, b.key);
    if (a.locked) {
      expect(a.position, `${where}: 고정 포지션 유지`).toBe(b.position);
      continue;
    }
    // 앞 순서에서 같은 새 팀·같은 포지션으로 고정된 사람이 있어야 한다.
    const earlier = order.slice(0, order.indexOf(b.key));
    const clash = earlier.some((k) => {
      const prev = slotOf(before, k);
      const now = slotOf(after, k);
      return prev.locked && now.locked && prev.position === b.position && now.team === a.team;
    });
    expect(clash, `${where}: 고정이 풀린 이유(같은 팀 고정 겹침)`).toBe(true);
  }
}

interface Step {
  op: Op;
  before: Draft;
  after: Draft;
}

const WEIGHTS: GroupWeights = [5, 4, 3, 2, 1];

/** 무작위 티어(사람마다 1~5 또는 미지정). 가끔은 아무도 정하지 않는다. 새 이름(참가자 ID 없음)은 미지정. */
function randomPriorities(ps: readonly DraftPerson[], rng: () => number): PriorityMap {
  const none = rng() < 0.15;
  return Object.fromEntries(
    ps.map((p) => {
      const r = rng();
      return [p.key, none || p.participantId === null || r < 0.2 ? null : 1 + Math.floor(rng() * 4)];
    }),
  );
}

/** 한 번 조작한다. 손으로 고르는 값(누구를 고정·조건·맞바꾸기)은 조작 rng로 정한다. */
function apply(
  d: Draft,
  op: Op,
  ctx: RotationContext,
  pick: () => number,
  priorities: PriorityMap,
  avoid?: AvoidMap,
): Draft {
  const keys = d.slots.map((s) => s.key);
  const any = () => keys[Math.floor(pick() * keys.length)]!;
  switch (op) {
    case "teamShuffle":
      return shuffleTeamsByPriority(d, priorities, WEIGHTS, avoid).draft;
    case "shuffle":
      return shuffleDraft(d, { fairSupport: false, avoid }, ctx);
    case "shuffleFair":
      return shuffleDraft(d, { fairSupport: true, avoid }, ctx);
    case "draw":
      return drawSupport(d, TEAMS, ctx).draft;
    case "reroll":
      return rerollPositions(d, avoid);
    case "applyTeams":
      return applyTeams(d, shuffle(keys, pick).slice(0, 5), avoid);
    case "swapSides":
      return swapSides(d);
    case "legacySide": {
      // 예전 기기에 저장된 초안(팀 A 진영 "red" 또는 "나중에 정하기")을 다시 읽는다.
      const { teamASide: _old, ...rest } = d;
      const legacy = pick() < 0.5 ? { ...rest, teamASide: "red" } : rest;
      return parseStoredDraft(JSON.stringify(legacy))!;
    }
    case "randomSide":
      return randomDraftSide(d);
    case "undo":
      return undoDraft(d);
    case "redo":
      return redoDraft(d);
    case "lock":
      return toggleLock(d, any());
    case "constraint": {
      const a = any();
      const b = any();
      return addConstraint(d, { kind: pick() < 0.5 ? "same" : "different", a, b });
    }
    case "removeConstraint":
      return (d.constraints ?? []).length === 0 ? d : removeConstraint(d, Math.floor(pick() * d.constraints!.length));
    case "swapPeople":
      return swapPeople(d, any(), any());
  }
}

/**
 * 기피 라인 검사(테스트 쪽 독립 계산): 팀마다 고정한 사람은 그대로 두고 나머지를 남은 자리에 놓는 모든 배정 중
 * 기피를 어기는 수의 최솟값. 섞은 결과의 비고정 어김 수가 이 값과 같아야 한다.
 */
function minMisses(after: Draft, team: Team, avoid: AvoidMap): number {
  const members = after.slots.filter((s) => s.team === team);
  const free = members.filter((s) => !s.locked);
  const left = POSITIONS.filter((p) => !members.some((m) => m.locked && m.position === p));
  let best = Infinity;
  const walk = (i: number, used: Set<Position>, misses: number) => {
    if (misses >= best) return;
    if (i === free.length) {
      best = misses;
      return;
    }
    for (const p of left) {
      if (used.has(p)) continue;
      used.add(p);
      walk(i + 1, used, misses + (avoid[free[i]!.key]?.includes(p) ? 1 : 0));
      used.delete(p);
    }
  };
  walk(0, new Set(), 0);
  return best;
}

function checkAvoid(op: Op, after: Draft, avoid: AvoidMap, where: string) {
  // 서포터 공평하게·서포터만 바꾸기는 서포터 횟수 규칙이 먼저라 기피 최소를 보장하지 않는다. 손으로 옮기는 것도 막지 않는다.
  if (op !== "shuffle" && op !== "reroll" && op !== "applyTeams" && op !== "teamShuffle") return;
  const misses = avoidViolations(after, avoid, { includeLocked: false });
  for (const team of TEAMS) {
    const mine = misses.filter((m) => slotOf(after, m.key).team === team).length;
    expect(mine, `${where}: 팀 ${team} 기피 최소 어김`).toBe(minMisses(after, team, avoid));
  }
}

function checkStep(step: Step, ctx: RotationContext, where: string, priorities: PriorityMap, avoid?: AvoidMap) {
  const { op, before, after } = step;
  // 항상: 10명, 팀당 5명, 팀 안 포지션 5개, 사람이 사라지거나 겹치지 않음.
  expect(isCompleteDraft(after), `${where}: 완전한 편성`).toBe(true);
  expect(keysOf(after.slots), `${where}: 사람 그대로`).toEqual(keysOf(before.slots));
  expect(after.people, `${where}: 참가자 목록 그대로`).toEqual(before.people);
  expect(new Set(after.slots.map((s) => s.key)).size).toBe(10);

  // 준비 화면의 초안은 어떤 조작 뒤에도 팀 A = 블루팀이다.
  expect(after.teamASide, `${where}: 팀 A는 블루`).toBe("blue");
  // 진영 바꾸기 두 번 = 원래(진영·추첨 기록·직전 편성 포함).
  expect(swapSides(swapSides(after)), `${where}: 진영 바꾸기 두 번`).toEqual(after);

  const recordsPrevious = after !== before && after.previousSlots === before.slots;
  if (recordsPrevious) {
    // 직전 편성으로 되돌리면 조작 직전 자리와 정확히 같다.
    expect(undoDraft(after).slots, `${where}: 되돌리기`).toEqual(before.slots);
    // 이력을 남긴 조작은 다시 앞으로를 지운다.
    expect(after.redoSlots ?? null, `${where}: 다시 앞으로 지움`).toBeNull();
  }
  // 되돌리기 이력(2026-11-07): 5개 이하, previousSlots는 이력의 마지막과 같다. 이력을 끝까지 되돌리면 이력 순서대로 복원된다.
  const history = historyOf(after);
  expect(history.length, `${where}: 이력 ${HISTORY_MAX}개 이하`).toBeLessThanOrEqual(HISTORY_MAX);
  expect(after.previousSlots ?? null, `${where}: previousSlots = 이력 마지막`).toEqual(history[history.length - 1] ?? null);
  let rewound = after;
  for (let k = history.length - 1; k >= 0; k--) {
    rewound = undoDraft(rewound);
    expect(rewound.slots, `${where}: ${history.length - k}번 되돌리기`).toEqual(history[k]);
    expect(isCompleteDraft(rewound)).toBe(true);
  }
  expect(undoDraft(rewound), `${where}: 이력 끝`).toBe(rewound);

  switch (op) {
    case "teamShuffle": {
      // 팀까지 올랜덤: 모든 순위 칸(1·2·3·4·미지정)에서 두 팀 인원 차 ≤ 1.
      for (const c of priorityCounts(after, priorities)) {
        expect(Math.abs(c.a - c.b), `${where}: ${c.priority ?? "미지정"} 인원 차`).toBeLessThanOrEqual(1);
      }
      // 고정은 applyTeams와 같은 규칙(같은 팀에서 겹친 뒤 사람만 풀림), 추첨 기록은 비움, 되돌리기 기록.
      checkLocksAfterRegroup(before, after, where);
      expect(after.draws).toEqual({});
      expect(recordsPrevious, `${where}: 직전 편성 기록`).toBe(true);
      // 진영·조건은 그대로. 순위 균형을 지키면서 조건을 지킬 수 있었으면 지켰다.
      expect(after.teamASide).toBe(before.teamASide);
      expect(after.constraints).toBe(before.constraints);
      const again = shuffleTeamsByPriority(before, priorities, WEIGHTS, avoid);
      expect(again.draft, `${where}: 결정적`).toEqual(after);
      if (again.constraintsKept) expect(violatedConstraints(after), `${where}: 조건 준수`).toEqual([]);
      expect(after.seed).not.toBe(before.seed);
      break;
    }
    case "shuffle":
    case "shuffleFair": {
      // 라인 섞기: 팀원(각 팀 5명 집합)은 반드시 그대로이고, 고정한 사람은 포지션·고정 모두 그대로다.
      for (const team of TEAMS) {
        expect(keysOf(after.slots.filter((s) => s.team === team)), `${where}: 팀 ${team} 팀원 그대로`).toEqual(
          keysOf(before.slots.filter((s) => s.team === team)),
        );
      }
      for (const b of before.slots) {
        expect(slotOf(after, b.key).locked, `${where}: 고정 유지`).toBe(b.locked);
        if (b.locked) expect(slotOf(after, b.key).position, `${where}: 고정 포지션 유지`).toBe(b.position);
      }
      // 조건은 섞기에 쓰지 않는다(팀 추천에만): 섞기 전후로 어기는 조건이 같다.
      expect(violatedConstraints(after)).toEqual(violatedConstraints(before));
      expect(after.draws).toEqual({});
      expect(recordsPrevious, `${where}: 직전 편성 기록`).toBe(true);
      if (op === "shuffleFair" && ctx.enabled) {
        for (const team of TEAMS) {
          const sup = supporterKey(after, team)!;
          if (slotOf(after, sup).locked) continue;
          const zero = after.slots.filter(
            (s) => s.team === team && !s.locked && supportCountOf(after, s.key, ctx) === 0,
          );
          if (zero.length > 0) {
            expect(supportCountOf(after, sup, ctx), `${where}: 공평 섞기 서포터 0회 (팀 ${team})`).toBe(0);
          } else {
            expect(supportTeamState(after, team, ctx) === "all-assigned" || zero.length === 0).toBe(true);
          }
        }
      }
      break;
    }
    case "draw": {
      // 팀 구성은 그대로, 바뀐 사람은 팀마다 최대 두 명(새 서포터와 원래 서포터)이다.
      for (const s of before.slots) expect(slotOf(after, s.key).team, `${where}: 팀 구성 그대로`).toBe(s.team);
      for (const team of TEAMS) {
        const changed = before.slots.filter(
          (s) => s.team === team && JSON.stringify(s) !== JSON.stringify(slotOf(after, s.key)),
        );
        const state = supportTeamState(before, team, ctx);
        if (state !== "ready") {
          // 바꿀 수 없는 팀(모두 배정받음·고정·지금 서포터만 남음)은 그대로다. 단 이미 적용된 같은 결과는 유지될 수 있다.
          const record = before.draws[team];
          if (!record) expect(changed, `${where}: ${state} 팀 그대로`).toEqual([]);
        }
        if (changed.length === 0) continue;
        expect(changed.length, `${where}: 바뀐 사람 2명`).toBe(2);
        const inKey = supporterKey(after, team)!;
        const outKey = supporterKey(before, team)!;
        expect(changed.map((s) => s.key).sort()).toEqual([inKey, outKey].sort());
        // 새 서포터는 0회·비고정. 원래 서포터는 새 서포터의 원래 포지션으로.
        expect(supportCountOf(after, inKey, ctx), `${where}: 새 서포터 0회`).toBe(0);
        expect(slotOf(after, inKey).locked).toBe(false);
        expect(slotOf(before, outKey).locked).toBe(false);
        expect(slotOf(after, outKey).position).toBe(slotOf(before, inKey).position);
      }
      if (after !== before) expect(recordsPrevious, `${where}: 직전 편성 기록`).toBe(true);
      break;
    }
    case "reroll": {
      for (const s of before.slots) {
        const a = slotOf(after, s.key);
        expect(a.team).toBe(s.team);
        expect(a.locked).toBe(s.locked);
        if (s.locked) expect(a.position, `${where}: 고정 포지션 유지`).toBe(s.position);
      }
      expect(after.draws).toEqual({});
      break;
    }
    case "applyTeams":
      checkLocksAfterRegroup(before, after, where);
      expect(after.draws).toEqual({});
      break;
    case "swapSides":
      for (const s of before.slots) {
        const a = slotOf(after, s.key);
        expect(a.team).toBe(s.team === "A" ? "B" : "A");
        expect(a.position).toBe(s.position);
        expect(a.locked).toBe(s.locked);
      }
      expect(after.teamASide).toBe("blue");
      break;
    case "legacySide":
      // "red"였으면 두 팀을 맞바꿔(블루였던 5명이 그대로 블루) 맞추고, 없었으면 자리 그대로 A를 블루로 둔다.
      expect([before.slots, swapSides(before).slots], `${where}: 예전 초안 맞추기`).toContainEqual(after.slots);
      break;
    case "randomSide":
      // 반반 확률로 진영 바꾸기. 바꾸지 않으면 자리 그대로다. 시드는 전진한다.
      expect([before.slots, swapSides(before).slots], `${where}: 진영 랜덤`).toContainEqual(after.slots);
      expect(after.seed).not.toBe(before.seed);
      break;
    case "undo": {
      // 여러 단계(2026-11-07): 이력에서 하나를 꺼내고, 되돌리기 전 자리는 다시 앞으로에 남는다.
      // (예전 한 단계 동작 "한 번 더 누르면 돌아온다"는 다시 앞으로(redo)가 맡는다.)
      const was = historyOf(before);
      if (was.length > 0) {
        expect(after.slots).toEqual(was[was.length - 1]);
        expect(historyOf(after)).toEqual(was.slice(0, -1));
        expect(after.redoSlots).toEqual(before.slots);
        expect(redoDraft(after).slots, `${where}: 다시 앞으로`).toEqual(before.slots);
      } else {
        expect(after).toBe(before);
      }
      break;
    }
    case "redo":
      if (before.redoSlots) {
        expect(after.slots).toEqual(before.redoSlots);
        expect(recordsPrevious, `${where}: 다시 앞으로도 이력에 남김`).toBe(true);
      } else {
        expect(after).toBe(before);
      }
      break;
    case "lock":
      for (const s of before.slots) {
        const a = slotOf(after, s.key);
        expect(a.team).toBe(s.team);
        expect(a.position).toBe(s.position);
      }
      break;
    case "constraint":
    case "removeConstraint":
      expect(after.slots).toEqual(before.slots);
      break;
    case "swapPeople":
      for (const s of before.slots) {
        const a = slotOf(after, s.key);
        if (a.team === s.team && a.position === s.position) expect(a.locked).toBe(s.locked);
      }
      break;
  }

  // 화면이 쓰는 판단 함수들이 어떤 편성에서도 일관되다.
  const full = allAssignedTeams(after, ctx);
  expect(resetCountsReady(after, ctx)).toBe(full.length > 0);
  for (const team of TEAMS) {
    const everyone = after.slots.filter((s) => s.team === team).every((s) => supportCountOf(after, s.key, ctx) >= 1);
    expect(full.includes(team)).toBe(ctx.enabled && everyone);
  }
  // 반복 확인: 이번 주기 'used' 사건이 있는 서포터는 묻든(repeat) 묻지 않든(fair) 빠짐없이 한쪽에 들어간다.
  // (서버는 그런 서포터의 ack가 없으면 SUPPORT_REPEAT로 시작을 거절한다.)
  const repeat = repeatSupporterIds(after, ctx);
  const fair = fairRepeatSupporterIds(after, ctx);
  for (const team of TEAMS) {
    const sup = supporterKey(after, team)!;
    const id = after.people.find((p) => p.key === sup)!.participantId;
    const used = id !== null && ctx.usedIds.has(id);
    expect(repeat.includes(id!) || fair.includes(id!), `${where}: used 서포터 ack`).toBe(used && ctx.enabled);
    expect(repeat.includes(id!) && fair.includes(id!)).toBe(false);
    // 직접 입력으로 0회가 된 사람은 'used' 사건이 있어도 묻지 않는다(공평한 반복으로 ack).
    if (used && ctx.enabled && supportCountOf(after, sup, ctx) === 0) expect(fair).toContain(id);
  }
}

/**
 * 무작위 기피 라인(사람마다 0~4개, 절반은 없음). 가끔은 여러 사람이 같은 라인을 피해 다 지킬 수 없게 만든다.
 * 새 이름(참가자 ID 없음)은 화면처럼 넣지 않는다.
 */
function randomAvoid(ps: readonly DraftPerson[], rng: () => number): AvoidMap {
  const map: Record<string, Position[]> = {};
  const crowd = rng() < 0.2 ? POSITIONS[Math.floor(rng() * 5)]! : null;
  for (const p of ps) {
    if (p.participantId === null) continue;
    if (crowd && rng() < 0.8) {
      map[p.key] = [crowd];
      continue;
    }
    if (rng() < 0.5) continue;
    const n = 1 + Math.floor(rng() * 4);
    map[p.key] = shuffle(POSITIONS, rng).slice(0, n);
  }
  return map;
}

/**
 * 한 시드로 조작 순서를 만들고 끝까지 돌린다. 마지막 초안과 조작 수를 돌려준다.
 * withAvoid면 기피 라인 맵을 만들어 섞기 조작에 넘긴다(맵은 별도 난수로 뽑아 조작 순서는 withAvoid가 아닐 때와 같다).
 */
function run(seed: number, check: boolean, withAvoid = false): { final: Draft; steps: number } {
  const rng = rngFromSeed(seed * 7919 + 1);
  const ctx = randomCtx(rng);
  const teamOf: Record<string, Team> = {};
  const ps = people(rng() < 0.2);
  const priorities = randomPriorities(ps, rng);
  ps.forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
  const avoid = withAvoid ? randomAvoid(ps, rngFromSeed(seed * 104729 + 7)) : undefined;
  let d = createDraft(ps, { groupId: "g", baseLiveVersion: 0, seed, now, teamOf: rng() < 0.5 ? teamOf : undefined, avoid });
  if (check && avoid) checkAvoid("reroll", d, avoid, `seed ${seed} createDraft`);
  const length = 20 + Math.floor(rng() * 21);
  // 되돌리기 이력의 독립 모형: 자리를 남긴 조작마다 직전 자리를 넣고(최근 5개), 되돌리기는 하나 꺼내고,
  // 진영 바꾸기(진영 랜덤·예전 "red" 초안 읽기 포함)는 모두 뒤집는다. 초안의 이력이 이 모형과 늘 같아야 한다.
  let model: DraftSlot[][] = [];
  const flip = (slots: DraftSlot[]) => slots.map((s) => ({ ...s, team: (s.team === "A" ? "B" : "A") as Team }));
  for (let i = 0; i < length; i++) {
    const op = OPS[Math.floor(rng() * OPS.length)]!;
    const before = d;
    d = apply(d, op, ctx, rng, priorities, avoid);
    if (check) {
      const where = `seed ${seed}${avoid ? " 기피" : ""} step ${i} ${op}`;
      checkStep({ op, before, after: d }, ctx, where, priorities, avoid);
      if (avoid) checkAvoid(op, d, avoid, where);
      if (d !== before && d.previousSlots === before.slots) model = [...model, before.slots].slice(-HISTORY_MAX);
      else if (op === "undo" && d !== before) model = model.slice(0, -1);
      else if (
        (op === "swapSides" || op === "randomSide" || op === "legacySide") &&
        JSON.stringify(d.slots) === JSON.stringify(swapSides(before).slots)
      )
        model = model.map(flip);
      expect(historyOf(d), `${where}: 이력 모형과 같음`).toEqual(model);
    }
  }
  return { final: d, steps: length };
}

describe("팀 섞기 대량 무작위 점검", () => {
  it("시드 1500개 × 조작 20~40번: 매 단계 불변식, 같은 시드·같은 조작이면 같은 결과", () => {
    let steps = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const first = run(seed, true);
      steps += first.steps;
      if (seed % 10 === 0) expect(run(seed, false).final).toEqual(first.final);
    }
    expect(steps).toBeGreaterThan(40000);
  });

  it("기피 라인 맵을 넣은 시드 800개: 같은 불변식 + 섞기마다 팀별 기피 어김이 최소, 결정적", () => {
    let steps = 0;
    for (let seed = 1; seed <= 800; seed++) {
      const first = run(seed, true, true);
      steps += first.steps;
      if (seed % 10 === 0) expect(run(seed, false, true).final).toEqual(first.final);
    }
    expect(steps).toBeGreaterThan(20000);
  });

  it("빈 기피 맵은 결과를 바꾸지 않는다(같은 시드·같은 조작 = 같은 편성)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = rngFromSeed(seed);
      const ps = people(false);
      let d = createDraft(ps, { groupId: "g", baseLiveVersion: 0, seed, now });
      expect(createDraft(ps, { groupId: "g", baseLiveVersion: 0, seed, now, avoid: {} })).toEqual(d);
      const ctx = randomCtx(rng);
      for (let i = 0; i < 10; i++) {
        const op = OPS[Math.floor(rng() * OPS.length)]!;
        const pickSeed = (rng() * 0xffffffff) >>> 0;
        const pri = randomPriorities(ps, rng);
        const plain = apply(d, op, ctx, rngFromSeed(pickSeed), pri);
        expect(apply(d, op, ctx, rngFromSeed(pickSeed), pri, {}), `seed ${seed} ${op}`).toEqual(plain);
        d = plain;
      }
    }
  });
});

describe("치우침 점검", () => {
  function base(seed: number): Draft {
    const teamOf: Record<string, Team> = {};
    people(false).forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
    return createDraft(people(false), { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
  }
  const none: RotationContext = { enabled: true, cycleId: "c1", usedIds: new Set(), eventCount: 0, counts: new Map() };

  it("올랜덤: 각 사람이 팀 안에서 각 포지션에 갈 비율은 20% 근처다(팀은 바뀌지 않는다)", () => {
    const N = 8000;
    const pos = new Map<string, number>();
    for (let seed = 1; seed <= N; seed++) {
      const next = shuffleDraft(base(seed), { fairSupport: false }, none);
      for (const s of next.slots) pos.set(`${s.key}|${s.position}`, (pos.get(`${s.key}|${s.position}`) ?? 0) + 1);
    }
    for (let i = 0; i < 10; i++) {
      for (const p of POSITIONS) expect(Math.abs((pos.get(`p:id${i}|${p}`) ?? 0) / N - 0.2)).toBeLessThan(0.025);
    }
  });

  it("이어서 누른 올랜덤(시드가 이어짐)도 치우치지 않는다", () => {
    let d = base(42);
    const N = 6000;
    const counts = new Map<string, number>();
    for (let i = 0; i < N; i++) {
      d = shuffleDraft(d, { fairSupport: false }, none);
      const p = slotOf(d, "p:id0").position;
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const p of POSITIONS) expect(Math.abs((counts.get(p) ?? 0) / N - 0.2)).toBeLessThan(0.025);
  });

  it("서포터만 바꾸기: 0회 후보들 사이에서 고르게 뽑는다", () => {
    const N = 6000;
    const hits = new Map<string, number>();
    for (let seed = 1; seed <= N; seed++) {
      const d = base(seed);
      const sup = supporterKey(d, "A")!;
      // 팀 A: 지금 서포터와 한 명은 1회, 나머지 세 명이 0회 후보다.
      const others = d.slots.filter((s) => s.team === "A" && s.key !== sup).map((s) => s.key).sort();
      const counts = new Map<string, number>([[sup.slice(2), 1], [others[0]!.slice(2), 1]]);
      const ctx: RotationContext = { ...none, counts, usedIds: new Set(counts.keys()) };
      const inKey = drawSupport(d, ["A"], ctx).draft.draws.A!.inKey;
      const rank = others.indexOf(inKey);
      expect(rank).toBeGreaterThan(0);
      hits.set(String(rank), (hits.get(String(rank)) ?? 0) + 1);
    }
    for (const rank of ["1", "2", "3"]) expect(Math.abs((hits.get(rank) ?? 0) / N - 1 / 3)).toBeLessThan(0.03);
  });

  it("올랜덤 + 서포터 공평하게: 팀의 0회 후보 중 누가 서포터가 될지 고르다", () => {
    const N = 6000;
    // id0~id4만 0회. 섞인 팀마다 그 팀의 0회 사람 중 하나가 서포터다. id0이 서포터가 되는 비율 = 기대값과 비교.
    const counts = new Map(Array.from({ length: 5 }, (_, i) => [`id${i + 5}`, 1]));
    const ctx: RotationContext = { ...none, counts, usedIds: new Set(counts.keys()) };
    let id0 = 0;
    let expected = 0;
    for (let seed = 1; seed <= N; seed++) {
      const next = shuffleDraft(base(seed), { fairSupport: true }, ctx);
      const team = slotOf(next, "p:id0").team;
      const zeros = next.slots.filter((s) => s.team === team && supportCountOf(next, s.key, ctx) === 0).length;
      expected += 1 / zeros;
      if (slotOf(next, "p:id0").position === "support") id0++;
    }
    expect(Math.abs(id0 - expected) / N).toBeLessThan(0.02);
  });
});
