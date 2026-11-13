import { describe, expect, it } from "vitest";
import { computeRatings, expectedScore, RATING_START } from "../src/shared/rating";
import { seasonSummary, seasonSummaryText } from "../src/shared/seasonAwards";
import { DEFAULT_SETTINGS, type MatchView, type Snapshot, type Team } from "../src/shared/types";
import {
  BALANCED_MMR_GAP,
  calibrateExpectation,
  expectationCalibration,
  expectedOf,
  fairnessReport,
  fairnessVerdict,
  isUpset,
  LOPSIDED_MMR_GAP,
  matchExpectations,
  personUpsets,
  UPSET_MMR_GAP,
  upsetWinsByPerson,
  type MatchExpectation,
} from "../src/shared/upset";

interface Options {
  winner?: Team;
  state?: MatchView["state"];
  teamA?: number[];
  teamB?: number[];
}

function match(no: number, options: Options = {}): MatchView {
  const teamA = options.teamA ?? [0, 1, 2, 3, 4];
  const teamB = options.teamB ?? [5, 6, 7, 8, 9];
  const state = options.state ?? "confirmed";
  const playedAt = new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  const done = state === "confirmed" || state === "excluded";
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: done ? playedAt : null,
    winnerTeam: done ? (options.winner ?? "A") : null,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((i) => ({ participantId: `p${i}`, team: "A" as const, position: null })),
      ...teamB.map((i) => ({ participantId: `p${i}`, team: "B" as const, position: null })),
    ],
  };
}

/** 같은 열 명으로 A가 n번 이긴 경기(1~n번). */
function aWins(n: number): MatchView[] {
  return Array.from({ length: n }, (_, i) => match(i + 1));
}

/** 팀 평균 MMR 차(팀 A − 팀 B)로 만든 가짜 예상. expectedA는 표시용이라 아무 값이나 넣어도 판정은 같아야 한다. */
function fake(id: string, ratingGapA: number, winnerTeam: Team, reliable = true, expectedA = 0.5): MatchExpectation {
  const winnerDeficit = winnerTeam === "A" ? -ratingGapA : ratingGapA;
  return {
    matchId: id,
    ratingGapA,
    expectedA,
    teamASide: "blue",
    winnerTeam,
    favoriteTeam: ratingGapA > 0 ? "A" : ratingGapA < 0 ? "B" : null,
    reliable,
    upset: isUpset(winnerDeficit, reliable),
    winnerDeficit,
  };
}

describe("경기 전 예상", () => {
  it("첫 경기는 모두 시작값이라 50%이고 우세 팀이 없다", () => {
    const e = matchExpectations([match(1)]).get("m1")!;
    expect(e.expectedA).toBe(0.5);
    expect(e.favoriteTeam).toBeNull();
    expect(e.reliable).toBe(false);
    expect(e.upset).toBe(false);
    expect(e.ratingGapA).toBe(0);
    expect(e.winnerDeficit).toBeCloseTo(0, 12);
  });

  it("직전 MMR(history.before) 평균으로 구한다", () => {
    const matches = [...aWins(10), match(11, { winner: "B" })];
    const table = computeRatings(matches);
    const before = (i: number) => table.get(`p${i}`)!.history.find((h) => h.matchId === "m11")!.before;
    const e = matchExpectations(matches).get("m11")!;
    expect(e.ratingGapA).toBeCloseTo(before(0) - before(5), 12);
    // 배치를 마친 판정 가능 경기가 m11 하나라 보정이 거의 없다(a ≈ 1).
    expect(e.expectedA).toBeCloseTo(expectedScore(before(0), before(5)), 1);
    expect(e.favoriteTeam).toBe("A");
    expect(expectedOf(e, "B")).toBeCloseTo(1 - e.expectedA, 12);
  });

  it("처음 나온 사람은 시작값으로 센다", () => {
    const matches = [...aWins(3), match(4, { teamB: [5, 6, 7, 8, 10] })];
    const table = computeRatings(matches);
    const avgA = table.get("p0")!.history[3]!.before;
    const avgB = (table.get("p5")!.history[3]!.before * 4 + RATING_START) / 5;
    expect(matchExpectations(matches).get("m4")!.expectedA).toBeCloseTo(expectedScore(avgA, avgB), 12);
  });

  it("유효 확정 경기가 아니면 예상이 없다", () => {
    const matches = [match(1), match(2, { state: "canceled" }), match(3, { state: "excluded" }), match(4, { state: "awaiting_result" })];
    const map = matchExpectations(matches);
    expect([...map.keys()]).toEqual(["m1"]);
  });
});

