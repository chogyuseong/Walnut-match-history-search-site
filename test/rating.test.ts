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
} from "../src/shared/rating";
import { personRecords, placements } from "../src/shared/stats";
import type { MatchView, Team } from "../src/shared/types";

// 결과 기반 레이팅(src/shared/rating.ts): Elo 방식, 시작 1000, 팀 평균, 배치 중 K=40·그 뒤 K=20.

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

describe("레이팅 계산", () => {
  it("빈 입력이면 빈 표", () => {
    expect(computeRatings([]).size).toBe(0);
  });

  it("첫 경기: 같은 1000끼리라 E=0.5, K=40 → 이긴 팀 +20 · 진 팀 −20", () => {
    const table = computeRatings([match(1, { winner: "A" })]);
    for (const i of [0, 1, 2, 3, 4]) expect(rating(table, i)).toBeCloseTo(1020, 10);
    for (const i of [5, 6, 7, 8, 9]) expect(rating(table, i)).toBeCloseTo(980, 10);
    expect(table.get("id0")!.games).toBe(1);
    expect(table.get("id0")!.history).toEqual([{ matchId: "m1", before: 1000, after: 1020 }]);
  });

  it("열 명의 K가 같으면 한 경기의 두 팀 변화 합은 0", () => {
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A", teamA: [0, 1, 2, 5, 6], teamB: [3, 4, 7, 8, 9] }),
      match(3, { winner: "B", teamA: [0, 5, 2, 7, 4], teamB: [1, 6, 3, 8, 9] }),
    ];
    const table = computeRatings(matches);
    for (const m of matches) expect(sumChange(table, m.id)).toBeCloseTo(0, 9);
    let total = 0;
    for (const p of table.values()) total += p.rating - RATING_START;
    expect(total).toBeCloseTo(0, 9);
  });

  it("강팀이 이기면 변화가 작고, 약팀이 이기면 변화가 크다", () => {
    // 첫 경기 뒤 팀 A(0~4)는 1020, 팀 B(5~9)는 980.
    const first = match(1, { winner: "A" });
    const strongWins = computeRatings([first, match(2, { winner: "A" })]);
    const weakWins = computeRatings([first, match(2, { winner: "B" })]);
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
    const table = computeRatings(winners.map((w, i) => match(i + 1, { winner: w })));
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
    const table = computeRatings([...ten, mixed]);
    // 같은 팀이라 (S − E)는 같고 K만 40 대 20이다.
    const newcomer = table.get("id10")!.history[0]!;
    const veteran = table.get("id5")!.history[10]!;
    const gain = newcomer.after - newcomer.before;
    expect(gain / (veteran.after - veteran.before)).toBeCloseTo(2, 9);
    expect(Math.abs(sumChange(table, "m11"))).toBeGreaterThan(0);
  });

  it("결과 대기·진행 중·취소·전적 제외 경기는 세지 않는다", () => {
    const counted = computeRatings([match(1)]);
    const withOthers = computeRatings([
      match(1),
      match(2, { state: "awaiting_result" }),
      match(3, { state: "in_progress" }),
      match(4, { state: "canceled" }),
      match(5, { state: "excluded", winner: "B" }),
    ]);
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

  it("최고 레이팅(시작값 포함)과 최근 10경기 변화 합", () => {
    // 0~4: 승 승 패 … (12경기)
    const results: Team[] = ["A", "A", "B", "B", "B", "A", "B", "A", "B", "B", "A", "B"];
    const table = computeRatings(results.map((w, i) => match(i + 1, { winner: w })));
    const p0 = table.get("id0")!;
    expect(p0.peak).toBeCloseTo(Math.max(RATING_START, ...p0.history.map((h) => h.after)), 9);
    expect(p0.peak).toBeGreaterThan(1020); // 두 번째 승리 뒤가 최고
    const last10 = p0.history.slice(-10);
    expect(p0.delta10).toBeCloseTo(last10[9]!.after - last10[0]!.before, 9);
    // 지기만 한 사람의 최고는 시작값 1000.
    const loser = computeRatings([match(1, { winner: "A" })]).get("id5")!;
    expect(loser.peak).toBe(RATING_START);
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
    const first = computeRatings(matches);
    const second = computeRatings([...matches].reverse());
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });

  it("합쳐진 참가자: 서버가 명단 ID를 남은 사람으로 옮긴 스냅숏에서는 처음부터 남은 사람의 경기로 센다", () => {
    // 합치기 전: id10이 1경기, id0이 1경기. 합친 뒤(id10 → id0): 두 경기 모두 id0.
    const before = [match(1, { teamA: [10, 1, 2, 3, 4] }), match(2, { winner: "B" })];
    const after = [match(1), match(2, { winner: "B" })];
    const table = computeRatings(after);
    expect(table.has("id10")).toBe(false);
    expect(table.get("id0")!.games).toBe(2);
    // personRecords(배치 판수)와 같은 사람·같은 경기 수.
    const records = personRecords(after);
    for (const [id, person] of table) expect(person.games).toBe(records.get(id)!.games);
    expect(computeRatings(before).get("id10")!.games).toBe(1);
  });

  it("5,000경기·200명도 한 번에 계산한다(경기 수에 비례)", () => {
    const matches = Array.from({ length: 5000 }, (_, i) => {
      const base = (i * 37) % 200;
      const ten = Array.from({ length: 10 }, (_, k) => (base + k * 19) % 200);
      return match(i + 1, { winner: i % 3 === 0 ? "B" : "A", teamA: ten.slice(0, 5), teamB: ten.slice(5) });
    });
    const started = performance.now();
    const table = computeRatings(matches);
    const took = performance.now() - started;
    expect(table.size).toBe(200);
    // 측정 환경이 느릴 수 있어 넉넉하게 본다(목표는 50ms 안).
    expect(took).toBeLessThan(500);
  });
});

describe("레이팅 표시·추이", () => {
  it("정수 반올림, 부호 붙은 변화, 단계 글자", () => {
    expect(shownRating(1043.4)).toBe(1043);
    expect(shownRating(1043.5)).toBe(1044);
    expect(signedDelta(12.4)).toBe("+12");
    expect(signedDelta(-5.6)).toBe("−6");
    expect(signedDelta(0.3)).toBe("0");
    expect(ratingBandOf(1250)).toBe("1200 이상");
    expect(ratingBandOf(1199.6)).toBe("1200 이상");
    expect(ratingBandOf(1100)).toBe("1100대");
    expect(ratingBandOf(1000)).toBe("1000대");
    expect(ratingBandOf(999.4)).toBe("900대");
    expect(ratingBandOf(899)).toBe("900 미만");
  });

  it("추이는 시작값부터, 많으면 솎되 마지막 점은 남긴다", () => {
    expect(ratingTrend([])).toEqual([]);
    const table = computeRatings([match(1), match(2, { winner: "B" })]);
    expect(ratingTrend(table.get("id0")!.history).map((p) => [p.game, Math.round(p.rating)])).toEqual([
      [0, 1000],
      [1, 1020],
      // 1020(팀 평균) 대 980에서 지면 −40 × E(1020, 980) ≈ −22.3
      [2, 998],
    ]);
    const long = Array.from({ length: 500 }, (_, i) => ({ matchId: `m${i}`, before: i, after: i + 1 }));
    const points = ratingTrend(long, 120);
    expect(points.length).toBeLessThanOrEqual(121);
    expect(points[points.length - 1]).toEqual({ game: 500, rating: 500 });
  });
});

describe("랭킹: 레이팅 순", () => {
  const nameOf = (id: string) => `선수${id.slice(2).padStart(2, "0")}`;
  const ids = (rows: { participantId: string }[]) => rows.map((r) => r.participantId);

  it("묶음(누적 50경기 이상 → 배치 완료 → 배치 진행 중) 안에서 레이팅 높은 순, 같으면 승률", () => {
    // 첫 경기에서 0~4 승, 둘째 경기에서 0·5·6·7·8이 1·2·3·4·9를 이긴다.
    const matches = [match(1), match(2, { teamA: [0, 5, 6, 7, 8], teamB: [1, 2, 3, 4, 9] })];
    const records = [...personRecords(matches).values()];
    const ratings = ratingValues(computeRatings(matches));
    const sorted = ids(sortRankingBy(records, placements(matches), nameOf, "rating", ratings));
    const values = sorted.map((id) => ratings.get(id)!);
    expect([...values].sort((a, b) => b - a)).toEqual(values);
    expect(sorted[0]).toBe("id0");
    expect(sorted[sorted.length - 1]).toBe("id9");
    // 묶음이 우선이다: 배치 완료한 사람이 레이팅이 낮아도 위.
    const placement = new Map([
      ["id9", { games: 12, done: true }],
      ["id0", { games: 2, done: false }],
    ]);
    expect(ids(sortRankingBy(records, placement, nameOf, "rating", ratings))[0]).toBe("id9");
    // 레이팅 표가 없으면 모두 1000으로 보고 승률 순.
    const noTable = ids(sortRankingBy(records, placements(matches), nameOf, "rating"));
    expect(noTable[0]).toBe("id0");
    // 검색해도 순위 숫자는 그대로.
    const all = rankAndSearch(records, placements(matches), nameOf, "rating", "", ratings);
    const searched = rankAndSearch(records, placements(matches), nameOf, "rating", "선수09", ratings);
    expect(searched.shown.map((r) => r.rank)).toEqual([all.ranked.find((r) => r.participantId === "id9")!.rank]);
  });
});
