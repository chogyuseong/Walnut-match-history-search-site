import { withoutHistory, type Draft, type DraftPerson } from "./draft";
import { remapPeople, resolveMerged } from "./merge";
import { nameKey } from "./names";
import { TEAM_SIZE_TOTAL, withBench } from "./prepTools";
import type { TeamConstraint } from "./recommend";
import type { MatchView, Position, Snapshot, Team } from "./types";

/**
 * 오늘 명단 이어가기(docs/개선-오늘명단-설계-2026-11-10.md ④·⑥).
 * 11명 이상 온 밤에 "그날 온 사람과 그 순서"만 기기에 남기고(src/web/nightPoolStore.ts), 판 수·연속 기록은
 * 그 세션의 서버 경기에서 그때그때 센다. 그래서 정정(취소·교체·합치기)이 따로 손대지 않아도 반영된다.
 * 다음 판 제안은 예측이 아니라 정해 둔 규칙 하나다(nextLineup). 화면에도 "규칙"이라고 적는다.
 */
export interface NightPool {
  v: 1;
  groupId: string;
  /** 첫 경기를 시작한 뒤에 묶인다. 묶이기 전에는 만든 시각에서 12시간만 산다. */
  sessionId: string | null;
  createdAt: string;
  /** 온 순서. 고르기 화면에서 고른 순서 그대로이고, 늦게 온 사람은 끝에 붙는다. 이름만 담는다. */
  people: DraftPerson[];
  /**
   * 오늘 명단에서 뺀 사람(먼저 간 사람)의 키. 그날 경기에 뛴 사람이라도 syncPool이 다시 넣지 않게 남긴다.
   * 나중에 생긴 필드라 없을 수 있다.
   */
  left?: string[];
}

/** 같은 밤으로 보는 간격. 시작 확인 창이 "새 내전으로 볼까요"를 묻는 기준(usePrepStart SESSION_GAP_MS)과 같다. */
export const NIGHT_GAP_MS = 12 * 60 * 60 * 1000;

/**
 * 이 명단을 오늘 것으로 볼지. 다른 모임·닫힌 세션·다른 세션이면 아니다.
 * 세션이 열려 있어도 마지막 활동에서 12시간이 지났으면 아니다: 운영자가 "오늘 내전 마치기"를 안 누르면 세션은
 * 다음 주까지 열려 있어서, 이 조건이 없으면 지난주 명단이 고르기 화면을 채운다.
 */
export function poolIsLive(pool: NightPool, snapshot: Snapshot, nowMs: number): boolean {
  if (pool.groupId !== snapshot.group.id) return false;
  if (pool.sessionId === null) return nowMs - Date.parse(pool.createdAt) < NIGHT_GAP_MS;
  const session = snapshot.session;
  return session !== null && session.id === pool.sessionId && nowMs - Date.parse(session.lastActivityAt) < NIGHT_GAP_MS;
}

