import type { Draft } from "../../../shared/draft";
import { laneRivalMeetings, type HardestLaneRivals, type LaneRival } from "../../../shared/headToHead";

/**
 * 팀 짜기 편성판(TeamBoards.tsx)의 "어려운 상대" 배지: 같은 라인에 마주 선 사람이 맞은편의 개인 통계
 * "맞라인 상대"에서 그 라인의 가장 어려운 상대로 뜨면, 그 강한 쪽에게 붙인다(낱말 뜻대로 "상대하기 어려운 사람", 사용자 결정).
 * 판정은 shared/headToHead.ts hardestLaneRivals·laneRivalMeetings가 하고 기록 화면 경기 카드·경기 상세도 같은 것을 쓴다.
 * 여기서는 편성의 슬롯 키(사람 키)로 옮기기만 한다.
 * test/teamBoardsRival.test.ts가 브라우저 타입 없이 가져오므로 web/format.ts 대신 shared만 쓴다.
 */

export interface RivalMark {
  /** 이 사람에게 약한 맞은편 같은 라인 사람의 슬롯 키(설명 글에 이름을 넣을 때 쓴다). */
  weakerKey: string;
  /** 약한 쪽 기준의 맞라인 전적. 배지를 단 사람 기준으로 읽으려면 승·패를 뒤집는다. */
  rival: LaneRival;
}

/** 슬롯 키 → 표식. 내가 맞은편 같은 라인 사람의 그 라인 가장 어려운 상대일 때만 붙는다. */
export function rivalMarks(draft: Draft, hardest: HardestLaneRivals | null): ReadonlyMap<string, RivalMark> {
  const marks = new Map<string, RivalMark>();
  if (!hardest) return marks;
  const idOf = new Map(draft.people.map((p) => [p.key, p.participantId]));
  const keyOf = new Map(draft.people.flatMap((p) => (p.participantId ? [[p.participantId, p.key] as const] : [])));
  const roster = draft.slots.map((s) => ({ participantId: idOf.get(s.key) ?? null, team: s.team, position: s.position }));
  for (const meeting of laneRivalMeetings(roster, hardest)) {
    marks.set(keyOf.get(meeting.strongId)!, { weakerKey: keyOf.get(meeting.weakId)!, rival: meeting.rival });
  }
  return marks;
}
