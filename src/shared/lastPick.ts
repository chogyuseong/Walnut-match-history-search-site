import type { DraftPerson } from "./draft";
import type { MatchView, ParticipantView } from "./types";

/**
 * "지난 참가자 불러오기"(docs/P4 시나리오 15)의 계산. 화면(Pick.tsx)의 같은 동작을 떼어 낸 것이다.
 * - 지난 경기 = 실시간으로 시작한 경기(source "live") 중 미진행 취소가 아닌, 경기 번호가 가장 큰 경기.
 *   지난 경기 입력·일괄 입력 경기는 "오늘 모인 사람"이 아니므로 쓰지 않는다.
 * - 불러오는 사람 = 그 경기 명단 중 지금 활성인 참가자(보관·합쳐진 사람은 빠진다). 합치기로 옮겨진 명단은
 *   남은 사람의 ID를 갖고 있으므로 남은 사람으로 불러온다.
 * - 요청을 보내지 않는다. 결과는 기기 초안(참가자 고르기)에만 들어간다.
 */
export function lastLiveMatch(matches: readonly MatchView[]): MatchView | null {
  let best: MatchView | null = null;
  for (const m of matches) {
    if (m.source !== "live" || m.state === "canceled") continue;
    if (!best || m.matchNo > best.matchNo) best = m;
  }
  return best;
}

export function lastMatchPeople(
  matches: readonly MatchView[],
  participants: readonly ParticipantView[],
): { match: MatchView; people: DraftPerson[]; missing: number } | null {
  const match = lastLiveMatch(matches);
  if (!match) return null;
  const ids = new Set(match.roster.map((r) => r.participantId));
  const people = participants
    .filter((p) => p.status === "active" && ids.has(p.id))
    .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .slice(0, 10);
  return { match, people, missing: match.roster.length - people.length };
}
