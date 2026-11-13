import { describe, expect, it } from "vitest";
import type { Draft, DraftPerson } from "../src/shared/draft";
import {
  draftForecast,
  forecastBluePercent,
  forecastSummaryText,
  LANE_EDGE_MIN,
  teamExpectation,
  type DraftForecast,
} from "../src/shared/forecast";
import { RATING_START, type PersonRating, type RatingTable } from "../src/shared/rating";
import { POSITIONS, type MatchView, type Side, type Team } from "../src/shared/types";
import {
  calibrateExpectation,
  fitExpectationCalibration,
  UNCALIBRATED,
  type CalibrationSample,
  type ExpectationCalibration,
} from "../src/shared/upset";

// 준비 화면 예상 승률 판(2026-11-09, src/shared/forecast.ts): 팀 평균 MMR의 Elo 예상, 라인 우위, 빈 슬롯·연결 없는 사람, 신뢰 여부.

const now = "2026-11-09T00:00:00.000Z";
const NAMES: readonly [string, string] = ["블루팀", "레드팀"];

/** id0~4 블루(탑~서폿), id5~9 레드(탑~서폿). linked=false인 번호는 참가자 연결 없는 임시 사람, skip은 빈 슬롯. */
function draftOf(opts: { unlinked?: number[]; skip?: number[] } = {}): Draft {
  const people: DraftPerson[] = [];
  const slots: Draft["slots"] = [];
  for (let i = 0; i < 10; i++) {
    if (opts.skip?.includes(i)) continue;
    const linked = !opts.unlinked?.includes(i);
    const key = linked ? `p:id${i}` : `n:임시${i}`;
    people.push({ key, name: `사람${i}`, participantId: linked ? `id${i}` : null });
    slots.push({ key, team: (i < 5 ? "A" : "B") as Team, position: POSITIONS[i % 5]!, locked: false });
  }
  return {
    formatVersion: 1,
    groupId: "g",
    baseLiveVersion: 0,
    createdAt: now,
    people,
    slots,
    draws: {},
    previousSlots: null,
    origin: "new",
    seed: 1,
  };
}

/** 번호 → MMR. games 기본 20(배치 마침). */
function ratingsOf(values: Record<number, number>, games = 20): RatingTable {
  const table: RatingTable = new Map();
  for (const [i, rating] of Object.entries(values)) {
    const person: PersonRating = { participantId: `id${i}`, rating, games, peak: rating, delta10: 0, history: [] };
    table.set(`id${i}`, person);
  }
  return table;
}

const flat = (rating: number) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i, rating]));

