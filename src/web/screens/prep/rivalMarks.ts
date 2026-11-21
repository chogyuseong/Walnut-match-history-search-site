import type { Draft } from "../../../shared/draft";
import { laneRivals, laneRivalSummary, type LaneRival } from "../../../shared/headToHead";
import type { MatchView, Position } from "../../../shared/types";

/**
 * 팀 짜기 편성판(TeamBoards.tsx)의 "어려운 상대" 배지: 같은 라인에 마주 선 상대가 그 사람의 개인 통계
 * "맞라인 상대"에서 그 라인의 가장 어려운 상대로 뜨는 사람이면, 지는 쪽에게 붙인다.
 * 판정을 개인 통계(Person.tsx lanePicks)와 똑같이 둬서 배지를 보고 개인 통계에 가면 같은 사람이 보이게 한다(사용자 결정).
 * 기준을 바꾸려면 headToHead.ts laneRivalSummary(경기 수·50% 미만)를 고친다. 두 화면이 함께 바뀐다.
 * test/teamBoardsRival.test.ts가 브라우저 타입 없이 가져오므로 web/format.ts 대신 shared만 쓴다.
 */

/** 참가자 ID → 라인 → 그 라인에서 가장 어려운 맞라인 상대. 어려운 상대가 없는 라인·사람은 빠진다. */
export type HardestLaneRivals = ReadonlyMap<string, ReadonlyMap<Position, LaneRival>>;

/**
 * 편성에 든 사람들의 라인별 가장 어려운 맞라인 상대(누적). 사람마다 전체 경기를 훑으므로 자리를 바꿀 때가 아니라
 * 스냅숏이나 편성 인원이 바뀔 때만 부른다. 배치 중인 상대를 빼는 것도 개인 통계와 같다(한두 판 운으로 뽑히지 않게).
 */
export function hardestLaneRivals(
  matches: readonly MatchView[],
  participantIds: readonly string[],
  standings: ReadonlyMap<string, { done: boolean }>,
): HardestLaneRivals {
  const result = new Map<string, Map<Position, LaneRival>>();
  for (const id of new Set(participantIds)) {
    const opponents = laneRivals(matches, id).filter((r) => standings.get(r.opponentId)?.done);
    const byLine = new Map<Position, LaneRival>();
    for (const pick of laneRivalSummary(opponents)) if (pick.hardest) byLine.set(pick.position, pick.hardest);
    if (byLine.size > 0) result.set(id, byLine);
  }
  return result;
}

export interface RivalMark {
  /** 맞은편 같은 라인 사람의 슬롯 키(설명 글에 이름을 넣을 때 쓴다). */
  opponentKey: string;
  /** 지금 라인에서 그 상대와의 맞라인 전적(배지를 단 사람 기준 승·패). */
  rival: LaneRival;
}

/**
 * 슬롯 키 → 표식. 맞은편 같은 라인 사람이 내 그 라인의 가장 어려운 상대일 때만 붙는다.
 * 어려운 상대는 50% 미만에서만 고르므로 같은 맞대결에서 두 사람이 동시에 받지는 않는다.
 */
export function rivalMarks(draft: Draft, hardest: HardestLaneRivals | null): ReadonlyMap<string, RivalMark> {
  const marks = new Map<string, RivalMark>();
  if (!hardest || hardest.size === 0) return marks;
  const idOf = new Map(draft.people.map((p) => [p.key, p.participantId]));
  for (const slot of draft.slots) {
    const id = idOf.get(slot.key);
    const rival = id ? hardest.get(id)?.get(slot.position) : undefined;
    if (!rival) continue;
    const across = draft.slots.find((s) => s.position === slot.position && s.team !== slot.team);
    if (across && idOf.get(across.key) === rival.opponentId) marks.set(slot.key, { opponentKey: across.key, rival });
  }
  return marks;
}
