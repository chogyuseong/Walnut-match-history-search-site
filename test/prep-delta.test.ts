import { describe, expect, it } from "vitest";
import { addConstraint, replacePerson, swapPeople, toggleLock, undoDraft, type AvoidMap, type Draft, type DraftSlot } from "../src/shared/draft";
import { draftForecast, forecastBluePercent, teamExpectation } from "../src/shared/forecast";
import { draftDelta } from "../src/shared/prepDelta";
import { computeRatings } from "../src/shared/rating";
import { diversityFor, recommendTeams } from "../src/shared/recommend";
import type { RotationContext } from "../src/shared/rotation";
import { POSITIONS, type MatchView, type Team } from "../src/shared/types";
import { expectationCalibration, UNCALIBRATED } from "../src/shared/upset";

// 준비 화면 "직전 편성 대비" 한 줄(src/shared/prepDelta.ts, 2026-11-10 실험 A 축소형).

const people = Array.from({ length: 10 }, (_, i) => ({ key: `p:p${i}`, name: `사람${i}`, participantId: `p${i}` }));

/** p0~p4가 블루(A) 탑~서폿, p5~p9가 레드(B) 탑~서폿. */
function baseDraft(): Draft {
  const slots: DraftSlot[] = people.map((p, i) => ({
    key: p.key,
    team: (i < 5 ? "A" : "B") as Team,
    position: POSITIONS[i % 5]!,
    locked: false,
  }));
  return {
    formatVersion: 1,
    groupId: "g",
    baseLiveVersion: 0,
    createdAt: "2026-11-10T00:00:00.000Z",
    people,
    slots,
    draws: {},
    previousSlots: null,
    origin: "new",
    seed: 1,
    teamASide: "blue",
  };
}

const off: RotationContext = { enabled: false, cycleId: null, usedIds: new Set(), eventCount: 0 };
const none = { avoid: {} as AvoidMap, ctx: off, ratings: null, calibration: UNCALIBRATED, ratingOptions: {} };

/** 같은 열 명이 같은 팀으로 n판. winner가 A면 p0~p4가 이긴다. */
function games(n: number, winner: Team = "A", from = 1): MatchView[] {
  return Array.from({ length: n }, (_, i) => {
    const playedAt = new Date(Date.UTC(2026, 9, 1) + (from + i) * 3600_000).toISOString();
    return {
      id: `m${from + i}`,
      matchNo: from + i,
      sessionId: "s1",
      state: "confirmed" as const,
      source: "live" as const,
      startedAt: playedAt,
      endedAt: playedAt,
      playedAt,
      confirmedAt: playedAt,
      winnerTeam: winner,
      teamASide: "blue" as const,
      version: 1,
      roster: people.map((p, k) => ({
        participantId: p.participantId,
        team: (k < 5 ? "A" : "B") as Team,
        position: POSITIONS[k % 5]!,
      })),
    };
  });
}

describe("draftDelta: 그리지 않는 경우", () => {
  it("직전 자리가 없으면 빈 목록", () => {
    expect(draftDelta(baseDraft(), none)).toEqual([]);
  });

  it("사람 교체 뒤에는 이력이 비어 빈 목록", () => {
    const swapped = swapPeople(baseDraft(), "p:p0", "p:p5");
    const replaced = replacePerson(swapped, "p:p1", { key: "n:새", name: "새", participantId: null });
    expect(draftDelta(replaced, { ...none, avoid: { "p:p0": ["top"] } })).toEqual([]);
  });

  it("달라진 값이 없으면 빈 목록(같은 팀 안 자리 바꾸기, 기피·조건·기록 없음)", () => {
    expect(draftDelta(swapPeople(baseDraft(), "p:p0", "p:p1"), none)).toEqual([]);
  });
});

