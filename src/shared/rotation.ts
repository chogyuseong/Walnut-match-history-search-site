import { rngFromSeed, type Draft, type DraftSlot, type DrawRecord } from "./draft";
import { TEAMS, type Position, type RotationView, type Team } from "./types";

/**
 * 서포터 순환의 기기 쪽 로직(docs/P2 P2-5, 해법 ③).
 * 서버는 시작 요청에서 양팀 서포터를 이력과 대조해 차례를 소비할 뿐이고,
 * 추첨과 추첨 기록은 기기 초안 안에만 있다.
 */
export interface RotationContext {
  enabled: boolean;
  cycleId: string | null;
  /** 이번 주기에서 차례를 쓴 참가자 ID. */
  usedIds: ReadonlySet<string>;
  /** 주기의 유효 사건 수. 사건이 늘거나 줄면 지문이 달라진다. */
  eventCount: number;
}

export function rotationContext(enabled: boolean, rotation: RotationView | null): RotationContext {
  return {
    enabled,
    cycleId: rotation?.cycleId ?? null,
    usedIds: new Set(
      (rotation?.events ?? []).filter((e) => e.kind === "used").map((e) => e.participantId),
    ),
    eventCount: rotation?.events.length ?? 0,
  };
}

function participantIdOf(draft: Draft, key: string): string | null {
  return draft.people.find((p) => p.key === key)?.participantId ?? null;
}

export function hasUsedTurn(draft: Draft, key: string, ctx: RotationContext): boolean {
  const id = participantIdOf(draft, key);
  return id !== null && ctx.usedIds.has(id);
}

function members(draft: Draft, team: Team): DraftSlot[] {
  return draft.slots.filter((s) => s.team === team);
}

export function supporterKey(draft: Draft, team: Team): string | null {
  return members(draft, team).find((s) => s.position === "support")?.key ?? null;
}

/**
 * 팀의 추첨 조건 지문.
 * 들어가는 것: 팀 5명, 추첨 전 서포터, 포지션 고정, 주기 ID, 주기의 유효 사건 수.
 * 들어가지 않는 것: 표시 이름, 화면 좌우, 진영, 표시 설정. 그래서 바뀌어도 추첨이 유지된다.
 */
export function teamFingerprint(
  draft: Draft,
  team: Team,
  supporterBefore: string | null,
  ctx: RotationContext,
): string {
  const team5 = members(draft, team);
  return JSON.stringify([
    team5.map((s) => s.key).sort(),
    supporterBefore,
    team5
      .filter((s) => s.locked)
      .map((s) => `${s.key}:${s.position}`)
      .sort(),
    ctx.cycleId,
    ctx.eventCount,
  ]);
}

export type CandidateBlock = "supporter-locked" | "no-candidates" | null;

/** 추첨 후보: 팀 5명 중 지금 서포터가 아니고, 이번 주기에 차례를 쓰지 않았고, 고정되지 않은 사람. */
export function drawCandidates(
  draft: Draft,
  team: Team,
  ctx: RotationContext,
): { candidates: string[]; block: CandidateBlock } {
  const team5 = members(draft, team);
  const supporter = team5.find((s) => s.position === "support");
  if (supporter?.locked) return { candidates: [], block: "supporter-locked" };
  const candidates = team5
    .filter((s) => s.position !== "support" && !s.locked && !hasUsedTurn(draft, s.key, ctx))
    .map((s) => s.key);
  return { candidates, block: candidates.length === 0 ? "no-candidates" : null };
}

export type DrawStatus = "none" | "applied" | "reapplicable" | "stale";

/**
 * 팀의 추첨 기록이 지금도 유효한지 본다.
 * applied: 추첨 결과가 지금 편성에 그대로 반영돼 있다.
 * reapplicable: 추첨 전 상태로 돌아와 있어 같은 결과를 다시 적용할 수 있다.
 * stale: 조건이 바뀌어 다시 확인해야 한다.
 */
export function drawStatus(draft: Draft, team: Team, ctx: RotationContext): DrawStatus {
  const record = draft.draws[team];
  if (!record) return "none";
  const team5 = members(draft, team);
  const inSlot = team5.find((s) => s.key === record.inKey);
  const outSlot = team5.find((s) => s.key === record.outKey);
  if (!inSlot || !outSlot) return "stale";
  if (teamFingerprint(draft, team, record.outKey, ctx) !== record.fingerprint) return "stale";
  // 추첨 뒤에 다른 경로로 차례가 소비됐다면 지문의 사건 수가 달라져 위에서 걸린다.
  if (inSlot.position === "support" && outSlot.position === record.fromPosition) return "applied";
  if (outSlot.position === "support" && inSlot.position === record.fromPosition) {
    return "reapplicable";
  }
  return "stale";
}

