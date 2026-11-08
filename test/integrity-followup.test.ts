import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seriesScore } from "../src/shared/series";
import type { Position, RosterEntry } from "../src/shared/types";
import {
  api,
  login,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
  type TestGroup,
} from "./helpers";
import { directCounted, FREE_PLAN_QUERY_LIMIT } from "./queryCount";

// 데이터 정합성 점검 후속(2026-11-08, docs/개선-서버-2026-11-08.md "정합성 점검 후속").

async function importN(g: TestGroup, n: number, roster: RosterEntry[], startMs = Date.parse("2024-03-01T00:00:00.000Z")) {
  const ids: string[] = [];
  for (let from = 0; from < n; from += 50) {
    const count = Math.min(50, n - from);
    const matches = Array.from({ length: count }, (_, i) => ({
      playedAt: new Date(startMs + (from + i) * 3600_000).toISOString(),
      roster,
      winnerTeam: (from + i) % 2 ? "A" : "B",
      winnerSide: "blue",
    }));
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: requestId(),
      matches,
    });
    expect(res.status).toBe(200);
    ids.push(...(res.body.matchIds as string[]));
  }
  return ids;
}

describe("1. 날짜 일괄 정정의 질의 수·시간대", () => {
  it("60경기를 옮겨도 질의는 50회 이하(경기 수와 상관없이 일정)", async () => {
    const g = await setupGroup(10);
    const ids = await importN(g, 60, rosterOf(g.people));
    const res = await directCounted("POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      cookie: g.cookie,
      body: { requestId: requestId(), matchIds: ids, years: -1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(60);
    expect(res.queries).toBeLessThanOrEqual(FREE_PLAN_QUERY_LIMIT);
    const snap = await snapshot(g);
    expect(snap.matches.find((m) => m.id === ids[0])!.playedAt).toBe("2023-03-01T00:00:00.000Z");
    expect(snap.revisions.filter((r) => r.kind === "correction").length).toBe(60);
    // 같은 요청을 한 번 더 세면 경기 수가 달라도 질의 수가 같다(경기마다 질의하지 않는다).
    const few = await directCounted("POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      cookie: g.cookie,
      body: { requestId: requestId(), matchIds: ids.slice(0, 2), years: 1 },
    });
    expect(few.status).toBe(200);
    const many = await directCounted("POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      cookie: g.cookie,
      body: { requestId: requestId(), matchIds: ids.slice(2), years: 1 },
    });
    expect(many.status).toBe(200);
    expect(many.queries).toBe(few.queries);
  });

  it("상한 500경기도 질의 50회 미만", async () => {
    const g = await setupGroup(10);
    const ids = await importN(g, 500, rosterOf(g.people), Date.parse("2023-01-01T00:00:00.000Z"));
    const res = await directCounted("POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      cookie: g.cookie,
      body: { requestId: requestId(), matchIds: ids, years: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(500);
    expect(res.queries).toBeLessThan(FREE_PLAN_QUERY_LIMIT);
  });

  it("모임 시간대의 날짜로 연도를 옮긴다", async () => {
    const g = await setupGroup(10);
    const [id] = await importN(g, 1, rosterOf(g.people), Date.parse("2024-02-29T03:00:00.000Z"));
    await env.DB.prepare("UPDATE groups SET timezone = 'America/New_York' WHERE id = ?1").bind(g.gid).run();
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: [id],
      years: 1,
    });
    expect(res.status).toBe(200);
    // 뉴욕 2024-02-28 22:00 → 2025-02-28 22:00(= UTC 2025-03-01 03:00). 한국 기준이었다면 2025-02-28T03:00Z.
    expect((await snapshot(g)).matches[0]!.playedAt).toBe("2025-03-01T03:00:00.000Z");
  });
});

