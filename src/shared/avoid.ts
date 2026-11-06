import type { AvoidMap, Draft, DraftPerson } from "./draft";
import { POSITIONS, type ParticipantView, type Position } from "./types";

/**
 * 기피 라인(migrations/0013). 사람마다 라인 섞기에서 되도록 피할 포지션 0~4개.
 * 섞기(draft.ts assignTeamPositions)는 고정을 먼저 지키고, 나머지는 기피를 하나도 어기지 않는 배정 중에서 균등 무작위,
 * 그런 배정이 없으면 어기는 수가 가장 적은 배정 중에서 무작위로 고른다.
 * 서포터 횟수 규칙(서포터 공평하게·서포터만 바꾸기)은 기피보다 먼저다. 손으로 자리를 바꾸는 것은 막지 않는다.
 */

/** 한 사람이 정할 수 있는 기피 라인 수의 최댓값. 다섯 개 모두는 갈 라인이 없어 받지 않는다. */
export const MAX_AVOID = 4;

/**
 * 받은 값을 기피 라인 목록으로 바꾼다. 포지션 이름만, 중복은 지우고, 탑~서폿 순서로 정렬한다.
 * 배열이 아니거나 모르는 값이 있거나 서로 다른 라인이 5개면 null(거절).
 */
export function normalizeAvoidPositions(value: unknown): Position[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => typeof v === "string" && (POSITIONS as readonly string[]).includes(v))) return null;
  const set = new Set(value as Position[]);
  const list = POSITIONS.filter((p) => set.has(p));
  return list.length > MAX_AVOID ? null : list;
}

/** DB 저장 글자. 없으면 NULL. */
export function encodeAvoid(list: readonly Position[] | null | undefined): string | null {
  return list && list.length > 0 ? POSITIONS.filter((p) => list.includes(p)).join(",") : null;
}

/** DB 글자 → 목록. 모르는 값은 버리고, 잘못 5개가 저장돼 있어도 섞기가 막히지 않게 4개까지만 본다. */
export function decodeAvoid(text: string | null | undefined): Position[] {
  if (!text) return [];
  const set = new Set(text.split(","));
  return POSITIONS.filter((p) => set.has(p)).slice(0, MAX_AVOID);
}

/** 초안 키 → 기피 라인. 참가자 ID가 없는 새 이름과 기피가 없는 사람은 넣지 않는다(비어 있으면 예전 섞기와 같다). */
export function avoidMapFor(
  people: readonly Pick<DraftPerson, "key" | "participantId">[],
  participants: readonly ParticipantView[] | undefined,
): AvoidMap {
  const byId = new Map((participants ?? []).map((p) => [p.id, p.avoidPositions]));
  const map: Record<string, readonly Position[]> = {};
  for (const person of people) {
    const list = person.participantId ? byId.get(person.participantId) : undefined;
    if (list && list.length > 0) map[person.key] = list;
  }
  return map;
}

export function avoids(avoid: AvoidMap | undefined, key: string, position: Position): boolean {
  return avoid?.[key]?.includes(position) ?? false;
}

/**
 * 지금 편성에서 기피 라인에 서 있는 사람. 화면 순서(팀 A→B, 탑→서폿).
 * includeLocked=false면 고정한 사람은 뺀다(사용자가 직접 고정한 것이라 섞기 알림에 넣지 않는다).
 */
export function avoidViolations(
  draft: Pick<Draft, "slots">,
  avoid: AvoidMap | undefined,
  options: { includeLocked?: boolean } = {},
): { key: string; position: Position }[] {
  if (!avoid) return [];
  const order = (s: { team: string; position: Position }) => (s.team === "A" ? 0 : 5) + POSITIONS.indexOf(s.position);
  return draft.slots
    .filter((s) => (options.includeLocked !== false || !s.locked) && avoids(avoid, s.key, s.position))
    .sort((a, b) => order(a) - order(b))
    .map((s) => ({ key: s.key, position: s.position }));
}
