import type { Draft, DraftPerson } from "./draft";
import type { MatchView, ParticipantView } from "./types";

/**
 * 중복 참가자 합치기의 순수 계산(서버 미리보기와 화면이 함께 쓴다).
 * 저장은 src/server/merge.ts가 한다. 합치기 전후 칭호 비교(누적 승패 계산이 필요)는 mergeStandings.ts에 따로 둔다:
 * 이 파일은 화면 첫 묶음(useApp.ts가 기기의 초안·고른 목록을 고칠 때)에도 실리므로 통계 계산을 부르지 않는다.
 */

/**
 * 합쳐진 사람의 ID → 마지막으로 남은 사람의 ID로 바꾸는 함수. 합쳐지지 않았으면 그대로 돌려준다.
 * 참가자 표(Map)를 여기서 한 번만 만든다. 경기·명단·신청 행을 도는 반복문에서는 resolveMerged 대신 이것을 밖에서 만들어 쓴다
 * (resolveMerged는 부를 때마다 참가자 전체로 Map을 다시 만든다. 스냅숏·참가 신청 응답이 행마다 부르면 CPU 10ms 한도를 깎는다).
 */
export function mergeResolver(
  participants: readonly Pick<ParticipantView, "id" | "mergedInto">[],
): (id: string) => string {
  const next = new Map(participants.map((p) => [p.id, p.mergedInto]));
  return (id) => {
    let current = id;
    // 합치기가 이어져 있어도(가→나, 나→다) 끝까지 따라간다. 잘못된 고리는 참가자 수만큼만 돈다.
    for (let i = 0; i <= participants.length; i++) {
      const target = next.get(current);
      if (!target) return current;
      current = target;
    }
    return id;
  };
}

/** 한 사람만 바꿀 때. 여러 번 부를 거면 mergeResolver를 쓴다. */
export function resolveMerged(
  participants: readonly Pick<ParticipantView, "id" | "mergedInto">[],
  id: string,
): string {
  return mergeResolver(participants)(id);
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

/** 명단·초안의 사람 하나를 남은 사람으로 바꾼다. 바꿀 것이 없으면 null. */
type PersonRemapper = (person: DraftPerson) => DraftPerson | null;

function personRemapper(participants: readonly ParticipantView[]): PersonRemapper {
  const resolve = mergeResolver(participants);
  const byId = new Map(participants.map((p) => [p.id, p]));
  return (person) => {
    if (!person.participantId) return null;
    const finalId = resolve(person.participantId);
    if (finalId === person.participantId) return null;
    const target = byId.get(finalId);
    if (!target) return null;
    return { key: `p:${target.id}`, name: target.name, participantId: target.id };
  };
}

/**
 * 기기에 남은 고른 참가자 목록에서 합쳐진 사람을 남은 사람으로 바꾼다.
 * 남은 사람이 이미 목록에 있으면 합쳐진 사람을 뺀다(같은 사람이 두 번 들어가지 않게).
 */
export function remapPeople(
  people: readonly DraftPerson[],
  participants: readonly ParticipantView[],
): { people: DraftPerson[]; changed: boolean } {
  return remapPeopleWith(people, personRemapper(participants));
}

function remapPeopleWith(
  people: readonly DraftPerson[],
  remapPerson: PersonRemapper,
): { people: DraftPerson[]; changed: boolean } {
  let changed = false;
  const out: DraftPerson[] = [];
  for (const person of people) {
    const replaced = remapPerson(person);
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
  const remapPerson = personRemapper(participants);
  for (const person of draft.people) {
    const replaced = remapPerson(person);
    if (!replaced) continue;
    if (keys.has(replaced.key) || [...rename.values()].some((r) => r.key === replaced.key)) {
      conflicts.push(person.name);
      continue;
    }
    rename.set(person.key, replaced);
  }
  // 대기자(2026-11-07)도 합쳐진 사람을 남은 사람으로 바꾸고, 편성에 이미 있는 사람은 뺀다.
  const bench = draft.bench ? remapPeopleWith(draft.bench, remapPerson) : null;
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
