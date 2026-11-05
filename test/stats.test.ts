import { describe, expect, it } from "vitest";
import {
  localDate,
  matchesInScope,
  personDetail,
  personRecords,
  personRecordsByLine,
  playerLineMatrix,
  sideTotals,
  placements,
  searchByName,
  sortRanking,
} from "../src/shared/stats";
import type { MatchView, Position, Side, Snapshot, Team } from "../src/shared/types";
import { api, playConfirmed, rosterOf, setupGroup, snapshot } from "./helpers";

// 괄호 안 번호는 docs/P4 P4-5의 검증 시나리오 번호다.

const POS: Position[] = ["top", "jungle", "mid", "adc", "support"];

interface MatchOptions {
  winner?: Team;
  /** 팀 A의 진영(승리 팀의 진영이 아니다). */
  side?: Side;
  state?: MatchView["state"];
  playedAt?: string;
  sessionId?: string;
  /** id0의 포지션. null이면 전원 포지션 없음. */
  positions?: boolean;
  /** 팀 A에 들어갈 참가자 번호 5개. 나머지는 팀 B. */
  teamA?: number[];
}

function match(no: number, options: MatchOptions = {}): MatchView {
  const teamA = options.teamA ?? [0, 1, 2, 3, 4];
  const teamB = Array.from({ length: 10 }, (_, i) => i).filter((i) => !teamA.includes(i));
  const state = options.state ?? "confirmed";
  const playedAt =
    options.playedAt ?? `2026-10-${String(1 + (no % 28)).padStart(2, "0")}T12:00:00.000Z`;
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: options.sessionId ?? "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: state === "confirmed" ? (options.winner ?? "A") : null,
    teamASide: state === "confirmed" ? (options.side ?? "unknown") : null,
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

function snap(matches: MatchView[], seasons: Snapshot["seasons"] = []): Snapshot {
  return {
    role: "viewer",
    serverTime: "2026-11-05T00:00:00.000Z",
    group: {
      id: "g",
      name: "모임",
      timezone: "Asia/Seoul",
      liveVersion: 0,
      settings: { rotationEnabled: true, groupsPublic: false, groupWeights: [0, 0, 0, 0] },
    },
    participants: Array.from({ length: 10 }, (_, i) => ({
      id: `id${i}`,
      name: `참가자${i}`,
      status: "active" as const,
    })),
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons,
  };
}

const nameOf = (id: string) => `참가자${id.slice(2)}`;

describe("범위 필터", () => {
  it("자정을 넘긴 경기도 모임 시간대의 날짜로 센다", () => {
    // UTC 10월 31일 16시는 한국 시간 11월 1일 01시다.
    expect(localDate("2026-10-31T16:00:00.000Z", "Asia/Seoul")).toBe("2026-11-01");
    expect(localDate("2026-10-31T14:00:00.000Z", "Asia/Seoul")).toBe("2026-10-31");
  });

  it("시즌 범위는 양 끝 날짜를 포함한다", () => {
    const s = snap(
      [
        match(1, { playedAt: "2026-09-30T14:00:00.000Z" }), // 한국 9/30 23시
        match(2, { playedAt: "2026-09-30T16:00:00.000Z" }), // 한국 10/1 01시
        match(3, { playedAt: "2026-10-31T14:00:00.000Z" }), // 한국 10/31 23시
        match(4, { playedAt: "2026-10-31T16:00:00.000Z" }), // 한국 11/1 01시
      ],
      [{ id: "s10", name: "10월", startsOn: "2026-10-01", endsOn: "2026-10-31" }],
    );
    const inSeason = matchesInScope(s, { kind: "season", seasonId: "s10" }).map((m) => m.matchNo);
    expect(inSeason).toEqual([2, 3]);
    expect(matchesInScope(s, { kind: "all" })).toHaveLength(4);
    expect(matchesInScope(s, { kind: "season", seasonId: "없는시즌" })).toEqual([]);
  });

  it("전체 100판·시즌 1판: 시즌 성적은 1판이고 배치는 누적 기준이다 (34)", () => {
    const all = [
      ...Array.from({ length: 99 }, (_, i) =>
        match(i + 1, { playedAt: "2026-08-10T03:00:00.000Z", winner: "A" }),
      ),
      match(100, { playedAt: "2026-10-10T03:00:00.000Z", winner: "B" }),
    ];
    const s = snap(all, [{ id: "s10", name: "10월", startsOn: "2026-10-01", endsOn: "2026-10-31" }]);
    const seasonMatches = matchesInScope(s, { kind: "season", seasonId: "s10" });
    const seasonRecord = personRecords(seasonMatches).get("id0");
    expect(seasonRecord).toMatchObject({ games: 1, wins: 0, losses: 1 });
    // 배치와 칭호의 근거는 시즌 필터와 무관하게 전체 누적이다.
    expect(placements(s.matches).get("id0")).toEqual({ games: 100, done: true });
  });

  it("취소된 경기는 어느 범위에도 없다", () => {
    const s = snap([match(1), match(2, { state: "canceled" })]);
    expect(matchesInScope(s, { kind: "all" }).map((m) => m.matchNo)).toEqual([1]);
  });
});

describe("개인 통계", () => {
  it("기록이 없는 라인은 0%가 아니라 항목 자체가 없다 (33)", () => {
    const tenGames = Array.from({ length: 10 }, (_, i) => match(i + 1));
    const detail = personDetail(tenGames, "id0", nameOf);
    expect(placements(tenGames).get("id0")?.done).toBe(true);
    expect(detail.byPosition.top).toEqual({ games: 10, wins: 10 });
    expect(detail.byPosition.support).toBeUndefined();
    expect(Object.keys(detail.byPosition)).toEqual(["top"]);
  });

  it("포지션 없는 경기는 라인별에서 빼고 몇 경기인지 알려준다", () => {
    const detail = personDetail([match(1), match(2, { positions: false })], "id0", nameOf);
    expect(detail.summary.games).toBe(2);
    expect(detail.byPosition.top).toEqual({ games: 1, wins: 1 });
    expect(detail.positionUnknown).toBe(1);
  });

  it("진영 미상 경기는 승패에 넣고 진영별에서만 뺀다", () => {
    const detail = personDetail(
      [
        match(1, { winner: "A", side: "blue" }), // 팀 A 블루 승
        match(2, { winner: "B", side: "red" }), // side는 팀 A의 진영이다. 팀 A 레드 패 → id0 레드 패
        match(3, { winner: "A", side: "unknown" }),
      ],
      "id0",
      nameOf,
    );
    expect(detail.summary).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(detail.bySide.blue).toEqual({ games: 1, wins: 1 });
    expect(detail.bySide.red).toEqual({ games: 1, wins: 0 });
    expect(detail.sideUnknown).toBe(1);
  });

  it("최근 10·20은 범위 안에서 세고 실제 집계 수를 돌려준다", () => {
    const seven = Array.from({ length: 7 }, (_, i) => match(i + 1, { winner: i < 4 ? "A" : "B" }));
    const detail = personDetail(seven, "id0", nameOf);
    expect(detail.recent10).toEqual({ games: 7, wins: 4 });
    expect(detail.recent20).toEqual({ games: 7, wins: 4 });
    const many = Array.from({ length: 25 }, (_, i) => match(i + 1, { winner: i < 15 ? "B" : "A" }));
    const longer = personDetail(many, "id0", nameOf);
    expect(longer.recent10).toEqual({ games: 10, wins: 10 });
    expect(longer.recent20).toEqual({ games: 20, wins: 10 });
  });

  it("연승·연패를 센다", () => {
    const order: Team[] = ["A", "A", "A", "B", "B", "A", "B", "B", "B", "B"];
    const detail = personDetail(
      order.map((winner, i) => match(i + 1, { winner })),
      "id0",
      nameOf,
    );
    expect(detail.longestWinStreak).toBe(3);
    expect(detail.longestLoseStreak).toBe(4);
    expect(detail.currentStreak).toBe(-4);
  });

  it("시너지와 상대 전적은 함께한 경기 수순이고 경기 수를 함께 준다", () => {
    const detail = personDetail(
      [
        match(1, { teamA: [0, 1, 2, 3, 4], winner: "A" }),
        match(2, { teamA: [0, 1, 5, 6, 7], winner: "B" }),
        match(3, { teamA: [0, 1, 2, 8, 9], winner: "A" }),
      ],
      "id0",
      nameOf,
    );
    expect(detail.synergy[0]).toEqual({ participantId: "id1", games: 3, wins: 2 });
    expect(detail.synergy[1]).toEqual({ participantId: "id2", games: 2, wins: 2 });
    const vs5 = detail.versus.find((v) => v.participantId === "id5");
    expect(vs5).toEqual({ participantId: "id5", games: 2, wins: 2 });
    // 같은 팀이었던 경기는 상대 전적에 넣지 않는다.
    const vs2 = detail.versus.find((v) => v.participantId === "id2");
    expect(vs2).toEqual({ participantId: "id2", games: 1, wins: 0 });
  });

  it("대기·제외 경기는 참여 경기와 성적에 들어가지 않는다", () => {
    const detail = personDetail(
      [match(1), match(2, { state: "awaiting_result" }), match(3, { state: "excluded" })],
      "id0",
      nameOf,
    );
    expect(detail.summary.games).toBe(1);
    expect(detail.matches.map((m) => m.matchNo)).toEqual([1]);
  });
});

describe("순위와 검색 (35)", () => {
  it("순위는 배치 완료자를 먼저 두고 그 안에서 승률순이다", () => {
    const records = [
      { participantId: "id1", games: 3, wins: 3, losses: 0 }, // 배치 중, 승률 100%
      { participantId: "id2", games: 12, wins: 6, losses: 6 }, // 배치 완료, 50%
      { participantId: "id3", games: 20, wins: 14, losses: 6 }, // 배치 완료, 70%
    ];
    const placement = new Map([
      ["id1", { games: 3, done: false }],
      ["id2", { games: 12, done: true }],
      ["id3", { games: 20, done: true }],
    ]);
    const ranked = sortRanking(records, placement, nameOf).map((r) => r.participantId);
    expect(ranked).toEqual(["id3", "id2", "id1"]);
  });

  it("동률은 경기 수 많은 순, 그다음 이름순이다", () => {
    const records = [
      { participantId: "id2", games: 10, wins: 5, losses: 5 },
      { participantId: "id1", games: 10, wins: 5, losses: 5 },
      { participantId: "id3", games: 20, wins: 10, losses: 10 },
    ];
    const placement = new Map(records.map((r) => [r.participantId, { games: r.games, done: true }]));
    expect(sortRanking(records, placement, nameOf).map((r) => r.participantId)).toEqual([
      "id3",
      "id1",
      "id2",
    ]);
  });

  it("이름 검색은 일치도 순이고 배치 여부로 순서를 바꾸지 않는다", () => {
    const people = [{ name: "김용호의친구" }, { name: "용호" }, { name: "김용호" }, { name: "조규성" }];
    expect(searchByName(people, "김용호").map((p) => p.name)).toEqual(["김용호", "김용호의친구"]);
    expect(searchByName(people, "용호").map((p) => p.name)).toEqual([
      "용호",
      "김용호",
      "김용호의친구",
    ]);
    expect(searchByName(people, "  ")).toHaveLength(4);
    expect(searchByName(people, "없는이름")).toEqual([]);
  });
});

describe("시즌 (서버)", () => {
  it("만들고, 겹치면 거절하고, 조회자에게도 보인다", async () => {
    const g = await setupGroup();
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "10월 시즌",
      startsOn: "2026-10-01",
      endsOn: "2026-10-31",
    });
    expect(created.status).toBe(200);
    const overlap = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "겹치는 시즌",
      startsOn: "2026-10-31",
      endsOn: "2026-11-30",
    });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe("SEASON_OVERLAP");
    const next = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "11월 시즌",
      startsOn: "2026-11-01",
      endsOn: "2026-11-30",
    });
    expect(next.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.seasons.map((s) => s.name)).toEqual(["10월 시즌", "11월 시즌"]);
    const view = await api(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(view.body.seasons).toHaveLength(2);
  });

  it("잘못된 날짜와 뒤집힌 범위를 거절한다", async () => {
    const g = await setupGroup(1);
    const bad = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "없는 날짜",
      startsOn: "2026-02-31",
      endsOn: "2026-03-10",
    });
    expect(bad.status).toBe(400);
    const reversed = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "뒤집힘",
      startsOn: "2026-03-10",
      endsOn: "2026-03-01",
    });
    expect(reversed.status).toBe(400);
  });

  it("시즌을 지워도 경기는 그대로이고 다른 모임의 시즌은 지울 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup(1);
    await playConfirmed(g, rosterOf(g.people));
    const season = await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
      name: "시즌",
      startsOn: "2026-01-01",
      endsOn: "2026-12-31",
    });
    const before = await snapshot(g);
    // 다른 모임 운영자가 자기 모임 주소로 이 시즌 ID를 지우려 해도 지워지지 않는다.
    await api(other.cookie, "DELETE", `/api/groups/${other.gid}/seasons/${season.body.id}`);
    expect((await snapshot(g)).seasons).toHaveLength(1);
    const denied = await api(other.cookie, "DELETE", `/api/groups/${g.gid}/seasons/${season.body.id}`);
    expect(denied.status).toBe(404);

    const deleted = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/seasons/${season.body.id}`);
    expect(deleted.status).toBe(200);
    const after = await snapshot(g);
    expect(after.seasons).toHaveLength(0);
    expect(after.matches).toEqual(before.matches);
  });
});

describe("그래프 분석용 집계", () => {
  it("라인으로 좁히면 그 라인을 맡은 경기만 센다", () => {
    const matches = [match(1, { winner: "A" }), match(2, { winner: "B" }), match(3, { positions: false })];
    const top = personRecordsByLine(matches, "top");
    // 탑은 팀 A의 id0과 팀 B의 id5다. 포지션 없는 3경기는 들어가지 않는다.
    expect([...top.keys()].sort()).toEqual(["id0", "id5"]);
    expect(top.get("id0")).toMatchObject({ games: 2, wins: 1, losses: 1 });
    expect(personRecordsByLine(matches, null).get("id0")).toMatchObject({ games: 3 });
  });

  it("진영별 누적은 진영을 아는 경기만 세고 미상 경기 수를 돌려준다", () => {
    const totals = sideTotals([
      match(1, { winner: "A", side: "blue" }), // 블루 승
      match(2, { winner: "B", side: "blue" }), // 팀 B(레드) 승
      match(3, { winner: "A", side: "red" }), // 팀 A(레드) 승
      match(4, { winner: "A", side: "unknown" }),
      match(5, { state: "awaiting_result" }),
    ]);
    expect(totals).toEqual({ known: 3, blueWins: 1, redWins: 2, unknown: 1 });
    // 블루 승과 레드 승을 더하면 진영을 아는 경기 수와 같다.
    expect(totals.blueWins + totals.redWins).toBe(totals.known);
  });

  it("플레이어 × 라인 표에서 기록이 없는 칸은 키가 없다", () => {
    const matrix = playerLineMatrix([match(1), match(2, { winner: "B" })]);
    expect(matrix.get("id0")).toEqual({ top: { games: 2, wins: 1 } });
    expect(matrix.get("id9")).toEqual({ support: { games: 2, wins: 1 } });
    expect(matrix.get("id0")?.support).toBeUndefined();
  });
});