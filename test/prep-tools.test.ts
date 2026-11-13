import { describe, expect, it } from "vitest";
import {
  applyTeams,
  createDraft,
  draftFromMatch,
  historyOf,
  keepMatchPositions,
  redoDraft,
  replacePerson,
  rerollPositions,
  swapPeople,
  toggleLock,
  undoDraft,
  type Draft,
  type DraftPerson,
} from "../src/shared/draft";
import { HISTORY_MAX, parseStoredDraft, swapSides } from "../src/shared/storedDraft";
import { remapDraft } from "../src/shared/merge";
import {
  balanceText,
  BENCH_MAX,
  draftBalance,
  draftSplitRanks,
  laneMatchups,
  lastLiveMatch,
  matchupText,
  sameTeamsAsLast,
  splitBench,
  splitRanksText,
  swapWithBench,
  withBench,
} from "../src/shared/prepTools";
import { shuffleTeamsByPriority } from "../src/shared/priority";
import type { PersonRating, RatingTable } from "../src/shared/rating";
import { recommendTeams } from "../src/shared/recommend";
import { drawSupport, shuffleDraft, type RotationContext } from "../src/shared/rotation";
import { DEFAULT_SETTINGS, POSITIONS, type MatchState, type MatchView, type ParticipantView, type Team } from "../src/shared/types";

// 준비 화면 추가 기능 6가지(2026-11-07)의 순수 로직: 편성 균형, 라인 맞대결, 되돌리기 여러 단계, 대기자 교체, 같은 편성 경고.
// 편성 이미지(5번)는 canvas라 e2e에서 버튼만 확인한다.

const now = "2026-11-07T00:00:00.000Z";

function people(n = 10): DraftPerson[] {
  return Array.from({ length: n }, (_, i) => ({ key: `p:id${i}`, name: `참가자${i}`, participantId: `id${i}` }));
}

/** id0~4 팀 A(블루), id5~9 팀 B(레드). */
function fixedDraft(seed = 7): Draft {
  const teamOf: Record<string, Team> = {};
  people().forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
  return createDraft(people(), { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
}

const none: RotationContext = { enabled: true, cycleId: "c1", usedIds: new Set(), eventCount: 0, counts: new Map() };

let matchNo = 0;
/** 경기 하나. teamA는 팀 A의 참가자 ID 5명, 나머지 5명은 roster에서. */
function match(
  teamA: string[],
  teamB: string[],
  winner: Team | null,
  state: MatchState = "confirmed",
  extra: Partial<MatchView> = {},
): MatchView {
  matchNo += 1;
  return {
    id: `m${matchNo}`,
    matchNo,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: now,
    endedAt: now,
    playedAt: now,
    confirmedAt: state === "confirmed" ? now : null,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((id, i) => ({ participantId: id, team: "A" as Team, position: POSITIONS[i]! })),
      ...teamB.map((id, i) => ({ participantId: id, team: "B" as Team, position: POSITIONS[i]! })),
    ],
    ...extra,
  };
}

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `id${from + i}`);