/** 시드로 재현하는 난수(테스트 전용). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** 14명 중 10명을 매번 다르게 뽑아 섞은 경기들. 결과·상태도 무작위(확정이 대부분, 가끔 결과 대기·제외·취소). */
function randomMatches(seed: number, count: number): MatchView[] {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const pool = Array.from({ length: 14 }, (_, k) => k).sort(() => random() - 0.5).slice(0, 10);
    const roll = random();
    const state: MatchView["state"] = roll < 0.06 ? "awaiting_result" : roll < 0.1 ? "excluded" : roll < 0.13 ? "canceled" : "confirmed";
    return match(i + 1, { teamA: pool.slice(0, 5), teamB: pool.slice(5), winner: random() < 0.5 ? "A" : "B", state });
  });
}

describe("경기 전 판정: 미래 결과가 섞이지 않는다(속성, 2026-11-10 설계 4절 D)", () => {
  // 판정(MMR 차·우세 팀·이변)만 견준다. 표시 %(expectedA)는 모임 전체 기록으로 맞춘 a·b를 쓰므로 뒤 경기가 들어오면
  // 바뀐다(upset.ts 머리 주석의 알려진 한계). 예전에는 50경기 미만이면 보정이 없어 %까지 같았지만 문턱을 없앴다.
  const judgment = (e: MatchExpectation | undefined) =>
    e && { ratingGapA: e.ratingGapA, favoriteTeam: e.favoriteTeam, reliable: e.reliable, upset: e.upset, winnerDeficit: e.winnerDeficit };
  it("앞부분 경기만 넣어 계산한 그 경기의 판정이 전체 기록으로 계산한 값과 같다", () => {
    for (const seed of [1, 7, 42]) {
      const all = randomMatches(seed, 40);
      // 넣는 순서는 섞는다: 계산은 경기 시각 → 번호로 다시 세운다.
      const full = matchExpectations([...all].reverse(), { placementGames: 3 });
      let compared = 0;
      for (let k = 1; k <= all.length; k++) {
        const target = all[k - 1]!;
        const prefix = matchExpectations(all.slice(0, k), { placementGames: 3 });
        expect(judgment(prefix.get(target.id)), `시드 ${seed}, ${k}번째`).toEqual(judgment(full.get(target.id)));
        if (full.has(target.id)) compared += 1;
      }
      // 확정 경기 대부분을 실제로 견줬다(예상이 없는 경기끼리만 같아서 통과하는 일이 없게).
      expect(compared).toBeGreaterThan(30);
    }
  });
});

