import { describe, expect, it } from "vitest";
import { api, requestId, rosterOf, setupGroup, snapshot } from "./helpers";

// 날짜 일괄 정정(POST /api/groups/:gid/matches/shift-dates, src/server/matches.ts shiftMatchDates).
async function backfillAt(g: Awaited<ReturnType<typeof setupGroup>>, playedAt: string) {
  const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, {
    requestId: requestId(),
    playedAt,
    roster: rosterOf(g.people.slice(0, 10)).map((r) => ({ ...r, position: null })),
    winnerTeam: "A",
    winnerSide: "unknown",
  });
  expect(res.status).toBe(200);
  return res.body.match.id as string;
}

describe("날짜 일괄 정정", () => {
  it("여러 확정 경기의 연도를 +1 옮기고 정정 기록을 남기며, −1로 되돌린다", async () => {
    const g = await setupGroup(10);
    const a = await backfillAt(g, "2024-01-05T12:00:00.000Z");
    const b = await backfillAt(g, "2024-02-10T12:00:00.000Z");
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: [a, b],
      years: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(2);
    let snap = await snapshot(g);
    expect(snap.matches.find((m) => m.id === a)!.playedAt).toBe("2025-01-05T12:00:00.000Z");
    expect(snap.matches.find((m) => m.id === b)!.playedAt).toBe("2025-02-10T12:00:00.000Z");
    const revs = snap.revisions.filter((r) => r.kind === "correction" && (r.matchId === a || r.matchId === b));
    expect(revs).toHaveLength(2);
    // 반대 부호로 되돌린다.
    const again = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: [a],
      years: -1,
    });
    expect(again.status).toBe(200);
    snap = await snapshot(g);
    expect(snap.matches.find((m) => m.id === a)!.playedAt).toBe("2024-01-05T12:00:00.000Z");
  });

  it("옮긴 시각이 미래가 되면 전체를 거절한다(부분 적용 없음)", async () => {
    const g = await setupGroup(10);
    const a = await backfillAt(g, "2024-01-05T12:00:00.000Z");
    const recent = await backfillAt(g, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: [a, recent],
      years: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code ?? res.body.code).toBe("FUTURE_MATCH");
    const snap = await snapshot(g);
    expect(snap.matches.find((m) => m.id === a)!.playedAt).toBe("2024-01-05T12:00:00.000Z");
  });

  it("빈 목록·엉뚱한 years·없는 경기는 400/404", async () => {
    const g = await setupGroup(10);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, { requestId: requestId(), matchIds: [], years: 1 })).status).toBe(400);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, { requestId: requestId(), matchIds: ["x"], years: 2 })).status).toBe(400);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, { requestId: requestId(), matchIds: ["없음"], years: 1 })).status).toBe(404);
  });
});
