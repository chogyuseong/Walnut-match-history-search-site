import { describe, expect, it } from "vitest";
import {
  anchorRecord,
  countedChronological,
  cumulativeTrend,
  dayRecords,
  EMPTY_FILTER,
  filterMatches,
  headToHead,
  isFilterActive,
  lineRanking,
  mainLine,
  matchesWithoutPositions,
  participation,
  personForms,
  pickPair,
  rankAndSearch,
  recentResults,
  resultsOf,
  sortRankingBy,
  streakOf,
  trends,
  winnerSideOf,
} from "../src/shared/insights";
import { personDetail, personRecords, placements, sortRanking } from "../src/shared/stats";
import type { MatchView, Position, Side, Team } from "../src/shared/types";

// 전적 사이트 화면이 쓰는 계산(연승·최근 흐름·라인별 랭킹·맞대결·추이·경기 거르기)을 확인한다.

const POS: Position[] = ["top", "jungle", "mid", "adc", "support"];

interface MatchOptions {
  winner?: Team;
  /** 팀 A의 진영. */
  side?: Side;
  state?: MatchView["state"];
  playedAt?: string;
  sessionId?: string | null;
  positions?: boolean;
  /** 팀 A 참가자 번호 5개. 나머지(0~9 중)는 팀 B. */
  teamA?: number[];
  /** 10명 전체 번호(기본 0~9). */
  people?: number[];
}

function match(no: number, options: MatchOptions = {}): MatchView {
  const people = options.people ?? Array.from({ length: 10 }, (_, i) => i);
  const teamA = options.teamA ?? people.slice(0, 5);
  const teamB = people.filter((i) => !teamA.includes(i));
  const state = options.state ?? "confirmed";
  const playedAt = options.playedAt ?? new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  const confirmedLike = state === "confirmed" || state === "excluded";
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: options.sessionId === undefined ? "s1" : options.sessionId,
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: confirmedLike ? playedAt : null,
    winnerTeam: confirmedLike ? (options.winner ?? "A") : null,
    teamASide: confirmedLike ? (options.side ?? "unknown") : null,
    version: 1,
    roster: [
      ...teamA.map((i, k) => ({
        participantId: `id${i}`,
        team: "A" as const,
        position: options.positions === false ? null : POS[k]!,
      })),
      ...teamB.map((i, k) => ({
        participantId: `id${i}`,
        team: "B" as const,
        position: options.positions === false ? null : POS[k]!,
      })),
    ],
  };
}

const nameOf = (id: string) => `선수${id.slice(2).padStart(2, "0")}`;

describe("연승·연패", () => {
  it("끊기면 새로 센다. 현재·최다 연승과 최다 연패", () => {
    expect(streakOf([true, true, false, true, true, true])).toEqual({
      currentStreak: 3,
      longestWinStreak: 3,
      longestLoseStreak: 1,
    });
    expect(streakOf([true, false, false, false])).toEqual({
      currentStreak: -3,
      longestWinStreak: 1,
      longestLoseStreak: 3,
    });
    expect(streakOf([])).toEqual({ currentStreak: 0, longestWinStreak: 0, longestLoseStreak: 0 });
  });

  it("대기·진행 중·취소·제외 경기는 건너뛰고 연승을 끊지 않는다", () => {
    // id0(팀 A)은 1·2·4·6경기 승. 3(제외, 패), 5(결과 미입력), 7(취소), 8(진행 중)은 세지 않는다.
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "A" }),
      match(3, { winner: "B", state: "excluded" }),
      match(4, { winner: "A" }),
      match(5, { state: "awaiting_result" }),
      match(6, { winner: "A" }),
      match(7, { state: "canceled" }),
      match(8, { state: "in_progress" }),
    ];
    const form = personForms(matches).get("id0")!;
    expect(form.results).toEqual([true, true, true, true]);
    expect(form.currentStreak).toBe(4);
    expect(personForms(matches).get("id5")!.currentStreak).toBe(-4);
  });

  it("경기 시각 순서로 센다. 같은 시각이면 경기 번호 순서다", () => {
    const t = "2026-10-01T12:00:00.000Z";
    // 번호는 뒤섞였지만 시각 순서: 10(승) → 3(패) → [같은 시각 5(패), 6(승)].
    const matches = [
      match(6, { winner: "A", playedAt: t }),
      match(3, { winner: "B", playedAt: "2026-09-30T12:00:00.000Z" }),
      match(5, { winner: "B", playedAt: t }),
      match(10, { winner: "A", playedAt: "2026-09-01T12:00:00.000Z" }),
    ];
    expect(countedChronological(matches).map((m) => m.matchNo)).toEqual([10, 3, 5, 6]);
    const form = personForms(matches).get("id0")!;
    expect(form.results).toEqual([true, false, false, true]);
    expect(form.currentStreak).toBe(1);
    expect(form.longestLoseStreak).toBe(2);
    // stats.personDetail과 같은 값이다.
    const detail = personDetail(matches, "id0", nameOf);
    expect(detail.currentStreak).toBe(form.currentStreak);
    expect(detail.longestLoseStreak).toBe(form.longestLoseStreak);
    expect(resultsOf(matches, "id0")).toEqual(form.results);
  });

  it("라인을 주면 그 라인으로 뛴 경기만 센다", () => {
    // id0은 1·2경기 탑(승·패), 3경기는 정글(승). 탑 기준 연속은 1연패.
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "B" }),
      match(3, { winner: "A", teamA: [1, 0, 2, 3, 4] }),
    ];
    expect(personForms(matches, "top").get("id0")!.results).toEqual([true, false]);
    expect(personForms(matches, "top").get("id0")!.currentStreak).toBe(-1);
    expect(personForms(matches, "jungle").get("id0")!.results).toEqual([true]);
  });
});