function applyRecord(draft: Draft, team: Team, record: DrawRecord): Draft {
  return {
    ...draft,
    previousSlots: draft.slots,
    slots: draft.slots.map((s) => {
      if (s.key === record.inKey) return { ...s, position: "support" as Position };
      if (s.key === record.outKey) return { ...s, position: record.fromPosition };
      return s;
    }),
    draws: { ...draft.draws, [team]: record },
  };
}

export interface TeamDrawOutcome {
  team: Team;
  /** drawn: 새로 뽑음. kept: 같은 조건이라 기존 결과를 유지. blocked: 뽑을 수 없음. */
  kind: "drawn" | "kept" | "blocked";
  record?: DrawRecord;
  block?: CandidateBlock;
}

/** 한 팀의 추첨 결과를 계산한다. 초안은 바꾸지 않는다. */
function planTeamDraw(
  draft: Draft,
  team: Team,
  ctx: RotationContext,
  rng: () => number,
): TeamDrawOutcome {
  const status = drawStatus(draft, team, ctx);
  if (status === "applied" || status === "reapplicable") {
    return { team, kind: "kept", record: draft.draws[team]! };
  }
  const { candidates, block } = drawCandidates(draft, team, ctx);
  const outKey = supporterKey(draft, team);
  if (block || outKey === null) return { team, kind: "blocked", block: block ?? "no-candidates" };
  const inKey = candidates[Math.floor(rng() * candidates.length)]!;
  const fromPosition = draft.slots.find((s) => s.key === inKey)!.position;
  return {
    team,
    kind: "drawn",
    record: {
      fingerprint: teamFingerprint(draft, team, outKey, ctx),
      inKey,
      outKey,
      fromPosition,
    },
  };
}

export interface DrawResult {
  /** 적용 뒤의 초안. 아무것도 적용하지 않았으면 원래 초안과 같다. */
  draft: Draft;
  outcomes: TeamDrawOutcome[];
  /**
   * 양팀을 요청했는데 한쪽만 가능할 때 그 팀. 이 경우 아무것도 적용하지 않았고
   * 사용자가 그 팀만 적용할지 골라야 한다.
   */
  needsChoice: Team | null;
}

/**
 * 서포터 추첨.
 * 새 서포터와 기존 서포터의 포지션만 맞바꾸고 나머지는 유지한다.
 * 같은 조건에서 다시 누르면 같은 결과를 돌려준다.
 * 양팀 실행에서 한쪽만 가능하면 아무것도 바꾸지 않고 선택을 묻는다.
 */
export function drawSupport(draft: Draft, teams: readonly Team[], ctx: RotationContext): DrawResult {
  const rng = rngFromSeed(draft.seed);
  const outcomes = teams.map((team) => planTeamDraw(draft, team, ctx, rng));
  const possible = outcomes.filter((o) => o.kind !== "blocked");
  if (teams.length === 2 && possible.length === 1) {
    return { draft, outcomes, needsChoice: possible[0]!.team };
  }
  let next = draft;
  let drew = false;
  for (const outcome of possible) {
    const status = drawStatus(next, outcome.team, ctx);
    if (outcome.kind === "kept" && status === "applied") continue;
    next = applyRecord(next, outcome.team, outcome.record!);
    if (outcome.kind === "drawn") drew = true;
  }
  if (drew) next = { ...next, seed: (Math.imul(next.seed, 1664525) + 1013904223) >>> 0 };
  // 여러 팀을 한 번에 적용해도 되돌리기는 추첨 전 편성으로 간다.
  if (next !== draft) next = { ...next, previousSlots: draft.slots };
  return { draft: next, outcomes, needsChoice: null };
}

/** 이미 차례를 쓴 사람이 서포터 자리에 있는 경우(시작 전에 알리고 확인받는다). */
export function repeatSupporterIds(draft: Draft, ctx: RotationContext): string[] {
  if (!ctx.enabled) return [];
  const result: string[] = [];
  for (const team of TEAMS) {
    const key = supporterKey(draft, team);
    if (key && hasUsedTurn(draft, key, ctx)) {
      const id = draft.people.find((p) => p.key === key)!.participantId!;
      result.push(id);
    }
  }
  return result;
}
