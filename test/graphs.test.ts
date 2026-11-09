import { describe, expect, it } from "vitest";
import { attendanceReport } from "../src/shared/attendance";
import {
  activityCalendar,
  addDays,
  calendarLevel,
  calendarRange,
  dailyCounts,
  groupLineTotals,
  lineShape,
  raceDrawable,
  rankRace,
  RACE_DAY_BUCKET_OVER,
  ratingRank,
  storyCards,
  weekdayOf,
} from "../src/shared/graphs";
import { computeRatings } from "../src/shared/rating";
import { playerLineMatrix } from "../src/shared/stats";
import type { MatchView, Position, Team } from "../src/shared/types";
import { matchExpectations } from "../src/shared/upset";

// 경기는 match()로 만든다: 기본 팀 A = p0~p4, 팀 B = p5~p9, 라인은 팀 안 순서대로 탑·정글·미드·원딜·서폿,
// 시각은 2026-10-01 + 번호 시간(UTC). 이름은 nameOf로 "사람00"처럼 두 자리라 이름순 = 번호순이다.

const TZ = "Asia/Seoul";
const LINES: Position[] = ["top", "jungle", "mid", "adc", "support"];

interface Options {
  winner?: Team;
  teamA?: number[];
  teamB?: number[];
  /** 경기 시각(ISO). 없으면 2026-10-01 + no시간. */
  at?: string;
  state?: MatchView["state"];
}

function match(no: number, options: Options = {}): MatchView {
  const teamA = options.teamA ?? [0, 1, 2, 3, 4];
  const teamB = options.teamB ?? [5, 6, 7, 8, 9];
  const state = options.state ?? "confirmed";
  const playedAt = options.at ?? new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: null,
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: state === "confirmed" ? (options.winner ?? "A") : null,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((i, k) => ({ participantId: `p${i}`, team: "A" as const, position: LINES[k] ?? null })),
      ...teamB.map((i, k) => ({ participantId: `p${i}`, team: "B" as const, position: LINES[k] ?? null })),
    ],
  };
}

const range = (n: number, f: (i: number) => MatchView) => Array.from({ length: n }, (_, i) => f(i + 1));
const nameOf = (id: string) => `사람${id.slice(1).padStart(2, "0")}`;

describe("ratingRank", () => {
  it("배치를 마친 사람끼리 MMR 순위를 매기고 배치 중이면 null", () => {
    const matches = [...range(10, (i) => match(i)), match(11, { teamA: [0, 1, 2, 3, 10], teamB: [5, 6, 7, 8, 9] })];
    const table = computeRatings(matches);
    expect(ratingRank(table, "p0")).toEqual({ rank: 1, total: 10 });
    expect(ratingRank(table, "p10")).toBeNull();
    // 팀 B(전패)는 아래쪽.
    expect(ratingRank(table, "p9")!.rank).toBeGreaterThan(5);
  });
});

