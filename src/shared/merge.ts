import type { Draft, DraftPerson } from "./draft";
import { standings, type Standing } from "./titles";
import type { MatchView, ParticipantView, TitleBand } from "./types";

/**
 * 중복 참가자 합치기의 순수 계산(서버 미리보기와 화면이 함께 쓴다).
 * 저장은 src/server/merge.ts가 한다.
 */

/** 합쳐진 사람의 ID를 마지막으로 남은 사람의 ID로 바꾼다. 합쳐지지 않았으면 그대로. */
export function resolveMerged(
  participants: readonly Pick<ParticipantView, "id" | "mergedInto">[],
  id: string,
): string {
  const next = new Map(participants.map((p) => [p.id, p.mergedInto]));
  let current = id;
  // 합치기가 이어져 있어도(가→나, 나→다) 끝까지 따라간다. 잘못된 고리는 참가자 수만큼만 돈다.
  for (let i = 0; i <= participants.length; i++) {
    const target = next.get(current);
    if (!target) return current;
    current = target;
  }
  return id;
}

/** 두 사람이 함께 들어 있는 경기(상태와 관계없이). 하나라도 있으면 합칠 수 없다. */
export function overlappingMatches(
  matches: readonly MatchView[],
  a: string,
  b: string,
): MatchView[] {
  return matches.filter(
    (m) => m.roster.some((r) => r.participantId === a) && m.roster.some((r) => r.participantId === b),
  );
}

/** 합친 뒤의 경기 목록(계산용). 합칠 대상의 명단 행을 남길 대상으로 바꾼다. */
export function mergedMatches(
  matches: readonly MatchView[],
  sourceId: string,
  targetId: string,
): MatchView[] {
  return matches.map((m) =>
    m.roster.some((r) => r.participantId === sourceId)
      ? {
          ...m,
          roster: m.roster.map((r) =>
            r.participantId === sourceId ? { ...r, participantId: targetId } : r,
          ),
        }
      : m,
  );
}

export interface MergeStandings {
  /** 합치기 전 합칠 대상. 확정 경기가 없으면 null. */
  source: Standing | null;
  /** 합치기 전 남길 대상. */
  target: Standing | null;
  /** 합친 뒤 남길 대상. */
  merged: Standing | null;
}

/** 합치기 전후의 누적 승패·배치·칭호(docs/P2 P2-11, 누적 기준). */
export function mergeStandings(
  matches: readonly MatchView[],
  sourceId: string,
  targetId: string,
  bands: readonly TitleBand[],
): MergeStandings {
  const before = standings(matches, bands);
  const after = standings(mergedMatches(matches, sourceId, targetId), bands);
  return {
    source: before.get(sourceId) ?? null,
    target: before.get(targetId) ?? null,
    merged: after.get(targetId) ?? null,
  };
}

function remapPerson(
  person: DraftPerson,
  participants: readonly ParticipantView[],
): DraftPerson | null {
  if (!person.participantId) return null;
  const finalId = resolveMerged(participants, person.participantId);
  if (finalId === person.participantId) return null;
  const target = participants.find((p) => p.id === finalId);
  if (!target) return null;
  return { key: `p:${target.id}`, name: target.name, participantId: target.id };
}

/**
 * 기기에 남은 고른 참가자 목록에서 합쳐진 사람을 남은 사람으로 바꾼다.
 * 남은 사람이 이미 목록에 있으면 합쳐진 사람을 뺀다(같은 사람이 두 번 들어가지 않게).
 */
export function remapPeople(
  people: readonly DraftPerson[],
  participants: readonly ParticipantView[],
): { people: DraftPerson[]; changed: boolean } {
  let changed = false;
  const out: DraftPerson[] = [];
  for (const person of people) {
    const replaced = remapPerson(person, participants);
    const next = replaced ?? person;
    if (replaced) changed = true;
    if (out.some((p) => p.key === next.key)) {
      changed = true;
      continue;
    }
    out.push(next);
  }
  return { people: out, changed };
}

/**
 * 기기의 초안에서 합쳐진 사람의 ID를 남은 사람의 ID로 바꾼다.
 * - 바꿀 것이 없으면 같은 초안을 그대로 돌려준다.
 * - 남은 사람이 이미 초안에 있으면(같은 사람이 두 자리를 차지) 자동으로 고치지 않고 conflicts에 담는다.
 *   서버는 보관된(합쳐진) 사람으로 시작하는 요청을 거절하므로 기록이 잘못 남지는 않는다.
 * - 바꾼 팀의 서포터 추첨 기록은 지문이 달라지므로 버린다(다시 확인 필요).
 */
export function remapDraft(
  draft: Draft,
  participants: readonly ParticipantView[],
): { draft: Draft; changed: boolean; conflicts: string[] } {
  const rename = new Map<string, DraftPerson>();
  const conflicts: string[] = [];
  const keys = new Set(draft.people.map((p) => p.key));
  for (const person of draft.people) {
    const replaced = remapPerson(person, participants);
    if (!replaced) continue;
    if (keys.has(replaced.key) || [...rename.values()].some((r) => r.key === replaced.key)) {
      conflicts.push(person.name);
      continue;
    }
    rename.set(person.key, replaced);
  }
  // 대기자(2026-11-07)도 합쳐진 사람을 남은 사람으로 바꾸고, 편성에 이미 있는 사람은 뺀다.
  const bench = draft.bench ? remapPeople(draft.bench, participants) : null;
  const finalKeys = new Set(draft.people.map((p) => rename.get(p.key)?.key ?? p.key));
  const benchPeople = bench ? bench.people.filter((p) => !finalKeys.has(p.key)) : null;
  const benchChanged = bench !== null && (bench.changed || benchPeople!.length !== bench.people.length);
  if (rename.size === 0 && !benchChanged) return { draft, changed: false, conflicts };
  if (rename.size === 0) return { draft: { ...draft, bench: benchPeople! }, changed: true, conflicts };
  const keyOf = (key: string) => rename.get(key)?.key ?? key;
  const remapSlots = (slots: Draft["slots"]) => slots.map((s) => ({ ...s, key: keyOf(s.key) }));
  const touchedTeams = new Set(
    draft.slots.filter((s) => rename.has(s.key)).map((s) => s.team),
  );
  const draws = { ...draft.draws };
  for (const team of touchedTeams) delete draws[team];
  const next: Draft = {
    ...draft,
    people: draft.people.map((p) => rename.get(p.key) ?? p),
    slots: remapSlots(draft.slots),
    previousSlots: draft.previousSlots ? remapSlots(draft.previousSlots) : null,
    constraints: draft.constraints?.map((c) => ({ ...c, a: keyOf(c.a), b: keyOf(c.b) })),
    draws,
  };
  // 되돌리기 이력·다시 앞으로(2026-11-07)도 같은 키로 바꾼다.
  if (draft.history) next.history = draft.history.map(remapSlots);
  if (draft.redoSlots) next.redoSlots = remapSlots(draft.redoSlots);
  if (benchPeople) next.bench = benchPeople;
  return { changed: true, conflicts, draft: next };
}
