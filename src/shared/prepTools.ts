import { replacePerson, type Draft, type DraftPerson } from "./draft";
import { pairRecord } from "./headToHead";
import { normalizePriority, priorityCounts, type PriorityCount, type PriorityMap } from "./priority";
import { priorityWeightOf, type RecommendPerson } from "./recommend";
import { sameComposition } from "./series";
import { isCounted, ratePercent } from "./stats";
import { POSITIONS, type GroupWeights, type MatchView, type Position, type RosterEntry } from "./types";

/**
 * 준비 화면 추가 기능(2026-11-07)의 순수 계산. 화면은 src/web/screens/Prep.tsx·Pick.tsx.
 * - 편성 균형: 두 팀의 티어 점수 합과 티어별 인원(운영자만 보는 정보).
 * - 라인 맞대결: 같은 라인에 선 두 사람이 지난 확정 경기에서 서로 다른 팀으로 만난 전적.
 * - 대기자: 11명 이상 고르면 10명으로 편성을 만들고 나머지를 초안의 bench에 둔다(기기에만, 서버로 보내지 않음).
 * - 같은 편성 경고: 직전 경기와 두 팀 구성이 같은지(진영이 바뀐 것은 같은 것으로 본다).
 * 되돌리기 여러 단계는 src/shared/draft.ts의 pushHistory·undoDraft·redoDraft가 맡는다.
 */

/* ------------------------------------------------------------------ */
/* 편성 균형                                                            */
/* ------------------------------------------------------------------ */

