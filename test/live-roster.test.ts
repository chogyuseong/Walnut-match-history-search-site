import { describe, expect, it } from "vitest";
import type { MatchView, Snapshot } from "../src/shared/types";
import {
  api,
  fingerprint,
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

// 사용자 편의 기능(2026-11-07): 진행 중 경기의 사람 교체(PATCH .../matches/:mid/roster)와
// 참가자 편성 화면(#/v/토큰/live)이 쓰는 조회 응답의 공개 범위.

function replace(
  g: TestGroup,
  match: { id: string; version: number },
  outId: string,
  inId: string,
  extra: Record<string, unknown> = {},
  cookie: string | null = g.cookie,
) {
  return api<{ match: MatchView; error?: { code: string; details?: { participantIds?: string[] } } }>(
    cookie,
    "PATCH",
    `/api/groups/${g.gid}/matches/${match.id}/roster`,
    { requestId: requestId(), baseMatchVersion: match.version, outParticipantId: outId, inParticipantId: inId, ...extra },
  );
}

async function startLive(g: TestGroup): Promise<MatchView> {
  const started = await start(g, rosterOf(g.people), { teamASide: "blue" });
  expect(started.status).toBe(200);
  return started.body.match;
}

describe("진행 중 경기의 사람 교체", () => {
  it("한 사람을 다른 활성 참가자로 바꾸면 팀·포지션은 그대로, 경기·진행 버전이 오르고 정정 이력이 남는다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const before = await snapshot(g);
    const out = g.people[1]!; // 팀 A 정글
    const incoming = g.people[10]!;

    const res = await replace(g, match, out.id, incoming.id);
    expect(res.status).toBe(200);
    const seat = res.body.match.roster.find((r) => r.participantId === incoming.id)!;
    expect(seat).toEqual({ participantId: incoming.id, team: "A", position: "jungle" });
    expect(res.body.match.roster.some((r) => r.participantId === out.id)).toBe(false);
    expect(res.body.match.roster).toHaveLength(10);
    expect(res.body.match.version).toBe(match.version + 1);
    expect(res.body.match.state).toBe("in_progress");

    const after = await snapshot(g);
    expect(after.group.liveVersion).toBe(before.group.liveVersion + 1);
    const revision = after.revisions.find((r) => r.matchId === match.id && r.kind === "correction")!;
    expect(revision.kind).toBe("correction");
    expect(revision.changes).toEqual({ participant: { from: out.id, to: incoming.id } });
    // 서포터가 아닌 자리라 서포터 차례 기록은 그대로다.
    expect(after.rotation).toEqual(before.rotation);
  });

  it("서포터 자리를 바꾸면 그 경기의 서포터 차례 기록도 들어온 사람에게 옮긴다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const support = g.people[4]!; // 팀 A 서포터
    const before = await snapshot(g);
    expect(before.rotation!.events.some((e) => e.participantId === support.id && e.kind === "used")).toBe(true);

    const res = await replace(g, match, support.id, g.people[11]!.id);
    expect(res.status).toBe(200);
    const after = await snapshot(g);
    const events = after.rotation!.events.filter((e) => e.matchId === match.id);
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.participantId === support.id)).toBe(false);
    expect(events.find((e) => e.participantId === g.people[11]!.id)?.kind).toBe("used");
    const revision = after.revisions.find((r) => r.matchId === match.id && r.kind === "correction")!;
    expect(revision.changes).toEqual({
      participant: { from: support.id, to: g.people[11]!.id },
      "rotation:A": { from: support.id, to: g.people[11]!.id },
    });
  });

  it("이번 순환에서 이미 서포터를 한 사람을 서포터 자리에 넣으려면 확인이 필요하고, 확인하면 반복으로 남는다", async () => {
    const g = await setupGroup(12);
    // 1경기: 4번(팀 A)·9번(팀 B)이 서포터. 2경기: 2~11번(팀 A 2~6, 팀 B 7~11, 서포터는 6번·11번), 명단 밖은 0·1번.
    await playConfirmed(g, rosterOf(g.people), "A", "blue");
    const shifted = [...g.people.slice(2), ...g.people.slice(0, 2)];
    const second = (await start(g, rosterOf(shifted), { teamASide: "blue" })).body.match;
    const supportA = shifted[4]!;
    expect(supportA.id).toBe(g.people[6]!.id);
    // 이미 명단에 있는 사람(9번)은 서포터 자리에 바로 넣을 수 없다.
    const before = fingerprint(await snapshot(g));
    const inRoster = await replace(g, second, supportA.id, g.people[9]!.id);
    expect(inRoster.status).toBe(400);
    expect(inRoster.body.error!.code).toBe("INVALID_PARTICIPANT");
    expect(fingerprint(await snapshot(g))).toBe(before);

    // 9번(팀 B 미드)을 0번으로 바꿔 명단에서 빼 둔 뒤, 팀 A 서포터 자리에 9번을 넣는다 → 반복 확인.
    const swapped = await replace(g, second, g.people[9]!.id, g.people[0]!.id);
    expect(swapped.status).toBe(200);
    const ask = await replace(g, swapped.body.match, supportA.id, g.people[9]!.id);
    expect(ask.status).toBe(409);
    expect(ask.body.error!.code).toBe("SUPPORT_REPEAT");
    expect(ask.body.error!.details!.participantIds).toEqual([g.people[9]!.id]);

    const ok = await replace(g, swapped.body.match, supportA.id, g.people[9]!.id, { ackRepeat: true });
    expect(ok.status).toBe(200);
    const events = (await snapshot(g)).rotation!.events.filter((e) => e.matchId === second.id);
    expect(events.find((e) => e.participantId === g.people[9]!.id)?.kind).toBe("repeat");
  });

  it("권한: 다른 계정·로그인 없음은 거절, 공동 운영자는 된다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const other = await login();
    expect((await replace(g, match, g.people[0]!.id, g.people[10]!.id, {}, other)).status).toBe(404);
    expect((await replace(g, match, g.people[0]!.id, g.people[10]!.id, {}, null)).status).toBe(401);
    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    expect((await replace(g, match, g.people[0]!.id, g.people[10]!.id, {}, co)).status).toBe(200);
  });

  it("진행 중이 아닌 경기(결과 대기·확정)와 옛 버전은 거절하고 아무것도 바꾸지 않는다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const ended = (await matchAction(g, match, "end-later")).body.match;
    const before = fingerprint(await snapshot(g));
    const waiting = await replace(g, ended, g.people[0]!.id, g.people[10]!.id);
    expect(waiting.status).toBe(409);
    expect(waiting.body.error!.code).toBe("STATE_CONFLICT");
    const stale = await replace(g, match, g.people[0]!.id, g.people[10]!.id);
    expect(stale.status).toBe(409);
    expect(stale.body.error!.code).toBe("VERSION_CONFLICT");
    expect(fingerprint(await snapshot(g))).toBe(before);

    const confirmed = (await matchAction(g, ended, "result", { winnerTeam: "A", winnerSide: "blue" })).body.match;
    const afterResult = fingerprint(await snapshot(g));
    const done = await replace(g, confirmed, g.people[0]!.id, g.people[10]!.id);
    expect(done.status).toBe(409);
    expect(done.body.error!.code).toBe("STATE_CONFLICT");
    expect(fingerprint(await snapshot(g))).toBe(afterResult);
  });

  it("다른 모임의 참가자·보관한 참가자·이미 명단에 있는 사람·명단에 없는 사람은 거절한다", async () => {
    const g = await setupGroup(12);
    const other = await setupGroup(12);
    const match = await startLive(g);
    const before = fingerprint(await snapshot(g));

    const foreign = await replace(g, match, g.people[0]!.id, other.people[10]!.id);
    expect(foreign.status).toBe(400);
    expect(foreign.body.error!.code).toBe("INVALID_PARTICIPANT");
    expect(fingerprint(await snapshot(g))).toBe(before);

    const archived = g.people[11]!;
    expect(
      (await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${archived.id}`, { status: "archived" })).status,
    ).toBe(200);
    const afterArchive = await snapshot(g);
    const res = await replace(g, match, g.people[0]!.id, archived.id);
    expect(res.status).toBe(400);
    expect(res.body.error!.code).toBe("INVALID_PARTICIPANT");

    expect((await replace(g, match, g.people[0]!.id, g.people[1]!.id)).status).toBe(400);
    expect((await replace(g, match, g.people[10]!.id, g.people[11]!.id)).status).toBe(400);
    expect((await replace(g, match, g.people[0]!.id, g.people[0]!.id)).status).toBe(400);
    expect(fingerprint(await snapshot(g))).toBe(fingerprint(afterArchive));
  });

  it("같은 요청 ID를 다시 보내면 한 번만 바꾸고 같은 결과를 돌려준다. 같은 ID로 다른 내용은 거절한다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const body = {
      requestId: requestId(),
      baseMatchVersion: match.version,
      outParticipantId: g.people[0]!.id,
      inParticipantId: g.people[10]!.id,
    };
    const path = `/api/groups/${g.gid}/matches/${match.id}/roster`;
    const first = await api(g.cookie, "PATCH", path, body);
    expect(first.status).toBe(200);
    const afterFirst = await snapshot(g);
    const again = await api(g.cookie, "PATCH", path, body);
    expect(again.status).toBe(200);
    expect(again.body.match.roster).toEqual(first.body.match.roster);
    const afterAgain = await snapshot(g);
    expect(fingerprint(afterAgain)).toBe(fingerprint(afterFirst));
    expect(afterAgain.group.liveVersion).toBe(afterFirst.group.liveVersion);

    const reused = await api(g.cookie, "PATCH", path, { ...body, inParticipantId: g.people[11]!.id });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
  });

  it("바꾼 명단은 백업 → 복원 왕복에서 그대로다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    expect((await replace(g, match, g.people[4]!.id, g.people[10]!.id)).status).toBe(200);
    const before = await snapshot(g);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    // 백업 뒤에 한 번 더 바꾼다 → 복원하면 백업 때 명단으로 돌아온다.
    const live = before.matches.find((m) => m.id === match.id)!;
    expect((await replace(g, live, g.people[10]!.id, g.people[11]!.id)).status).toBe(200);
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: before.group.generation,
      backup,
    });
    expect(restored.status).toBe(200);
    const after = await snapshot(g);
    const m = after.matches.find((x) => x.id === match.id)!;
    expect(m.state).toBe("in_progress");
    expect(m.roster).toEqual(live.roster);
    expect(after.rotation?.events).toEqual(before.rotation?.events);
    expect(after.revisions.filter((r) => r.matchId === match.id).map((r) => [r.kind, r.changes])).toEqual(
      before.revisions.filter((r) => r.matchId === match.id).map((r) => [r.kind, r.changes]),
    );
  });
});

describe("참가자 편성 화면이 쓰는 조회 응답", () => {
  it("진행 중 경기의 명단·포지션·시작 시각이 있고, 티어·기피 라인·서포터 횟수 보정값·조회 토큰·계정 정보는 없다", async () => {
    const g = await setupGroup(12);
    const pid = g.people[0]!.id;
    expect(
      (await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { skillGroup: 1, avoidPositions: ["support"] }))
        .status,
    ).toBe(200);
    const match = await startLive(g);
    // 서포터 횟수 직접 입력(보정값)은 운영자 응답에만 있다.
    expect(
      (
        await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
          requestId: requestId(),
          counts: [{ participantId: g.people[11]!.id, count: 3 }],
        })
      ).status,
    ).toBe(200);
    const op = await snapshot(g);
    expect(op.rotation?.adjustments?.length ?? 0).toBeGreaterThan(0);
    const token = op.group.viewToken!;

    const view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.status).toBe(200);
    const live = view.body.matches.find((m) => m.state === "in_progress")!;
    expect(live.id).toBe(match.id);
    expect(live.startedAt).toBe(match.startedAt);
    expect(live.teamASide).toBe("blue");
    expect(live.roster).toHaveLength(10);
    expect(live.roster.every((r) => r.position !== null)).toBe(true);

    const text = JSON.stringify(view.body);
    for (const secret of ["skillGroup", "avoidPositions", "adjustments", "viewToken", "accountId", "importBatches"]) {
      expect(text).not.toContain(secret);
    }
    // 티어 가중치는 비공개 모임이면 0으로만 나간다.
    expect(view.body.group.settings.groupWeights).toEqual([0, 0, 0, 0, 0]);
    expect(view.body.participants.every((p) => p.version === undefined)).toBe(true);
    expect(text).not.toContain(token);
  });

  it("교체하면 조회 응답(ETag)이 바뀌어 참가자 화면에 새 명단이 보인다", async () => {
    const g = await setupGroup(12);
    const match = await startLive(g);
    const token = (await snapshot(g)).group.viewToken!;
    const first = await fetchView(token);
    expect(first.status).toBe(200);
    const etag = first.etag!;
    expect((await fetchView(token, etag)).status).toBe(304);
    expect((await replace(g, match, g.people[0]!.id, g.people[10]!.id)).status).toBe(200);
    const changed = await fetchView(token, etag);
    expect(changed.status).toBe(200);
    const live = (changed.body as Snapshot).matches.find((m) => m.state === "in_progress")!;
    expect(live.roster.some((r) => r.participantId === g.people[10]!.id)).toBe(true);
  });
});

async function fetchView(token: string, ifNoneMatch?: string): Promise<{ status: number; etag: string | null; body: unknown }> {
  const { SELF } = await import("cloudflare:test");
  const response = await SELF.fetch(`https://example.test/api/view/${token}`, {
    headers: ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {},
  });
  return {
    status: response.status,
    etag: response.headers.get("ETag"),
    body: response.status === 200 ? await response.json() : null,
  };
}