describe("draftDelta: 항목과 순서", () => {
  it("두 팀 맞바꾸기: 같은 팀 반복과 예상(MMR 추정)이 바뀐 값만 나온다", () => {
    const matches = games(12);
    const ratings = computeRatings(matches, { placementGames: 3 });
    const diversity = diversityFor({ matches, settings: {} }, people)!;
    // 블루 탑 p0과 레드 탑 p5를 맞바꾼다. 최근 8경기(DIVERSITY_RECENT_MATCHES) 내내 같은 팀이던 쌍: 팀마다 10쌍 × 8 = 160.
    // 바꾼 뒤에는 팀마다 p1~p4(또는 p6~p9) 6쌍만 남아 96. 예상은 이기던 p0이 레드로 가 블루 쪽이 내려간다.
    const lines = draftDelta(swapPeople(baseDraft(), "p:p0", "p:p5"), {
      avoid: {},
      ctx: off,
      diversity,
      ratings,
      calibration: UNCALIBRATED,
      ratingOptions: { placementGames: 3 },
    });
    expect(lines.map((l) => l.kind)).toEqual(["repeat", "forecast"]);
    expect(lines.every((l) => !l.warn)).toBe(true);
    expect(lines[0]).toMatchObject({ from: 160, to: 96, matches: 8 });
    expect(lines[1]!.from).toBeGreaterThan(lines[1]!.to);
  });

  it("기피 라인으로 옮기면 경고로 맨 앞, 뒤 항목(반복·예상)이 좋아져도 순서를 지킨다", () => {
    const matches = games(12);
    // p0(블루 탑)이 정글을 기피하는데 레드 정글 p6과 맞바꾼다: 기피 0 → 1, 같은 팀 반복은 준다.
    const lines = draftDelta(swapPeople(baseDraft(), "p:p0", "p:p6"), {
      avoid: { "p:p0": ["jungle"] },
      ctx: off,
      diversity: diversityFor({ matches, settings: {} }, people),
      ratings: computeRatings(matches, { placementGames: 3 }),
      calibration: UNCALIBRATED,
      ratingOptions: { placementGames: 3 },
    });
    expect(lines.map((l) => [l.kind, l.warn])).toEqual([
      ["avoid", true],
      ["repeat", false],
      ["forecast", false],
    ]);
    expect(lines[0]).toMatchObject({ from: 0, to: 1 });
    expect(lines[1]!.to).toBeLessThan(lines[1]!.from);
  });

  it("팀 조건을 깨면 경고 맨 앞", () => {
    const withRule = addConstraint(baseDraft(), { kind: "same", a: "p:p0", b: "p:p1" });
    const lines = draftDelta(swapPeople(withRule, "p:p0", "p:p5"), none);
    expect(lines).toEqual([{ kind: "constraint", from: 0, to: 1, warn: true }]);
    // 되돌리는 쪽(깨진 조건이 풀림)은 경고가 아니다.
    const broken = swapPeople(withRule, "p:p0", "p:p5");
    const fixed = draftDelta(swapPeople(broken, "p:p0", "p:p5"), none);
    expect(fixed).toEqual([{ kind: "constraint", from: 1, to: 0, warn: false }]);
  });

  it("이미 서포터로 간 사람을 서포터로 옮기면(같은 팀에 안 간 사람이 있음) 시작 때 확인할 서포터가 는다", () => {
    const ctx: RotationContext = { enabled: true, cycleId: "c", usedIds: new Set(["p0"]), eventCount: 1 };
    const lines = draftDelta(swapPeople(baseDraft(), "p:p0", "p:p4"), { ...none, ctx });
    expect(lines).toEqual([{ kind: "support", from: 0, to: 1, warn: true }]);
    // 서포터 순환이 꺼져 있으면 항목이 없다.
    expect(draftDelta(swapPeople(baseDraft(), "p:p0", "p:p4"), none)).toEqual([]);
  });

  it("고정한 사람을 손으로 옮기면 풀린 고정 수", () => {
    const locked = toggleLock(baseDraft(), "p:p0");
    const lines = draftDelta(swapPeople(locked, "p:p0", "p:p1"), none);
    expect(lines).toEqual([{ kind: "lock", from: 0, to: 1, warn: true }]);
  });

  it("경고 여럿: 조건 → 기피 → 서포터 → 고정 순서", () => {
    const ctx: RotationContext = { enabled: true, cycleId: "c", usedIds: new Set(["p0"]), eventCount: 1 };
    const draft = toggleLock(addConstraint(baseDraft(), { kind: "same", a: "p:p0", b: "p:p1" }), "p:p0");
    // p0(블루 탑, 고정)을 레드 서폿(p9)과 맞바꾼다: 조건 깨짐, 서폿 기피, 이미 간 서포터, 고정 풀림.
    const lines = draftDelta(swapPeople(draft, "p:p0", "p:p9"), { ...none, ctx, avoid: { "p:p0": ["support"] } });
    expect(lines.map((l) => [l.kind, l.warn])).toEqual([
      ["constraint", true],
      ["avoid", true],
      ["support", true],
      ["lock", true],
    ]);
  });
});

