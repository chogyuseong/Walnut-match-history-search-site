import { pushHistory, rerollPositions, rngFromSeed, type AvoidMap, type Draft, type DraftSlot, type DrawRecord } from "./draft";
import { TEAMS, type Position, type RotationView, type Team } from "./types";

/**
 * 서포터 순환의 기기 쪽 로직(docs/P2 P2-5, 해법 ③). 화면에서는 "서포터 횟수"라고 부른다.
 * 서버는 시작 요청에서 양팀 서포터마다 사건을 남긴다(주기 첫 번째는 used, 그 뒤는 repeat, 미진행 취소는 무효).
 * 기기는 활성 주기의 유효 사건 수를 "서포터로 간 횟수"로 보고, 같은 팀에서 아직 서포터를 안 간 사람(0회)만
 * 새 서포터로 고른다. 팀 5명이 모두 한 번 이상 갔으면 그 팀은 바꾸지 않고 횟수 초기화를 안내한다.
 * 추첨·섞기는 기기 초안 안에서만 일어나므로 횟수를 올리지 않는다. 실제로 시작한 경기만 센다.
 * 횟수 초기화 = 새 주기(POST /rotation/new-cycle). 새 내전(세션)을 시작해도 새 주기가 된다.
 */
export interface RotationContext {
  enabled: boolean;
  cycleId: string | null;
  /** 이번 주기에서 첫 차례(used)를 쓴 참가자 ID. 서버가 반복 확인(SUPPORT_REPEAT)을 묻는 기준이다. */
  usedIds: ReadonlySet<string>;
  /** 주기의 유효 사건 수. */
  eventCount: number;
  /**
   * 참가자 ID → 이번 주기에 서포터로 간 횟수(used + repeat, 무효 제외 + 직접 넣은 보정값, 0 미만은 0).
   * 없으면 usedIds로 1회씩 센다. 팀 상태·후보·알림·초기화 버튼이 모두 이 값을 쓴다.
   */
  counts?: ReadonlyMap<string, number>;
}

export function rotationContext(enabled: boolean, rotation: RotationView | null): RotationContext {
  // 스냅숏의 rotation.events는 활성 주기의 무효가 아닌 사건만 담는다(src/server/snapshot.ts).
  const events = rotation?.events ?? [];
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.participantId, (counts.get(e.participantId) ?? 0) + 1);
  // 서포터 횟수 직접 입력의 보정값을 더한다(0 미만이면 0). 'used' 사건(usedIds)은 그대로라 서버의 반복 확인과 맞는다.
  for (const a of rotation?.adjustments ?? []) {
    const n = Math.max(0, (counts.get(a.participantId) ?? 0) + a.delta);
    if (n > 0) counts.set(a.participantId, n);
    else counts.delete(a.participantId);
  }
  return {
    enabled,
    cycleId: rotation?.cycleId ?? null,
    usedIds: new Set(events.filter((e) => e.kind === "used").map((e) => e.participantId)),
    eventCount: events.length,
    counts,
  };
}

/** 참가자 ID → 서포터로 간 횟수. 기록이 없는 사람은 들어 있지 않다(0회). */
export function supportCounts(ctx: RotationContext): ReadonlyMap<string, number> {
  if (ctx.counts) return ctx.counts;
  return new Map([...ctx.usedIds].map((id) => [id, 1]));
}

function participantIdOf(draft: Draft, key: string): string | null {
  return draft.people.find((p) => p.key === key)?.participantId ?? null;
}

/** 초안의 한 사람이 서포터로 간 횟수. 아직 참가자 ID가 없는 새 이름은 0회. */
export function supportCountOf(draft: Draft, key: string, ctx: RotationContext): number {
  const id = participantIdOf(draft, key);
  return id === null ? 0 : (supportCounts(ctx).get(id) ?? 0);
}

/** 이번 주기에 첫 차례(used)를 쓴 사람인지. 서버가 반복 확인을 묻는 기준과 같다. */
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
 * 서포터 고르기 규칙(팀 하나). 이 함수 하나를 "서포터만 바꾸기"와 "올랜덤 + 서포터 공평하게"가 같이 쓴다.
 * - 서포터 자리에 고정된 사람이 있으면 그 사람만(바꾸지 않는다).
 * - 아니면 팀 5명 중 포지션 고정이 아니고 이번 주기에 서포터를 한 번도 안 간 사람(0회)이 후보다.
 *   모두 한 번 이상 갔으면 후보가 없다(그 팀은 바꾸지 않고 횟수 초기화를 안내한다).
 */
