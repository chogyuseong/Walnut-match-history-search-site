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

/**
 * "지난 내전 참가자 그대로"(2026-11-07): 지난 경기(lastLiveMatch)가 속한 내전(세션, 같은 날 묶음)의 모든 경기 명단을 합친 사람들.
 * - 세션은 서버가 정한다(시작 때 마지막 활동에서 12시간이 지났으면 새 내전을 묻는다, prep/usePrepStart.ts SESSION_GAP_MS).
 *   세션이 없는 경기(예전 기록)면 그 경기 하나만 본다.
 * - 그 세션에서 미진행 취소가 아닌 실시간 경기만 센다. 지금 활성인 참가자만(보관·합쳐진 사람은 빠지고 missing에 센다).
 * - 순서: 그 내전에서 많이 뛴 사람 → 지난 경기에 있던 사람 → 이름. 고르기 화면은 앞 10명으로 팀을 짜고 나머지를 대기자로 둔다
 *   (prepTools.ts splitBench). max명까지만 돌려준다.
 */
export function lastSessionPeople(
  matches: readonly MatchView[],
  participants: readonly ParticipantView[],
  max = 20,
): { match: MatchView; people: DraftPerson[]; missing: number; games: number } | null {
  const last = lastLiveMatch(matches);
  if (!last) return null;
  const session = matches.filter((m) =>
    last.sessionId === null
      ? m.id === last.id
      : m.sessionId === last.sessionId && m.source === "live" && m.state !== "canceled",
  );
  const games = new Map<string, number>();
  for (const m of session) for (const r of m.roster) games.set(r.participantId, (games.get(r.participantId) ?? 0) + 1);
  const inLast = new Set(last.roster.map((r) => r.participantId));
  const active = participants.filter((p) => p.status === "active" && games.has(p.id));
  const people = active
    .sort(
      (a, b) =>
        games.get(b.id)! - games.get(a.id)! ||
        Number(inLast.has(b.id)) - Number(inLast.has(a.id)) ||
        a.name.localeCompare(b.name, "ko"),
    )
    .slice(0, max)
    .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));
  return { match: last, people, missing: games.size - active.length, games: session.length };
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