describe("8. 날짜 정정과 전적 제외 경기", () => {
  it("제외 경기도 함께 옮기고 제외 상태·통계 제외는 그대로, 정정 기록은 남긴다", async () => {
    const g = await setupGroup(10);
    const ids = await importN(g, 3, rosterOf(g.people), Date.parse("2024-01-05T12:00:00.000Z"));
    let snap = await snapshot(g);
    const middle = snap.matches.find((m) => m.id === ids[1])!;
    expect((await matchAction(g, middle, "exclude")).status).toBe(200);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: ids,
      years: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(3);
    snap = await snapshot(g);
    const moved = snap.matches.find((m) => m.id === ids[1])!;
    expect(moved.state).toBe("excluded");
    expect(moved.playedAt).toBe("2025-01-05T13:00:00.000Z");
    expect(snap.matches.filter((m) => m.state === "confirmed")).toHaveLength(2);
    expect(snap.revisions.some((r) => r.kind === "correction" && r.matchId === ids[1])).toBe(true);
    // 제외 경기를 복구하면 옮긴 날짜로 돌아온다.
    expect((await matchAction(g, moved, "restore")).status).toBe(200);
    expect((await snapshot(g)).matches.find((m) => m.id === ids[1])!.state).toBe("confirmed");
  });

  it("진행 중 경기는 여전히 거절한다", async () => {
    const g = await setupGroup(10);
    const [id] = await importN(g, 1, rosterOf(g.people), Date.parse("2024-01-05T12:00:00.000Z"));
    const live = (await start(g, rosterOf(g.people))).body.match;
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/shift-dates`, {
      requestId: requestId(),
      matchIds: [id, live.id],
      years: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATE_CONFLICT");
    expect((await snapshot(g)).matches.find((m) => m.id === id)!.playedAt).toBe("2024-01-05T12:00:00.000Z");
  });
});

describe("2. 합치기 전 백업으로 같은 모임 복원", () => {
  it("남길 대상에 옮겨 간 연결을 원래 사람에게 돌려놓아, 그 계정이 남길 대상의 기피 라인을 바꿀 수 없다", async () => {
    const g = await setupGroup(12);
    const A = g.people[0]!.id;
    const B = g.people[11]!.id;
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${A}/claim-link`)).body.token;
    const member = await login();
    expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: A, targetId: B });
    expect(merged.status).toBe(200);
    const linkOf = async () =>
      (
        await env.DB.prepare("SELECT participant_id FROM participant_links WHERE group_id = ?1")
          .bind(g.gid)
          .all<{ participant_id: string }>()
      ).results.map((r) => r.participant_id);
    expect(await linkOf()).toEqual([B]);

    const gen = (await snapshot(g)).group.generation;
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: gen,
      backup,
    });
    expect(restored.status).toBe(200);
    expect(await linkOf()).toEqual([A]);

    const avoid = await api(member, "PUT", `/api/member/${g.gid}/avoid`, { avoidPositions: ["top"] });
    expect(avoid.status).toBe(200);
    const after = await snapshot(g);
    expect(after.participants.find((p) => p.id === B)!.avoidPositions ?? []).toEqual([]);
    expect(after.participants.find((p) => p.id === A)!.avoidPositions).toEqual(["top"]);
    expect(after.participants.find((p) => p.id === A)!.status).toBe("active");
  });

  it("지금도 파일에도 유효한 합치기는 연결 기록(moved_link)을 지켜, 복원 뒤 되돌려도 연결이 돌아간다", async () => {
    const g = await setupGroup(12);
    const A = g.people[0]!.id;
    const B = g.people[11]!.id;
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${A}/claim-link`)).body.token;
    const member = await login();
    expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: A, targetId: B });
    expect(merged.status).toBe(200);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    const gen = (await snapshot(g)).group.generation;
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: gen,
      backup,
    });
    expect(restored.status).toBe(200);
    const row = await env.DB.prepare("SELECT moved_link FROM participant_merges WHERE id = ?1")
      .bind(merged.body.mergeId)
      .first<{ moved_link: string | null }>();
    expect(row!.moved_link).not.toBeNull();
    const undone = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${merged.body.mergeId}/undo`, {
      requestId: requestId(),
    });
    expect(undone.status).toBe(200);
    expect(undone.body.link).toMatchObject({ outcome: "returned" });
    const links = await env.DB.prepare("SELECT participant_id FROM participant_links WHERE group_id = ?1")
      .bind(g.gid)
      .all<{ participant_id: string }>();
    expect(links.results.map((r) => r.participant_id)).toEqual([A]);
  });
});