describe("편성 균형", () => {
  it("티어 점수 합은 팀 추천과 같은 계산(미지정은 지정된 사람 가중치의 중앙값)이고 티어별 인원을 센다", () => {
    const d = fixedDraft();
    // 팀 A: 1·1·2·미지정·미지정, 팀 B: 3·4·5·미지정·미지정. 가중치 [5,4,3,2,1], 지정 가중치 [5,5,4,3,2,1]의 중앙값 3.5.
    const priority = { "p:id0": 1, "p:id1": 1, "p:id2": 2, "p:id5": 3, "p:id6": 4, "p:id7": 5 };
    const balance = draftBalance(d, priority, DEFAULT_SETTINGS.groupWeights);
    expect(balance.sumA).toBe(5 + 5 + 4 + 3.5 + 3.5);
    expect(balance.sumB).toBe(3 + 2 + 1 + 3.5 + 3.5);
    expect(balance.diff).toBe(balance.sumA - balance.sumB);
    expect(balance.assigned).toBe(6);
    expect(balance.counts).toEqual([
      { priority: 1, a: 2, b: 0 },
      { priority: 2, a: 1, b: 0 },
      { priority: 3, a: 0, b: 1 },
      { priority: 4, a: 0, b: 1 },
      { priority: 5, a: 0, b: 1 },
      { priority: null, a: 2, b: 2 },
    ]);
    expect(balanceText(balance, ["블루팀", "레드팀"])).toBe(`블루팀이 ${balance.diff} 높아요`);
    // 팀을 맞바꾸면 레드팀이 높다.
    const swapped = draftBalance(swapSides(d), priority, DEFAULT_SETTINGS.groupWeights);
    expect(swapped.diff).toBe(-balance.diff);
    expect(balanceText(swapped, ["블루팀", "레드팀"])).toBe(`레드팀이 ${balance.diff} 높아요`);
  });

  it("팀 추천 후보의 합 차와 같다(같은 계산 방식)", () => {
    const d = fixedDraft();
    const priority = { "p:id0": 1, "p:id3": 2, "p:id5": 2, "p:id8": 4, "p:id9": 5 };
    const people = d.people.map((p) => ({ key: p.key, skillGroup: (priority as Record<string, number>)[p.key] ?? null }));
    for (const candidate of recommendTeams(people, DEFAULT_SETTINGS.groupWeights, 3, 5)) {
      const applied = applyTeams(d, candidate.teamA);
      const balance = draftBalance(applied, priority, DEFAULT_SETTINGS.groupWeights);
      expect(Math.abs(balance.diff)).toBe(candidate.sumDiff);
    }
  });

  it("차가 0이면 '균형', 아무도 정하지 않았으면 모두 0점", () => {
    const d = fixedDraft();
    const even = draftBalance(d, { "p:id0": 1, "p:id5": 1 }, DEFAULT_SETTINGS.groupWeights);
    expect(even.diff).toBe(0);
    expect(balanceText(even, ["블루팀", "레드팀"])).toBe("균형");
    const empty = draftBalance(d, {}, DEFAULT_SETTINGS.groupWeights);
    expect([empty.sumA, empty.sumB, empty.diff, empty.assigned]).toEqual([0, 0, 0, 0]);
    expect(empty.counts.find((c) => c.priority === null)).toEqual({ priority: null, a: 5, b: 5 });
  });
});