describe("표시 %는 이 모임 기록으로 보정하고, 판정은 팀 평균 MMR 차로 한다", () => {
  it("history.before 평균의 차로 판정하고, 그 Elo 예상을 보정한 값을 표시 %로 둔다", () => {
    const options = { placementGames: 3 };
    // 결과가 무작위라 MMR 차가 실제 전력 차보다 과장된 기록(내전 모임의 과신과 같은 꼴).
    const matches = randomMatches(5, 150);
    const calibration = expectationCalibration(matches, options);
    expect(calibration.games).toBeGreaterThan(0);
    expect(calibration.scale).toBeLessThan(1);
    const expectations = matchExpectations(matches, options);
    const table = computeRatings(matches, options);
    const beforeAvg = (m: MatchView, team: Team) => {
      const ids = m.roster.filter((r) => r.team === team).map((r) => r.participantId);
      const sum = ids.reduce((s, id) => s + table.get(id)!.history.find((h) => h.matchId === m.id)!.before, 0);
      return sum / ids.length;
    };
    let upsets = 0;
    for (const m of matches) {
      const e = expectations.get(m.id);
      if (!e) continue;
      const gap = beforeAvg(m, "A") - beforeAvg(m, "B");
      expect(e.ratingGapA).toBeCloseTo(gap, 9);
      const raw = expectedScore(beforeAvg(m, "A"), beforeAvg(m, "B"));
      expect(e.expectedA).toBeCloseTo(calibrateExpectation(raw, m.teamASide, calibration), 12);
      expect(e.upset).toBe(e.reliable && (e.winnerTeam === "A" ? -gap : gap) >= UPSET_MMR_GAP);
      if (e.upset) upsets += 1;
    }
    expect(upsets).toBeGreaterThan(0);
  });

  it("a가 0.25 안팎인 모임에서도 팀 평균 MMR이 70점 이상 낮은 팀이 이기면 이변이다", () => {
    // 결과가 동전이라 보정값이 실제 모임(a ≈ 0.25)처럼 작다. 보정한 %로 판정하던 때는 이긴 팀 예상이 40% 아래로
    // 내려가는 일이 드물어 이변이 거의 사라졌다.
    const options = { placementGames: 3 };
    const matches = randomMatches(5, 400);
    expect(expectationCalibration(matches, options).scale).toBeLessThan(0.4);
    const upsets = [...matchExpectations(matches, options).values()].filter((e) => e.upset);
    expect(upsets.length).toBeGreaterThan(0);
    for (const e of upsets) expect(e.winnerDeficit).toBeGreaterThanOrEqual(UPSET_MMR_GAP);
    // 보정한 %로는 이긴 팀이 40% 이상이었던(예전 판정이면 이변이 아닌) 경기도 이변으로 잡힌다.
    expect(upsets.some((e) => expectedOf(e, e.winnerTeam) >= 0.4)).toBe(true);
  });

  it("같은 경기 배열이면 다시 맞추지 않고 같은 값을 돌려준다", () => {
    const matches = randomMatches(9, 80);
    expect(matchExpectations(matches, { placementGames: 3 })).toBe(matchExpectations(matches, { placementGames: 3 }));
    expect(expectationCalibration(matches, { placementGames: 3 })).toBe(expectationCalibration(matches, { placementGames: 3 }));
  });
});

describe("이변 판정", () => {
  it("경계값: 이긴 팀이 70점 낮으면 이변이고 그보다 덜 낮으면 아니다", () => {
    expect(UPSET_MMR_GAP).toBe(70);
    expect(isUpset(70, true)).toBe(true);
    expect(isUpset(69.99, true)).toBe(false);
    expect(isUpset(-200, true)).toBe(false);
  });

  it("점수 기준은 보정 전 Elo 예상의 선(40%·45~55%·35~65%)과 같다", () => {
    const PERCENT_TOLERANCE = 0.002;
    expect(Math.abs(expectedScore(0, UPSET_MMR_GAP) - 0.4)).toBeLessThan(PERCENT_TOLERANCE);
    expect(Math.abs(expectedScore(0, BALANCED_MMR_GAP) - 0.45)).toBeLessThan(PERCENT_TOLERANCE);
    expect(Math.abs(expectedScore(0, LOPSIDED_MMR_GAP) - 0.35)).toBeLessThan(PERCENT_TOLERANCE);
  });

  it("열 명 모두 배치 중이면 판정하지 않는다(예상 값은 남긴다)", () => {
    expect(isUpset(500, false)).toBe(false);
    // 9경기 뒤 10번째: 모두 이 경기 전 9경기라 배치 중.
    const matches = [...aWins(9), match(10, { winner: "B" })];
    const e = matchExpectations(matches).get("m10")!;
    expect(e.reliable).toBe(false);
    expect(e.expectedA).toBeGreaterThan(0.6);
    expect(e.upset).toBe(false);
    expect(e.winnerDeficit).toBeGreaterThan(UPSET_MMR_GAP);
  });

  it("한 명이라도 배치를 마쳤으면 판정한다", () => {
    const matches = [...aWins(10), match(11, { winner: "B" })];
    const e = matchExpectations(matches).get("m11")!;
    expect(e.reliable).toBe(true);
    expect(e.winnerDeficit).toBeGreaterThanOrEqual(UPSET_MMR_GAP);
    expect(e.upset).toBe(true);
    // 배치를 마친 사람 하나와 새 사람 아홉.
    const mixed = [...aWins(10), match(11, { teamA: [0, 20, 21, 22, 23], teamB: [24, 25, 26, 27, 28] })];
    expect(matchExpectations(mixed).get("m11")!.reliable).toBe(true);
    const fresh = [...aWins(10), match(11, { teamA: [30, 31, 32, 33, 34], teamB: [35, 36, 37, 38, 39] })];
    expect(matchExpectations(fresh).get("m11")!.reliable).toBe(false);
  });
});