export function fairSupportPool(draft: Draft, team: Team, ctx: RotationContext): { keys: string[]; locked: boolean } {
  const team5 = members(draft, team);
  const supporter = team5.find((s) => s.position === "support");
  if (supporter?.locked) return { keys: [supporter.key], locked: true };
  return {
    keys: team5.filter((s) => !s.locked && supportCountOf(draft, s.key, ctx) === 0).map((s) => s.key),
    locked: false,
  };
}

/**
 * 팀 하나의 서포터 상태.
 * - all-assigned: 팀 5명이 모두 이번 주기에 서포터를 한 번 이상 갔다. 바꾸지 않고 "모두 배정받았어요"를 알린다.
 * - supporter-locked: 서포터 자리가 고정돼 있다.
 * - only-current: 아직 안 간 사람이 지금 서포터뿐이거나, 나머지 안 간 사람이 모두 포지션 고정이다.
 * - ready: 지금 서포터가 아닌 후보(0회, 고정 아님)가 있다.
 * all-assigned를 먼저 본다. 횟수 초기화 버튼을 켜는 조건이기 때문이다(resetCountsReady).
 */
export type SupportTeamState = "all-assigned" | "supporter-locked" | "only-current" | "ready";

export function supportTeamState(draft: Draft, team: Team, ctx: RotationContext): SupportTeamState {
  const team5 = members(draft, team);
  if (team5.length > 0 && team5.every((s) => supportCountOf(draft, s.key, ctx) >= 1)) return "all-assigned";
  const pool = fairSupportPool(draft, team, ctx);
  if (pool.locked) return "supporter-locked";
  const current = supporterKey(draft, team);
  return pool.keys.some((key) => key !== current) ? "ready" : "only-current";
}

/** 팀 5명이 모두 서포터를 한 번 이상 간 팀. 화면의 "모두 서포터를 배정받았어요" 알림 대상이다. */
export function allAssignedTeams(draft: Draft, ctx: RotationContext): Team[] {
  if (!ctx.enabled) return [];
  return TEAMS.filter((team) => supportTeamState(draft, team, ctx) === "all-assigned");
}

/** 준비 화면의 "서포터 횟수 초기화" 버튼을 켤지. 지금 초안의 두 팀 중 하나라도 모두 배정받았을 때만 켠다. */
export function resetCountsReady(draft: Draft, ctx: RotationContext): boolean {
  return allAssignedTeams(draft, ctx).length > 0;
}

/**
 * 팀의 추첨 조건 지문.
 * 들어가는 것: 팀 5명, 추첨 전 서포터, 포지션 고정, 주기 ID, 팀 5명 각자의 서포터 횟수.
 * 들어가지 않는 것: 표시 이름, 화면 좌우, 진영, 표시 설정, 다른 팀 사람의 횟수. 그래서 바뀌어도 추첨이 유지된다.
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
    team5.map((s) => `${s.key}:${supportCountOf(draft, s.key, ctx)}`).sort(),
  ]);
}

/** 바꿀 수 없는 이유. 팀 상태(supportTeamState) 중 ready가 아닌 것. */
export type CandidateBlock = Exclude<SupportTeamState, "ready"> | null;

/**
 * "서포터만 바꾸기" 후보: 서포터 고르기 규칙(fairSupportPool)의 후보에서 지금 서포터를 뺀 사람.
 * 지금 서포터도 0회면 다른 0회인 사람으로 바뀐다(누르면 바뀌는 것이 보이게).
 */
export function drawCandidates(
  draft: Draft,
  team: Team,
  ctx: RotationContext,
): { candidates: string[]; block: CandidateBlock } {
  const state = supportTeamState(draft, team, ctx);
  if (state !== "ready") return { candidates: [], block: state };
  const current = supporterKey(draft, team);
  return { candidates: fairSupportPool(draft, team, ctx).keys.filter((key) => key !== current), block: null };
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
  // 추첨 뒤에 실제 경기로 이 팀 사람의 횟수가 바뀌었다면 지문이 달라져 위에서 걸린다.
  if (inSlot.position === "support" && outSlot.position === record.fromPosition) return "applied";
  if (outSlot.position === "support" && inSlot.position === record.fromPosition) {
    return "reapplicable";
  }
  return "stale";
}