describe("균형 순위(같은 10명 나누기 중 몇 위)", () => {
  // id0~id9의 MMR을 1000, 1100, … 1900으로 둔다. 순위 계산은 rating 값만 읽는다.
  const ratings: RatingTable = new Map(
    Array.from({ length: 10 }, (_, i) => [`id${i}`, { rating: 1000 + 100 * i } as PersonRating]),
  );
  const tiers = { "p:id0": 1, "p:id1": 1, "p:id2": 2, "p:id3": 2, "p:id4": 3, "p:id5": 3, "p:id6": 4, "p:id7": 4, "p:id8": 5, "p:id9": 5 };
  const tier = { priorityOf: tiers, groupWeights: DEFAULT_SETTINGS.groupWeights };

  it("조건이 없으면 126가지와 견준다. 강한 다섯 대 약한 다섯은 MMR·티어 모두 꼴찌", () => {
    const ranks = draftSplitRanks(fixedDraft(), ratings, 1200, tier);
    expect(ranks.mmr).toEqual({ rank: 126, ties: 1, total: 126 });
    // 3티어(id4·id5)가 양쪽에 한 명씩이라 둘을 맞바꾼 나눔도 차가 같다: 공동 꼴찌 2개.
    expect(ranks.tier).toEqual({ rank: 125, ties: 2, total: 126 });
  });

  it("팀 추천 1번 후보는 티어 점수 차 1위다(같은 차의 후보와 공동)", () => {
    const d = fixedDraft();
    const people = d.people.map((p) => ({ key: p.key, skillGroup: (tiers as Record<string, number>)[p.key] ?? null }));
    const [best] = recommendTeams(people, DEFAULT_SETTINGS.groupWeights, 3, 1);
    const ranks = draftSplitRanks(applyTeams(d, best!.teamA), ratings, 1200, tier);
    expect(ranks.tier!.rank).toBe(1);
    expect(ranks.tier!.ties).toBeGreaterThan(1);
  });

  it("같은 팀·다른 팀 조건을 어기는 나누기는 빼고 센다(같은 팀이면 56가지, 다른 팀이면 70가지)", () => {
    const d = fixedDraft();
    const together = draftSplitRanks({ ...d, constraints: [{ kind: "same", a: "p:id0", b: "p:id9" }] }, ratings, 1200, null);
    expect(together.mmr!.total).toBe(56);
    const apart = draftSplitRanks({ ...d, constraints: [{ kind: "different", a: "p:id0", b: "p:id9" }] }, ratings, 1200, null);
    expect(apart.mmr!.total).toBe(70);
  });

  it("티어를 넘기지 않거나 아무도 정하지 않았으면 티어 순위는 없다. 10명이 다 앉지 않았으면 둘 다 없다", () => {
    const d = fixedDraft();
    expect(draftSplitRanks(d, ratings, 1200, null).tier).toBeNull();
    expect(draftSplitRanks(d, ratings, 1200, { ...tier, priorityOf: {} }).tier).toBeNull();
    const nine = { ...d, slots: d.slots.slice(1) };
    expect(draftSplitRanks(nine, ratings, 1200, tier)).toEqual({ mmr: null, tier: null });
  });

  it("한 줄 문구: 분모 하나, 공동은 개수, 확률·승률이라는 말은 쓰지 않는다", () => {
    const text = splitRanksText({ mmr: { rank: 3, ties: 1, total: 126 }, tier: { rank: 1, ties: 14, total: 126 } });
    expect(text).toBe("같은 10명을 나누는 126가지 중 MMR 평균 차 3위 · 티어 점수 차 1위(공동 14개)");
    expect(text).not.toMatch(/확률|승률/);
    expect(splitRanksText({ mmr: null, tier: null })).toBe("");
  });
});

describe("라인 맞대결", () => {
  it("같은 라인 두 사람이 서로 다른 팀으로 만난 확정 경기만 센다(포지션 무관, 왼쪽 사람 기준 승패)", () => {
    const d = fixedDraft();
    const topA = d.slots.find((s) => s.team === "A" && s.position === "top")!.key.slice(2);
    const topB = d.slots.find((s) => s.team === "B" && s.position === "top")!.key.slice(2);
    const othersA = ids(0, 10).filter((id) => id !== topA && id !== topB).slice(0, 4);
    const othersB = ids(0, 10).filter((id) => id !== topA && id !== topB).slice(4, 8);
    const matches: MatchView[] = [
      // 서로 다른 팀: 왼쪽(topA)이 이김 → 1승. 그 경기의 포지션은 탑이 아니어도 된다.
      match([...othersA, topA], [topB, ...othersB], "A"),
      // 진영이 반대(topA가 팀 B)이고 팀 B가 이김 → 왼쪽 기준 또 1승.
      match([topB, ...othersA], [...othersB, topA], "B"),
      // 왼쪽이 짐 → 1패.
      match([topA, ...othersA], [topB, ...othersB], "B"),
      // 같은 팀이었던 경기는 세지 않는다.
      match([topA, topB, ...othersA.slice(0, 3)], [...othersB, othersA[3]!], "A"),
      // 확정이 아닌 경기(진행 중·결과 대기·미진행 취소·전적 제외)는 세지 않는다.
      match([topA, ...othersA], [topB, ...othersB], null, "in_progress"),
      match([topA, ...othersA], [topB, ...othersB], null, "awaiting_result"),
      match([topA, ...othersA], [topB, ...othersB], "A", "canceled"),
      match([topA, ...othersA], [topB, ...othersB], "A", "excluded"),
    ];
    const result = laneMatchups(d, matches);
    expect(result.map((m) => m.position)).toEqual(POSITIONS);
    const top = result[0]!;
    expect([top.leftKey, top.rightKey]).toEqual([`p:${topA}`, `p:${topB}`]);
    expect([top.games, top.wins, top.losses]).toEqual([3, 2, 1]);
    expect(matchupText(top)).toBe("67% · 2승 1패 (3경기)");
  });

  it("만난 적이 없거나 참가자 ID가 없는 새 이름이면 '첫 맞대결'", () => {
    const d = fixedDraft();
    const result = laneMatchups(d, []);
    expect(result.every((m) => m.games === 0)).toBe(true);
    expect(result.map(matchupText)).toEqual(Array(5).fill("첫 맞대결"));
    const fresh = replacePerson(d, d.slots.find((s) => s.team === "A" && s.position === "mid")!.key, {
      key: "n:새이름",
      name: "새이름",
      participantId: null,
    });
    const midB = fresh.slots.find((s) => s.team === "B" && s.position === "mid")!.key.slice(2);
    const many = [match(["id0", "id1", "id2", "id3", "id4"], [midB, "x1", "x2", "x3", "x4"], "A")];
    expect(laneMatchups(fresh, many).find((m) => m.position === "mid")!.games).toBe(0);
  });
});

