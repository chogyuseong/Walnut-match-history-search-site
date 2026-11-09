import { describe, expect, it } from "vitest";
import { rankAndSearch, sortRankingBy } from "../src/shared/insights";
import {
  computeRatings,
  expectedScore,
  kFactor,
  RATING_K,
  RATING_K_PLACEMENT,
  RATING_START,
  ratingBandOf,
  ratingTrend,
  ratingValues,
  shownRating,
  signedDelta,
  STREAK_K_MAX,
  streakMultiplier,
  type RatingOptions,
} from "../src/shared/rating";
import { personRecords, placements } from "../src/shared/stats";
import type { MatchView, Team } from "../src/shared/types";

// 결과 기반 MMR(src/shared/rating.ts): Elo 방식, 시작 1000, 팀 평균, 배치 중 K=40·그 뒤 K=20, 3연승·3연패부터 K 가중(최대 1.5배).

/** 손으로 계산한 기대값은 예전 기본값(시작 1000 · K 40/20)으로 적었다. 옵션을 직접 넘겨 계산 규칙만 본다. */
const LEGACY_START = 1000;
const LEGACY: Partial<RatingOptions> = { start: LEGACY_START, kPlacement: 40, k: 20 };

interface MatchOptions {
  winner?: Team;
  state?: MatchView["state"];
  playedAt?: string;
  /** 팀 A 참가자 번호 5개. */
  teamA?: number[];
  /** 팀 B 참가자 번호 5개. */
  teamB?: number[];
}

function match(no: number, options: MatchOptions = {}): MatchView {
  const teamA = options.teamA ?? [0, 1, 2, 3, 4];
  const teamB = options.teamB ?? [5, 6, 7, 8, 9];
  const state = options.state ?? "confirmed";
  const playedAt = options.playedAt ?? new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  const confirmedLike = state === "confirmed" || state === "excluded";
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: confirmedLike ? playedAt : null,
    winnerTeam: confirmedLike ? (options.winner ?? "A") : null,
    teamASide: confirmedLike ? "blue" : null,
    version: 1,
    roster: [
      ...teamA.map((i) => ({ participantId: `id${i}`, team: "A" as const, position: null })),
      ...teamB.map((i) => ({ participantId: `id${i}`, team: "B" as const, position: null })),
    ],
  };
}

const rating = (table: ReturnType<typeof computeRatings>, i: number) => table.get(`id${i}`)!.rating;
const sumChange = (table: ReturnType<typeof computeRatings>, matchId: string) => {
  let sum = 0;
  for (const person of table.values()) {
    for (const p of person.history) if (p.matchId === matchId) sum += p.after - p.before;
  }
  return sum;
};