function applyRecord(draft: Draft, team: Team, record: DrawRecord): Draft {
  // 되돌리기 이력은 drawSupport가 추첨 전 편성 기준으로 한 번만 남긴다.
  return {
    ...draft,
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
  /** drawn: 새로 뽑음. blocked: 뽑을 수 없음. kept는 예전 동작(같은 조건이면 유지)의 값으로 지금은 나오지 않는다. */
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
  // 누를 때마다 새로 뽑는다(2026-11-06 사용자 결정). 예전에는 같은 조건이면 기존 결과를 유지했다.
  // 후보에서 지금 서포터를 빼므로, 안 간 사람이 둘 이상이면 누를 때마다 서포터가 바뀐다.
  const { candidates, block } = drawCandidates(draft, team, ctx);
  const outKey = supporterKey(draft, team);
  if (block || outKey === null) return { team, kind: "blocked", block: block ?? "only-current" };
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
  /** 팀 5명이 모두 서포터를 한 번 이상 가서 바꾸지 않은 팀. 화면이 "모두 서포터를 배정받았어요"를 알린다. */
  allAssigned: Team[];
}

/**
 * 서포터만 바꾸기(이전 이름 "서포터 추첨").
 * 팀마다 아직 서포터를 안 간 사람(fairSupportPool) 중 지금 서포터가 아닌 사람을 뽑아
 * 새 서포터와 기존 서포터의 포지션만 맞바꾸고 나머지 8명은 유지한다.
 * 누를 때마다 새로 뽑는다: 안 간 사람이 둘 이상이면 매번 다른 사람이 서포터가 된다(같은 시드·같은 편성이면 결과는 같다).
 * 두 팀을 따로 판단한다: 바꿀 수 없는 팀(모두 배정받음·고정·지금 서포터만 남음)은 그대로 두고
 * 바꿀 수 있는 팀만 바로 적용한다(묻지 않는다).
 */
export function drawSupport(draft: Draft, teams: readonly Team[], ctx: RotationContext): DrawResult {
  const rng = rngFromSeed(draft.seed);
  const outcomes = teams.map((team) => planTeamDraw(draft, team, ctx, rng));
  const possible = outcomes.filter((o) => o.kind !== "blocked");
  const allAssigned = outcomes.filter((o) => o.block === "all-assigned").map((o) => o.team);
  let next = draft;
  let drew = false;
  for (const outcome of possible) {
    const status = drawStatus(next, outcome.team, ctx);
    if (outcome.kind === "kept" && status === "applied") continue;
    next = applyRecord(next, outcome.team, outcome.record!);
    if (outcome.kind === "drawn") drew = true;
  }
  if (drew) next = { ...next, seed: (Math.imul(next.seed, 1664525) + 1013904223) >>> 0 };
  // 여러 팀을 한 번에 적용해도 되돌리기 이력은 한 단계(추첨 전 편성)만 남긴다.
  if (next !== draft) next = pushHistory(draft, next);
  return { draft: next, outcomes, allAssigned };
}

/**
 * 이미 간 사람이 서포터일 때 그것이 공평한지: 같은 팀에 아직 안 간 사람(고정 아님)이 없으면 공평하다.
 * 안 간 사람이 있는데도 이미 간 사람이 서포터면 시작 전에 확인을 묻는다.
 */
function isFairSupporter(draft: Draft, team: Team, key: string, ctx: RotationContext): boolean {
  const others = members(draft, team).filter((s) => s.key !== key && !s.locked);
  return others.every((s) => supportCountOf(draft, s.key, ctx) >= 1);
}

function repeatIds(draft: Draft, ctx: RotationContext, fair: boolean): string[] {
  if (!ctx.enabled) return [];
  const result: string[] = [];
  for (const team of TEAMS) {
    const key = supporterKey(draft, team);
    // 직접 입력으로 0회가 된 사람은 'used' 사건이 있어도 안 간 사람으로 본다: 묻지 않고 ack에 넣는다.
    const isFair = (k: string) => supportCountOf(draft, k, ctx) === 0 || isFairSupporter(draft, team, k, ctx);
    if (key && hasUsedTurn(draft, key, ctx) && isFair(key) === fair) {
      result.push(draft.people.find((p) => p.key === key)!.participantId!);
    }
  }
  return result;
}

/**
 * 이번 주기에 이미 서포터로 간 사람이 서포터 자리에 있고, 같은 팀에 아직 안 간 사람(고정 아님)이 있는 경우.
 * 시작 전에 알리고 확인받는다(서버의 SUPPORT_REPEAT·ackRepeat 흐름은 그대로).
 */
export function repeatSupporterIds(draft: Draft, ctx: RotationContext): string[] {
  return repeatIds(draft, ctx, false);
}

/**
 * 이미 간 사람이 서포터지만 같은 팀에 아직 안 간 사람(고정 아님)이 없어 공평한 반복인 경우(모두 한 번씩 간 뒤 등).
 * 묻지 않고 시작 요청의 ackRepeat에 넣는다.
 */
export function fairRepeatSupporterIds(draft: Draft, ctx: RotationContext): string[] {
  return repeatIds(draft, ctx, true);
}

/** 두 사람의 포지션만 맞바꾼 자리. */
function swapPositions(slots: DraftSlot[], keyA: string, keyB: string): DraftSlot[] {
  const a = slots.find((s) => s.key === keyA)!;
  const b = slots.find((s) => s.key === keyB)!;
  return slots.map((s) => {
    if (s.key === keyA) return { ...s, position: b.position };
    if (s.key === keyB) return { ...s, position: a.position };
    return s;
  });
}

/**
 * 라인 섞기(준비 화면). 팀원은 그대로 두고 각 팀 안에서 라인만 섞는다. 한 함수로 두 가지:
 * - fairSupport=false "올랜덤": 팀마다 포지션 무작위(고정 유지). draft.ts의 rerollPositions와 같다.
 * - fairSupport=true "올랜덤 + 서포터 공평하게": 위와 같이 섞은 뒤 각 팀에 서포터 고르기 규칙(fairSupportPool)을
 *   적용해 아직 안 간 사람 중 뽑힌 사람과 지금 서포터의 포지션만 맞바꾼다. 팀에 안 간 사람이 없으면
 *   그 팀 서포터는 무작위 결과 그대로 둔다(화면은 allAssignedTeams로 "모두 배정받았어요"를 알린다).
 * 섞은 뒤에도 "서포터만 바꾸기"가 같은 규칙으로 이어서 동작한다. 같은 팀·다른 팀 조건은 팀 추천에만 쓴다.
 * 추첨 기록은 비우고, 직전 편성으로 되돌릴 수 있다. 진영 선택은 A/B 자리 기준이라 그대로 둔다.
 * avoid(기피 라인)를 넘기면 라인을 섞을 때 되도록 피한다. 서포터를 고르는 규칙은 기피보다 먼저라 그대로다
 * (뽑힌 사람이 서포터를 기피해도 서포터가 된다). 비어 있으면 예전과 같은 결과다.
 */
export function shuffleDraft(
  draft: Draft,
  options: { fairSupport: boolean; avoid?: AvoidMap },
  ctx: RotationContext,
): Draft {
  const shuffled = rerollPositions(draft, options.avoid);
  if (!options.fairSupport) return shuffled;
  // 섞기에 쓴 난수와 겹치지 않게, 섞은 뒤의 시드로 서포터를 고른다.
  const rng = rngFromSeed(shuffled.seed);
  let slots = shuffled.slots;
  for (const team of TEAMS) {
    const current = { ...shuffled, slots };
    const pool = fairSupportPool(current, team, ctx);
    if (pool.locked || pool.keys.length === 0) continue;
    const pick = pool.keys[Math.floor(rng() * pool.keys.length)]!;
    const supporter = supporterKey(current, team);
    if (supporter && pick !== supporter) slots = swapPositions(slots, pick, supporter);
  }
  return { ...shuffled, slots, seed: (Math.imul(shuffled.seed, 1664525) + 1013904223) >>> 0 };
}
