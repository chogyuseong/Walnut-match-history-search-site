import { byPlayedAt, isCounted } from "./stats";
import type { MatchView, Position } from "./types";

/**
 * 한 회차(그날 내전) 안에서 한 사람이 뛴 경기를 순서대로 늘어놓고, 고른 다른 한 사람과 경기마다
 * 같은 팀이었는지 상대였는지를 붙인다. 두 사람 비교 화면(Compare.tsx "그날 경기")과
 * 개인 통계의 진입 링크(Person.tsx 최근 경기)가 쓴다.
 * - 세는 경기는 전적 집계와 같다(isCounted). 결과 대기·취소·전적 제외는 순서에도 넣지 않는다.
 * - 회차가 없는 경기(지난 기록 가져오기·빠진 경기 채우기)는 어느 회차에도 넣지 않는다. 날짜가 같아도
 *   한 묶음이라는 근거가 없어서다. 그 경기는 원래 경기 목록과 상세에서 그대로 본다.
 * - 같은 팀인지는 팀 A/B 글자로만 비교한다. 진영(블루·레드)을 몰라도 된다.
 * - 고른 사람이 빠진 경기는 "apart"로만 적는다. 왜 빠졌는지(늦게 옴·쉼)는 기록에 없으니 말하지 않는다.
 */

export type SessionRelation = "together" | "against" | "apart";

export interface SessionGame {
  match: MatchView;
  position: Position | null;
  won: boolean;
  /** 고른 다른 사람과의 관계. 다른 사람을 고르지 않았으면 null. */
  relation: SessionRelation | null;
}

export interface PlayedSession {
  sessionId: string;
  /** 그 회차 첫 확정 경기 시각. 회차 이름(날짜)에 쓴다. 자정을 넘겨도 회차는 하나다. */
  startedAt: string;
  /** 그 회차의 확정 경기 수(모임 전체). */
  sessionGames: number;
  /** 그중 이 사람이 뛴 경기 수. */
  myGames: number;
}

function countedInSessions(matches: readonly MatchView[]): MatchView[] {
  return matches.filter((m) => m.sessionId !== null && isCounted(m)).sort(byPlayedAt);
}

function playedIn(match: MatchView, id: string): boolean {
  return match.roster.some((r) => r.participantId === id);
}

/**
 * 이 사람이 확정 경기를 한 번이라도 뛴 회차, 최근 회차부터.
 * withOther를 주면 두 사람이 같은 경기에 함께 들어간 적이 있는 회차만 남긴다(팀은 상관없다).
 */
export function playedSessions(matches: readonly MatchView[], me: string, withOther?: string): PlayedSession[] {
  const bySession = new Map<string, { startedAt: string; sessionGames: number; myGames: number; shared: boolean }>();
  for (const match of countedInSessions(matches)) {
    const sid = match.sessionId!;
    const entry = bySession.get(sid) ?? { startedAt: match.playedAt, sessionGames: 0, myGames: 0, shared: false };
    entry.sessionGames += 1;
    if (playedIn(match, me)) {
      entry.myGames += 1;
      if (withOther !== undefined && playedIn(match, withOther)) entry.shared = true;
    }
    bySession.set(sid, entry);
  }
  return [...bySession]
    .filter(([, s]) => s.myGames > 0 && (withOther === undefined || s.shared))
    .map(([sessionId, s]) => ({ sessionId, startedAt: s.startedAt, sessionGames: s.sessionGames, myGames: s.myGames }))
    .sort((x, y) => y.startedAt.localeCompare(x.startedAt));
}

/** 그 회차에서 이 사람이 뛴 확정 경기, 앞 경기부터. other를 주면 경기마다 그 사람과의 관계를 붙인다. */
export function sessionGames(
  matches: readonly MatchView[],
  sessionId: string,
  me: string,
  other: string | null,
): SessionGame[] {
  const games: SessionGame[] = [];
  for (const match of countedInSessions(matches)) {
    if (match.sessionId !== sessionId) continue;
    const mine = match.roster.find((r) => r.participantId === me);
    if (!mine) continue;
    let relation: SessionRelation | null = null;
    if (other !== null) {
      const theirs = match.roster.find((r) => r.participantId === other);
      relation = !theirs ? "apart" : theirs.team === mine.team ? "together" : "against";
    }
    games.push({ match, position: mine.position, won: mine.team === match.winnerTeam, relation });
  }
  return games;
}

/** 그 회차에서 이 사람과 같은 경기에 한 번이라도 들어간 사람(같은 팀이든 상대든). 순서는 부르는 쪽이 정한다. */
export function sessionMates(matches: readonly MatchView[], sessionId: string, me: string): string[] {
  const mates = new Set<string>();
  for (const match of countedInSessions(matches)) {
    if (match.sessionId !== sessionId || !playedIn(match, me)) continue;
    for (const seat of match.roster) if (seat.participantId !== me) mates.add(seat.participantId);
  }
  return [...mates];
}
