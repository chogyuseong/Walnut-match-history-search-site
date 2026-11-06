import { rngFromSeed } from "./draft";
import type { MatchView, Settings } from "./types";

/**
 * 팀 추천(docs/P2 P2-6).
 * 10명을 5:5로 나누는 126개 분할을 모두 비교한다.
 * 가중치와 비교 순서는 확인하지 못한 가정값이며 모임 설정으로 바꿀 수 있다.
 */
export interface RecommendPerson {
  key: string;
  /** 티어(화면 이름, 예전 "실력 그룹"). 1(가장 잘함)~4 또는 null(미지정). 미지정은 낮은 실력이 아니다. */
  skillGroup: number | null;
}

/** 같은 팀·다른 팀 조건. 추천은 이 조건을 어기는 편성을 후보에서 뺀다. */
export interface TeamConstraint {
  kind: "same" | "different";
  a: string;
  b: string;
}

/** 주어진 팀 A 구성이 조건을 만족하는지. */
export function satisfies(teamA: ReadonlySet<string>, constraint: TeamConstraint): boolean {
  const together = teamA.has(constraint.a) === teamA.has(constraint.b);
  return constraint.kind === "same" ? together : !together;
}

export interface TeamCandidate {
  teamA: string[];
  teamB: string[];
  /** 가중치 합의 차. 승리 확률이 아니다. */
  sumDiff: number;
  topCount: [number, number];
  bottomCount: [number, number];
  unassignedCount: [number, number];
  /**
   * 조합 다양성을 반영했을 때만 있다: 이 분할에서 같은 팀이 되는 쌍들이
   * 최근 경기에서 같은 팀이었던 횟수의 합. 작을수록 새 조합이다.
   */
  repeatPairs?: number;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* 조합 다양성                                                          */
/* ------------------------------------------------------------------ */

/**
 * 다양성 계산에 쓰는 최근 경기 수. 하루 최대 8경기 가정(docs/P2 P2-2의 대기 상한 근거)과 같게 두어
 * "오늘 저녁 안에서 같은 조합 반복"을 주로 막고, 새 내전 첫 판에는 지난 내전 후반의 조합을 피한다.
 */
export const DIVERSITY_RECENT_MATCHES = 8;

export interface DiversityInput {
  /** 두 사람(추천 키)이 최근 경기에서 같은 팀이었던 횟수. */
  together: (a: string, b: string) => number;
  /** 실제로 센 최근 경기 수(0이면 다양성이 결과를 바꾸지 않는다). */
  recentMatches: number;
}

/** 다양성 설정. 저장한 적이 없으면 켜짐이다(docs: Settings.teamDiversity). */
export function diversityEnabled(settings: Pick<Settings, "teamDiversity">): boolean {
  return settings.teamDiversity !== false;
}

/**
 * 최근 경기에서 참가자 ID 쌍마다 같은 팀이었던 횟수를 센다.
 * 센다: 결과 확정·결과 입력 대기·진행 중(실제로 뛴 경기). 세지 않는다: 미진행 취소, 전적 제외.
 * 순서는 경기 시각 → 경기 번호의 최근 순이라 같은 경기 목록이면 항상 같은 결과다.
 */
export function recentTeammateCounts(
  matches: readonly MatchView[],
  limit = DIVERSITY_RECENT_MATCHES,
): { counts: Map<string, number>; used: number } {
  const played = matches
    .filter((m) => m.state === "confirmed" || m.state === "awaiting_result" || m.state === "in_progress")
    .sort((a, b) => (a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : b.matchNo - a.matchNo))
    .slice(0, limit);
  const counts = new Map<string, number>();
  for (const match of played) {
    for (const team of ["A", "B"] as const) {
      const ids = match.roster.filter((r) => r.team === team).map((r) => r.participantId);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = pairKey(ids[i]!, ids[j]!);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
  }
  return { counts, used: played.length };
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * 추천에 넘길 다양성 입력을 만든다. 설정이 꺼져 있으면 undefined(예전 추천과 같은 결과).
 * people의 key는 추천 키, participantId는 서버 참가자 ID(아직 없으면 null — 최근 기록이 없는 사람).
 */
export function diversityFor(
  source: { matches: readonly MatchView[]; settings: Pick<Settings, "teamDiversity"> },
  people: readonly { key: string; participantId: string | null }[],
  limit = DIVERSITY_RECENT_MATCHES,
): DiversityInput | undefined {
  if (!diversityEnabled(source.settings)) return undefined;
  const { counts, used } = recentTeammateCounts(source.matches, limit);
  const idOf = new Map(people.map((p) => [p.key, p.participantId]));
  return {
    recentMatches: used,
    together: (a, b) => {
      const ia = idOf.get(a);
      const ib = idOf.get(b);
      if (!ia || !ib) return 0;
      return counts.get(pairKey(ia, ib)) ?? 0;
    },
  };
}

function repeatScore(team: readonly string[], diversity: DiversityInput): number {
  let score = 0;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) score += diversity.together(team[i]!, team[j]!);
  }
  return score;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * 사람별 가중치. 지정된 사람은 그 티어의 가중치, 미지정은 지정된 사람 가중치의 중앙값(아무도 없으면 0).
 * 팀 추천과 팀까지 올랜덤(src/shared/priority.ts)이 같이 쓴다.
 */
export function priorityWeightOf(
  people: readonly RecommendPerson[],
  groupWeights: readonly [number, number, number, number],
): (p: RecommendPerson) => number {
  const assigned = people.filter((p) => p.skillGroup !== null);
  const fallback =
    assigned.length > 0 ? median(assigned.map((p) => groupWeights[p.skillGroup! - 1]!)) : 0;
  return (p) => (p.skillGroup === null ? fallback : groupWeights[p.skillGroup - 1]!);
}

/** 9명 중 4명을 고르는 모든 조합. 첫 사람을 팀 A에 고정해 중복 분할을 없앤다. */
export function* chooseFour(n: number): Generator<number[]> {
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) yield [a, b, c, d];
}

function count(people: RecommendPerson[], group: number | null): number {
  return people.filter((p) => p.skillGroup === group).length;
}

/**
 * 추천 후보를 좋은 순으로 돌려준다(최대 limit개).
 * 같은 팀·다른 팀 조건을 어기는 분할은 비교하기 전에 뺀다.
 * 비교 순서(앞 기준이 같을 때만 뒤 기준을 본다):
 *   1) 가중치 합의 차  2) 1티어 인원 차  3) 4티어 인원 차
 *   4) 미지정 인원 차  5) 조합 다양성(diversity를 넘겼을 때만) 6) 시드로 정한 순서
 * 다양성은 1~4가 모두 같은 후보(균형 허용 폭 0) 사이에서만 순서를 정하므로 균형을 희생하지 않는다.
 * diversity를 넘기지 않으면 예전과 똑같은 결과다(시드 순서 값도 같은 순서로 뽑는다).
 */
export function recommendTeams(
  people: RecommendPerson[],
  groupWeights: readonly [number, number, number, number],
  seed: number,
  limit = 3,
  constraints: readonly TeamConstraint[] = [],
  diversity?: DiversityInput,
): TeamCandidate[] {
  if (people.length !== 10) throw new Error("추천은 10명이어야 합니다.");
  const assigned = people.filter((p) => p.skillGroup !== null);
  // 미지정은 지정된 참가자 가중치의 중앙값으로 계산한다.
  const weightOf = priorityWeightOf(people, groupWeights);

  const rng = rngFromSeed(seed);
  const first = people[0]!;
  const rest = people.slice(1);
  const scored = [...chooseFour(rest.length)].flatMap((picks) => {
    const teamA = [first, ...picks.map((i) => rest[i]!)];
    const inA = new Set(teamA.map((p) => p.key));
    // 조건을 어기는 분할은 후보에서 뺀다. 모두 빠지면 빈 목록을 돌려준다.
    if (!constraints.every((c) => satisfies(inA, c))) return [];
    const teamB = people.filter((p) => !inA.has(p.key));
    const sumA = teamA.reduce((s, p) => s + weightOf(p), 0);
    const sumB = teamB.reduce((s, p) => s + weightOf(p), 0);
    const topCount: [number, number] = [count(teamA, 1), count(teamB, 1)];
    const bottomCount: [number, number] = [count(teamA, 4), count(teamB, 4)];
    const unassignedCount: [number, number] = [count(teamA, null), count(teamB, null)];
    const repeat = diversity
      ? repeatScore(teamA.map((p) => p.key), diversity) + repeatScore(teamB.map((p) => p.key), diversity)
      : 0;
    return [
      {
        teamA: teamA.map((p) => p.key),
        teamB: teamB.map((p) => p.key),
        sumDiff: Math.round(Math.abs(sumA - sumB) * 1000) / 1000,
        topCount,
        bottomCount,
        unassignedCount,
        repeat,
        order: rng(),
      },
    ];
  });

  scored.sort(
    (x, y) =>
      x.sumDiff - y.sumDiff ||
      Math.abs(x.topCount[0] - x.topCount[1]) - Math.abs(y.topCount[0] - y.topCount[1]) ||
      Math.abs(x.bottomCount[0] - x.bottomCount[1]) -
        Math.abs(y.bottomCount[0] - y.bottomCount[1]) ||
      Math.abs(x.unassignedCount[0] - x.unassignedCount[1]) -
        Math.abs(y.unassignedCount[0] - y.unassignedCount[1]) ||
      x.repeat - y.repeat ||
      x.order - y.order,
  );

  const diversityShown = diversity !== undefined && diversity.recentMatches > 0;
  return scored.slice(0, limit).map(({ order: _order, repeat, ...c }) => {
    const base =
      assigned.length === 0
        ? diversityShown
          ? "티어를 정한 사람이 없어 최근 조합을 피해 나눴어요."
          : "티어를 정한 사람이 없어 무작위로 나눴어요."
        : `티어 합계 차 ${c.sumDiff} · 1티어 ${c.topCount[0]}:${c.topCount[1]}` +
          (c.unassignedCount[0] + c.unassignedCount[1] > 0
            ? ` · 미지정 ${c.unassignedCount[0]}:${c.unassignedCount[1]}`
            : "");
    if (!diversityShown) return { ...c, reason: base };
    return {
      ...c,
      repeatPairs: repeat,
      reason: `${base} · 최근 ${diversity!.recentMatches}경기 같은 팀 반복 ${repeat}번`,
    };
  });
}
