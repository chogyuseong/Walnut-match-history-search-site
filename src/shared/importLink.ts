/**
 * 가져올 표의 이름을 모임의 기존 참가자와 잇는다.
 *
 * - 정확히 같은 이름(대소문자·앞뒤 공백만 다름, nameKey가 같음)인 활성 참가자가 있으면 자동으로 잇는다.
 * - 같은 이름이 합쳐진(다른 사람으로 합친) 참가자이면 마지막으로 남은 사람에게 잇는다.
 * - 공백·대소문자·전각/반각만 다른 비슷한 이름은 후보로 보여주고 사용자가 고른다(자동으로 잇지 않는다).
 * - 나머지는 새 참가자로 만든다. 같은 이름의 보관된 참가자가 있으면 알려준다(가져오기는 활성 참가자만 받는다).
 */
import { resolveMerged } from "./merge";
import { nameKey } from "./names";
import type { ParticipantView } from "./types";

/** 비슷한 이름 비교용: 전각→반각(NFKC), 모든 공백 제거, 소문자. */
export function looseKey(name: string): string {
  return name.normalize("NFKC").replace(/[\s\u200b]+/g, "").toLowerCase();
}

export interface NameLink {
  name: string;
  kind: "exact" | "merged" | "similar" | "new";
  /** exact·merged: 이을 참가자. */
  participantId?: string;
  /** merged: 표의 이름과 같은 이름이던(합쳐진) 참가자의 이름. */
  mergedFrom?: string;
  /** similar: 고를 수 있는 기존 참가자. */
  candidates: { id: string; name: string }[];
  /** new: 같은 이름의 보관된 참가자가 있음. */
  archivedSameName?: boolean;
}

export function linkNames(
  names: readonly string[],
  participants: readonly Pick<ParticipantView, "id" | "name" | "status" | "mergedInto">[],
): NameLink[] {
  const byId = new Map(participants.map((p) => [p.id, p]));
  const active = participants.filter((p) => p.status === "active");
  const activeByKey = new Map(active.map((p) => [nameKey(p.name), p]));
  return names.map((name): NameLink => {
    const key = nameKey(name);
    const exact = activeByKey.get(key);
    if (exact) return { name, kind: "exact", participantId: exact.id, candidates: [] };
    const sameNameArchived = participants.filter((p) => p.status !== "active" && nameKey(p.name) === key);
    for (const old of sameNameArchived) {
      if (!old.mergedInto) continue;
      const target = byId.get(resolveMerged(participants, old.id));
      if (target && target.status === "active") {
        return { name, kind: "merged", participantId: target.id, mergedFrom: old.name, candidates: [] };
      }
    }
    const loose = looseKey(name);
    const candidates = active
      .filter((p) => looseKey(p.name) === loose)
      .map((p) => ({ id: p.id, name: p.name }));
    if (candidates.length > 0) return { name, kind: "similar", candidates };
    return { name, kind: "new", candidates: [], archivedSameName: sameNameArchived.length > 0 };
  });
}

/** 표 안에서 서로 비슷한(같은 사람일 수 있는) 이름 묶음. 표를 고치거나 나중에 합치기로 정리하라고 알린다. */
export function similarWithinTable(names: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const key = looseKey(name);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}