describe("예상 승률(draftForecast)", () => {
  it("같은 MMR이면 50%이고 팽팽, 라인 우위 없음", () => {
    const f = draftForecast(draftOf(), ratingsOf(flat(1100)), []);
    expect(f.expectedA).toBe(0.5);
    expect(forecastBluePercent(f)).toBe(50);
    expect(f.reliable).toBe(true);
    expect(f.lanes.map((l) => l.edgeTeam)).toEqual([null, null, null, null, null]);
    expect(forecastSummaryText(f, NAMES)).toBe("팽팽해요(50%)");
  });

  it("블루 미드·원딜이 높고 레드 정글이 높으면 블루 유리와 라인 우위 목록", () => {
    // 블루 미드 +200, 원딜 +100, 레드 정글 +60, 탑은 차 10(비슷).
    const r = { ...flat(1000), 2: 1200, 3: 1100, 6: 1060, 0: 1010 };
    const f = draftForecast(draftOf(), ratingsOf(r), []);
    expect(f.teams.A.average).toBe(1062);
    expect(f.teams.B.average).toBe(1012);
    expect(f.expectedA).toBeGreaterThan(0.55);
    expect(f.reasons).toEqual({ A: ["mid", "adc"], B: ["jungle"] });
    expect(f.lanes[0]!.edge).toBe(10);
    expect(f.lanes[0]!.edgeTeam).toBeNull();
    expect(f.lanes[1]!.edge).toBe(-60);
    expect(forecastSummaryText(f, NAMES)).toBe(
      `블루팀이 유리해요(${forecastBluePercent(f)}%) · 미드·원딜 MMR 우위, 레드팀은 정글 우위`,
    );
  });

  it("레드가 유리하면 레드 % = 100 − 블루 %로 쓴다", () => {
    const r = { ...flat(1000), 5: 1300, 7: 1300 };
    const f = draftForecast(draftOf(), ratingsOf(r), []);
    const blue = forecastBluePercent(f);
    expect(forecastSummaryText(f, NAMES)).toBe(`레드팀이 유리해요(${100 - blue}%) · 탑·미드 MMR 우위`);
  });

  it(`라인 우위 경계: 차 ${LANE_EDGE_MIN} 미만은 비슷, ${LANE_EDGE_MIN}부터 우위`, () => {
    const f = draftForecast(draftOf(), ratingsOf({ ...flat(1000), 0: 1000 + LANE_EDGE_MIN, 1: 1000 + LANE_EDGE_MIN - 1 }), []);
    expect(f.lanes[0]!.edgeTeam).toBe("A");
    expect(f.lanes[1]!.edgeTeam).toBeNull();
  });

  it("빈 슬롯은 사람 null·우위 없음, 연결 없는 사람은 시작값으로 세고 unknown에 센다", () => {
    // 시작값을 1000으로 둔 모임: 연결 없는 사람은 1000이라 레드 탑(1100)이 우위.
    const f = draftForecast(draftOf({ skip: [7], unlinked: [0] }), ratingsOf({ ...flat(1100) }), [], { start: 1000 });
    expect(f.lanes[2]!.red).toBeNull();
    expect(f.lanes[2]!.edge).toBeNull();
    expect(f.lanes[2]!.edgeTeam).toBeNull();
    expect(f.lanes[0]!.blue!.rating).toBe(1000);
    expect(f.lanes[0]!.blue!.participantId).toBeNull();
    expect(f.lanes[0]!.edgeTeam).toBe("B");
    expect(f.teams.A).toMatchObject({ size: 5, unknown: 1, placement: 0, average: (1000 + 4 * 1100) / 5 });
    expect(f.teams.B).toMatchObject({ size: 4, unknown: 0, average: 1100 });
    // 기본 시작값(1200)이면 연결 없는 사람이 1200으로 들어가 블루 탑이 우위가 된다.
    const byDefault = draftForecast(draftOf({ skip: [7], unlinked: [0] }), ratingsOf({ ...flat(1100) }), []);
    expect(byDefault.lanes[0]!.blue!.rating).toBe(RATING_START);
    expect(byDefault.lanes[0]!.edgeTeam).toBe("A");
  });

  it("모두 배치 중이면 신뢰 불가 문구, 배치 인원을 센다", () => {
    const f = draftForecast(draftOf(), ratingsOf({ ...flat(1000), 2: 1200 }, 3), []);
    expect(f.reliable).toBe(false);
    expect(f.teams.A.placement).toBe(5);
    expect(forecastSummaryText(f, NAMES)).toBe("아직 MMR이 쌓이지 않아 예상이 정확하지 않아요");
  });

  it("경기 기록이 없는 사람(표에 없음)도 시작값·0경기, 라인 전적은 그 라인에서 뛴 경기만", () => {
    const m: MatchView = {
      id: "m1",
      matchNo: 1,
      sessionId: "s1",
      state: "confirmed",
      source: "live",
      startedAt: now,
      endedAt: now,
      playedAt: now,
      confirmedAt: now,
      winnerTeam: "A",
      teamASide: "blue",
      version: 1,
      roster: Array.from({ length: 10 }, (_, i) => ({
        participantId: `id${i}`,
        team: (i < 5 ? "A" : "B") as Team,
        // id0은 이 경기에서 미드였다(편성에서는 탑).
        position: POSITIONS[i === 0 ? 2 : i === 2 ? 0 : i % 5]!,
      })),
    };
    const f: DraftForecast = draftForecast(draftOf(), new Map(), [m]);
    expect(f.lanes[0]!.blue).toMatchObject({ rating: RATING_START, games: 0, line: { games: 0, wins: 0 } });
    expect(f.lanes[1]!.blue!.line).toEqual({ games: 1, wins: 1 });
    expect(f.lanes[1]!.red!.line).toEqual({ games: 1, wins: 0 });
    // 맞대결 전적(laneMatchups)도 함께 담긴다.
    expect(f.lanes[1]).toMatchObject({ games: 1, wins: 1, losses: 0 });
  });
});

