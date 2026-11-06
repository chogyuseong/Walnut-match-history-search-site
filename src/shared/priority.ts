import { applyTeams, nextSeed, rngFromSeed, type AvoidMap, type Draft } from "./draft";
import { chooseFour, priorityWeightOf, satisfies, type RecommendPerson } from "./recommend";

/**
 * 우선순위(화면 이름. 코드·DB 이름은 skillGroup / skill_group 그대로)와 "팀까지 올랜덤".
 * 1순위가 가장 잘하는 사람이고 미지정은 못하는 사람이 아니라 아직 안 정한 사람이다.
 */

/** 순위 칸: 1~4와 미지정(null). */
export const PRIORITY_CLASSES = [1, 2, 3, 4, null] as const;
export type Priority = (typeof PRIORITY_CLASSES)[number];

/** 초안 키 → 우선순위. 없거나 1~4가 아닌 값은 미지정. */
export type PriorityMap = Readonly<Record<string, number | null | undefined>>;

export function normalizePriority(value: number | null | undefined): Priority {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : null;
}

export interface PriorityCount {
  priority: Priority;
  /** 팀 A 인원. */
  a: number;
  /** 팀 B 인원. */
  b: number;
}

/** 지금 편성에서 순위 칸마다 팀 A·B 인원. 5칸 모두 돌려준다(0명 포함). */
export function priorityCounts(draft: Draft, priorityOf: PriorityMap): PriorityCount[] {
  return PRIORITY_CLASSES.map((priority) => {
    const slots = draft.slots.filter((s) => normalizePriority(priorityOf[s.key]) === priority);
    return {
      priority,
      a: slots.filter((s) => s.team === "A").length,
      b: slots.filter((s) => s.team === "B").length,
    };
  });
}

/**
 * 가중치 합 차의 허용 폭: 서로 다른 가중치 사이의 가장 작은 간격(기본 [4,3,2,1]이면 1).
 * 가중치가 모두 같으면 0. 순위별 인원 차 ≤ 1을 지키면 합 차는 "남는 한 명"들을 어느 팀에 두느냐로만 달라지므로,
 * 최소값 + 이 폭 안의 후보만 남겨 남는 사람이 한 팀에 몰리지 않게 한다. 같은 순위 안에서 누가 어느 팀에 가는지는
 * 여전히 자유라 후보는 충분히 많다.
 */
export function priorityTolerance(groupWeights: readonly number[]): number {
  const distinct = [...new Set(groupWeights)].sort((x, y) => x - y);
  let step = Infinity;
  for (let i = 1; i < distinct.length; i++) step = Math.min(step, distinct[i]! - distinct[i - 1]!);
  return Number.isFinite(step) ? step : 0;
}

export interface TeamShuffleResult {
  draft: Draft;
  /** 섞은 뒤 순위 칸마다 팀 A·B 인원(5칸). */
  counts: PriorityCount[];
  /** 우선순위를 정한 사람 수(0이면 완전 무작위). */
  assigned: number;
  /** 같은 팀·다른 팀 조건을 모두 지켰는지. 조건이 없으면 true. */
  constraintsKept: boolean;
  /** 고를 수 있던 후보 수(팀 A·B 이름표를 뺀 분할 수). 점검용. */
  candidates: number;
}

/**
 * 팀까지 올랜덤: 10명을 두 팀으로 다시 나누고 라인도 팀마다 무작위로 정한다.
 * 1) 5:5의 126개 분할 중 모든 순위 칸(1·2·3·4·미지정)에서 두 팀 인원 차가 1 이하인 것만 후보(합이 10이라 항상 있다).
 * 2) 같은 팀·다른 팀 조건을 모두 지키는 후보가 있으면 그 안에서만. 없으면 조건을 어기더라도 순위 균형을 지킨다
 *    (화면은 violatedConstraints로 알린다).
 * 3) 가중치 합 차(미지정은 recommendTeams와 같은 중앙값)가 최소 + priorityTolerance 이하인 후보만.
 * 4) 남은 후보 중 하나를 시드로 균등하게 고르고, 팀 A·B 이름표도 시드로 반반 정한다.
 * 팀을 정한 뒤는 applyTeams와 같다: 포지션 고정은 유지하되 같은 팀에서 겹치면 뒤 사람의 고정을 풀고, 라인은 팀마다 무작위,
 * 추첨 기록은 비우고, 직전 편성으로 되돌릴 수 있다. 진영 선택(teamASide)과 조건은 그대로 둔다. 시드는 전진한다.
 * 우선순위를 정한 사람이 없으면 모든 분할이 후보라 완전 무작위 5:5다.
 * avoid(기피 라인)는 팀을 나누는 데는 쓰지 않고 라인을 뽑을 때만 되도록 피한다(applyTeams). 비어 있으면 예전과 같은 결과다.
 */