describe("MMR 계산", () => {
  it("빈 입력이면 빈 표", () => {
    expect(computeRatings([]).size).toBe(0);
  });

  it("첫 경기: 같은 1000끼리라 E=0.5, K=40 → 이긴 팀 +20 · 진 팀 −20", () => {
    const table = computeRatings([match(1, { winner: "A" })], LEGACY);
    for (const i of [0, 1, 2, 3, 4]) expect(rating(table, i)).toBeCloseTo(1020, 10);
    for (const i of [5, 6, 7, 8, 9]) expect(rating(table, i)).toBeCloseTo(980, 10);
    expect(table.get("id0")!.games).toBe(1);
    expect(table.get("id0")!.history).toEqual([{ matchId: "m1", before: 1000, after: 1020, run: 1, multiplier: 1 }]);
  });

  it("열 명의 K가 같으면 한 경기의 두 팀 변화 합은 0", () => {
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A", teamA: [0, 1, 2, 5, 6], teamB: [3, 4, 7, 8, 9] }),
      match(3, { winner: "B", teamA: [0, 5, 2, 7, 4], teamB: [1, 6, 3, 8, 9] }),
    ];
    const table = computeRatings(matches, LEGACY);
    for (const m of matches) expect(sumChange(table, m.id)).toBeCloseTo(0, 9);
    let total = 0;
    for (const p of table.values()) total += p.rating - LEGACY_START;
    expect(total).toBeCloseTo(0, 9);
  });

  it("강팀이 이기면 변화가 작고, 약팀이 이기면 변화가 크다", () => {
    // 첫 경기 뒤 팀 A(0~4)는 1020, 팀 B(5~9)는 980.
    const first = match(1, { winner: "A" });
    const strongWins = computeRatings([first, match(2, { winner: "A" })], LEGACY);
    const weakWins = computeRatings([first, match(2, { winner: "B" })], LEGACY);
    const gainStrong = rating(strongWins, 0) - 1020;
    const gainWeak = rating(weakWins, 5) - 980;
    expect(gainStrong).toBeGreaterThan(0);
    expect(gainStrong).toBeLessThan(20);
    expect(gainWeak).toBeGreaterThan(20);
    // E(1020 대 980) ≈ 0.5576 → 강팀 승 +40 × 0.4424, 약팀 승 +40 × 0.5576
    const e = expectedScore(1020, 980);
    expect(gainStrong).toBeCloseTo(40 * (1 - e), 9);
    expect(gainWeak).toBeCloseTo(40 * e, 9);
  });

  it("확정 10경기 뒤(11경기째부터) K가 40에서 20으로 내려간다", () => {
    expect(kFactor(0)).toBe(RATING_K_PLACEMENT);
    expect(kFactor(9)).toBe(RATING_K_PLACEMENT);
    expect(kFactor(10)).toBe(RATING_K);
    // 같은 두 팀이 번갈아 이긴다. 팀원은 늘 같은 값이라 팀 평균 = 한 사람 값이다.
    const winners: Team[] = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? "A" : "B"));
    const table = computeRatings(winners.map((w, i) => match(i + 1, { winner: w })), LEGACY);
    const mine = table.get("id0")!.history;
    const theirs = table.get("id5")!.history;
    expect(mine).toHaveLength(11);
    mine.forEach((p, i) => {
      const e = expectedScore(p.before, theirs[i]!.before);
      const k = i < 10 ? 40 : 20;
      expect(p.after - p.before).toBeCloseTo(k * ((winners[i] === "A" ? 1 : 0) - e), 9);
    });
  });

  it("배치 중인 사람과 끝난 사람이 섞이면 K가 달라 변화 합이 0이 아니다(사람별 K 규칙)", () => {
    // 0~9가 10경기를 마친 뒤, 10번(새 사람)이 9번 대신 들어온다.
    const ten = Array.from({ length: 10 }, (_, i) => match(i + 1, { winner: i % 2 === 0 ? "A" : "B" }));
    const mixed = match(11, { winner: "B", teamB: [5, 6, 7, 8, 10] });
    const table = computeRatings([...ten, mixed], LEGACY);
    // 같은 팀이라 (S − E)는 같고 K만 40 대 20이다.
    const newcomer = table.get("id10")!.history[0]!;
    const veteran = table.get("id5")!.history[10]!;
    const gain = newcomer.after - newcomer.before;
    expect(gain / (veteran.after - veteran.before)).toBeCloseTo(2, 9);
    expect(Math.abs(sumChange(table, "m11"))).toBeGreaterThan(0);
  });

  it("결과 대기·진행 중·취소·전적 제외 경기는 세지 않는다", () => {
    const counted = computeRatings([match(1)], LEGACY);
    const withOthers = computeRatings([
      match(1),
      match(2, { state: "awaiting_result" }),
      match(3, { state: "in_progress" }),
      match(4, { state: "canceled" }),
      match(5, { state: "excluded", winner: "B" }),
    ], LEGACY);
    expect(ratingValues(withOthers)).toEqual(ratingValues(counted));
    expect(withOthers.get("id0")!.games).toBe(1);
  });

  it("경기 시각 순서로 계산한다: 순서가 바뀌면 결과도 다르다(배열 순서와는 무관)", () => {
    const early = "2026-10-01T10:00:00.000Z";
    const late = "2026-10-01T12:00:00.000Z";
    // 첫 경기에서 0~4가 이기고, 둘째 경기는 0~4 + 5~9를 섞어 0이 진다.
    const x = (at: string) => match(1, { winner: "A", playedAt: at });
    const y = (at: string) =>
      match(2, { winner: "B", teamA: [0, 5, 6, 7, 8], teamB: [1, 2, 3, 4, 9], playedAt: at });
    const xFirst = computeRatings([x(early), y(late)]);
    const yFirst = computeRatings([x(late), y(early)]);
    expect(rating(xFirst, 9)).not.toBeCloseTo(rating(yFirst, 9), 6);
    // 배열 순서만 바꾸면 그대로다.
    expect(ratingValues(computeRatings([y(late), x(early)]))).toEqual(ratingValues(xFirst));
    // 같은 시각이면 경기 번호 순.
    const same = "2026-10-01T10:00:00.000Z";
    expect(ratingValues(computeRatings([y(same), x(same)]))).toEqual(
      ratingValues(computeRatings([x(early), y(late)])),
    );
  });

  it("최고 MMR(시작값 포함)과 최근 10경기 변화 합", () => {
    // 0~4: 승 승 패 … (12경기)
    const results: Team[] = ["A", "A", "B", "B", "B", "A", "B", "A", "B", "B", "A", "B"];
    const table = computeRatings(results.map((w, i) => match(i + 1, { winner: w })), LEGACY);
    const p0 = table.get("id0")!;
    expect(p0.peak).toBeCloseTo(Math.max(LEGACY_START, ...p0.history.map((h) => h.after)), 9);
    expect(p0.peak).toBeGreaterThan(1020); // 두 번째 승리 뒤가 최고
    const last10 = p0.history.slice(-10);
    expect(p0.delta10).toBeCloseTo(last10[9]!.after - last10[0]!.before, 9);
    // 지기만 한 사람의 최고는 시작값 1000.
    const loser = computeRatings([match(1, { winner: "A" })], LEGACY).get("id5")!;
    expect(loser.peak).toBe(LEGACY_START);
    expect(loser.delta10).toBeCloseTo(-20, 9);
  });

  it("결정적이다: 같은 입력이면 같은 결과", () => {
    const matches = Array.from({ length: 30 }, (_, i) =>
      match(i + 1, {
        winner: (i * 7) % 3 === 0 ? "B" : "A",
        teamA: [0, 1, 2, 3, 4].map((k) => (k + i) % 12),
        teamB: [5, 6, 7, 8, 9].map((k) => (k + i) % 12),
      }),
    );
    const first = computeRatings(matches, LEGACY);
    const second = computeRatings([...matches].reverse(), LEGACY);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it("합쳐진 참가자: 서버가 명단 ID를 남은 사람으로 옮긴 스냅숏에서는 처음부터 남은 사람의 경기로 센다", () => {
    // 합치기 전: id10이 1경기, id0이 1경기. 합친 뒤(id10 → id0): 두 경기 모두 id0.
    const before = [match(1, { teamA: [10, 1, 2, 3, 4] }), match(2, { winner: "B" })];
    const after = [match(1), match(2, { winner: "B" })];
    const table = computeRatings(after, LEGACY);
    expect(table.has("id10")).toBe(false);
    expect(table.get("id0")!.games).toBe(2);
    // personRecords(배치 판수)와 같은 사람·같은 경기 수.
    const records = personRecords(after);
    for (const [id, person] of table) expect(person.games).toBe(records.get(id)!.games);
    expect(computeRatings(before, LEGACY).get("id10")!.games).toBe(1);
  });

  it("5,000경기·200명도 한 번에 계산한다(경기 수에 비례)", () => {
    const matches = Array.from({ length: 5000 }, (_, i) => {
      const base = (i * 37) % 200;
      const ten = Array.from({ length: 10 }, (_, k) => (base + k * 19) % 200);
      return match(i + 1, { winner: i % 3 === 0 ? "B" : "A", teamA: ten.slice(0, 5), teamB: ten.slice(5) });
    });
    const started = performance.now();
    const table = computeRatings(matches, LEGACY);
    const took = performance.now() - started;
    expect(table.size).toBe(200);
    // 측정 환경이 느릴 수 있어 넉넉하게 본다(목표는 50ms 안).
    expect(took).toBeLessThan(500);
  });
});

