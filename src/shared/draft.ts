import { satisfies, type TeamConstraint } from "./recommend";
import { POSITIONS, TEAMS, type MatchView, type Position, type Team } from "./types";

/**
 * 편성 초안. 기기에만 보관하고 서버에는 저장하지 않는다(docs/P2 P2-1).
 * "이 팀으로 시작"을 누를 때 명단 전체를 서버로 보내고 서버가 처음부터 검증한다.
 */
export const DRAFT_FORMAT_VERSION = 1;

export interface DraftPerson {
  /** 초안 안에서의 고유 키. 참가자 ID가 있으면 "p:ID", 아직 없으면 "n:이름키". */
  key: string;
  name: string;
  participantId: string | null;
}

export interface DraftSlot {
  key: string;
  team: Team;
  position: Position;
  /** 포지션 고정. 무작위 배정과 서포터 추첨이 이 사람의 자리를 바꾸지 않는다. */
  locked: boolean;
}

/** 서포터 추첨 기록. 같은 조건에서 다시 누르면 같은 결과를 돌려주기 위해 남긴다. */
export interface DrawRecord {
  fingerprint: string;
  /** 새로 서포터가 된 사람. */
  inKey: string;
  /** 서포터였다가 inKey의 자리로 간 사람. */
  outKey: string;
  /** inKey가 원래 있던 포지션. */
  fromPosition: Position;
}

export interface Draft {
  formatVersion: number;
  groupId: string | null;
  /** 이 초안을 만들 때 본 서버의 진행 상태 버전. 충돌 판단에만 쓴다. */
  baseLiveVersion: number | null;
  createdAt: string;
  people: DraftPerson[];
  slots: DraftSlot[];
  draws: Partial<Record<Team, DrawRecord>>;
  /** 직전 편성(1단계 되돌리기). */
  previousSlots: DraftSlot[] | null;
  /** "다음 경기 준비"로 만든 초안이면 안내 문구를 보여준다. */
  origin: "new" | "same-teams";
  seed: number;
  /** 같은 팀·다른 팀 조건. 팀 추천에만 쓰이고 손으로 옮기는 것은 막지 않는다. */
  constraints?: TeamConstraint[];
}