/** 보관값에서 명단을 읽는다. 없거나 깨졌으면 null(깨진 값 때문에 준비 화면·결과 저장 창이 멈추지 않게 버린다). */
export function parseNightPool(text: string | null, groupId: string): NightPool | null {
  try {
    const value = JSON.parse(text ?? "null") as NightPool | null;
    if (value?.v !== 1 || value.groupId !== groupId || !Array.isArray(value.people)) return null;
    if (!value.people.every((p) => typeof p?.key === "string" && typeof p?.name === "string")) return null;
    // left는 syncPool이 펼쳐 쓰므로 배열이 아니면 TypeError로 화면이 멈춘다.
    if (value.left !== undefined && !(Array.isArray(value.left) && value.left.every((k) => typeof k === "string"))) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * 고르기 화면에서 명단을 새로 만들 때 left로 남길 키: 지금 열린 세션(12시간 안)에서 이미 뛰었는데 새 명단에 없는 사람.
 * 이 사람들은 집에 간 사람이다. 남기지 않으면 syncPool이 "다른 기기에서 교체로 넣은 사람"으로 보고 되살려
 * 다음 판 편성에 바로 넣는다(리뷰 2026-11-10). 명단을 만든 뒤에 다른 기기가 시작한 경기의 새 얼굴은 여기 들지 않으므로
 * 그 사람은 예전처럼 syncPool이 더한다. 명단이 아직 세션에 묶이기 전이어도 다음 시작은 보통 이 세션에 이어지므로
 * snapshot.session으로 본다(새 내전을 고르면 다른 세션이 되고, 이 목록은 그 세션에서 쓰일 일이 없다).
 */
export function goneFromSession(snapshot: Snapshot, people: readonly DraftPerson[], nowMs: number): string[] {
  const session = snapshot.session;
  if (!session || !(nowMs - Date.parse(session.lastActivityAt) < NIGHT_GAP_MS)) return [];
  const here = new Set(people.map((p) => p.key));
  const gone = new Set<string>();
  for (const match of snapshot.matches) {
    if (match.sessionId !== session.id || match.state === "canceled") continue;
    for (const entry of match.roster) {
      const key = `p:${resolveMerged(snapshot.participants, entry.participantId)}`;
      if (!here.has(key)) gone.add(key);
    }
  }
  return [...gone];
}

/** 이 명단의 세션에서 판 수로 세는 경기(경기 번호 순). 미진행 취소만 빼고, 결과 대기·진행 중·전적 제외는 "뛴 판"이다. */
export function sessionMatchesOf(pool: NightPool, matches: readonly MatchView[]): MatchView[] {
  if (pool.sessionId === null) return [];
  return matches
    .filter((m) => m.sessionId === pool.sessionId && m.state !== "canceled")
    .sort((a, b) => a.matchNo - b.matchNo);
}

/**
 * 명단을 지금 서버 상태에 맞춘다.
 * - 아직 참가자 ID가 없던 새 이름("n:")은 시작할 때 서버가 만든 참가자로 바꾼다(그 뒤 경기 명단은 "p:" 키라서).
 * - 합쳐진 사람은 남은 사람으로, 겹치면 하나로(remapPeople). 이름이 바뀐 사람은 지금 이름으로.
 * - 그 세션 경기에 뛰었는데 명단에 없는 사람(다른 기기에서 교체로 넣은 사람)은 끝에 붙이고 added로 알린다.
 *   운영자가 빼기로 뺀 사람(left)은 그날 뛰었어도 다시 넣지 않는다.
 * 바뀐 것이 없으면 같은 명단 객체를 돌려준다.
 */
export function syncPool(pool: NightPool, snapshot: Snapshot): { pool: NightPool; added: DraftPerson[] } {
  const active = snapshot.participants.filter((p) => p.status === "active");
  const byNameKey = new Map(active.map((p) => [nameKey(p.name), p]));
  const named = pool.people.map((person) => {
    if (person.participantId !== null && person.key.startsWith("p:")) return person;
    const found = byNameKey.get(nameKey(person.name));
    return found ? { key: `p:${found.id}`, name: found.name, participantId: found.id } : person;
  });
  const merged = remapPeople(named, snapshot.participants).people;
  const nameOf = new Map(snapshot.participants.map((p) => [p.id, p.name]));
  const people = merged.map((p) => {
    const current = p.participantId ? nameOf.get(p.participantId) : undefined;
    return current !== undefined && current !== p.name ? { ...p, name: current } : p;
  });
  const keys = new Set([...people.map((p) => p.key), ...(pool.left ?? [])]);
  const added: DraftPerson[] = [];
  for (const match of sessionMatchesOf(pool, snapshot.matches)) {
    for (const entry of match.roster) {
      // 합치기는 서버에서 경기 명단도 옮기지만, 옮기기 전 스냅숏이어도 같은 사람이 두 번 들어가지 않게 남은 사람으로 본다.
      const id = resolveMerged(snapshot.participants, entry.participantId);
      const key = `p:${id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      added.push({ key, name: nameOf.get(id) ?? "", participantId: id });
    }
  }
  const next = [...people, ...added];
  const same = next.length === pool.people.length && next.every((p, i) => {
    const old = pool.people[i]!;
    return p.key === old.key && p.name === old.name && p.participantId === old.participantId;
  });
  return { pool: same ? pool : { ...pool, people: next }, added };
}

export interface TonightStat {
  /** 오늘 뛴 판 수. */
  games: number;
  /** 가장 최근 경기부터 거슬러 연속으로 뛴 판 수. */
  playStreak: number;
  /** 가장 최근 경기부터 거슬러 연속으로 쉰 판 수. */
  restStreak: number;
}

/** 명단의 사람마다 오늘 판 수와 연속 기록. sessionMatches는 sessionMatchesOf의 결과(경기 번호 순). */
export function tonightStats(pool: NightPool, sessionMatches: readonly MatchView[]): Map<string, TonightStat> {
  const rosters = sessionMatches.map((m) => new Set(m.roster.map((r) => `p:${r.participantId}`)));
  const stats = new Map<string, TonightStat>();
  for (const person of pool.people) {
    const played = rosters.map((keys) => keys.has(person.key));
    const streak = (value: boolean) => {
      let n = 0;
      for (let i = played.length - 1; i >= 0 && played[i] === value; i--) n++;
      return n;
    };
    stats.set(person.key, {
      games: played.filter(Boolean).length,
      playStreak: streak(true),
      restStreak: streak(false),
    });
  }
  return stats;
}

export interface NextLineup {
  /** 이번에 들어올 사람(명단 순서). */
  inKeys: string[];
  /** 이번에 쉴 사람(규칙 순서). inKeys[i]가 outKeys[i]의 자리에 들어간다. */
  outKeys: string[];
  /** 다음 판에 뛰지 않는 사람(명단 순서). */
  bench: DraftPerson[];
}

/**
 * 다음 판 제안(쉬는 순서 규칙). 명단이 10명 이하면 바꾸지 않는다.
 * 그렇지 않으면 직전 경기에 없던 명단 사람이 모두(최대 10명) 들어오고, 같은 수만큼 직전 경기 사람 중
 * 명단에서 빠진 사람 → 연속으로 가장 오래 뛴 사람 → 오늘 경기가 많은 사람 → 명단 앞쪽 순으로 쉰다.
 * 무작위가 없어서 같은 명단·같은 경기면 어느 기기에서나 같은 제안이 나온다(두 운영자가 서로 다른 말을 하지 않게).
 */
export function nextLineup(pool: NightPool, last: MatchView, sessionMatches: readonly MatchView[]): NextLineup {
  const lastKeys = new Set(last.roster.map((r) => `p:${r.participantId}`));
  const benchOf = (playing: ReadonlySet<string>) => pool.people.filter((p) => !playing.has(p.key));
  if (pool.people.length <= TEAM_SIZE_TOTAL) {
    // 쉬는 순서를 돌릴 만큼 사람이 없다. 다만 직전 경기에 뛰고 명단에서 빠진 사람(먼저 간 사람)은 그대로 둘 수 없다:
    // 11명 밤에 한 명을 빼서 10명이 되면, 뺀 사람이 직전 경기에 있었을 경우 다음 판에도 계속 뛰게 된다.
    // 그 자리만 쉬던 사람으로 채운다(직전 경기 명단 순서대로, 채울 사람이 모자라면 남는 자리는 그대로).
    const inPool = new Set(pool.people.map((p) => p.key));
    const gone = [...lastKeys].filter((k) => !inPool.has(k));
    const fill = pool.people.filter((p) => !lastKeys.has(p.key)).slice(0, gone.length).map((p) => p.key);
    if (fill.length === 0) return { inKeys: [], outKeys: [], bench: benchOf(lastKeys) };
    const outKeys = gone.slice(0, fill.length);
    const playing = new Set([...lastKeys].filter((k) => !outKeys.includes(k)).concat(fill));
    return { inKeys: fill, outKeys, bench: benchOf(playing) };
  }

  const inKeys = pool.people.filter((p) => !lastKeys.has(p.key)).slice(0, TEAM_SIZE_TOTAL).map((p) => p.key);
  const stats = tonightStats(pool, sessionMatches);
  const order = new Map(pool.people.map((p, i) => [p.key, i]));
  const zero: TonightStat = { games: 0, playStreak: 0, restStreak: 0 };
  // 직전 경기에 뛰고 명단에서 빠진 사람(먼저 간 사람)이 가장 먼저 쉰다. 명단에 없어 판 수가 0으로 보이므로
  // 이 줄이 없으면 맨 뒤로 밀려 계속 뛰고, 명단의 다른 사람이 대신 쉬었다.
  const outKeys = [...lastKeys]
    .sort((a, b) => {
      const sa = stats.get(a) ?? zero;
      const sb = stats.get(b) ?? zero;
      return (
        Number(order.has(a)) - Number(order.has(b)) ||
        sb.playStreak - sa.playStreak ||
        sb.games - sa.games ||
        (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity)
      );
    })
    .slice(0, inKeys.length);
  const playing = new Set([...lastKeys].filter((k) => !outKeys.includes(k)).concat(inKeys));
  return { inKeys, outKeys, bench: benchOf(playing) };
}

/**
 * 제안을 초안에 적용한다. 들어온 사람은 짝이 된 나간 사람의 팀·포지션을 물려받는다(진행 중 교체와 같은 규칙).
 * 사람이 바뀌어 예전 자리로 되돌릴 수 없으므로 이력은 비우고, 나간 사람에게 걸린 조건은 지운다.
 * 대기자는 lineup.bench(명단 순서)다. 들어올 사람이 없으면 대기자만 붙이고 나머지는 그대로다(10명 밤·시리즈).
 */
export function rotateDraft(draft: Draft, lineup: NextLineup, people: readonly DraftPerson[]): Draft {
  if (lineup.inKeys.length === 0) return withBench(draft, lineup.bench);
  const personOf = new Map(people.map((p) => [p.key, p]));
  const incomingFor = new Map(lineup.outKeys.map((out, i) => [out, lineup.inKeys[i]!]));
  const out = new Set(lineup.outKeys);
  const rotated: Draft = {
    ...withoutHistory(draft),
    people: draft.people.map((p) => (incomingFor.has(p.key) ? personOf.get(incomingFor.get(p.key)!)! : p)),
    slots: draft.slots.map((s) =>
      incomingFor.has(s.key) ? { ...s, key: incomingFor.get(s.key)!, locked: false } : s,
    ),
    // 서포터 추첨 기록은 사람이 바뀐 팀에서 맞지 않는다. 새 초안이라 원래 비어 있지만 함께 비운다.
    draws: {},
    constraints: (draft.constraints ?? []).filter((c) => !out.has(c.a) && !out.has(c.b)),
  };
  return withBench(rotated, lineup.bench);
}

/** 오늘 명단 글. 다른 기기의 고르기 화면에 그대로 붙여 넣을 수 있게 이름만 한 줄에 한 명. */
export function poolText(pool: NightPool): string {
  return pool.people.map((p) => p.name).join("\n");
}

/**
 * "다음 경기 준비"가 만든 초안에 붙여 두는 안내(준비 화면 안내 줄). 초안 형식(src/shared/draft.ts)은 고치지 않고
 * 선택 필드 하나를 얹는다(만들 때는 draft.ts가 첫 화면 묶음이었다. 지금은 저장값 읽기만 storedDraft.ts로 첫 화면에 실린다). 초안 조작은 모두 {...draft}로 이어 가므로 남고, "같은 10명으로"·"포지션 유지"처럼
 * 초안을 새로 만들면 사라진다.
 */
export interface NightNote {
  /** 들어간 사람과 그 자리(들어간 순간의 팀·포지션). 10명 밤·시리즈면 비어 있다. */
  swaps: { inName: string; outName: string; team: Team; position: Position }[];
  /** 그날 명단 인원(안내 줄의 "오늘 온 12명"). */
  poolSize: number;
  /** 이번 판 번호. */
  matchNo: number;
  /** syncPool이 다른 기기의 경기에서 찾아 명단에 더한 사람. */
  addedNames: string[];
  /** 지난 경기에서 이어 온 팀 조건 수(⑤). */
  carried: number;
}

export type NightDraft = Draft & { night?: NightNote };

/** 지난 경기 조건을 이어 올 수 있는 시간. 오늘 명단과 같은 간격이다. */
export const CARRY_MS = NIGHT_GAP_MS;

/** 다음 판으로 넘길 팀 조건의 보관 꼴(src/web/nightPoolStore.ts가 기기에 쓴다). */
export interface CarryRecord {
  savedAt: string;
  constraints: TeamConstraint[];
}

/**
 * 시작한 편성에서 넘길 조건. 새 이름의 조건 키("n:")는 시작하면서 생긴 참가자 ID 키로 바꾼다(다음 초안은 "p:" 키라서).
 * 조건이 없으면 null: 보관값을 지워서, 지난 경기에서 지운 조건이 다음 판에 되살아나지 않게 한다.
 */
export function carryRecord(started: Draft, now: string): CarryRecord | null {
  const constraints = started.constraints ?? [];
  if (constraints.length === 0) return null;
  const keyOf = new Map(started.people.map((p) => [p.key, p.participantId ? `p:${p.participantId}` : p.key]));
  return { savedAt: now, constraints: constraints.map((c) => ({ ...c, a: keyOf.get(c.a) ?? c.a, b: keyOf.get(c.b) ?? c.b })) };
}

/** 보관값에서 이어 올 조건. 없거나 깨졌거나 12시간이 지났으면 빈 목록. */
export function parseCarry(text: string | null, nowMs: number): TeamConstraint[] {
  try {
    const value = JSON.parse(text ?? "null") as CarryRecord | null;
    if (!value || !Array.isArray(value.constraints)) return [];
    if (!(nowMs - Date.parse(value.savedAt) < CARRY_MS)) return [];
    return value.constraints.filter((c) => typeof c?.a === "string" && typeof c?.b === "string");
  } catch {
    return [];
  }
}

/**
 * "다음 경기 준비"가 직전 경기로 만든 초안(base, draftFromMatch 결과)을 마무리한다.
 * 1) 지난 경기의 팀 조건 중 두 사람이 모두 이 초안에 있는 것을 넣는다(⑤).
 * 2) 오늘 명단이 있으면 쉬던 사람을 넣는다(nextLineup → rotateDraft). 시리즈는 같은 10명이 이어서 하는 판이라 바꾸지 않고
 *    쉬는 사람만 붙인다. 들어온 사람에게는 이어 온 조건이 걸릴 수 없고(직전 경기에 없었다), 나간 사람의 조건은 지워진다.
 * 3) 보여 줄 것이 있을 때만 안내(night)를 붙인다. 오늘 명단도 이어 온 조건도 없으면 base와 같은 내용이다(10명 밤).
 */
export function planNextDraft(
  base: Draft,
  from: MatchView,
  input: {
    pool: NightPool | null;
    added: readonly DraftPerson[];
    matches: readonly MatchView[];
    carried: readonly TeamConstraint[];
    series: boolean;
  },
): NightDraft {
  let draft: NightDraft = base;
  const inBase = new Set(base.people.map((p) => p.key));
  const carried = input.carried.filter((c) => inBase.has(c.a) && inBase.has(c.b));
  if (carried.length > 0) draft = { ...draft, constraints: carried };

  const { pool } = input;
  let swaps: NightNote["swaps"] = [];
  if (pool) {
    const lineup: NextLineup = input.series
      ? { inKeys: [], outKeys: [], bench: pool.people.filter((p) => !inBase.has(p.key)) }
      : nextLineup(pool, from, sessionMatchesOf(pool, input.matches));
    draft = rotateDraft(draft, lineup, pool.people);
    const nameOf = (key: string) => pool.people.find((p) => p.key === key)?.name ?? "";
    swaps = lineup.inKeys.map((key, i) => {
      const slot = draft.slots.find((s) => s.key === key)!;
      return { inName: nameOf(key), outName: nameOf(lineup.outKeys[i]!), team: slot.team, position: slot.position };
    });
  }
  const kept = draft.constraints?.length ?? 0;
  if (!pool && kept === 0) return draft;
  return {
    ...draft,
    night: {
      swaps,
      poolSize: pool?.people.length ?? 0,
      matchNo: Math.max(0, ...input.matches.map((m) => m.matchNo)) + 1,
      addedNames: input.added.map((p) => p.name),
      carried: kept,
    },
  };
}