export interface DraftBalance {
  /** 팀 A(블루)·팀 B(레드)의 티어 점수 합. 미지정은 팀 추천과 같은 중앙값(priorityWeightOf). */
  sumA: number;
  sumB: number;
  /** sumA − sumB(소수 셋째 자리에서 반올림). 0이면 균형. */
  diff: number;
  /** 티어 칸(1~5·미지정)마다 팀 A·B 인원. 6칸 모두. */
  counts: PriorityCount[];
  /** 티어를 정한 사람 수. */
  assigned: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * 지금 편성의 균형. 점수 계산은 팀 추천(recommendTeams)·팀·라인 모두 섞기와 같다:
 * 지정된 사람은 그 티어의 가중치(groupWeights[티어 − 1]), 미지정은 지정된 사람 가중치의 중앙값(아무도 없으면 0).
 */
export function draftBalance(draft: Draft, priorityOf: PriorityMap, groupWeights: Readonly<GroupWeights>): DraftBalance {
  const people: RecommendPerson[] = draft.people.map((p) => ({
    key: p.key,
    skillGroup: normalizePriority(priorityOf[p.key]),
  }));
  const weightOf = priorityWeightOf(people, groupWeights);
  const byKey = new Map(people.map((p) => [p.key, p]));
  const sum = (team: "A" | "B") =>
    round3(
      draft.slots
        .filter((s) => s.team === team)
        .reduce((total, s) => total + weightOf(byKey.get(s.key) ?? { key: s.key, skillGroup: null }), 0),
    );
  const sumA = sum("A");
  const sumB = sum("B");
  return {
    sumA,
    sumB,
    diff: round3(sumA - sumB),
    counts: priorityCounts(draft, priorityOf),
    assigned: people.filter((p) => p.skillGroup !== null).length,
  };
}

/** 균형 한 줄: "균형" 또는 "블루팀이 2 높아요". teamNames는 [팀 A 이름, 팀 B 이름]. */
export function balanceText(balance: DraftBalance, teamNames: readonly [string, string]): string {
  if (balance.diff === 0) return "균형";
  const higher = balance.diff > 0 ? teamNames[0] : teamNames[1];
  return `${higher}이 ${Math.abs(balance.diff)} 높아요`;
}

/* ------------------------------------------------------------------ */
/* 라인 맞대결                                                          */
/* ------------------------------------------------------------------ */

export interface LaneMatchup {
  position: Position;
  /** 왼쪽(팀 A, 블루) 사람의 초안 키. 그 자리가 비었으면 null. */
  leftKey: string | null;
  /** 오른쪽(팀 B, 레드) 사람의 초안 키. */
  rightKey: string | null;
  /** 두 사람이 서로 다른 팀으로 만난 확정 경기 수. */
  games: number;
  /** 왼쪽 사람 기준 승·패. */
  wins: number;
  losses: number;
}

/**
 * 같은 라인에 선 두 사람(블루 탑 vs 레드 탑 등)이 지난 경기에서 서로 다른 팀으로 만난 횟수와 승패(왼쪽 사람 기준).
 * 세는 경기는 전적 집계(src/shared/stats.ts isCounted)와 같다: 결과가 확정된 경기만(진행 중·결과 대기·
 * 미진행 취소·전적 제외는 빼고). 그 경기에서 두 사람의 포지션은 따지지 않는다(서로 다른 팀이기만 하면 센다).
 * 아직 참가자 ID가 없는 새 이름은 지난 경기가 없으므로 0경기다.
 */
export function laneMatchups(draft: Draft, matches: readonly MatchView[]): LaneMatchup[] {
  const idOf = new Map(draft.people.map((p) => [p.key, p.participantId]));
  const counted = matches.filter(isCounted);
  return POSITIONS.map((position) => {
    const leftKey = draft.slots.find((s) => s.team === "A" && s.position === position)?.key ?? null;
    const rightKey = draft.slots.find((s) => s.team === "B" && s.position === position)?.key ?? null;
    const left = leftKey ? idOf.get(leftKey) : null;
    const right = rightKey ? idOf.get(rightKey) : null;
    // 두 사람의 상대 전적 계산은 src/shared/headToHead.ts 하나를 쓴다(개인 통계·두 사람 비교와 같은 기준).
    const { wins, losses } = left && right ? pairRecord(counted, left, right).against : { wins: 0, losses: 0 };
    return { position, leftKey, rightKey, games: wins + losses, wins, losses };
  });
}

/** 맞대결 한 줄의 전적: 다른 화면과 같은 꼴 "67% · 2승 1패 (3경기)" 또는 "첫 맞대결". */
export function matchupText(m: Pick<LaneMatchup, "games" | "wins" | "losses">): string {
  if (m.games === 0) return "첫 맞대결";
  return `${ratePercent(m.wins, m.games)}% · ${m.wins}승 ${m.losses}패 (${m.games}경기)`;
}

/* ------------------------------------------------------------------ */
/* 대기자                                                               */
/* ------------------------------------------------------------------ */

/** 편성 인원. */
export const TEAM_SIZE_TOTAL = 10;
/** 대기자 최대 인원(고르기 화면에서 10 + 이 수까지 고를 수 있다). */
export const BENCH_MAX = 10;

/**
 * 고른 사람을 편성 10명과 대기자로 나눈다. 고른 순서대로 앞 10명이 편성, 나머지가 대기자다.
 * extra(참가 신청의 대기 등)는 대기자 뒤에 붙인다. 같은 사람(키가 같은 사람)은 한 번만, 대기자는 BENCH_MAX명까지.
 */
export function splitBench(
  selected: readonly DraftPerson[],
  extra: readonly DraftPerson[] = [],
): { players: DraftPerson[]; bench: DraftPerson[] } {
  const players = selected.slice(0, TEAM_SIZE_TOTAL);
  const seen = new Set(players.map((p) => p.key));
  const bench: DraftPerson[] = [];
  for (const person of [...selected.slice(TEAM_SIZE_TOTAL), ...extra]) {
    if (seen.has(person.key) || bench.length >= BENCH_MAX) continue;
    seen.add(person.key);
    bench.push(person);
  }
  return { players, bench };
}

/** 초안에 대기자를 붙인다. 비어 있으면 필드를 두지 않는다(예전 초안과 같은 모양). */
export function withBench(draft: Draft, bench: readonly DraftPerson[]): Draft {
  const { bench: _old, ...rest } = draft;
  const keys = new Set(draft.people.map((p) => p.key));
  const kept = bench.filter((p) => !keys.has(p.key));
  return kept.length > 0 ? { ...rest, bench: kept } : rest;
}

/**
 * 편성 안의 사람(oldKey)과 대기자(benchKey)를 맞바꾼다. 대기자가 그 자리(팀·포지션)를 물려받고(replacePerson),
 * 빠진 사람은 대기자 맨 뒤로 간다. replacePerson과 같이 되돌리기 이력은 비우고, 빠진 사람에게 걸린 조건은 지운다.
 * 둘 중 하나라도 없으면 같은 초안을 그대로 돌려준다.
 */
export function swapWithBench(draft: Draft, oldKey: string, benchKey: string): Draft {
  const incoming = draft.bench?.find((p) => p.key === benchKey);
  const outgoing = draft.people.find((p) => p.key === oldKey);
  if (!incoming || !outgoing) return draft;
  const replaced = replacePerson(draft, oldKey, incoming);
  if (replaced === draft) return draft;
  return { ...replaced, bench: [...(replaced.bench ?? []).filter((p) => p.key !== benchKey), outgoing] };
}

/* ------------------------------------------------------------------ */
/* 같은 편성 경고                                                       */
/* ------------------------------------------------------------------ */

/** 초안의 명단(참가자 ID가 없는 새 이름은 초안 키로 둔다. 지난 경기와 구성을 견줄 때만 쓴다). */
export function draftRoster(draft: Draft): RosterEntry[] {
  return draft.slots.map((s) => ({
    participantId: draft.people.find((p) => p.key === s.key)?.participantId ?? s.key,
    team: s.team,
    position: s.position,
  }));
}

/** 직전 경기: 미진행 취소가 아닌 실시간(live) 경기 중 경기 번호가 가장 큰 것. 없으면 null. */
export function lastLiveMatch(matches: readonly MatchView[]): MatchView | null {
  let last: MatchView | null = null;
  for (const m of matches) {
    if (m.state === "canceled" || m.source !== "live") continue;
    if (!last || m.matchNo > last.matchNo) last = m;
  }
  return last;
}

/**
 * "이 팀으로 시작" 전에 같은 편성을 물을지: 직전 경기(lastLiveMatch)와 두 팀 구성이 같으면 그 경기를 돌려준다.
 * 진영(팀 A/B)이 바뀐 것은 같은 구성으로 본다(src/shared/series.ts sameComposition).
 * 시리즈로 이어가기 중(draft.series)이거나 "다음 경기 준비"로 만든 초안(origin "same-teams")이면 같은 팀이 의도된 것이라 묻지 않는다(null).
 */
export function sameTeamsAsLast(draft: Draft, matches: readonly MatchView[]): MatchView | null {
  if (draft.series || draft.origin === "same-teams") return null;
  const last = lastLiveMatch(matches);
  if (!last) return null;
  return sameComposition(last.roster, draftRoster(draft)) ? last : null;
}