describe("새 기본값(시작 1200 · 배치 중 K 50 · 배치 뒤 K 30)", () => {
  it("첫 경기 ±25, 같은 팀이 또 이기면 50 × (1 − E(1225, 1175)) ≈ +21.43", () => {
    expect([RATING_START, RATING_K_PLACEMENT, RATING_K]).toEqual([1200, 50, 30]);
    const one = computeRatings([match(1)]);
    expect(rating(one, 0)).toBeCloseTo(1225, 10);
    expect(rating(one, 5)).toBeCloseTo(1175, 10);
    const two = computeRatings([match(1), match(2)]);
    // E = 1 / (1 + 10^(−50/400)) ≈ 0.57146 → 50 × 0.42854 ≈ 21.43
    expect(rating(two, 0)).toBeCloseTo(1225 + 21.427, 2);
    expect(shownRating(rating(two, 0))).toBe(1246);
  });

  it("배치(10경기)를 마치면 K 30", () => {
    const winners: Team[] = Array.from({ length: 11 }, (_, i) => (i % 2 === 0 ? "A" : "B"));
    const mine = computeRatings(winners.map((w, i) => match(i + 1, { winner: w }))).get("id0")!.history;
    const last = mine[10]!;
    const e = expectedScore(last.before, 2 * RATING_START - last.before);
    expect(last.after - last.before).toBeCloseTo(30 * (1 - e), 9);
  });
});