describe("사람별 이변 집계", () => {
  const matches = [...aWins(10), match(11), match(12, { winner: "B" }), match(13, { winner: "B" })];
  const map = matchExpectations(matches);

  it("이변 승·이변 패·약팀일 때 승률", () => {
    expect(map.get("m12")!.upset).toBe(true);
    const b = personUpsets(map, matches, "p5");
    expect(b.upsetWins).toBeGreaterThanOrEqual(1);
    expect(b.underdogGames).toBe(3);
    expect(b.underdogWins).toBe(2);
    const a = personUpsets(map, matches, "p0");
    expect(a.upsetWins).toBe(0);
    expect(a.upsetLosses).toBe(b.upsetWins);
    expect(a.underdogGames).toBe(0);
  });

  it("범위로 넘긴 경기만 센다", () => {
    const b = personUpsets(map, matches.slice(0, 11), "p5");
    expect(b).toEqual({ upsetWins: 0, upsetLosses: 0, underdogGames: 1, underdogWins: 0 });
  });

  it("사람별 이변 승 횟수(이긴 팀 전원)", () => {
    const wins = upsetWinsByPerson(map, matches);
    expect([...wins.keys()].sort()).toEqual(["p5", "p6", "p7", "p8", "p9"]);
  });
});

describe("편성 공정성", () => {
  it("균형 경기 경계(35점)·많이 치우침(108점 초과)·평균 MMR 차·우세 팀 승률을 센다", () => {
    expect(BALANCED_MMR_GAP).toBe(35);
    expect(LOPSIDED_MMR_GAP).toBe(108);
    const expectations = [
      fake("a", 35, "A"),
      fake("b", -35, "B"),
      fake("c", 36, "A"),
      fake("d", -150, "A"),
      fake("e", 0, "B"),
      fake("g", 108, "B"),
      fake("f", 400, "B", false),
    ];
    const scoped = expectations.map((e, i) => ({ ...match(i + 1), id: e.matchId }));
    const r = fairnessReport(new Map(expectations.map((e) => [e.matchId, e])), scoped);
    expect(r.games).toBe(6);
    expect(r.balanced).toBe(3);
    // 36점·108점은 "조금", 150점은 "많이". 세 구간의 합은 games다.
    expect(r.slight).toBe(2);
    expect(r.lopsided).toBe(1);
    expect(r.avgGap).toBeCloseTo((35 + 35 + 36 + 150 + 0 + 108) / 6, 12);
    // 우세 팀: a·b·c 적중, d(B 우세인데 A 승)·g(A 우세인데 B 승) 빗나감. e는 차가 0이라 빠진다.
    expect(r.favoriteGames).toBe(5);
    expect(r.favoriteWins).toBe(3);
    // d(150점 낮은 A 승)·g(108점 낮은 B 승).
    expect(r.upsets).toBe(2);
  });

  it("같은 MMR 차면 모임의 보정값과 관계없이 판정이 같다", () => {
    // 같은 경기를 보정이 다른 두 모임에서 본 것처럼 표시 %만 다르게 넣는다(80점 낮은 팀 승: a = 1이면 약 39%, a = 0.25면 약 47%).
    const gaps: [string, number, Team][] = [["a", 20, "B"], ["b", -80, "A"], ["c", 130, "A"], ["d", -40, "B"]];
    const asSeenWith = (scale: number) =>
      gaps.map(([id, gap, winner]) => {
        const shown = calibrateExpectation(expectedScore(gap, 0), "blue", { scale, blueEdge: 0, games: 300 });
        return fake(id, gap, winner, true, shown);
      });
    const scoped = gaps.map(([id], i) => ({ ...match(i + 1), id }));
    const plain = asSeenWith(1);
    const shrunk = asSeenWith(0.25);
    expect(shrunk[1]!.expectedA).not.toBeCloseTo(plain[1]!.expectedA, 2);
    const reportOf = (list: MatchExpectation[]) => fairnessReport(new Map(list.map((e) => [e.matchId, e])), scoped);
    expect(reportOf(shrunk)).toEqual(reportOf(plain));
    expect(shrunk.map((e) => e.upset)).toEqual(plain.map((e) => e.upset));
    expect(plain.map((e) => e.upset)).toEqual([false, true, false, false]);
  });

  it("실제 경기: 모두 배치 중인 경기는 빼고 같은 MMR끼리는 균형이다", () => {
    const matches = [
      ...aWins(10),
      match(11),
      match(12, { winner: "B" }),
      // 앞 팀 둘·뒤 팀 둘씩 섞은 4대4: 평균이 같아 정확히 50%.
      match(13, { teamA: [0, 1, 5, 6], teamB: [2, 3, 7, 8] }),
    ];
    const map = matchExpectations(matches);
    expect(map.get("m13")!.ratingGapA).toBe(0);
    const r = fairnessReport(map, matches);
    expect(r.games).toBe(3);
    expect(r.balanced).toBe(1);
    expect(r.favoriteGames).toBe(2);
    expect(r.favoriteWins).toBe(1);
    expect(r.upsets).toBe(1);
  });

  it("경기가 없으면 모두 0", () => {
    expect(fairnessReport(new Map(), [])).toEqual({
      games: 0,
      balanced: 0,
      slight: 0,
      lopsided: 0,
      avgGap: 0,
      favoriteGames: 0,
      favoriteWins: 0,
      upsets: 0,
    });
  });
});