describe("최근 흐름", () => {
  it("최근 5경기, 최근 것이 앞", () => {
    const results = [true, false, true, true, false, false, true];
    const form = { results, ...streakOf(results) };
    expect(recentResults(form)).toEqual([true, false, false, true, true]);
    expect(recentResults(form, 3)).toEqual([true, false, false]);
    expect(recentResults(undefined)).toEqual([]);
    // 경기가 5개보다 적으면 있는 만큼만
    expect(recentResults({ results: [false, true], ...streakOf([false, true]) })).toEqual([true, false]);
  });
});

describe("랭킹 정렬 기준", () => {
  // id0: 4경기 3승, id1: 10경기 6승, id2: 2경기 2승, id3: 10경기 7승 (id1·id3만 배치 완료)
  const records = [
    { participantId: "id0", games: 4, wins: 3, losses: 1 },
    { participantId: "id1", games: 10, wins: 6, losses: 4 },
    { participantId: "id2", games: 2, wins: 2, losses: 0 },
    { participantId: "id3", games: 10, wins: 7, losses: 3 },
  ];
  const placement = new Map([
    ["id0", { games: 4, done: false }],
    ["id1", { games: 10, done: true }],
    ["id2", { games: 2, done: false }],
    ["id3", { games: 10, done: true }],
  ]);
  const ids = (rows: { participantId: string }[]) => rows.map((r) => r.participantId);

  it("승률(기본): 배치 완료 먼저, 그 안에서 승률. stats.sortRanking과 같다", () => {
    expect(ids(sortRankingBy(records, placement, nameOf, "rate"))).toEqual(["id3", "id1", "id2", "id0"]);
    expect(ids(sortRankingBy(records, placement, nameOf, "rate"))).toEqual(
      ids(sortRanking([...records], placement, nameOf)),
    );
  });

  it("경기 수: 배치 완료 먼저, 경기 수 → 승률", () => {
    expect(ids(sortRankingBy(records, placement, nameOf, "games"))).toEqual(["id3", "id1", "id0", "id2"]);
  });

  it("승수: 배치 완료 먼저, 승수 → 승률", () => {
    expect(ids(sortRankingBy(records, placement, nameOf, "wins"))).toEqual(["id3", "id1", "id0", "id2"]);
    // 승수가 같으면 승률 → 경기 수 → 이름
    const tie = [
      { participantId: "id5", games: 6, wins: 3, losses: 3 },
      { participantId: "id4", games: 4, wins: 3, losses: 1 },
      { participantId: "id6", games: 4, wins: 3, losses: 1 },
    ];
    expect(ids(sortRankingBy(tie, new Map(), nameOf, "wins"))).toEqual(["id4", "id6", "id5"]);
  });

  it("검색은 순위 숫자를 바꾸지 않는다(어느 정렬 기준이든)", () => {
    for (const sort of ["rate", "games", "wins"] as const) {
      const all = rankAndSearch(records, placement, nameOf, sort, "");
      const searched = rankAndSearch(records, placement, nameOf, sort, "선수00");
      expect(searched.shown).toHaveLength(1);
      expect(searched.shown[0]!.rank).toBe(all.ranked.find((r) => r.participantId === "id0")!.rank);
      expect(searched.ranked.map((r) => r.rank)).toEqual(all.ranked.map((r) => r.rank));
    }
    const rate = rankAndSearch(records, placement, nameOf, "rate", "선수0");
    // 일치도 순으로 보여주지만 숫자는 전체 순위 그대로
    expect(rate.shown.map((r) => [r.participantId, r.rank])).toEqual([
      ["id0", 4],
      ["id1", 2],
      ["id2", 3],
      ["id3", 1],
    ]);
  });
});

