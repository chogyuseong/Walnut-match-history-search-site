import { rngFromSeed } from "./draft";

/**
 * 팀 추천(docs/P2 P2-6).
 * 10명을 5:5로 나누는 126개 분할을 모두 비교한다.
 * 가중치와 비교 순서는 확인하지 못한 가정값이며 모임 설정으로 바꿀 수 있다.
 */
export interface RecommendPerson {
  key: string;
  /** 1(최상위)~4(최하위) 또는 null(미지정). 미지정은 낮은 실력이 아니다. */
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
  reason: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 9명 중 4명을 고르는 모든 조합. 첫 사람을 팀 A에 고정해 중복 분할을 없앤다. */
function* chooseFour(n: number): Generator<number[]> {
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) yield [a, b, c, d];
}

function count(people: RecommendPerson[], group: number | null): number {
  return people.filter((p) => p.skillGroup === group).length;
}

/**
 * 추천 후보를 좋은 순으로 돌려준다(최대 limit개).
 * 비교 순서(앞 기준이 같을 때만 뒤 기준을 본다):
 *   1) 가중치 합의 차  2) 최상위 그룹 인원 차  3) 최하위 그룹 인원 차
 *   4) 미지정 인원 차  5) 시드로 정한 순서
 */
export function recommendTeams(
  people: RecommendPerson[],
  groupWeights: readonly [number, number, number, number],
  seed: number,
  limit = 3,
  constraints: readonly TeamConstraint[] = [],
): TeamCandidate[] {
  if (people.length !== 10) throw new Error("추천은 10명이어야 합니다.");
  const assigned = people.filter((p) => p.skillGroup !== null);
  // 미지정은 지정된 참가자 가중치의 중앙값으로 계산한다.
  const fallback =
    assigned.length > 0 ? median(assigned.map((p) => groupWeights[p.skillGroup! - 1]!)) : 0;
  const weightOf = (p: RecommendPerson) =>
    p.skillGroup === null ? fallback : groupWeights[p.skillGroup - 1]!;

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
    return [
      {
        teamA: teamA.map((p) => p.key),
        teamB: teamB.map((p) => p.key),
        sumDiff: Math.round(Math.abs(sumA - sumB) * 1000) / 1000,
        topCount,
        bottomCount,
        unassignedCount,
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
      x.order - y.order,
  );

  return scored.slice(0, limit).map(({ order: _order, ...c }) => ({
    ...c,
    reason:
      assigned.length === 0
        ? "실력 그룹을 지정한 사람이 없어 무작위로 나눴어요."
        : `그룹 합계 차 ${c.sumDiff} · 최상위 ${c.topCount[0]}:${c.topCount[1]}` +
          (c.unassignedCount[0] + c.unassignedCount[1] > 0
            ? ` · 미지정 ${c.unassignedCount[0]}:${c.unassignedCount[1]}`
            : ""),
  }));
}
