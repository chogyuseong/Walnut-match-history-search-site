import { describe, expect, it } from "vitest";
import { rankingGroup } from "../src/shared/insights";
import { computeRatings } from "../src/shared/rating";
import {
  PLACEMENT_GAMES,
  PLACEMENT_GAMES_DEFAULT,
  PLACEMENT_GAMES_MAX,
  PLACEMENT_GAMES_MIN,
  placements,
  placementGamesOf,
} from "../src/shared/stats";
import { DEFAULT_TITLE_BANDS, standings } from "../src/shared/titles";
import type { MatchView, Snapshot, Team } from "../src/shared/types";
import { api, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";

// 배치 경기 수 설정(Settings.placementGames): 기본 10, 1~30. 계산 함수는 넘겨받은 값을 따른다.

function match(no: number, winner: Team): MatchView {
  const playedAt = new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: "s1",
    state: "confirmed",
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: playedAt,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...[0, 1, 2, 3, 4].map((i) => ({ participantId: `id${i}`, team: "A" as const, position: null })),
      ...[5, 6, 7, 8, 9].map((i) => ({ participantId: `id${i}`, team: "B" as const, position: null })),
    ],
  };
}

/** 번갈아 이겨 연속성 가중이 붙지 않는 n경기. */
const alternating = (n: number) => Array.from({ length: n }, (_, i) => match(i + 1, i % 2 === 0 ? "A" : "B"));

describe("배치 경기 수 설정(계산)", () => {
  it("저장하지 않았으면 기본 10이고, 옛 이름 PLACEMENT_GAMES도 같은 값이다", () => {
    expect(placementGamesOf({})).toBe(10);
    expect(PLACEMENT_GAMES).toBe(PLACEMENT_GAMES_DEFAULT);
    expect(placementGamesOf({ placementGames: 5 })).toBe(5);
    expect([PLACEMENT_GAMES_MIN, PLACEMENT_GAMES_MAX]).toEqual([1, 30]);
  });

  it("배치 경기 수는 MMR 계산 자체를 바꾸지 않는다(배치·티어·이변 판정에만 쓴다)", () => {
    const matches = alternating(8);
    expect(computeRatings(matches, { placementGames: 5 }).get("id0")).toEqual(computeRatings(matches).get("id0"));
  });

  it("칭호와 배치 완료는 설정한 경기 수를 채운 뒤에 붙는다", () => {
    const matches = alternating(3);
    expect(standings(matches, DEFAULT_TITLE_BANDS).get("id0")).toMatchObject({ done: false, title: null });
    const three = standings(matches, DEFAULT_TITLE_BANDS, 3).get("id0")!;
    expect(three.done).toBe(true);
    expect(three.title).not.toBeNull();
    expect(standings(matches.slice(0, 2), DEFAULT_TITLE_BANDS, 3).get("id0")!.done).toBe(false);
  });

  it("랭킹 묶음(배치 완료·진행 중)도 설정값을 따른다", () => {
    const matches = alternating(4);
    expect(rankingGroup(placements(matches), "id0")).toBe(2);
    expect(rankingGroup(placements(matches, 4), "id0")).toBe(1);
    expect(rankingGroup(placements(matches, 5), "id0")).toBe(2);
  });
});

describe("배치 경기 수 설정 저장(서버)", () => {
  async function save(g: TestGroup, placementGames: unknown) {
    const snap = await snapshot(g);
    return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: snap.group.settingsVersionId,
      settings: { ...snap.group.settings, placementGames },
    });
  }

  it("1~30 정수만 받고, 저장한 값은 운영자·조회 응답 모두에 나간다", async () => {
    const g = await setupGroup(10);
    expect((await snapshot(g)).group.settings.placementGames).toBeUndefined();
    for (const bad of [0, 31, 5.5, "10", null]) {
      const res = await save(g, bad);
      expect(res.status).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_FIELD");
    }
    expect((await save(g, 1)).status).toBe(200);
    expect((await snapshot(g)).group.settings.placementGames).toBe(1);
    expect((await save(g, 30)).status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.group.settings.placementGames).toBe(30);
    const view = await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(view.body.group.settings.placementGames).toBe(30);
  });
});