describe("라인별 랭킹", () => {
  it("그 라인으로 뛴 경기만 센다. 포지션 없는 경기는 어느 라인에도 들어가지 않는다", () => {
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "B", teamA: [1, 0, 2, 3, 4] }), // id0 정글
      match(3, { winner: "A", positions: false }), // 일괄 입력분: 포지션 없음
      match(4, { winner: "A", state: "awaiting_result" }),
    ];
    const top = new Map(lineRanking(matches, "top").map((r) => [r.participantId, r]));
    expect(top.get("id0")).toEqual({ participantId: "id0", games: 1, wins: 1, losses: 0 });
    expect(top.get("id1")).toEqual({ participantId: "id1", games: 1, wins: 0, losses: 1 });
    const jungle = new Map(lineRanking(matches, "jungle").map((r) => [r.participantId, r]));
    expect(jungle.get("id0")).toEqual({ participantId: "id0", games: 1, wins: 0, losses: 1 });
    // 전체 라인은 포지션 없는 경기도 센다(3경기). 대기 경기는 세지 않는다.
    const all = new Map(lineRanking(matches, null).map((r) => [r.participantId, r]));
    expect(all.get("id0")!.games).toBe(3);
    expect(matchesWithoutPositions(matches)).toBe(1);
  });

  it("한 사람의 라인 경기 수 합 + 포지션 없는 경기 = 전체 경기 수", () => {
    const matches = [
      match(1),
      match(2, { teamA: [1, 0, 2, 3, 4] }),
      match(3, { positions: false }),
      match(4, { teamA: [2, 1, 0, 3, 4], winner: "B" }),
    ];
    const total = (["top", "jungle", "mid", "adc", "support"] as const)
      .map((p) => lineRanking(matches, p).find((r) => r.participantId === "id0")?.games ?? 0)
      .reduce((a, b) => a + b, 0);
    expect(total + 1).toBe(personRecords(matches).get("id0")!.games);
  });
});