describe("편성 판정", () => {
  const base = { games: 10, slight: 0, lopsided: 0, avgGap: 0, favoriteGames: 0, favoriteWins: 0, upsets: 0 };
  it("균형 비율 60% 이상 good, 40% 이상 ok, 그 아래 poor, 경기 없으면 ok", () => {
    expect(fairnessVerdict({ ...base, balanced: 6 })).toBe("good");
    expect(fairnessVerdict({ ...base, balanced: 5 })).toBe("ok");
    expect(fairnessVerdict({ ...base, balanced: 4 })).toBe("ok");
    expect(fairnessVerdict({ ...base, balanced: 3 })).toBe("poor");
    expect(fairnessVerdict({ ...base, games: 0, balanced: 0 })).toBe("ok");
  });
});

describe("이변 메이커 상", () => {
  function snap(matches: MatchView[]): Snapshot {
    return {
      role: "viewer",
      serverTime: "2026-11-06T00:00:00.000Z",
      group: { id: "g", name: "모임", timezone: "Asia/Seoul", liveVersion: 0, settings: DEFAULT_SETTINGS },
      participants: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `사람${i}`, status: "active" as const })),
      session: null,
      rotation: null,
      matches,
      revisions: [],
      seasons: [],
    };
  }
  const nameOf = (id: string) => `사람${id.slice(1)}`;
  const now = new Date("2026-11-06T00:00:00.000Z");

  it("이변 승이 가장 많은 사람(동률이면 공동, 이름 순)", () => {
    const s = seasonSummary(snap([...aWins(10), match(11, { winner: "B" })]), { kind: "year", year: 2026 }, nameOf, now);
    const award = s.awards.find((a) => a.key === "upsetMaker")!;
    expect(award.winners.map((w) => w.participantIds[0])).toEqual(["p5", "p6", "p7", "p8", "p9"]);
    expect(award.winners[0]!.value).toBe("이변 승 1회");
    expect(seasonSummaryText(s, "모임", nameOf)).toContain("이변 메이커: 사람5 이변 승 1회");
  });

  it("이변이 없으면 해당 없음", () => {
    const s = seasonSummary(snap(aWins(12)), { kind: "year", year: 2026 }, nameOf, now);
    const award = s.awards.find((a) => a.key === "upsetMaker")!;
    expect(award.winners).toEqual([]);
    expect(award.none).toBe("이변으로 이긴 경기가 없어요.");
    expect(seasonSummaryText(s, "모임", nameOf)).toContain("이변 메이커: 해당 없음");
  });
});