describe("되돌리기 여러 단계", () => {
  it("섞기·자리 바꾸기·추천 적용·서포터 바꾸기를 이력에 쌓고, 최근 5단계까지 하나씩 되돌린다", () => {
    let d = fixedDraft();
    const states: Draft["slots"][] = [d.slots];
    for (let i = 0; i < 7; i++) {
      d =
        i % 4 === 0
          ? rerollPositions(d)
          : i % 4 === 1
            ? swapPeople(d, "p:id0", "p:id5")
            : i % 4 === 2
              ? applyTeams(d, ["p:id0", "p:id2", "p:id4", "p:id6", "p:id8"])
              : drawSupport(d, ["A", "B"], none).draft;
      states.push(d.slots);
      expect(historyOf(d).length).toBe(Math.min(i + 1, HISTORY_MAX));
      // 호환 필드: previousSlots는 항상 이력의 마지막과 같다.
      expect(d.previousSlots).toBe(historyOf(d)[historyOf(d).length - 1]);
    }
    // 7번 조작했지만 이력은 5개: 5번까지 되돌리면 2번째 조작 뒤의 편성이고, 더 누르면 그대로다.
    for (let k = 1; k <= HISTORY_MAX; k++) {
      d = undoDraft(d);
      expect(d.slots, `${k}번 되돌림`).toEqual(states[states.length - 1 - k]);
      expect(historyOf(d).length).toBe(HISTORY_MAX - k);
    }
    expect(d.previousSlots).toBeNull();
    expect(undoDraft(d)).toBe(d);
  });

  it("다시 앞으로는 1단계: 되돌리기 전으로 돌아오고, 다른 조작이나 고정을 하면 사라진다", () => {
    const d0 = fixedDraft();
    const d1 = rerollPositions(d0);
    const d2 = rerollPositions(d1);
    const back = undoDraft(d2);
    expect(back.slots).toEqual(d1.slots);
    expect(back.redoSlots).toEqual(d2.slots);
    const forward = redoDraft(back);
    expect(forward.slots).toEqual(d2.slots);
    expect(forward.redoSlots ?? null).toBeNull();
    expect(historyOf(forward)).toEqual(historyOf(d2));
    // 다시 앞으로는 한 단계뿐: 두 번 되돌린 뒤에는 마지막 되돌리기만 취소된다.
    const twice = undoDraft(undoDraft(d2));
    expect(twice.slots).toEqual(d0.slots);
    expect(redoDraft(twice).slots).toEqual(d1.slots);
    expect(redoDraft(redoDraft(twice)).slots).toEqual(d1.slots);
    // 새 조작·고정은 다시 앞으로를 지운다.
    expect(rerollPositions(back).redoSlots ?? null).toBeNull();
    expect(toggleLock(back, "p:id0").redoSlots ?? null).toBeNull();
    expect(redoDraft(fixedDraft())).toEqual(fixedDraft());
  });

  it("섞기 + 서포터 공평하게, 팀·라인 모두 섞기도 이력 한 단계씩이다", () => {
    const d = fixedDraft();
    const fair = shuffleDraft(d, { fairSupport: true }, none);
    expect(historyOf(fair)).toEqual([d.slots]);
    const team = shuffleTeamsByPriority(fair, {}, DEFAULT_SETTINGS.groupWeights).draft;
    expect(historyOf(team)).toEqual([d.slots, fair.slots]);
    expect(undoDraft(undoDraft(team)).slots).toEqual(d.slots);
  });

  it("진영 바꾸기는 이력과 다시 앞으로도 뒤집어, 되돌린 자리가 사람 기준으로 같다", () => {
    const d0 = fixedDraft();
    const d1 = rerollPositions(d0);
    const d2 = rerollPositions(d1);
    const swapped = swapSides(d2);
    expect(historyOf(swapped)).toHaveLength(2);
    const back = undoDraft(swapped);
    expect(back.slots).toEqual(swapSides(d1).slots);
    expect(swapSides(swapSides(back))).toEqual(back);
    const undone = undoDraft(d2);
    expect(swapSides(undone).redoSlots).toEqual(swapSides(d2).slots);
  });

  it("다른 사람으로 교체하면 이력과 다시 앞으로를 비운다", () => {
    const d = undoDraft(rerollPositions(rerollPositions(fixedDraft())));
    const replaced = replacePerson(d, "p:id0", { key: "p:new", name: "새사람", participantId: "new" });
    expect(historyOf(replaced)).toEqual([]);
    expect(replaced.previousSlots).toBeNull();
    expect(replaced.redoSlots ?? null).toBeNull();
    expect(undoDraft(replaced)).toBe(replaced);
  });

  it("포지션 유지는 같은 사람들이면 이력에 남기고, 지난 경기에서 만든 초안은 이력이 없다", () => {
    const m = match(ids(0, 5), ids(5, 10), "A");
    const fresh = draftFromMatch(m, (id) => id, { groupId: "g", baseLiveVersion: 0, seed: 3, now });
    expect(historyOf(fresh)).toEqual([]);
    const shuffled = rerollPositions(fresh);
    const kept = keepMatchPositions(shuffled, m, (id) => id, now);
    expect(historyOf(kept)).toEqual([fresh.slots, shuffled.slots]);
    expect(undoDraft(kept).slots).toEqual(shuffled.slots);
  });

  it("예전 초안(이력 없음, previousSlots 하나)도 그대로 읽고 한 단계 되돌린다", () => {
    const d0 = fixedDraft();
    const d1 = rerollPositions(d0);
    const { history: _h, redoSlots: _r, ...legacy } = d1;
    const read = parseStoredDraft(JSON.stringify(legacy))!;
    expect(read).not.toBeNull();
    expect(read.history).toBeUndefined();
    expect(historyOf(read)).toEqual([d0.slots]);
    const back = undoDraft(read);
    expect(back.slots).toEqual(d0.slots);
    expect(historyOf(back)).toEqual([]);
    // 새 조작은 예전 previousSlots를 이력 첫 단계로 이어받는다.
    expect(historyOf(rerollPositions(read))).toEqual([d0.slots, d1.slots]);
    // 이력이 없는 아주 예전 초안(previousSlots: null)도 읽힌다.
    const older = parseStoredDraft(JSON.stringify({ ...legacy, previousSlots: null }))!;
    expect(undoDraft(older)).toBe(older);
  });

  it("저장했다 다시 읽어도 이력·다시 앞으로·대기자가 그대로이고, 모양이 어긋난 선택 필드만 버린다", () => {
    const d = withBench(undoDraft(rerollPositions(rerollPositions(fixedDraft()))), [
      { key: "p:b1", name: "대기1", participantId: "b1" },
    ]);
    expect(parseStoredDraft(JSON.stringify(d))).toEqual(d);
    const broken = parseStoredDraft(JSON.stringify({ ...d, history: [[1, 2]], redoSlots: "x", bench: [{}] }))!;
    expect(broken.history).toBeUndefined();
    expect(broken.redoSlots).toBeUndefined();
    expect(broken.bench).toBeUndefined();
    expect(broken.slots).toEqual(d.slots);
    // 이력이 5개보다 많게 저장돼 있으면 최근 5개만 쓴다.
    const long = { ...d, history: Array(8).fill(d.slots) };
    expect(historyOf(parseStoredDraft(JSON.stringify(long))!)).toHaveLength(HISTORY_MAX);
  });
});