describe("3. 시리즈 만들기·이어가기·넣기의 질의 수", () => {
  it("상한 15판으로 만들기, 14판 시리즈에 이어가기·넣기 모두 50회 이하", async () => {
    const g = await setupGroup(10);
    const roster = rosterOf(g.people);
    const ids = await importN(g, 15, roster);
    const created = await directCounted("POST", `/api/groups/${g.gid}/series`, {
      cookie: g.cookie,
      body: { requestId: requestId(), format: "free", matchIds: ids },
    });
    expect(created.status).toBe(200);
    expect(created.body.series.matchIds).toEqual(ids);
    expect(created.queries).toBeLessThanOrEqual(FREE_PLAN_QUERY_LIMIT);

    const g2 = await setupGroup(10);
    const ids2 = await importN(g2, 15, rosterOf(g2.people));
    expect(
      (await api(g2.cookie, "POST", `/api/groups/${g2.gid}/series`, { requestId: requestId(), format: "free", matchIds: ids2.slice(0, 14) }))
        .status,
    ).toBe(200);
    const series = (await snapshot(g2)).series![0]!;
    const added = await directCounted("POST", `/api/groups/${g2.gid}/series/${series.id}/add`, {
      cookie: g2.cookie,
      body: { requestId: requestId(), matchId: ids2[14] },
    });
    expect(added.status).toBe(200);
    expect(added.body.series.matchIds).toEqual(ids2);
    expect(added.queries).toBeLessThanOrEqual(FREE_PLAN_QUERY_LIMIT);

    const g3 = await setupGroup(10);
    const ids3 = await importN(g3, 14, rosterOf(g3.people));
    expect(
      (await api(g3.cookie, "POST", `/api/groups/${g3.gid}/series`, { requestId: requestId(), format: "free", matchIds: ids3 })).status,
    ).toBe(200);
    const snap = await snapshot(g3);
    const continued = await directCounted("POST", `/api/groups/${g3.gid}/matches/start`, {
      cookie: g3.cookie,
      body: {
        requestId: requestId(),
        baseLiveVersion: snap.group.liveVersion,
        roster: rosterOf(g3.people),
        series: { fromMatchId: ids3[13] },
      },
    });
    expect(continued.status).toBe(200);
    expect(continued.queries).toBeLessThanOrEqual(FREE_PLAN_QUERY_LIMIT);
    expect((await snapshot(g3)).series![0]!.matchIds).toHaveLength(15);
  });
});

describe("4. 시리즈 기준 판 = 가장 많은 구성", () => {
  it("bo3 3판 중 첫 판만 참가자 정정되면 2·3판은 계속 센다(화면 점수와 서버 넣기 검사가 같은 기준)", async () => {
    const g = await setupGroup(11);
    const roster = rosterOf(g.people);
    const ids = await importN(g, 4, roster);
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/series`, {
      requestId: requestId(),
      format: "bo3",
      matchIds: ids.slice(0, 3),
    });
    expect(created.status).toBe(200);
    let snap = await snapshot(g);
    const first = snap.matches.find((m) => m.id === ids[0])!;
    const corrected = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${first.id}/correct`, {
      requestId: requestId(),
      baseMatchVersion: first.version,
      field: "participant",
      outParticipantId: g.people[0]!.id,
      inParticipantId: g.people[10]!.id,
      fixRotation: true,
    });
    expect(corrected.status).toBe(200);
    snap = await snapshot(g);
    const score = seriesScore(snap.series![0]!, snap.matches);
    expect(score.games.map((x) => x.status)).toEqual(["mismatch", "counted", "counted"]);
    expect(score.mismatched).toBe(1);
    // 기준 구성(2·3판)의 팀 A = 원래 앞 5명.
    expect(score.teams[0]).toContain(g.people[0]!.id);
    // 서버도 같은 기준: 원래 구성의 4판은 넣을 수 있다(예전 기준이면 1판 구성과 달라 거절됐다).
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${snap.series![0]!.id}/add`, {
      requestId: requestId(),
      matchId: ids[3],
    });
    expect(added.status).toBe(200);
  });
});

describe("5. 멤버 쓰기의 batch 안 점검 확인", () => {
  it("점검 확인 뒤 batch 전에 점검이 켜지면 기피 라인 저장은 MAINTENANCE이고 아무것도 바뀌지 않는다", async () => {
    const g = await setupGroup(10);
    const A = g.people[0]!.id;
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${A}/claim-link`)).body.token;
    const member = await login();
    expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);
    const res = await directCounted("PUT", `/api/member/${g.gid}/avoid`, {
      cookie: member,
      body: { avoidPositions: ["mid"] },
      beforeBatch: async (sqls) => {
        if (sqls.some((s) => s.includes("SET avoid_positions"))) {
          await env.DB.prepare("UPDATE groups SET maintenance = 1 WHERE id = ?1").bind(g.gid).run();
        }
      },
    });
    await env.DB.prepare("UPDATE groups SET maintenance = 0 WHERE id = ?1").bind(g.gid).run();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("MAINTENANCE");
    expect((await snapshot(g)).participants.find((p) => p.id === A)!.avoidPositions ?? []).toEqual([]);
  });
});

