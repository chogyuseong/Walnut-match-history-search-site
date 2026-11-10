import { describe, expect, it } from "vitest";
import { computeRatings, expectedScore, RATING_START } from "../src/shared/rating";
import { seasonSummary, seasonSummaryText } from "../src/shared/seasonAwards";
import { DEFAULT_SETTINGS, type MatchView, type Snapshot, type Team } from "../src/shared/types";
import {
  BALANCED_MARGIN,
  expectedOf,
  fairnessReport,
  fairnessVerdict,
  isUpset,
  matchExpectations,
  personUpsets,
  UPSET_THRESHOLD,
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

function fake(id: string, expectedA: number, winnerTeam: Team, reliable = true): MatchExpectation {
  const winnerExpected = winnerTeam === "A" ? expectedA : 1 - expectedA;
  return {
    matchId: id,
    expectedA,
    teamASide: "blue",
    winnerTeam,
    favoriteTeam: expectedA > 0.5 ? "A" : expectedA < 0.5 ? "B" : null,
    reliable,
    upset: isUpset(winnerExpected, reliable),
    surprise: 1 - winnerExpected,
  };
}

describe("경기 전 예상", () => {
  it("첫 경기는 모두 시작값이라 50%이고 우세 팀이 없다", () => {
    const e = matchExpectations([match(1)]).get("m1")!;
    expect(e.expectedA).toBe(0.5);
    expect(e.favoriteTeam).toBeNull();
    expect(e.reliable).toBe(false);
    expect(e.upset).toBe(false);
    expect(e.surprise).toBe(0.5);
  });

  it("직전 MMR(history.before) 평균으로 구한다", () => {
    const matches = [...aWins(10), match(11, { winner: "B" })];
    const table = computeRatings(matches);
    const before = (i: number) => table.get(`p${i}`)!.history.find((h) => h.matchId === "m11")!.before;
    const e = matchExpectations(matches).get("m11")!;
    expect(e.expectedA).toBeCloseTo(expectedScore(before(0), before(5)), 12);
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

describe("경기 전 예상: 미래 결과가 섞이지 않는다(속성, 2026-11-10 설계 4절 D)", () => {
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

  it("앞부분 경기만 넣어 계산한 그 경기의 예상이 전체 기록으로 계산한 값과 같다", () => {
    for (const seed of [1, 7, 42]) {
      const all = randomMatches(seed, 40);
      // 넣는 순서는 섞는다: 계산은 경기 시각 → 번호로 다시 세운다.
      const full = matchExpectations([...all].reverse(), { placementGames: 3 });
      let compared = 0;
      for (let k = 1; k <= all.length; k++) {
        const target = all[k - 1]!;
        const prefix = matchExpectations(all.slice(0, k), { placementGames: 3 });
        expect(prefix.get(target.id), `시드 ${seed}, ${k}번째`).toEqual(full.get(target.id));
        if (full.has(target.id)) compared += 1;
      }
      // 확정 경기 대부분을 실제로 견줬다(예상이 없는 경기끼리만 같아서 통과하는 일이 없게).
      expect(compared).toBeGreaterThan(30);
    }
  });
});

describe("이변 판정", () => {
  it("경계값: 이긴 팀 예상이 40%면 이변이 아니고 그 미만이면 이변이다", () => {
    expect(UPSET_THRESHOLD).toBe(0.4);
    expect(isUpset(0.4, true)).toBe(false);
    expect(isUpset(0.3999, true)).toBe(true);
    expect(isUpset(0.6, true)).toBe(false);
  });

  it("열 명 모두 배치 중이면 판정하지 않는다(예상 값은 남긴다)", () => {
    expect(isUpset(0.1, false)).toBe(false);
    // 9경기 뒤 10번째: 모두 이 경기 전 9경기라 배치 중.
    const matches = [...aWins(9), match(10, { winner: "B" })];
    const e = matchExpectations(matches).get("m10")!;
    expect(e.reliable).toBe(false);
    expect(e.expectedA).toBeGreaterThan(0.6);
    expect(e.upset).toBe(false);
    expect(e.surprise).toBeCloseTo(e.expectedA, 12);
  });

  it("한 명이라도 배치를 마쳤으면 판정한다", () => {
    const matches = [...aWins(10), match(11, { winner: "B" })];
    const e = matchExpectations(matches).get("m11")!;
    expect(e.reliable).toBe(true);
    expect(1 - e.expectedA).toBeLessThan(UPSET_THRESHOLD);
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
  it("균형 경기 경계(45~55%)·평균 치우침·우세 팀 승률을 센다", () => {
    expect(BALANCED_MARGIN).toBe(0.05);
    const expectations = [
      fake("a", 0.55, "A"),
      fake("b", 0.45, "B"),
      fake("c", 0.56, "A"),
      fake("d", 0.3, "A"),
      fake("e", 0.5, "B"),
      fake("f", 0.9, "B", false),
    ];
    const map = new Map(expectations.map((e) => [e.matchId, e]));
    const scoped = expectations.map((e, i) => ({ ...match(i + 1), id: e.matchId }));
    const r = fairnessReport(map, scoped);
    expect(r.games).toBe(5);
    expect(r.balanced).toBe(3);
    // 치우침 0.06은 "조금", 0.2는 "많이". 세 구간의 합은 games다.
    expect(r.slight).toBe(1);
    expect(r.lopsided).toBe(1);
    expect(r.avgDeviation).toBeCloseTo((0.05 + 0.05 + 0.06 + 0.2 + 0) / 5, 12);
    // 우세 팀: a(A 승 적중), b(B 승 적중), c(A 적중), d(B 우세인데 A 승). e는 50%라 빠진다.
    expect(r.favoriteGames).toBe(4);
    expect(r.favoriteWins).toBe(3);
    expect(r.upsets).toBe(1);
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
    expect(map.get("m13")!.expectedA).toBeCloseTo(0.5, 12);
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
      avgDeviation: 0,
      favoriteGames: 0,
      favoriteWins: 0,
      upsets: 0,
    });
  });
});

describe("편성 판정", () => {
  const base = { games: 10, slight: 0, lopsided: 0, avgDeviation: 0, favoriteGames: 0, favoriteWins: 0, upsets: 0 };
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