describe("MMR 표시·추이", () => {
  it("정수 반올림, 부호 붙은 변화, 단계 글자", () => {
    expect(shownRating(1043.4)).toBe(1043);
    expect(shownRating(1043.5)).toBe(1044);
    expect(signedDelta(12.4)).toBe("+12");
    expect(signedDelta(-5.6)).toBe("−6");
    expect(signedDelta(0.3)).toBe("0");
    expect(ratingBandOf(1250, LEGACY_START)).toBe("1200 이상");
    expect(ratingBandOf(1199.6, LEGACY_START)).toBe("1200 이상");
    expect(ratingBandOf(1100, LEGACY_START)).toBe("1100대");
    expect(ratingBandOf(1000, LEGACY_START)).toBe("1000대");
    expect(ratingBandOf(999.4, LEGACY_START)).toBe("900대");
    expect(ratingBandOf(899, LEGACY_START)).toBe("900 미만");
  });

  it("추이는 시작값부터, 많으면 솎되 마지막 점은 남긴다", () => {
    expect(ratingTrend([])).toEqual([]);
    const table = computeRatings([match(1), match(2, { winner: "B" })], LEGACY);
    expect(ratingTrend(table.get("id0")!.history).map((p) => [p.game, Math.round(p.rating)])).toEqual([
      [0, 1000],
      [1, 1020],
      // 1020(팀 평균) 대 980에서 지면 −40 × E(1020, 980) ≈ −22.3
      [2, 998],
    ]);
    const long = Array.from({ length: 500 }, (_, i) => ({ matchId: `m${i}`, before: i, after: i + 1, run: 1, multiplier: 1 }));
    const points = ratingTrend(long, 120);
    expect(points.length).toBeLessThanOrEqual(121);
    expect(points[points.length - 1]).toEqual({ game: 500, rating: 500 });
  });
});

describe("랭킹: MMR 순", () => {
  const nameOf = (id: string) => `선수${id.slice(2).padStart(2, "0")}`;
  const ids = (rows: { participantId: string }[]) => rows.map((r) => r.participantId);

  it("묶음(누적 50경기 이상 → 배치 완료 → 배치 진행 중) 안에서 MMR 높은 순, 같으면 승률", () => {
    // 첫 경기에서 0~4 승, 둘째 경기에서 0·5·6·7·8이 1·2·3·4·9를 이긴다.
    const matches = [match(1), match(2, { teamA: [0, 5, 6, 7, 8], teamB: [1, 2, 3, 4, 9] })];
    const records = [...personRecords(matches).values()];
    const ratings = ratingValues(computeRatings(matches, LEGACY));
    const sorted = ids(sortRankingBy(records, placements(matches), nameOf, "rating", ratings));
    const values = sorted.map((id) => ratings.get(id)!);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(sorted[0]).toBe("id0");
    expect(sorted[sorted.length - 1]).toBe("id9");
    // 묶음이 우선이다: 배치 완료한 사람이 MMR이 낮아도 위.
    const placement = new Map([
      ["id9", { games: 12, done: true }],
      ["id0", { games: 2, done: false }],
    ]);
    expect(ids(sortRankingBy(records, placement, nameOf, "rating", ratings))[0]).toBe("id9");
    // MMR 표가 없으면 모두 같은 시작값으로 보고 승률 순.
    const noTable = ids(sortRankingBy(records, placements(matches), nameOf, "rating"));
    expect(noTable[0]).toBe("id0");
    // 검색해도 순위 숫자는 그대로.
    const all = rankAndSearch(records, placements(matches), nameOf, "rating", "", ratings);
    const searched = rankAndSearch(records, placements(matches), nameOf, "rating", "선수09", ratings);
    expect(searched.shown.map((r) => r.rank)).toEqual([all.ranked.find((r) => r.participantId === "id9")!.rank]);
  });
});