describe("맞대결·같은 팀 전적", () => {
  it("같은 팀일 때 승패와 상대일 때 누가 몇 승인지", () => {
    const matches = [
      match(1, { winner: "A" }), // id0·id1 같은 팀 승
      match(2, { winner: "B" }), // 같은 팀 패
      match(3, { winner: "A", teamA: [0, 2, 3, 4, 5] }), // id0(A) vs id1(B): id0 승
      match(4, { winner: "B", teamA: [0, 2, 3, 4, 5] }), // id1 승
      match(5, { winner: "B", teamA: [0, 2, 3, 4, 5] }), // id1 승
      match(6, { winner: "A", teamA: [0, 2, 3, 4, 5], state: "excluded" }), // 세지 않음
      match(7, { teamA: [0, 2, 3, 4, 5], state: "awaiting_result" }), // 세지 않음
      match(8, { people: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), // id1 없음
    ];
    const h = headToHead(matches, "id0", "id1");
    expect(h.together).toEqual({ games: 2, wins: 1 });
    expect(h.against).toEqual({ games: 3, aWins: 1, bWins: 2 });
    expect(h.againstMatches.map((m) => m.matchNo)).toEqual([5, 4, 3]);
    expect(h.togetherMatches.map((m) => m.matchNo)).toEqual([2, 1]);
    // 반대로 물으면 숫자도 반대다.
    const r = headToHead(matches, "id1", "id0");
    expect(r.against).toEqual({ games: 3, aWins: 2, bWins: 1 });
    // personDetail의 시너지·상대 전적과 같다.
    const detail = personDetail(matches, "id0", nameOf);
    expect(detail.synergy.find((p) => p.participantId === "id1")).toMatchObject({ games: 2, wins: 1 });
    expect(detail.versus.find((p) => p.participantId === "id1")).toMatchObject({ games: 3, wins: 1 });
  });

  it("같은 사람끼리는 비교하지 않는다", () => {
    expect(headToHead([match(1)], "id0", "id0").together.games).toBe(0);
  });
});

describe("개인 요약", () => {
  it("주 라인: 가장 많이 뛴 라인, 같으면 승이 많은 라인", () => {
    expect(mainLine({})).toBeNull();
    expect(mainLine({ mid: { games: 3, wins: 1 }, top: { games: 5, wins: 1 } })).toEqual({
      position: "top",
      tally: { games: 5, wins: 1 },
    });
    expect(mainLine({ mid: { games: 3, wins: 2 }, top: { games: 3, wins: 1 } })!.position).toBe("mid");
  });

  it("동료·상대는 5경기 이상만. 같은 승률이면 경기 수가 많은 쪽", () => {
    const pairs = [
      { participantId: "a", games: 4, wins: 4 }, // 표본 부족
      { participantId: "b", games: 5, wins: 4 }, // 80%
      { participantId: "c", games: 10, wins: 8 }, // 80%, 경기 수 많음
      { participantId: "d", games: 6, wins: 1 },
    ];
    expect(pickPair(pairs, "best")!.participantId).toBe("c");
    expect(pickPair(pairs, "worst")!.participantId).toBe("d");
    expect(pickPair(pairs.slice(0, 1), "best")).toBeNull();
  });

  it("누적 승률 추이: 경기마다 그때까지의 승률, 많으면 솎되 마지막 점은 남긴다", () => {
    expect(cumulativeTrend([true, false, true, true])).toEqual([
      { game: 1, rate: 1 },
      { game: 2, rate: 0.5 },
      { game: 3, rate: 2 / 3 },
      { game: 4, rate: 0.75 },
    ]);
    const many = Array.from({ length: 2001 }, (_, i) => i % 3 !== 0);
    const points = cumulativeTrend(many, 120);
    expect(points.length).toBeLessThanOrEqual(121);
    expect(points[points.length - 1]!.game).toBe(2001);
    expect(points[points.length - 1]!.rate).toBeCloseTo(many.filter(Boolean).length / 2001);
  });
});

describe("요즘 흐름", () => {
  it("3연승 이상만, 최근 10경기를 채운 사람만, 오래 쉰 사람은 뺀다", () => {
    const matches: MatchView[] = [];
    // 1~12경기: 0~9가 뛰고 팀 A(0~4) 전승 → id0~4는 12연승, 최근 10경기 10승
    for (let i = 1; i <= 12; i++) matches.push(match(i, { winner: "A" }));
    // 13~45경기(33경기): 10~19만 뛴다 → 0~9는 모임의 최근 30경기에 없음
    for (let i = 13; i <= 45; i++) {
      matches.push(
        match(i, {
          people: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          winner: i >= 43 ? "A" : "B",
        }),
      );
    }
    const t = trends(matches, nameOf);
    // 0~9는 오래 쉬어 빠진다. 10~14는 마지막 3경기 승 → 3연승.
    expect(t.hotStreaks.map((r) => r.participantId)).toEqual(["id10", "id11", "id12"]);
    expect(t.hotStreaks.every((r) => r.streak === 3)).toBe(true);
    expect(t.recentBest.every((r) => r.recent.games === 10)).toBe(true);
    // 최근 10경기: id15~19는 7승 3패, id10~14는 3승 7패. 승이 같으면 연승(연패) → 이름 순.
    expect(t.recentBest.map((r) => [r.participantId, r.recent.wins])).toEqual([
      ["id15", 7],
      ["id16", 7],
      ["id17", 7],
    ]);
    // 기준 미달이면 빈 목록
    const few = trends([match(1), match(2)], nameOf);
    expect(few.hotStreaks).toEqual([]);
    expect(few.recentBest).toEqual([]);
  });
});

describe("경기 거르기", () => {
  const matches = [
    match(1, { winner: "A", side: "blue" }), // id0 탑 승, 블루 승
    match(2, { winner: "B", side: "blue" }), // id0 탑 패, 레드 승
    match(3, { winner: "A", side: "unknown", teamA: [0, 2, 3, 4, 5] }), // id0·id1 상대, id0 승, 미상
    match(4, { winner: "A", side: "red", people: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10] }), // id1 없음, 레드 승
    match(5, { state: "awaiting_result" }), // 결과 없음
    match(6, { winner: "A", teamA: [1, 0, 2, 3, 4] }), // id0 정글 승
  ];
  const nos = (list: MatchView[]) => list.map((m) => m.matchNo);

  it("조건이 없으면 그대로", () => {
    expect(nos(filterMatches(matches, EMPTY_FILTER))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("여러 명이면 모두 함께 뛴 경기만(AND)", () => {
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, people: ["id0"] }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, people: ["id0", "id1"] }))).toEqual([1, 2, 3, 5, 6]);
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, people: ["id1", "id10"] }))).toEqual([]);
  });

  it("라인·승패는 첫 번째 사람 기준이고, 사람이 없으면 적용하지 않는다", () => {
    const f = { ...EMPTY_FILTER, people: ["id0"], position: "top" as const };
    expect(nos(filterMatches(matches, f))).toEqual([1, 2, 3, 4, 5]);
    expect(nos(filterMatches(matches, { ...f, result: "win" }))).toEqual([1, 3, 4]);
    expect(nos(filterMatches(matches, { ...f, result: "loss" }))).toEqual([2]);
    // 기준이 id1이면 id1의 승패다(3경기에서 id1은 졌다).
    expect(
      nos(filterMatches(matches, { ...EMPTY_FILTER, people: ["id1", "id0"], result: "loss" })),
    ).toEqual([2, 3]);
    // 사람 없이 고른 라인·승패는 무시한다.
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, position: "mid", result: "win" }))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(isFilterActive({ ...EMPTY_FILTER, position: "mid" })).toBe(false);
  });

  it("이긴 팀의 진영: 블루 승·레드 승·미상. 결과 없는 경기는 빠진다", () => {
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, winnerSide: "blue" }))).toEqual([1]);
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, winnerSide: "red" }))).toEqual([2, 4]);
    expect(nos(filterMatches(matches, { ...EMPTY_FILTER, winnerSide: "unknown" }))).toEqual([3, 6]);
    expect(winnerSideOf(matches[4]!)).toBeNull();
  });

  it("거른 경기 안에서 기준인 사람의 승패(확정 경기만)", () => {
    const list = filterMatches(matches, { ...EMPTY_FILTER, people: ["id0"] });
    expect(anchorRecord(list, "id0")).toEqual({ games: 5, wins: 4 });
  });
});