export function shuffleTeamsByPriority(
  draft: Draft,
  priorityOf: PriorityMap,
  groupWeights: readonly [number, number, number, number],
  avoid?: AvoidMap,
): TeamShuffleResult {
  if (draft.people.length !== 10) throw new Error("팀까지 올랜덤은 10명이어야 합니다.");
  const people: RecommendPerson[] = draft.people.map((p) => ({
    key: p.key,
    skillGroup: normalizePriority(priorityOf[p.key]),
  }));
  const weightOf = priorityWeightOf(people, groupWeights);
  const total = new Map<Priority, number>();
  for (const p of people) total.set(p.skillGroup as Priority, (total.get(p.skillGroup as Priority) ?? 0) + 1);

  const first = people[0]!;
  const rest = people.slice(1);
  const constraints = draft.constraints ?? [];
  const balanced: { teamA: string[]; sumDiff: number; kept: boolean }[] = [];
  for (const picks of chooseFour(rest.length)) {
    const teamA = [first, ...picks.map((i) => rest[i]!)];
    const inA = new Set(teamA.map((p) => p.key));
    const ok = PRIORITY_CLASSES.every((c) => {
      const a = teamA.filter((p) => p.skillGroup === c).length;
      return Math.abs(a - ((total.get(c) ?? 0) - a)) <= 1;
    });
    if (!ok) continue;
    const sumA = teamA.reduce((s, p) => s + weightOf(p), 0);
    const sumB = people.filter((p) => !inA.has(p.key)).reduce((s, p) => s + weightOf(p), 0);
    balanced.push({
      teamA: teamA.map((p) => p.key),
      sumDiff: Math.round(Math.abs(sumA - sumB) * 1000) / 1000,
      kept: constraints.every((c) => satisfies(inA, c)),
    });
  }
  // 순위 균형을 지키는 분할은 항상 있다(같은 순위끼리 번갈아 놓으면 된다).
  const keeping = balanced.filter((c) => c.kept);
  let pool = keeping.length > 0 ? keeping : balanced;
  const min = Math.min(...pool.map((c) => c.sumDiff));
  const tolerance = priorityTolerance(groupWeights);
  pool = pool.filter((c) => c.sumDiff <= min + tolerance + 1e-9);

  const rng = rngFromSeed(draft.seed);
  const chosen = pool[Math.floor(rng() * pool.length)]!;
  const chosenA = new Set(chosen.teamA);
  const teamA = rng() < 0.5 ? chosen.teamA : people.map((p) => p.key).filter((k) => !chosenA.has(k));
  // 라인 무작위는 applyTeams가 한다. 분할을 고른 난수와 겹치지 않게 다음 시드를 넘긴다.
  const next = applyTeams({ ...draft, seed: nextSeed(draft.seed) }, teamA, avoid);
  return {
    draft: next,
    counts: priorityCounts(next, priorityOf),
    assigned: people.filter((p) => p.skillGroup !== null).length,
    constraintsKept: keeping.length > 0 || constraints.length === 0,
    candidates: pool.length,
  };
}

export function priorityLabel(priority: Priority): string {
  return priority === null ? "미지정" : `${priority}순위`;
}

/** 팀까지 올랜덤 뒤 알림 문구. 예: "1순위 1:1 · 2순위 2:1로 나눴어요." */
export function teamShuffleText(result: TeamShuffleResult): string {
  const shown = result.counts.filter((c) => c.a + c.b > 0);
  // 마지막 숫자를 읽는 소리(영·삼·육은 받침 ㅇ·ㅁ·ㄱ)에 맞춰 "으로"/"로".
  const last = shown[shown.length - 1]?.b ?? 0;
  const particle = [0, 3, 6].includes(last % 10) ? "으로" : "로";
  const base =
    result.assigned === 0
      ? "우선순위를 정한 사람이 없어 무작위로 나눴어요."
      : `${shown.map((c) => `${priorityLabel(c.priority)} ${c.a}:${c.b}`).join(" · ")}${particle} 나눴어요.`;
  return result.constraintsKept
    ? base
    : `${base} 같은 팀·다른 팀 조건을 모두 지키는 편성이 없어 우선순위 균형을 먼저 지켰어요.`;
}