describe("6. 포지션 정정으로 바뀐 서포터의 차례 종류", () => {
  it("반복이던 서포터 자리를 아직 차례를 안 쓴 사람으로 고치면 '사용'으로 남는다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    // 같은 서포터가 또 서포터: 반복 허용.
    const second = await playConfirmed(g, roster, "A", "blue", { ackRepeat: roster.map((r) => r.participantId) });
    let events = (await snapshot(g)).rotation!.events.filter((e) => e.matchId === second.id);
    const support = roster[4]!.participantId;
    const adc = roster[3]!.participantId;
    expect(events.find((e) => e.participantId === support)!.kind).toBe("repeat");
    const positions: { participantId: string; position: Position }[] = [
      { participantId: adc, position: "support" },
      { participantId: support, position: "adc" },
    ];
    const fixed = await matchAction(g, second, "correct", { field: "positions", positions, fixRotation: true });
    expect(fixed.status).toBe(200);
    events = (await snapshot(g)).rotation!.events.filter((e) => e.matchId === second.id);
    expect(events.find((e) => e.participantId === adc)!.kind).toBe("used");
  });
});

describe("7. 시리즈 요청의 같은 요청 ID 재전송", () => {
  it("그 사이 시리즈가 지워져도 처음 응답을 그대로 준다", async () => {
    const g = await setupGroup(10);
    const ids = await importN(g, 2, rosterOf(g.people));
    const createBody = { requestId: requestId(), format: "bo3", matchIds: [ids[0]] };
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/series`, createBody);
    expect(created.status).toBe(200);
    const seriesId = created.body.series.id as string;
    const addBody = { requestId: requestId(), matchId: ids[1] };
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/add`, addBody);
    expect(added.status).toBe(200);
    const updateBody = { requestId: requestId(), name: "결승", format: "bo5" };
    const updated = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/update`, updateBody);
    expect(updated.status).toBe(200);
    const removeBody = { requestId: requestId(), matchId: ids[1] };
    const removed = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/remove`, removeBody);
    expect(removed.status).toBe(200);
    // 마지막 판을 빼 시리즈가 사라진다.
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/remove`, { requestId: requestId(), matchId: ids[0] }))
        .status,
    ).toBe(200);
    expect((await snapshot(g)).series).toEqual([]);

    const again = async (path: string, body: unknown) => api(g.cookie, "POST", `/api/groups/${g.gid}${path}`, body);
    const c2 = await again("/series", createBody);
    expect(c2.status).toBe(200);
    expect(c2.body).toEqual(created.body);
    const a2 = await again(`/series/${seriesId}/add`, addBody);
    expect(a2.status).toBe(200);
    expect(a2.body).toEqual(added.body);
    const u2 = await again(`/series/${seriesId}/update`, updateBody);
    expect(u2.status).toBe(200);
    expect(u2.body).toEqual(updated.body);
    const r2 = await again(`/series/${seriesId}/remove`, removeBody);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual(removed.body);
    expect((await snapshot(g)).series).toEqual([]);
  });
});