describe("예상 보정(upset.ts fitExpectationCalibration)", () => {
  /** 시드로 재현하는 난수(테스트 전용). */
  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  /**
   * 합성 기록 n판. 원래 예상은 로짓 [−spread, spread]에서 고르게, 진영은 반반.
   * winChance(원래 예상, 팀 A 진영)가 팀 A가 실제로 이길 확률이다.
   */
  function samples(n: number, spread: number, winChance: (p: number, side: Side) => number, seed = 11): CalibrationSample[] {
    const random = rng(seed);
    return Array.from({ length: n }, () => {
      const p = 1 / (1 + Math.exp(-(random() * 2 - 1) * spread));
      const side: Side = random() < 0.5 ? "blue" : "red";
      return { expectedA: p, teamASide: side, winnerTeam: random() < winChance(p, side) ? "A" : "B" };
    });
  }

  const shown = (p: number, side: Side, c: ExpectationCalibration) => calibrateExpectation(p, side, c);

  it("결과가 예상과 무관하면(동전) 보정된 예상이 50% ± 3%로 모인다", () => {
    const c = fitExpectationCalibration(samples(4000, Math.log(7 / 3), () => 0.5));
    expect(c.games).toBe(4000);
    for (const p of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      for (const side of ["blue", "red"] as const) {
        expect(Math.abs(shown(p, side, c) - 0.5)).toBeLessThanOrEqual(0.03);
      }
    }
  });

  it("예상이 잘 맞는 기록이면 배율 a가 1 근처로 남고 진영 몫은 거의 없다", () => {
    const c = fitExpectationCalibration(samples(3000, Math.log(4), (p) => p));
    expect(c.scale).toBeGreaterThan(0.9);
    expect(c.scale).toBeLessThan(1.1);
    expect(Math.abs(c.blueEdge)).toBeLessThan(0.1);
  });

  it("블루가 60% 이기는 기록이면 진영 몫 b가 드러난다", () => {
    const c = fitExpectationCalibration(samples(4000, Math.log(7 / 3), (_, side) => (side === "blue" ? 0.6 : 0.4)));
    // logit(0.6) ≈ 0.405
    expect(c.blueEdge).toBeGreaterThan(0.3);
    expect(c.blueEdge).toBeLessThan(0.5);
    expect(shown(0.5, "blue", c)).toBeCloseTo(0.6, 1);
    expect(shown(0.5, "red", c)).toBeCloseTo(0.4, 1);
    // 진영을 모르는 경기에는 진영 몫을 더하지 않는다.
    expect(shown(0.5, "unknown", c)).toBe(0.5);
  });

  it("지난 경기가 없으면 보정하지 않고 원래 예상을 그대로 둔다", () => {
    const c = fitExpectationCalibration([]);
    expect(c).toEqual(UNCALIBRATED);
    expect(shown(0.62, "blue", c)).toBe(0.62);
  });

  // 실제 모임처럼 MMR 차가 결과를 약하게만 따르는 기록(참 a = 0.25). 예전에는 50경기에서 보정을 한꺼번에 켰다.
  it("경기가 적으면 조금만 보정하고, 쌓일수록 실제 쪽으로 옮겨 가며, 50경기 앞뒤로 뛰지 않는다", () => {
    const TRUE_SCALE = 0.25;
    const all = samples(1500, Math.log(4), (p) => 1 / (1 + Math.exp(-TRUE_SCALE * Math.log(p / (1 - p)))), 23);
    const scaleAt = (n: number) => fitExpectationCalibration(all.slice(0, n)).scale;
    // 5경기: 가상 경기 30판에 눌려 1 근처(62% 예상이 60% 남짓으로만 바뀐다).
    expect(Math.abs(scaleAt(5) - 1)).toBeLessThan(0.2);
    expect(Math.abs(shown(0.62, "unknown", fitExpectationCalibration(all.slice(0, 5))) - 0.62)).toBeLessThan(0.02);
    expect(scaleAt(10)).toBeGreaterThan(scaleAt(300));
    expect(scaleAt(300)).toBeGreaterThan(scaleAt(1500));
    expect(scaleAt(1500)).toBeLessThan(0.3);
    // 예전에는 50번째 경기에서 a가 1 → 약 0.45로 한꺼번에 바뀌었다. 지금은 한 판만큼만 움직인다.
    for (const n of [48, 49, 50, 51]) expect(Math.abs(scaleAt(n + 1) - scaleAt(n)), `${n} → ${n + 1}경기`).toBeLessThan(0.05);
  });

  it("준비 화면 %도 보정값을 거친다(진영 몫은 블루 쪽으로 들어간다)", () => {
    const halved: ExpectationCalibration = { scale: 0.5, blueEdge: 0, games: 100 };
    const r = { ...flat(1000), 0: 1300, 1: 1300 }; // 블루 평균 +120점, 보정 전 약 66%
    const raw = teamExpectation(draftOf(), ratingsOf(r), UNCALIBRATED);
    const calibrated = teamExpectation(draftOf(), ratingsOf(r), halved);
    expect(forecastBluePercent(raw)).toBe(67);
    expect(calibrated.expectedA).toBeCloseTo(calibrateExpectation(raw.expectedA, "blue", halved), 12);
    expect(forecastBluePercent(calibrated)).toBe(59);
    // 두 팀 MMR이 같아도 진영 몫이 있으면 블루가 앞선다.
    const blueSide: ExpectationCalibration = { scale: 1, blueEdge: Math.log(0.6 / 0.4), games: 100 };
    expect(forecastBluePercent(teamExpectation(draftOf(), ratingsOf(flat(1100)), blueSide))).toBe(60);
  });
});
