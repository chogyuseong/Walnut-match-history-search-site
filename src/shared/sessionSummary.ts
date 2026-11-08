import { isCounted } from "./stats";
import type { MatchView } from "./types";

/**
 * 오늘(가장 최근 내전) 요약 공유(2026-11-07). 화면은 src/web/screens/Today.tsx "오늘 요약 공유",
 * 이미지는 src/web/shareImage.tsx drawSessionSummaryImage.
 * - 세는 경기는 전적 집계와 같다(isCounted: 결과가 확정된 경기만). 진행 중·결과 대기 경기는 빠진다.
 * - 넣는 것: 경기 수, 사람별 승패(승 많은 순), 서포터를 간 사람과 횟수, 지금 연승 중인 사람(2연승 이상).
 * - 넣지 않는 것: 티어·가중치·기피 라인·서포터 횟수 보정값·조회 링크(비공개 정보). 이름과 경기 결과만 쓴다.
 */

export interface SessionPersonLine {
  participantId: string;
  name: string;
  wins: number;
  losses: number;
}

export interface SessionSupporter {
  participantId: string;
  name: string;
  /** 오늘 확정 경기에서 서포터로 뛴 횟수. */
  count: number;
}

export interface SessionStreak {
  participantId: string;
  name: string;
  /** 모든 확정 경기(오늘까지 누적)의 지금 연승 수. 2 이상만 싣는다. */
  wins: number;
}

export interface SessionSummary {
  /** 오늘 확정 경기 수. */
  games: number;
  /** 오늘 결과를 아직 넣지 않은 경기 수(진행 중·결과 대기). 요약에는 들어가지 않는다는 안내에 쓴다. */
  pending: number;
  /** 승 많은 순 → 패 적은 순 → 이름 순. */
  people: SessionPersonLine[];
  /** 횟수 많은 순 → 이름 순. */
  supporters: SessionSupporter[];
  /** 연승 많은 순 → 이름 순. 오늘 뛴 사람만. */
  streaks: SessionStreak[];
}

/** 연승을 알리는 최소 연승 수. */
export const STREAK_MIN = 2;

function byPlayed(a: MatchView, b: MatchView): number {
  return a.playedAt.localeCompare(b.playedAt) || a.matchNo - b.matchNo;
}

/**
 * sessionMatches: 오늘 경기(stats.ts todayMatches), allMatches: 모임의 모든 경기(연승 계산용).
 */
export function sessionSummary(
  sessionMatches: readonly MatchView[],
  allMatches: readonly MatchView[],
  nameOf: (id: string) => string,
): SessionSummary {
  const counted = sessionMatches.filter(isCounted).sort(byPlayed);
  const pending = sessionMatches.filter((m) => m.state === "in_progress" || m.state === "awaiting_result").length;
  const ko = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "ko");

  const tally = new Map<string, SessionPersonLine>();
  const support = new Map<string, number>();
  for (const match of counted) {
    for (const entry of match.roster) {
      const line =
        tally.get(entry.participantId) ??
        { participantId: entry.participantId, name: nameOf(entry.participantId), wins: 0, losses: 0 };
      if (entry.team === match.winnerTeam) line.wins += 1;
      else line.losses += 1;
      tally.set(entry.participantId, line);
      if (entry.position === "support") support.set(entry.participantId, (support.get(entry.participantId) ?? 0) + 1);
    }
  }
  const people = [...tally.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || ko(a, b));
  const supporters = [...support]
    .map(([participantId, count]) => ({ participantId, name: nameOf(participantId), count }))
    .sort((a, b) => b.count - a.count || ko(a, b));

  // 지금 연승: 모든 확정 경기를 시간 순으로 보며 사람마다 이기면 +1, 지면 0.
  const current = new Map<string, number>();
  for (const match of allMatches.filter(isCounted).sort(byPlayed)) {
    for (const entry of match.roster) {
      current.set(entry.participantId, entry.team === match.winnerTeam ? (current.get(entry.participantId) ?? 0) + 1 : 0);
    }
  }
  const streaks = people
    .map((p) => ({ participantId: p.participantId, name: p.name, wins: current.get(p.participantId) ?? 0 }))
    .filter((s) => s.wins >= STREAK_MIN)
    .sort((a, b) => b.wins - a.wins || ko(a, b));

  return { games: counted.length, pending, people, supporters, streaks };
}

/** 카톡 등에 붙여 넣을 글. dateLabel 예: "11월 7일". */
export function sessionSummaryText(summary: SessionSummary, groupName: string, dateLabel: string): string {
  const lines = [`${groupName} · ${dateLabel} 내전 요약`, `확정 ${summary.games}경기 · 참가 ${summary.people.length}명`];
  lines.push("", "개인 승패 (승 많은 순)");
  for (const p of summary.people) lines.push(`${p.name} ${p.wins}승 ${p.losses}패`);
  lines.push(
    "",
    summary.supporters.length > 0
      ? `서포터: ${summary.supporters.map((s) => `${s.name} ${s.count}번`).join(" · ")}`
      : "서포터: 기록 없음",
    summary.streaks.length > 0
      ? `연승 중: ${summary.streaks.map((s) => `${s.name} ${s.wins}연승`).join(" · ")}`
      : "연승 중: 없음",
  );
  if (summary.pending > 0) lines.push("", `결과를 아직 넣지 않은 ${summary.pending}경기는 빠졌어요.`);
  return lines.join("\n");
}
