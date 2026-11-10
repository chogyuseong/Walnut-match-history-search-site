import { avoidViolations } from "./avoid";
import { violatedConstraints, type AvoidMap, type Draft, type DraftSlot } from "./draft";
import { forecastBluePercent, teamExpectation } from "./forecast";
import type { RatingOptions, RatingTable } from "./rating";
import { repeatPairsOf, type DiversityInput } from "./recommend";
import { repeatSupporterIds, type RotationContext } from "./rotation";

/**
 * 준비 화면 "직전 편성 대비" 한 줄(2026-11-10 실험 A 축소형, docs/개선-경험-설계-2026-11-10.md 5·6절).
 * 직전 자리(previousSlots)와 지금 자리를 같은 입력으로 평가해 달라진 항목만 돌려준다. 초안·서버·MMR은 바꾸지 않는다.
 * 손으로 옮기는 것을 막지 않는 규칙은 그대로다: 이 줄은 알려 주기만 한다.
 * 폐기 조건(5절): 운영자 관찰에서 아무도 읽지 않거나, 예상 %를 실제 효과로 말하거나, 섞기 버튼을 못 찾게 되면 뺀다.
 */

/**
 * 항목 순서가 곧 화면 순서다. 앞의 넷(constraint~lock)은 시작 조건과 관련된 것이라 늘면 경고로 맨 앞에 둔다.
 * repeat·forecast는 참고 숫자라 늘거나 줄어도 경고하지 않는다.
 */
export type DeltaKind = "constraint" | "avoid" | "support" | "lock" | "repeat" | "forecast";

export interface DeltaLine {
  kind: DeltaKind;
  from: number;
  to: number;
  /** 나빠졌는지(앞의 넷에서 수가 늘었을 때만 true). */
  warn: boolean;
  /** repeat일 때 실제로 센 최근 경기 수. */
  matches?: number;
}

const ORDER: readonly DeltaKind[] = ["constraint", "avoid", "support", "lock", "repeat", "forecast"];

export function draftDelta(
  draft: Draft,
  inputs: {
    avoid: AvoidMap;
    ctx: RotationContext;
    diversity?: DiversityInput;
    ratings: RatingTable | null;
    ratingOptions: Partial<RatingOptions>;
  },
): DeltaLine[] {
  const previous = draft.previousSlots;
  if (!previous || !sameKeys(previous, draft.slots)) return [];
  const before: Draft = { ...draft, slots: previous };
  const lines: DeltaLine[] = [];
  const push = (kind: DeltaKind, from: number, to: number, extra: Partial<DeltaLine> = {}) => {
    if (from === to) return;
    const guarded = kind === "constraint" || kind === "avoid" || kind === "support" || kind === "lock";
    lines.push({ kind, from, to, warn: guarded && to > from, ...extra });
  };

  push("constraint", violatedConstraints(before).length, violatedConstraints(draft).length);
  push("avoid", avoidViolations(before, inputs.avoid).length, avoidViolations(draft, inputs.avoid).length);
  // 서포터 순환이 꺼져 있으면 repeatSupporterIds가 늘 빈 목록이라 이 항목은 나오지 않는다.
  push("support", repeatSupporterIds(before, inputs.ctx).length, repeatSupporterIds(draft, inputs.ctx).length);
  push("lock", 0, releasedLocks(previous, draft.slots));

  const diversity = inputs.diversity;
  if (diversity && diversity.recentMatches > 0) {
    push("repeat", repeatOf(previous, diversity), repeatOf(draft.slots, diversity), {
      matches: diversity.recentMatches,
    });
  }

  if (inputs.ratings) {
    const a = teamExpectation(before, inputs.ratings, inputs.ratingOptions);
    const b = teamExpectation(draft, inputs.ratings, inputs.ratingOptions);
    // 한쪽이라도 신뢰할 수 없으면(전원 배치 중 등) 숫자를 견주지 않는다.
    if (a.reliable && b.reliable) push("forecast", forecastBluePercent(a), forecastBluePercent(b));
  }

  // 나빠진 항목을 앞으로. 같은 무리 안에서는 ORDER 순서. 뒤 항목이 좋아져도 앞의 경고를 가리지 않는다.
  return lines.sort((x, y) => Number(y.warn) - Number(x.warn) || ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind));
}

/** 사람 교체 뒤에는 이력이 비지만(draft.ts replacePerson), 예전 초안이 남긴 어긋난 이력이면 견주지 않는다. */
function sameKeys(a: readonly DraftSlot[], b: readonly DraftSlot[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((s) => s.key));
  return b.every((s) => keys.has(s.key));
}

/** 직전에 고정이었는데 팀이나 포지션이 바뀐 사람 수(손으로 옮기면 고정이 풀린다, draft.ts swapPeople). */
function releasedLocks(previous: readonly DraftSlot[], current: readonly DraftSlot[]): number {
  const now = new Map(current.map((s) => [s.key, s]));
  return previous.filter((s) => {
    const after = now.get(s.key);
    return s.locked && after !== undefined && (after.team !== s.team || after.position !== s.position);
  }).length;
}

function repeatOf(slots: readonly DraftSlot[], diversity: DiversityInput): number {
  const team = (t: "A" | "B") => slots.filter((s) => s.team === t).map((s) => s.key);
  return repeatPairsOf(team("A"), team("B"), diversity);
}
