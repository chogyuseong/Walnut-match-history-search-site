import { describe, expect, it } from "vitest";
import { rankAndSearch, sortRankingBy } from "../src/shared/insights";
import {
  computeRatings,
  RATING_HALF_LIFE,
  RATING_PRIOR_GAMES,
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

// 결과 기반 MMR(src/shared/rating.ts): 전체 기록 일괄 계산(팀 평균 로지스틱, 가상 반반 경기, 최근 가중, 3연승·3연패부터 가중).
// 일괄 계산은 손으로 값을 맞추기 어려워 성질(대칭·순서·팀원 감안·판수 적은 사람의 쏠림 방지·수렴)로 확인한다.

/** 시작값을 기본과 다르게 두어 시작값이 제대로 옮겨지는지도 같이 본다. */
const LEGACY_START = 1000;
const LEGACY: Partial<RatingOptions> = { start: LEGACY_START };

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

describe("MMR 계산", () => {
  it("빈 입력이면 빈 표", () => {
    expect(computeRatings([]).size).toBe(0);
  });

  it("첫 경기: 시작값에서 이긴 팀은 같은 만큼 오르고 진 팀은 같은 만큼 내린다", () => {
    const table = computeRatings([match(1, { winner: "A" })], LEGACY);
    const gain = rating(table, 0) - LEGACY_START;
    expect(gain).toBeGreaterThan(0);
    for (const i of [0, 1, 2, 3, 4]) expect(rating(table, i)).toBeCloseTo(LEGACY_START + gain, 1);
    for (const i of [5, 6, 7, 8, 9]) expect(rating(table, i)).toBeCloseTo(LEGACY_START - gain, 1);
    expect(table.get("id0")!.games).toBe(1);
    const point = table.get("id0")!.history[0]!;
    expect(point).toMatchObject({ matchId: "m1", before: LEGACY_START, run: 1, multiplier: 1 });
    // 경기 직후 값은 경기마다 몇 번만 맞춘 근삿값이라 끝까지 맞춘 지금 값과 몇 점 다를 수 있다.
    expect(Math.abs(point.after - rating(table, 0))).toBeLessThan(5);
  });

  it("같은 열 명이 같은 팀으로 번갈아 이기면 시작값 근처에 모인다(팀원이 한꺼번에 움직여 발산하지 않는다)", () => {
    const table = computeRatings(Array.from({ length: 30 }, (_, i) => match(i + 1, { winner: i % 2 === 0 ? "A" : "B" })));
    for (const person of table.values()) expect(Math.abs(person.rating - RATING_START)).toBeLessThan(20);
    for (const p of table.get("id0")!.history) expect(Math.abs(p.after - RATING_START)).toBeLessThan(120);
  });

  it("팀원을 감안한다: 같은 반반이라도 약한 팀원과 거둔 사람이 강한 팀원과 거둔 사람보다 높다", () => {
    // 20~24가 30~34를 여섯 번 이겨 강약이 드러난 뒤, 0번은 약한 쪽(30~33)과, 5번은 강한 쪽(20~23)과 붙어 세 번씩 이긴다.
    const setup = Array.from({ length: 6 }, (_, i) => match(i + 1, { teamA: [20, 21, 22, 23, 24], teamB: [30, 31, 32, 33, 34] }));
    const even = Array.from({ length: 6 }, (_, i) =>
      match(10 + i, { teamA: [0, 30, 31, 32, 33], teamB: [5, 20, 21, 22, 23], winner: i % 2 === 0 ? "A" : "B" }),
    );
    const table = computeRatings([...setup, ...even]);
    expect(rating(table, 0)).toBeGreaterThan(rating(table, 5));
  });

  it("판수가 많을수록 같은 전승이라도 더 높다(판수 적은 사람은 가상 경기 때문에 덜 움직인다)", () => {
    const opponents = (i: number) => [5, 6, 7, 8, 9].map((k) => k + i * 5);
    const one = [match(1)];
    const ten = Array.from({ length: 10 }, (_, i) => match(i + 1, { teamB: opponents(i) }));
    expect(rating(computeRatings(ten), 0)).toBeGreaterThan(rating(computeRatings(one), 0));
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

  it("경기 시각 순서로 계산한다(배열 순서와는 무관, 같은 시각이면 경기 번호 순)", () => {
    const early = "2026-10-01T10:00:00.000Z";
    const late = "2026-10-01T12:00:00.000Z";
    const x = (at: string) => match(1, { winner: "A", playedAt: at });
    const y = (at: string) => match(2, { winner: "B", teamA: [0, 5, 6, 7, 8], teamB: [1, 2, 3, 4, 9], playedAt: at });
    const xFirst = computeRatings([x(early), y(late)]);
    expect(ratingValues(computeRatings([y(late), x(early)]))).toEqual(ratingValues(xFirst));
    const same = "2026-10-01T10:00:00.000Z";
    expect(ratingValues(computeRatings([y(same), x(same)]))).toEqual(ratingValues(xFirst));
    // 최근 가중이 있어 경기 순서를 바꾸면 값은 조금 다르다.
    const yFirst = computeRatings([x(late), y(early)]);
    expect(rating(xFirst, 9)).not.toBeCloseTo(rating(yFirst, 9), 6);
  });

  it("최근 가중: 같은 1승 1패라도 최근에 이긴 쪽이 높다", () => {
    const winLate = [match(1, { winner: "B" }), match(2, { winner: "A" })];
    const winEarly = [match(1, { winner: "A" }), match(2, { winner: "B" })];
    expect(rating(computeRatings(winLate), 0)).toBeGreaterThan(rating(computeRatings(winEarly), 0));
    expect([RATING_START, RATING_PRIOR_GAMES, RATING_HALF_LIFE]).toEqual([1200, 20, 200]);
  });

  it("최고 MMR(시작값·경기 직후·지금 중 최고)과 최근 10경기 변화(지금 − 그 첫 경기 직전)", () => {
    const results: Team[] = ["A", "A", "B", "B", "B", "A", "B", "A", "B", "B", "A", "B"];
    const table = computeRatings(results.map((w, i) => match(i + 1, { winner: w })), LEGACY);
    const p0 = table.get("id0")!;
    expect(p0.peak).toBeCloseTo(Math.max(LEGACY_START, p0.rating, ...p0.history.map((h) => h.after)), 9);
    expect(p0.delta10).toBeCloseTo(p0.rating - p0.history.at(-10)!.before, 9);
    const loser = computeRatings([match(1, { winner: "A" })], LEGACY).get("id5")!;
    expect(loser.peak).toBe(LEGACY_START);
    expect(loser.delta10).toBeCloseTo(loser.rating - LEGACY_START, 9);
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
    const before = [match(1, { teamA: [10, 1, 2, 3, 4] }), match(2, { winner: "B" })];
    const after = [match(1), match(2, { winner: "B" })];
    const table = computeRatings(after, LEGACY);
    expect(table.has("id10")).toBe(false);
    expect(table.get("id0")!.games).toBe(2);
    const records = personRecords(after);
    for (const [id, person] of table) expect(person.games).toBe(records.get(id)!.games);
    expect(computeRatings(before, LEGACY).get("id10")!.games).toBe(1);
  });

  it("5,000경기·200명도 계산한다(최근 가중 창 덕에 경기 수에 비례)", () => {
    const matches = Array.from({ length: 5000 }, (_, i) => {
      const base = (i * 37) % 200;
      const ten = Array.from({ length: 10 }, (_, k) => (base + k * 19) % 200);
      return match(i + 1, { winner: i % 3 === 0 ? "B" : "A", teamA: ten.slice(0, 5), teamB: ten.slice(5) });
    });
    const started = performance.now();
    const table = computeRatings(matches, LEGACY);
    const took = performance.now() - started;
    expect(table.size).toBe(200);
    // 개발 PC에서 약 2초(실제 모임 522경기는 수십 ms). 측정 환경이 느릴 수 있어 넉넉하게 본다.
    expect(took).toBeLessThan(8000);
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
    const history = table.get("id0")!.history;
    expect(ratingTrend(history)).toEqual([
      { game: 0, rating: LEGACY_START },
      { game: 1, rating: history[0]!.after },
      { game: 2, rating: history[1]!.after },
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

describe("연승·연패 가중", () => {
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
    // 양쪽 가중이 같아 두 팀은 대칭으로 움직인다.
    expect(rating(table, 0) - LEGACY_START).toBeCloseTo(LEGACY_START - rating(table, 5), 1);
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

  it("팀원마다 자기 연속 기록으로 가중치가 다르다", () => {
    // id0~4는 3연승째(1.25), 처음 나온 id10~14는 첫 패(1).
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A" }),
      match(3, { teamB: [10, 11, 12, 13, 14], winner: "A" }),
    ];
    const table = computeRatings(matches, LEGACY);
    expect(points(table, 0)[2]!.multiplier).toBe(1.25);
    expect(points(table, 10)[0]!.multiplier).toBe(1);
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

  it("3연속 미만만 있는 시나리오는 가중이 모두 1", () => {
    const table = computeRatings(series(["A", "A", "B", "B", "A"]), LEGACY);
    for (const person of table.values()) for (const p of person.history) expect(p.multiplier).toBe(1);
  });
});