/** 시드로 재현할 수 있는 난수. */
export function rngFromSeed(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

/** 한 팀의 포지션을 무작위로 정한다. 고정된 사람은 그대로 둔다. */
function assignTeamPositions(slots: DraftSlot[], team: Team, rng: () => number): DraftSlot[] {
  const members = slots.filter((s) => s.team === team);
  const taken = new Set(members.filter((m) => m.locked).map((m) => m.position));
  const free = shuffle(
    POSITIONS.filter((p) => !taken.has(p)),
    rng,
  );
  let index = 0;
  return slots.map((s) => {
    if (s.team !== team || s.locked) return s;
    return { ...s, position: free[index++]! };
  });
}

function assignAllPositions(slots: DraftSlot[], rng: () => number): DraftSlot[] {
  let result = slots;
  for (const team of TEAMS) result = assignTeamPositions(result, team, rng);
  return result;
}

/** 팀별 5명, 팀 내 포지션 중복 없음을 만족하는지 확인한다. */
export function isCompleteDraft(draft: Draft): boolean {
  if (draft.people.length !== 10 || draft.slots.length !== 10) return false;
  for (const team of TEAMS) {
    const members = draft.slots.filter((s) => s.team === team);
    if (members.length !== 5) return false;
    if (new Set(members.map((m) => m.position)).size !== 5) return false;
  }
  return true;
}

export interface NewDraftOptions {
  groupId: string | null;
  baseLiveVersion: number | null;
  seed: number;
  now: string;
  /** 팀을 미리 정했으면 그대로 쓴다. 없으면 무작위로 5:5로 나눈다. */
  teamOf?: Record<string, Team>;
}

/** 10명으로 새 초안을 만든다. 포지션은 완전 무작위다. */
export function createDraft(people: DraftPerson[], options: NewDraftOptions): Draft {
  if (people.length !== 10) throw new Error("초안은 10명이어야 합니다.");
  const rng = rngFromSeed(options.seed);
  let teamOf = options.teamOf;
  if (!teamOf) {
    const order = shuffle(people, rng);
    teamOf = {};
    order.forEach((p, i) => {
      teamOf![p.key] = i < 5 ? "A" : "B";
    });
  }
  // 포지션은 임시로 채운 뒤 팀별로 무작위 배정한다.
  const counters: Record<Team, number> = { A: 0, B: 0 };
  const slots: DraftSlot[] = people.map((p) => {
    const team = teamOf![p.key]!;
    return { key: p.key, team, position: POSITIONS[counters[team]++ % 5]!, locked: false };
  });
  return {
    formatVersion: DRAFT_FORMAT_VERSION,
    groupId: options.groupId,
    baseLiveVersion: options.baseLiveVersion,
    createdAt: options.now,
    people,
    slots: assignAllPositions(slots, rng),
    draws: {},
    previousSlots: null,
    origin: "new",
    seed: nextSeed(options.seed),
  };
}

/** 포지션을 다시 뽑는다. 고정된 사람은 그대로다. 추첨 기록은 버린다. */
export function rerollPositions(draft: Draft): Draft {
  const rng = rngFromSeed(draft.seed);
  return {
    ...draft,
    previousSlots: draft.slots,
    slots: assignAllPositions(draft.slots, rng),
    draws: {},
    seed: nextSeed(draft.seed),
  };
}

/** 두 사람의 자리(팀과 포지션)를 맞바꾼다. 손으로 옮긴 사람의 고정은 풀린다. */
export function swapPeople(draft: Draft, keyA: string, keyB: string): Draft {
  if (keyA === keyB) return draft;
  const a = draft.slots.find((s) => s.key === keyA);
  const b = draft.slots.find((s) => s.key === keyB);
  if (!a || !b) return draft;
  return {
    ...draft,
    previousSlots: draft.slots,
    slots: draft.slots.map((s) => {
      if (s.key === keyA) return { ...s, team: b.team, position: b.position, locked: false };
      if (s.key === keyB) return { ...s, team: a.team, position: a.position, locked: false };
      return s;
    }),
  };
}

/**
 * 좌우 바꾸기(docs/P4 시나리오 19): 두 팀의 A·B 자리를 통째로 맞바꾼다.
 * 팀 구성·포지션·고정은 그대로이고 이름표(A/B)만 바뀐다.
 * 서포터 추첨 기록도 함께 옮긴다. 추첨 지문에는 팀 이름표가 들어가지 않으므로(rotation.ts)
 * 옮긴 기록은 그대로 유효하고, "두 팀 추첨 유지"가 깨지지 않는다.
 * 직전 편성(되돌리기)도 같은 방식으로 바꿔, 되돌려도 추첨 기록과 어긋나지 않게 한다.
 * 두 번 바꾸면 원래와 같다. 팀 조건(같은 팀·다른 팀)은 좌우와 무관하다.
 */
export function swapSides(draft: Draft): Draft {
  const flip = (slots: DraftSlot[]): DraftSlot[] =>
    slots.map((s) => ({ ...s, team: s.team === "A" ? "B" : "A" }));
  const draws: Partial<Record<Team, DrawRecord>> = {};
  if (draft.draws.B) draws.A = draft.draws.B;
  if (draft.draws.A) draws.B = draft.draws.A;
  return {
    ...draft,
    slots: flip(draft.slots),
    previousSlots: draft.previousSlots ? flip(draft.previousSlots) : null,
    draws,
  };
}

/** 한 사람을 초안에 없는 다른 사람으로 바꾼다. 자리(팀·포지션)는 그대로 물려받는다. */
export function replacePerson(draft: Draft, oldKey: string, person: DraftPerson): Draft {
  if (draft.people.some((p) => p.key === person.key)) return draft;
  if (!draft.people.some((p) => p.key === oldKey)) return draft;
  return {
    ...draft,
    previousSlots: null,
    people: draft.people.map((p) => (p.key === oldKey ? person : p)),
    // 빠진 사람에게 걸려 있던 조건은 함께 지운다.
    constraints: (draft.constraints ?? []).filter((c) => c.a !== oldKey && c.b !== oldKey),
    slots: draft.slots.map((s) => (s.key === oldKey ? { ...s, key: person.key, locked: false } : s)),
  };
}

/** 두 사람 사이의 조건을 넣는다. 같은 두 사람의 이전 조건은 새 조건으로 바뀐다. */
export function addConstraint(draft: Draft, constraint: TeamConstraint): Draft {
  if (constraint.a === constraint.b) return draft;
  const samePair = (c: TeamConstraint) =>
    (c.a === constraint.a && c.b === constraint.b) || (c.a === constraint.b && c.b === constraint.a);
  return {
    ...draft,
    constraints: [...(draft.constraints ?? []).filter((c) => !samePair(c)), constraint],
  };
}

export function removeConstraint(draft: Draft, index: number): Draft {
  return { ...draft, constraints: (draft.constraints ?? []).filter((_, i) => i !== index) };
}

/** 지금 편성이 어기고 있는 조건. */
export function violatedConstraints(draft: Draft): TeamConstraint[] {
  const teamA = new Set(draft.slots.filter((s) => s.team === "A").map((s) => s.key));
  return (draft.constraints ?? []).filter((c) => !satisfies(teamA, c));
}

export function toggleLock(draft: Draft, key: string): Draft {
  return {
    ...draft,
    slots: draft.slots.map((s) => (s.key === key ? { ...s, locked: !s.locked } : s)),
  };
}

/** 추천 등으로 정한 팀 구성을 적용한다. 포지션은 다시 뽑고 고정은 가능한 범위에서 유지한다. */
export function applyTeams(draft: Draft, teamA: readonly string[]): Draft {
  const inA = new Set(teamA);
  const rng = rngFromSeed(draft.seed);
  // 같은 팀 안에서 고정 포지션이 겹치면 뒤 사람의 고정을 푼다.
  const lockedTaken: Record<Team, Set<Position>> = { A: new Set(), B: new Set() };
  const slots = draft.slots.map((s) => {
    const team: Team = inA.has(s.key) ? "A" : "B";
    let locked = s.locked;
    if (locked) {
      if (lockedTaken[team].has(s.position)) locked = false;
      else lockedTaken[team].add(s.position);
    }
    return { ...s, team, locked };
  });
  return {
    ...draft,
    previousSlots: draft.slots,
    slots: assignAllPositions(slots, rng),
    draws: {},
    seed: nextSeed(draft.seed),
  };
}

/** 직전 편성으로 되돌린다. 한 번 더 누르면 다시 돌아온다. */
export function undoDraft(draft: Draft): Draft {
  if (!draft.previousSlots) return draft;
  return { ...draft, slots: draft.previousSlots, previousSlots: draft.slots };
}

/**
 * 다음 판 준비(docs/P1 후보 A). 같은 팀으로 초안을 만들고 포지션은 새로 뽑는다.
 * 복사하는 것: 참가자, 팀 구성. keepPositions면 포지션도.
 * 복사하지 않는 것: 경기 ID, 승패, 진영, 요청 ID, 완료 상태, 순환 사건, 추첨 기록.
 */
export function draftFromMatch(
  match: MatchView,
  nameOf: (participantId: string) => string,
  options: Omit<NewDraftOptions, "teamOf"> & { keepPositions?: boolean },
): Draft {
  const people: DraftPerson[] = match.roster.map((r) => ({
    key: `p:${r.participantId}`,
    name: nameOf(r.participantId),
    participantId: r.participantId,
  }));
  const teamOf: Record<string, Team> = {};
  for (const r of match.roster) teamOf[`p:${r.participantId}`] = r.team;
  const draft = createDraft(people, { ...options, teamOf });
  if (options.keepPositions && match.roster.every((r) => r.position !== null)) {
    const positionOf = new Map(match.roster.map((r) => [`p:${r.participantId}`, r.position!]));
    return {
      ...draft,
      origin: "same-teams",
      slots: draft.slots.map((s) => ({ ...s, position: positionOf.get(s.key)! })),
    };
  }
  return { ...draft, origin: "same-teams" };
}

/** 저장소에서 읽은 값이 쓸 수 있는 초안인지 확인한다. 형식이 다르면 버린다. */
export function parseStoredDraft(text: string | null): Draft | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Draft;
    if (value.formatVersion !== DRAFT_FORMAT_VERSION) return null;
    if (!Array.isArray(value.people) || !Array.isArray(value.slots)) return null;
    if (value.people.length !== 10 || value.slots.length !== 10) return null;
    return value;
  } catch {
    return null;
  }
}