describe("연속성 가중 K", () => {
  const points = (table: ReturnType<typeof computeRatings>, i: number) => table.get(`id${i}`)!.history;
  /** 같은 열 명이 경기마다 정해진 승자로 붙는다. */
  const series = (winners: Team[]) => winners.map((winner, i) => match(i + 1, { winner }));

  it("가중치: run 1·2는 1, 3은 1.25, 4는 1.375, 5부터 1.5에서 멈춘다", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((run) => streakMultiplier(run))).toEqual([1, 1, 1.25, 1.375, 1.5, 1.5, 1.5]);
    expect(STREAK_K_MAX).toBe(1.5);
  });

  it("상한을 1로 두면 언제나 1(연속성 가중 없음)", () => {
    for (const run of [1, 2, 3, 4, 5, 10]) expect(streakMultiplier(run, 1)).toBe(1);
  });

  it("2연승까지 가중 1, 3연승째 1.25, 5연승째 1.5", () => {
    const table = computeRatings(series(["A", "A", "A", "A", "A", "A"]), LEGACY);
    expect(points(table, 0).map((p) => [p.run, p.multiplier])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1.25],
      [4, 1.375],
      [5, 1.5],
      [6, 1.5],
    ]);
    // 3연승째 변화 = K(40) × 1.25 × (1 − E)
    const third = points(table, 0)[2]!;
    expect(third.after - third.before).toBeCloseTo(40 * 1.25 * (1 - expectedScore(third.before, points(table, 5)[2]!.before)), 10);
  });

  it("연패도 대칭: 진 팀은 3연패째부터 더 내려간다", () => {
    const table = computeRatings(series(["A", "A", "A", "A", "A"]), LEGACY);
    expect(points(table, 5).map((p) => [p.run, p.multiplier])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1.25],
      [4, 1.375],
      [5, 1.5],
    ]);
    // 이긴 쪽·진 쪽 모두 K와 가중치가 같으므로 두 팀 변화의 합은 여전히 0
    for (let no = 1; no <= 5; no++) expect(sumChange(table, `m${no}`)).toBeCloseTo(0, 9);
  });

  it("연승이 끊긴 다음 경기는 가중 1, 다시 세기 시작한다", () => {
    const table = computeRatings(series(["A", "A", "A", "B", "B", "A"]), LEGACY);
    expect(points(table, 0).map((p) => [p.run, p.multiplier])).toEqual([
      [1, 1],
      [2, 1],
      [3, 1.25],
      [1, 1],
      [2, 1],
      [1, 1],
    ]);
  });

  it("팀원마다 자기 연속 기록으로 가중치가 다르다(합이 0이 아니어도 된다)", () => {
    // id0~4는 3연승째(1.25), 처음 나온 id10~14는 첫 패(1).
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A" }),
      match(3, { teamB: [10, 11, 12, 13, 14], winner: "A" }),
    ];
    const table = computeRatings(matches, LEGACY);
    expect(points(table, 0)[2]!.multiplier).toBe(1.25);
    expect(points(table, 10)[0]!.multiplier).toBe(1);
    expect(Math.abs(sumChange(table, "m3"))).toBeGreaterThan(1e-6);
  });

  it("미확정·전적 제외 경기는 연속 기록을 끊지도 잇지도 않는다", () => {
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A" }),
      match(3, { state: "awaiting_result" }),
      match(4, { state: "excluded", winner: "B" }),
      match(5, { winner: "A" }),
    ];
    const table = computeRatings(matches, LEGACY);
    expect(points(table, 0).map((p) => p.run)).toEqual([1, 2, 3]);
  });

  it("3연속 미만만 있는 시나리오는 가중 전과 값이 같다", () => {
    const table = computeRatings(series(["A", "A", "B", "B", "A"]), LEGACY);
    for (const person of table.values()) for (const p of person.history) expect(p.multiplier).toBe(1);
  });
});
