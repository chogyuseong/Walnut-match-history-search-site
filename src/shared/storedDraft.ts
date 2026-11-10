import type { Draft, DraftSlot, DrawRecord } from "./draft";
import type { Team } from "./types";

/**
 * 기기에 저장된 편성 초안을 읽는 데 필요한 것만 모았다(형식 번호, 되돌리기 이력 길이, 예전 진영 맞추기).
 * 화면 첫 묶음의 useApp.ts가 시작할 때 저장값을 읽으므로, 편성 조작 전체(draft.ts)와 팀 추천(recommend.ts)을
 * 끌고 오지 않게 draft.ts에서 떼어 냈다. 초안의 모양(타입)은 draft.ts에 그대로 있다.
 */

/** 저장 형식 번호. 바뀌면 예전 초안은 읽지 않고 버린다(parseStoredDraft). */
export const DRAFT_FORMAT_VERSION = 1;

/** 되돌리기 이력의 최대 단계 수. */
export const HISTORY_MAX = 5;

/**
 * 진영 바꾸기(docs/P4 시나리오 19): 블루팀(A) 5명과 레드팀(B) 5명을 통째로 맞바꾼다.
 * 팀 구성·포지션·고정은 사람을 따라가고 A/B 이름표만 바뀐다. 팀 A는 계속 블루라(teamASide = "blue")
 * 블루였던 5명이 레드가 된다.
 * 서포터 추첨 기록도 함께 옮긴다. 추첨 지문에는 팀 이름표가 들어가지 않으므로(rotation.ts)
 * 옮긴 기록은 그대로 유효하고, "두 팀 추첨 유지"가 깨지지 않는다.
 * 직전 편성(되돌리기)도 같은 방식으로 바꿔, 되돌려도 추첨 기록과 어긋나지 않게 한다.
 * 두 번 바꾸면 원래와 같다. 팀 조건(같은 팀·다른 팀)은 진영과 무관하다.
 */
export function swapSides(draft: Draft): Draft {
  const flip = (slots: DraftSlot[]): DraftSlot[] =>
    slots.map((s) => ({ ...s, team: s.team === "A" ? "B" : "A" }));
  const draws: Partial<Record<Team, DrawRecord>> = {};
  if (draft.draws.B) draws.A = draft.draws.B;
  if (draft.draws.A) draws.B = draft.draws.A;
  const next: Draft = {
    ...draft,
    slots: flip(draft.slots),
    previousSlots: draft.previousSlots ? flip(draft.previousSlots) : null,
    draws,
    teamASide: "blue",
  };
  // 되돌리기 이력·다시 앞으로도 같은 방식으로 뒤집는다(이력에서 꺼낸 자리가 지금 진영 기준과 맞게).
  if (draft.history) next.history = draft.history.map(flip);
  if (draft.redoSlots) next.redoSlots = flip(draft.redoSlots);
  return next;
}

/**
 * 예전 초안을 "팀 A = 블루"로 맞춘다. "red"였으면(블루였던 쪽이 B) 두 팀을 맞바꿔 블루였던 5명이 그대로 블루가 되게 하고,
 * 없었으면("나중에 정하기") 지금 자리 그대로 A를 블루로 둔다. 이미 "blue"면 그대로 돌려준다.
 */
export function normalizeDraftSide(draft: Draft): Draft {
  if (draft.teamASide === "blue") return draft;
  if (draft.teamASide === "red") return swapSides(draft);
  return { ...draft, teamASide: "blue" };
}

/** 저장소에서 읽은 값이 쓸 수 있는 초안인지 확인한다. 형식이 다르면 버린다. */
export function parseStoredDraft(text: string | null): Draft | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Draft;
    if (value.formatVersion !== DRAFT_FORMAT_VERSION) return null;
    if (!Array.isArray(value.people) || !Array.isArray(value.slots)) return null;
    if (value.people.length !== 10 || value.slots.length !== 10) return null;
    // 선택 필드(되돌리기 이력·다시 앞으로·대기자)는 모양이 어긋나면 그 필드만 버린다. 없는 예전 초안은 그대로 읽는다.
    const slotsOk = (v: unknown): v is DraftSlot[] => Array.isArray(v) && v.length === 10;
    if (value.history !== undefined) {
      if (Array.isArray(value.history) && value.history.every(slotsOk)) {
        value.history = value.history.slice(-HISTORY_MAX);
        value.previousSlots = value.history[value.history.length - 1] ?? null;
      } else {
        delete value.history;
      }
    }
    if (value.redoSlots !== undefined && value.redoSlots !== null && !slotsOk(value.redoSlots)) delete value.redoSlots;
    if (value.bench !== undefined) {
      const ok =
        Array.isArray(value.bench) &&
        value.bench.every((p) => typeof p?.key === "string" && typeof p?.name === "string");
      if (!ok) delete value.bench;
    }
    // 예전 초안(진영 "red"·없음)은 팀 A = 블루로 맞춘다.
    return normalizeDraftSide(value);
  } catch {
    return null;
  }
}