describe("오늘의 결과·참가자 고르기", () => {
  it("개인 승패는 승 많은 순, 확정 경기만", () => {
    const rows = dayRecords([match(1, { winner: "A" }), match(2, { winner: "A" }), match(3, { state: "awaiting_result" })], nameOf);
    expect(rows[0]).toMatchObject({ wins: 2, losses: 0, games: 2 });
    expect(rows[rows.length - 1]).toMatchObject({ wins: 0, losses: 2 });
    expect(rows).toHaveLength(10);
  });

  it("누적 경기 수와 마지막 세션. 취소 경기는 세지 않는다", () => {
    const seen = participation([
      match(1, { sessionId: "s1", playedAt: "2026-10-01T10:00:00.000Z" }),
      match(2, { sessionId: "s2", playedAt: "2026-10-08T10:00:00.000Z", state: "awaiting_result" }),
      match(3, { sessionId: "s3", playedAt: "2026-10-09T10:00:00.000Z", state: "canceled" }),
    ]);
    expect(seen.get("id0")).toEqual({ games: 1, lastPlayedAt: "2026-10-08T10:00:00.000Z", lastSessionId: "s2" });
  });
});

describe("규모", () => {
  it("2000경기·30명에서도 계산이 빠르다", () => {
    const matches: MatchView[] = [];
    for (let i = 1; i <= 2000; i++) {
      const start = i % 20;
      const people = Array.from({ length: 10 }, (_, k) => (start + k * 3) % 30);
      matches.push(
        match(i, {
          people,
          winner: i % 3 === 0 ? "B" : "A",
          playedAt: new Date(Date.UTC(2024, 0, 1) + i * 3600_000).toISOString(),
          positions: i % 7 !== 0,
        }),
      );
    }
    const t0 = performance.now();
    const forms = personForms(matches);
    const ranked = rankAndSearch(lineRanking(matches, null), placements(matches), nameOf, "rate", "");
    trends(matches, nameOf);
    for (const r of ranked.ranked.slice(0, 5)) {
      personDetail(matches, r.participantId, nameOf);
      headToHead(matches, r.participantId, ranked.ranked[0]!.participantId);
    }
    filterMatches(matches, { ...EMPTY_FILTER, people: ["id0", "id3"], position: "top" });
    const ms = performance.now() - t0;
    expect(forms.size).toBe(30);
    expect(ms).toBeLessThan(1000);
  });
});