describe("draftDelta: 자료가 없으면 그 항목을 뺀다", () => {
  it("기록 0개면 반복·예상이 없다", () => {
    const diversity = diversityFor({ matches: [], settings: {} }, people)!;
    const ratings = computeRatings([]);
    const lines = draftDelta(swapPeople(baseDraft(), "p:p0", "p:p5"), { ...none, diversity, ratings });
    expect(lines).toEqual([]);
  });

  it("전원 배치 중이면 예상 항목이 없다(반복은 있다)", () => {
    const matches = games(4);
    const lines = draftDelta(swapPeople(baseDraft(), "p:p0", "p:p5"), {
      ...none,
      diversity: diversityFor({ matches, settings: {} }, people),
      ratings: computeRatings(matches),
      calibration: UNCALIBRATED,
      ratingOptions: { placementGames: 10 },
    });
    expect(lines.map((l) => l.kind)).toEqual(["repeat"]);
  });

  it("조합 다양성 설정이 꺼져 있으면 반복 항목이 없다", () => {
    const matches = games(12);
    expect(diversityFor({ matches, settings: { teamDiversity: false } }, people)).toBeUndefined();
  });
});

describe("draftDelta: 초안을 바꾸지 않는다", () => {
  it("호출 전후 초안이 같고, 되돌리면 자리가 교환 전과 같다", () => {
    const before = baseDraft();
    const swapped = swapPeople(before, "p:p0", "p:p5");
    const copy = structuredClone(swapped);
    const matches = games(12);
    draftDelta(swapped, {
      avoid: { "p:p0": ["top"] },
      ctx: { enabled: true, cycleId: "c", usedIds: new Set(["p0"]), eventCount: 1 },
      diversity: diversityFor({ matches, settings: {} }, people),
      ratings: computeRatings(matches),
      calibration: UNCALIBRATED,
      ratingOptions: {},
    });
    expect(swapped).toEqual(copy);
    expect(undoDraft(swapped).slots).toEqual(before.slots);
  });
});

describe("같은 식을 쓴다", () => {
  it.each([
    // 경기 수 문턱이 없어져 둘 다 보정이 걸린다. 경기가 적을 때와 많을 때 모두 같은 보정값을 거치는지.
    ["경기 적음(12경기)", games(12)],
    ["경기 많음(70경기)", [...games(40), ...games(30, "B", 41)]],
  ])("teamExpectation은 draftForecast와 같은 예상·신뢰 여부: %s", (_, matches) => {
    const ratings = computeRatings(matches, { placementGames: 3 });
    const draft = swapPeople(baseDraft(), "p:p0", "p:p5");
    const full = draftForecast(draft, ratings, matches, { placementGames: 3 });
    const light = teamExpectation(draft, ratings, expectationCalibration(matches, { placementGames: 3 }), {
      placementGames: 3,
    });
    expect(full.calibration).toBe(expectationCalibration(matches, { placementGames: 3 }));
    expect(light.expectedA).toBe(full.expectedA);
    expect(light.reliable).toBe(full.reliable);
    expect(light.teams).toEqual(full.teams);
    expect(forecastBluePercent(light)).toBe(forecastBluePercent(full));
  });

  it("반복 수는 추천 후보의 repeatPairs와 같다", () => {
    const matches = games(12);
    const diversity = diversityFor({ matches, settings: {} }, people)!;
    const [candidate] = recommendTeams(
      people.map((p) => ({ key: p.key, skillGroup: null })),
      [5, 4, 3, 2, 1],
      1,
      1,
      [],
      diversity,
    );
    const draft = baseDraft();
    const teamOf = new Set(candidate!.teamA);
    const slots = draft.slots.map((s) => ({ ...s, team: (teamOf.has(s.key) ? "A" : "B") as Team }));
    const lines = draftDelta({ ...draft, slots, previousSlots: draft.slots }, { ...none, diversity });
    const repeat = lines.find((l) => l.kind === "repeat");
    expect(repeat).toBeDefined();
    expect(repeat!.to).toBe(candidate!.repeatPairs);
  });
});