describe("대기자", () => {
  it("고른 순서대로 앞 10명이 편성, 나머지와 신청 대기가 대기자(중복 없음, 최대 인원)", () => {
    const ps = people(13);
    const { players, bench } = splitBench(ps, [ps[11]!, { key: "p:w", name: "신청대기", participantId: "w" }]);
    expect(players.map((p) => p.key)).toEqual(ps.slice(0, 10).map((p) => p.key));
    expect(bench.map((p) => p.key)).toEqual(["p:id10", "p:id11", "p:id12", "p:w"]);
    expect(splitBench(people(10)).bench).toEqual([]);
    expect(splitBench(people(10), [people(1)[0]!]).bench).toEqual([]);
    expect(splitBench(people(30)).bench).toHaveLength(BENCH_MAX);
  });

  it("편성 사람과 대기자를 맞바꾸면 대기자가 그 자리를 물려받고 빠진 사람은 대기자 맨 뒤로 간다", () => {
    const bench: DraftPerson[] = [
      { key: "p:b1", name: "대기1", participantId: "b1" },
      { key: "n:대기2", name: "대기2", participantId: null },
    ];
    const d = withBench(rerollPositions(fixedDraft()), bench);
    const slot = d.slots.find((s) => s.key === "p:id3")!;
    const next = swapWithBench(d, "p:id3", "p:b1");
    const taken = next.slots.find((s) => s.key === "p:b1")!;
    expect([taken.team, taken.position]).toEqual([slot.team, slot.position]);
    expect(next.people.some((p) => p.key === "p:id3")).toBe(false);
    expect(next.people.some((p) => p.key === "p:b1")).toBe(true);
    expect(next.bench!.map((p) => p.key)).toEqual(["n:대기2", "p:id3"]);
    // replacePerson과 같이 이력을 비운다.
    expect(historyOf(next)).toEqual([]);
    // 다시 바꾸면 원래 사람이 돌아온다.
    const back = swapWithBench(next, "p:b1", "p:id3");
    expect(back.slots.find((s) => s.key === "p:id3")).toMatchObject({ team: slot.team, position: slot.position });
    expect(back.bench!.map((p) => p.key)).toEqual(["n:대기2", "p:b1"]);
    // 없는 사람은 그대로.
    expect(swapWithBench(d, "p:id3", "p:없음")).toBe(d);
    expect(swapWithBench(d, "p:없음", "p:b1")).toBe(d);
  });

  it("대기자가 없으면 필드를 두지 않고, 다른 사람으로 교체로 넣은 대기자는 대기자에서 빠진다", () => {
    const d = fixedDraft();
    expect("bench" in withBench(d, [])).toBe(false);
    const withOne = withBench(d, [{ key: "p:b1", name: "대기1", participantId: "b1" }]);
    const replaced = replacePerson(withOne, "p:id0", { key: "p:b1", name: "대기1", participantId: "b1" });
    expect(replaced.bench).toEqual([]);
  });

  it("다음 경기 준비(지난 경기에서 만든 초안)에는 대기자가 이어지지 않는다", () => {
    const m = match(ids(0, 5), ids(5, 10), "A");
    const fresh = draftFromMatch(m, (id) => id, { groupId: "g", baseLiveVersion: 0, seed: 3, now });
    expect(fresh.bench).toBeUndefined();
  });

  it("합쳐진 대기자는 남은 사람으로 바뀌고, 이미 편성에 있으면 대기자에서 빠진다", () => {
    const d = withBench(fixedDraft(), [
      { key: "p:old", name: "옛이름", participantId: "old" },
      { key: "p:dup", name: "중복", participantId: "dup" },
    ]);
    const participants: ParticipantView[] = [
      { id: "old", name: "옛이름", status: "archived", mergedInto: "kept" },
      { id: "kept", name: "남은이름", status: "active" },
      { id: "dup", name: "중복", status: "archived", mergedInto: "id0" },
      ...people().map((p) => ({ id: p.participantId!, name: p.name, status: "active" as const })),
    ];
    const result = remapDraft(d, participants);
    expect(result.changed).toBe(true);
    expect(result.draft.bench).toEqual([{ key: "p:kept", name: "남은이름", participantId: "kept" }]);
  });
});

