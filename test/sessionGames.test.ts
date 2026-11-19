import { describe, expect, it } from "vitest";
import { playedSessions, sessionGames, sessionMates } from "../src/shared/sessionGames";
import type { MatchView, Position, Team } from "../src/shared/types";

// 그날 경기(두 사람 비교 "그날 경기")의 순서와 관계 판정을 확인한다.
// 기준 예시: 1경기 나·지수 같은 팀 → 2경기 나 쉼 → 3경기 상대 → 4경기 지수 쉼.

const POS: Position[] = ["top", "jungle", "mid", "adc", "support"];
const ME = "p0";
const JISU = "p1";

function match(
  matchNo: number,
  people: number[],
  teamA: number[],
  opts: { winner?: Team; playedAt?: string; sessionId?: string | null; state?: MatchView["state"] } = {},
): MatchView {
  let a = 0;
  let b = 0;
  return {
    id: `m${matchNo}`,
    matchNo,
    sessionId: opts.sessionId === undefined ? "s1" : opts.sessionId,
    state: opts.state ?? "confirmed",
    source: "live",
    startedAt: null,
    endedAt: null,
    playedAt: opts.playedAt ?? `2026-11-18T1${matchNo}:00:00.000Z`,
    confirmedAt: null,
    winnerTeam: opts.state === "awaiting_result" ? null : (opts.winner ?? "A"),
    teamASide: null,
    version: 1,
    roster: people.map((n) => {
      const team: Team = teamA.includes(n) ? "A" : "B";
      return { participantId: `p${n}`, team, position: POS[(team === "A" ? a++ : b++) % 5]! };
    }),
  } as MatchView;
}

const ten = (skip: number) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => n !== skip);

const evening: MatchView[] = [
  match(1, ten(10), [0, 1, 2, 3, 4]),
  match(2, ten(0), [1, 2, 3, 4, 5]),
  // 3경기는 B가 이겨서 나는 지고 지수는 이긴다.
  match(3, ten(10), [0, 2, 3, 4, 5], { winner: "B" }),
  // 자정을 넘긴 경기(한국 시각 0시 10분)도 같은 회차다.
  match(4, ten(1), [0, 2, 3, 4, 5], { playedAt: "2026-11-18T15:10:00.000Z" }),
];

describe("sessionGames", () => {
  it("내가 뛴 경기만 순서대로, 지수와는 같은 팀 → 상대 팀 → 함께 안 뜀", () => {
    const games = sessionGames(evening, "s1", ME, JISU);
    expect(games.map((g) => [g.match.matchNo, g.relation, g.won])).toEqual([
      [1, "together", true],
      [3, "against", false],
      [4, "apart", true],
    ]);
  });

  it("상대를 고르지 않으면 관계는 비워 둔다", () => {
    expect(sessionGames(evening, "s1", ME, null).map((g) => g.relation)).toEqual([null, null, null]);
  });

  it("지수 쪽에서 보면 3경기는 이긴 경기다", () => {
    const games = sessionGames(evening, "s1", JISU, ME);
    expect(games.map((g) => [g.match.matchNo, g.relation, g.won])).toEqual([
      [1, "together", true],
      [2, "apart", true],
      [3, "against", true],
    ]);
  });

  it("결과 대기·취소 경기는 순서에 넣지 않는다", () => {
    const withPending = [
      ...evening,
      match(5, ten(10), [0, 1, 2, 3, 4], { state: "awaiting_result", playedAt: "2026-11-18T16:00:00.000Z" }),
      match(6, ten(10), [0, 1, 2, 3, 4], { state: "canceled", playedAt: "2026-11-18T16:30:00.000Z" }),
    ];
    expect(sessionGames(withPending, "s1", ME, JISU).map((g) => g.match.matchNo)).toEqual([1, 3, 4]);
  });

  it("정정된 결과가 들어오면 새 판정을 따른다", () => {
    const fixed = evening.map((m) => (m.matchNo === 3 ? { ...m, winnerTeam: "A" as Team } : m));
    expect(sessionGames(fixed, "s1", ME, JISU)[1]!.won).toBe(true);
  });
});

describe("playedSessions", () => {
  // 회차가 없는 가져오기 경기 둘은 같은 날이어도 어느 회차로도 묶지 않는다.
  const imported = [
    match(7, ten(10), [0, 1, 2, 3, 4], { sessionId: null, playedAt: "2026-11-10T10:00:00.000Z" }),
    match(8, ten(10), [0, 2, 3, 4, 5], { sessionId: null, playedAt: "2026-11-10T11:00:00.000Z" }),
  ];
  const later = match(9, ten(1), [0, 2, 3, 4, 5], { sessionId: "s2", playedAt: "2026-11-25T10:00:00.000Z" });
  const all = [...imported, ...evening, later];

  it("최근 회차부터, 모임 경기 수와 내 경기 수를 센다", () => {
    expect(playedSessions(all, ME)).toEqual([
      { sessionId: "s2", startedAt: "2026-11-25T10:00:00.000Z", sessionGames: 1, myGames: 1 },
      { sessionId: "s1", startedAt: "2026-11-18T11:00:00.000Z", sessionGames: 4, myGames: 3 },
    ]);
  });

  it("다른 사람을 주면 같은 경기에 함께 들어간 회차만 남긴다", () => {
    expect(playedSessions(all, ME, JISU).map((s) => s.sessionId)).toEqual(["s1"]);
  });
});

describe("sessionMates", () => {
  it("그 회차에서 나와 같은 경기에 들어간 사람만", () => {
    const mates = sessionMates(evening, "s1", ME);
    expect(mates).toContain(JISU);
    expect(mates).toContain("p10");
    expect(mates).not.toContain(ME);
    expect(mates).toHaveLength(10);
  });
});