describe("rankRace", () => {
  it("배치 전에는 순위가 없고, 경기 단위로 시점을 만든다", () => {
    const matches = range(12, (i) => match(i, { winner: i % 3 === 0 ? "B" : "A" }));
    const race = rankRace(matches, computeRatings(matches), matches, TZ);
    expect(race.unit).toBe("match");
    expect(race.labels).toHaveLength(12);
    expect(race.labels[0]).toBe("1경기째");
    const s = race.series.find((x) => x.participantId === "p0")!;
    expect(s.ranks.slice(0, 9).every((r) => r === null)).toBe(true);
    expect(s.ranks[9]).not.toBeNull();
    expect(race.maxRank).toBe(10);
    // 마지막 순위순으로 정렬된다.
    expect(race.series[0]!.finalRank).toBe(1);
    expect(raceDrawable(race)).toBe(true);
  });

  it("범위가 일부여도 MMR·배치는 누적으로 센다", () => {
    const matches = range(14, (i) => match(i));
    const scoped = matches.slice(10);
    const race = rankRace(matches, computeRatings(matches), scoped, TZ);
    expect(race.games).toBe(4);
    expect(race.series.every((s) => s.ranks.every((r) => r !== null))).toBe(true);
    // 경기가 10개 미만이라 그리지 않는다.
    expect(raceDrawable(race)).toBe(false);
  });

  it("경기가 많으면 모임 날 단위로 묶는다", () => {
    const n = RACE_DAY_BUCKET_OVER + 10;
    // 하루 10경기씩(한국 시각 낮).
    const matches = range(n, (i) =>
      match(i, { at: new Date(Date.UTC(2026, 9, 1 + Math.floor((i - 1) / 10), 3) + i * 60_000).toISOString() }),
    );
    const race = rankRace(matches, computeRatings(matches), matches, TZ);
    expect(race.unit).toBe("day");
    expect(race.labels).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("결과 대기 경기는 시점이 아니다", () => {
    const matches = [...range(10, (i) => match(i)), match(11, { state: "awaiting_result" })];
    const race = rankRace(matches, computeRatings(matches), matches, TZ);
    expect(race.labels).toHaveLength(10);
  });
});

describe("lineShape · groupLineTotals", () => {
  it("승률은 5경기 미만을 중심으로 당기고, 경기 수는 가장 많은 라인 기준", () => {
    const row = { top: { games: 10, wins: 7 }, mid: { games: 2, wins: 2 } };
    const rate = lineShape(row, "rate");
    expect(rate.map((a) => a.position)).toEqual(LINES);
    expect(rate[0]).toMatchObject({ value: 0.7, weak: false });
    expect(rate[2]).toMatchObject({ value: 0.4, weak: true, games: 2 });
    expect(rate[1]).toMatchObject({ value: 0, weak: true, games: 0 });
    const games = lineShape(row, "games");
    expect(games[0]!.value).toBe(1);
    expect(games[2]!.value).toBe(0.2);
    expect(lineShape({}, "games").every((a) => a.value === 0)).toBe(true);
  });
  it("모임 전체 라인별 합", () => {
    const totals = groupLineTotals(playerLineMatrix(range(3, (i) => match(i))));
    expect(totals.top).toEqual({ games: 6, wins: 3 });
  });
});

describe("activity calendar", () => {
  it("요일과 날짜 더하기", () => {
    expect(weekdayOf("2026-11-09")).toBe(0); // 월
    expect(weekdayOf("2026-11-08")).toBe(6); // 일
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
  it("경기 수 단계: 0 · 1~2 · 3~5 · 6~9 · 10+", () => {
    expect([0, 1, 2, 3, 5, 6, 9, 10, 30].map(calendarLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it("월요일 시작 주로 나누고 범위 밖 칸을 채운다, 요약을 낸다", () => {
    const counts = new Map([
      ["2026-11-07", 4],
      ["2026-11-03", 2],
      ["2026-10-31", 6],
    ]);
    const cal = activityCalendar(counts, "2026-10-28", "2026-11-08");
    expect(cal.weeks.every((w) => w.length === 7)).toBe(true);
    expect(cal.weeks[0]![0]!.date).toBe("2026-10-26");
    expect(cal.weeks[0]![0]!.outside).toBe(true);
    expect(cal.weeks[cal.weeks.length - 1]![6]!.date).toBe("2026-11-08");
    expect(cal.activeDays).toBe(3);
    expect(cal.total).toBe(12);
    expect(cal.busiestWeekday).toBe(5); // 토(6 + 4)
    expect(cal.avgPerDay).toBe(4);
    expect(activityCalendar(new Map(), "2026-11-02", "2026-11-08").busiestWeekday).toBeNull();
  });
  it("날짜별 경기 수: 모임 시간대, 고른 사람만, 취소 제외", () => {
    const matches = [
      match(1, { at: "2026-11-07T16:00:00.000Z" }), // 한국 11-08
      match(2, { at: "2026-11-07T10:00:00.000Z" }),
      match(3, { at: "2026-11-07T11:00:00.000Z", teamA: [10, 1, 2, 3, 4] }),
      match(4, { at: "2026-11-07T12:00:00.000Z", state: "canceled" }),
    ];
    expect(dailyCounts(matches, TZ)).toEqual(new Map([["2026-11-08", 1], ["2026-11-07", 2]]));
    expect(dailyCounts(matches, TZ, "p0")).toEqual(new Map([["2026-11-08", 1], ["2026-11-07", 1]]));
  });
  it("범위별 기간", () => {
    expect(calendarRange({ kind: "year", year: 2025 }, "2026-11-09")).toEqual({ start: "2025-01-01", end: "2025-12-31" });
    expect(calendarRange({ kind: "season", startsOn: "2026-07-01", endsOn: "2026-08-31" }, "2026-11-09")).toEqual({
      start: "2026-07-01",
      end: "2026-08-31",
    });
    const all = calendarRange({ kind: "all" }, "2026-11-09");
    expect(all.end).toBe("2026-11-09");
    expect(addDays(all.start, 26 * 7 - 1)).toBe("2026-11-09");
  });
});

describe("storyCards", () => {
  const input = (matches: MatchView[], picked: string | null = null) => ({
    scoped: matches,
    expectations: matchExpectations(matches),
    attendance: attendanceReport(matches, TZ),
    ratings: computeRatings(matches),
    nameOf,
    picked,
  });

  it("경기가 5개 미만이면 없다", () => {
    expect(storyCards(input(range(4, (i) => match(i))))).toEqual([]);
  });

  it("연승·뭉친 플레이어·출전·MMR 상승, 최대 4개", () => {
    const cards = storyCards(input(range(6, (i) => match(i))));
    expect(cards.map((c) => c.kind)).toEqual(["streak", "pair", "attendance", "rating"]);
    expect(cards[0]!.text).toBe("사람00 6연승");
    expect(cards[1]!.text).toBe("사람00·사람01 같은 팀 6회");
    expect(cards[2]!.text).toBe("사람00 1일 출전");
    expect(cards[3]!.text).toMatch(/^사람00 \+\d+$/);
  });

  it("최대 이변: 이긴 팀 이름 두 명 + 외 n명, 예상 승률", () => {
    // A가 12번 이겨 MMR이 벌어진 뒤 B가 이긴다.
    const matches = [...range(12, (i) => match(i)), match(13, { winner: "B" })];
    const cards = storyCards(input(matches, "p7"));
    const upset = cards.find((c) => c.kind === "upset")!;
    const e = matchExpectations(matches).get("m13")!;
    expect(e.upset).toBe(true);
    expect(upset.text).toBe(`사람07·사람05 외 3명 예상 ${Math.round((1 - e.surprise) * 100)}%에서 승리`);
    // 고른 사람이 나온 문장이 맨 앞이다.
    expect(cards[0]!.kind).toBe("upset");
    expect(upset.people[0]).toBe("p7");
  });
});
