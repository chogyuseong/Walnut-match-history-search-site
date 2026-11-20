import type { Combo } from "../../../shared/bestCombos";
import type { Draft } from "../../../shared/draft";
import { ratePercent } from "../../../shared/stats";
import { POSITIONS, TEAMS } from "../../../shared/types";

/**
 * 팀 짜기 편성판(TeamBoards.tsx)의 "콤비" 배지: 누구에게 붙이고, 어느 색으로 묶고, 마우스를 올리면 무슨 설명이 뜨는지.
 * 콤비 판정 자체는 shared/bestCombos.ts가 한다. 여기서는 지금 편성에서 같은 팀에 함께 선 쌍만 고른다.
 * test/teamBoardsCombo.test.ts가 브라우저 타입 없이 가져오므로 web/format.ts(location을 씀) 대신 shared만 쓴다.
 */

/**
 * 콤비 배지 색 칸 수. 한 팀 5명이라 팀마다 최대 2쌍, 두 팀 합쳐 4쌍이고, 색은 이야기 카드 넷(--story-*)을 다시 쓴다
 * (CLAUDE.md 5절 예외, CSS .combo-hue-1~4). 쌍이 늘 4개 이하라 색이 겹칠 일은 없지만, 규칙이 바뀌어 넘치면 나머지로 돌려 쓴다.
 */
const COMBO_HUES = 4;

export interface ComboMark {
  /** 편성판에서 몇 번째 콤비인지(1부터, 블루팀 위 라인부터 센다). 콤비가 하나뿐이면 null: 색 없이 회색 배지. */
  hue: number | null;
  /** 배지에 마우스를 올렸을 때 뜨는 설명. 두 사람 모두 같은 글이다. */
  title: string;
}

/**
 * 같은 팀에 최고의 콤비 두 사람이 함께 있으면 그 둘의 슬롯 키 → 표식. 참가자 ID가 없는 사람(새 이름)은 기록이 없어
 * 콤비가 될 수 없다. 콤비가 둘 이상일 때만 쌍마다 색을 준다: 하나뿐이면 누구와 짝인지 헷갈릴 일이 없어 회색 그대로 둔다.
 * 번호는 자리 순서(팀 → 라인)로 매긴다. 섞으면 순서가 바뀌어 같은 쌍의 색도 바뀔 수 있다(한 화면 안에서 묶는 용도라 괜찮다).
 */
export function comboMarks(
  draft: Draft,
  combos: ReadonlyMap<string, Combo> | null,
  nameOf: (key: string) => string,
): ReadonlyMap<string, ComboMark> {
  const marks = new Map<string, ComboMark>();
  if (!combos || combos.size === 0) return marks;
  const idOf = new Map(draft.people.map((p) => [p.key, p.participantId]));
  const ordered = TEAMS.flatMap((team) =>
    POSITIONS.flatMap((position) => draft.slots.filter((s) => s.team === team && s.position === position)),
  );
  const slotOfId = new Map<string, { key: string; team: string }>();
  for (const slot of ordered) {
    const id = idOf.get(slot.key);
    if (id) slotOfId.set(id, slot);
  }
  const pairs: { keys: [string, string]; combo: Combo }[] = [];
  const counted = new Set<string>();
  for (const slot of ordered) {
    const id = idOf.get(slot.key);
    const combo = id ? combos.get(id) : undefined;
    const partner = combo ? slotOfId.get(combo.partnerId) : undefined;
    if (!combo || !partner || partner.team !== slot.team || counted.has(slot.key)) continue;
    pairs.push({ keys: [slot.key, partner.key], combo });
    counted.add(slot.key).add(partner.key);
  }
  pairs.forEach(({ keys, combo }, index) => {
    const { wins, games } = combo.together;
    const title =
      `${nameOf(keys[0])}·${nameOf(keys[1])}의 최고의 콤비 · ` +
      `같은 팀 ${games}경기 승률 ${ratePercent(wins, games)}% · 두 사람 평균보다 +${combo.synergy}%p`;
    const hue = pairs.length > 1 ? (index % COMBO_HUES) + 1 : null;
    for (const key of keys) marks.set(key, { hue, title });
  });
  return marks;
}