describe("같은 편성 경고", () => {
  const draftOf = (teamA: string[], teamB: string[]) => {
    const teamOf: Record<string, Team> = {};
    for (const id of teamA) teamOf[`p:${id}`] = "A";
    for (const id of teamB) teamOf[`p:${id}`] = "B";
    return createDraft(people(), { groupId: "g", baseLiveVersion: 0, seed: 1, now, teamOf });
  };

  it("직전 경기(미진행 취소가 아닌 실시간 경기 중 번호가 가장 큰 것)와 두 팀 구성이 같으면 그 경기", () => {
    const last = match(ids(0, 5), ids(5, 10), "A");
    const older = match(["id0", "id1", "id2", "id3", "id5"], ["id4", "id6", "id7", "id8", "id9"], "B");
    const matches = [last, older];
    // older가 번호가 더 크다.
    expect(lastLiveMatch(matches)).toBe(older);
    expect(sameTeamsAsLast(draftOf(ids(0, 5), ids(5, 10)), matches)).toBeNull();
    expect(sameTeamsAsLast(draftOf(["id0", "id1", "id2", "id3", "id5"], ["id4", "id6", "id7", "id8", "id9"]), matches)).toBe(
      older,
    );
    // 진영(팀 A/B)이 바뀐 것은 같은 구성이다.
    expect(sameTeamsAsLast(draftOf(["id4", "id6", "id7", "id8", "id9"], ["id0", "id1", "id2", "id3", "id5"]), matches)).toBe(
      older,
    );
    // 포지션이 달라도 같은 구성이다.
    expect(sameTeamsAsLast(rerollPositions(draftOf(["id0", "id1", "id2", "id3", "id5"], ["id4", "id6", "id7", "id8", "id9"])), matches)).toBe(older);
  });

  it("미진행 취소·지난 경기 입력(backfill)·가져온 경기는 직전 경기로 보지 않는다. 경기가 없으면 묻지 않는다", () => {
    const live = match(ids(0, 5), ids(5, 10), "A");
    const canceled = match(["id0", "id1", "id2", "id3", "id5"], ["id4", "id6", "id7", "id8", "id9"], null, "canceled");
    const backfill = match(["id0", "id1", "id2", "id3", "id6"], ["id4", "id5", "id7", "id8", "id9"], "A", "confirmed", {
      source: "backfill",
    });
    expect(lastLiveMatch([live, canceled, backfill])).toBe(live);
    expect(sameTeamsAsLast(draftOf(ids(0, 5), ids(5, 10)), [live, canceled, backfill])).toBe(live);
    expect(sameTeamsAsLast(draftOf(ids(0, 5), ids(5, 10)), [])).toBeNull();
  });

  it("시리즈로 이어가기 중이거나 다음 경기 준비로 만든 초안이면 묻지 않는다", () => {
    const last = match(ids(0, 5), ids(5, 10), "A");
    const d = draftOf(ids(0, 5), ids(5, 10));
    expect(sameTeamsAsLast(d, [last])).toBe(last);
    expect(sameTeamsAsLast({ ...d, series: { format: "bo3", name: "" } }, [last])).toBeNull();
    expect(sameTeamsAsLast({ ...d, series: null }, [last])).toBe(last);
    const next = draftFromMatch(last, (id) => id, { groupId: "g", baseLiveVersion: 0, seed: 3, now });
    expect(next.origin).toBe("same-teams");
    expect(sameTeamsAsLast(next, [last])).toBeNull();
  });

  it("새 이름(참가자 ID 없음)이 있으면 지난 경기와 같을 수 없다", () => {
    const last = match(ids(0, 5), ids(5, 10), "A");
    const d = replacePerson(draftOf(ids(0, 5), ids(5, 10)), "p:id0", { key: "n:새", name: "새", participantId: null });
    expect(sameTeamsAsLast(d, [last])).toBeNull();
  });
});
