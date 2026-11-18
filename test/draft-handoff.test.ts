import { env, SELF } from "cloudflare:test";
import { HANDOFF_KEEP_MS, pruneDraftHandoffs } from "../src/server/draftHandoff";
import { describe, expect, it } from "vitest";
import { api, login, rosterOf, setupGroup, snapshot, start, type TestGroup } from "./helpers";

// 편성 넘기기(migrations/0029, src/server/draftHandoff.ts): 운영자가 편성 초안을 서버 한 칸에 맡기고 다른 기기가 이어받는다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"] as const;

/** 화면이 보내는 초안과 같은 겉모양(10명·10자리 + 대기자). 서버는 안을 해석하지 않는다. */
function draftOf(g: TestGroup, liveVersion: number, benchCount = 0) {
  const people = g.people.slice(0, 10).map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));
  return {
    formatVersion: 1,
    groupId: g.gid,
    baseLiveVersion: liveVersion,
    createdAt: new Date().toISOString(),
    people,
    slots: people.map((p, i) => ({ key: p.key, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5], locked: false })),
    draws: {},
    previousSlots: null,
    origin: "new",
    seed: 1,
    bench: g.people.slice(10, 10 + benchCount).map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id })),
  };
}

async function hand(g: TestGroup, cookie: string, handoffId: string, benchCount = 0) {
  const live = (await snapshot(g)).group.liveVersion;
  return api(cookie, "PUT", `/api/groups/${g.gid}/draft-handoff`, {
    handoffId,
    draft: draftOf(g, live, benchCount),
    nightPool: { v: 1, groupId: g.gid, sessionId: null, createdAt: new Date().toISOString(), people: [] },
  });
}

describe("편성 넘기기", () => {
  it("넘기면 운영자 스냅숏에 요약만 실리고, 본문은 따로 받고, 지우면 사라진다", async () => {
    const g = await setupGroup(12);
    expect((await snapshot(g)).draftHandoff).toBeNull();
    expect((await hand(g, g.cookie, "device-one-0001", 2)).status).toBe(200);

    const snap = await snapshot(g);
    expect(snap.draftHandoff).toMatchObject({ id: "device-one-0001", people: 12, baseLiveVersion: snap.group.liveVersion });
    expect(JSON.stringify(snap.draftHandoff)).not.toContain(g.people[0]!.name);

    const body = await api(g.cookie, "GET", `/api/groups/${g.gid}/draft-handoff`);
    expect(body.status).toBe(200);
    expect(body.body.handoffId).toBe("device-one-0001");
    expect(body.body.draft.people).toHaveLength(10);
    expect(body.body.nightPool.groupId).toBe(g.gid);

    expect((await api(g.cookie, "DELETE", `/api/groups/${g.gid}/draft-handoff?id=device-one-0001`)).status).toBe(200);
    expect((await snapshot(g)).draftHandoff).toBeNull();
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/draft-handoff`)).status).toBe(404);
  });

  it("새로 넘기면 덮어쓰고, 지난 넘기기 ID로 지우면 새것은 남는다", async () => {
    const g = await setupGroup(10);
    await hand(g, g.cookie, "first-handoff");
    await hand(g, g.cookie, "second-handoff");
    await api(g.cookie, "DELETE", `/api/groups/${g.gid}/draft-handoff?id=first-handoff`);
    expect((await snapshot(g)).draftHandoff?.id).toBe("second-handoff");
  });

  it("넘긴 것이 바뀌면 스냅숏 ETag도 바뀐다(304로 옛 요약이 남지 않는다)", async () => {
    const g = await setupGroup(10);
    const etagOf = () => snapshotEtagOf(g.cookie, `/api/groups/${g.gid}/snapshot`);
    const before = await etagOf();
    await hand(g, g.cookie, "etag-handoff");
    const handed = await etagOf();
    expect(handed).not.toBe(before);
    await api(g.cookie, "DELETE", `/api/groups/${g.gid}/draft-handoff`);
    expect(await etagOf()).not.toBe(handed);
  });

  it("경기를 시작하면 넘긴 편성을 지운다", async () => {
    const g = await setupGroup(10);
    await hand(g, g.cookie, "before-start");
    expect((await start(g, rosterOf(g.people))).status).toBe(200);
    expect((await snapshot(g)).draftHandoff).toBeNull();
  });

  it("공동 운영자도 넘기고 받을 수 있고, 운영자가 아니면 404다", async () => {
    const g = await setupGroup(10);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`)).body.token as string;
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${token}/accept`)).status).toBe(200);

    expect((await hand(g, co, "from-co-operator")).status).toBe(200);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/draft-handoff`)).body.handoffId).toBe("from-co-operator");

    const stranger = await login();
    expect((await hand(g, stranger, "stranger-handoff")).status).toBe(404);
    expect((await api(stranger, "GET", `/api/groups/${g.gid}/draft-handoff`)).status).toBe(404);
    expect((await api(stranger, "DELETE", `/api/groups/${g.gid}/draft-handoff`)).status).toBe(404);
    expect((await snapshot(g)).draftHandoff?.id).toBe("from-co-operator");
  });

  it("겉모양이 틀리거나 모르는 칸이 있으면 400이고 저장하지 않는다", async () => {
    const g = await setupGroup(10);
    const live = (await snapshot(g)).group.liveVersion;
    const good = draftOf(g, live);
    const put = (body: unknown) => api(g.cookie, "PUT", `/api/groups/${g.gid}/draft-handoff`, body);
    expect((await put({ handoffId: "bad-people-1", draft: { ...good, people: good.people.slice(0, 9) } })).status).toBe(400);
    expect((await put({ handoffId: "short", draft: good })).status).toBe(400);
    expect((await put({ handoffId: "bad-pool-01", draft: good, nightPool: [1, 2] })).status).toBe(400);
    expect((await put({ handoffId: "extra-key-1", draft: good, owner: "me" })).status).toBe(400);
    expect((await put({ handoffId: "bad-draft-1", draft: "draft" })).status).toBe(400);
    expect((await snapshot(g)).draftHandoff).toBeNull();
  });
});

/** 스냅숏 응답 머리(ETag)를 보려고 helpers.api 대신 직접 부른다. */
async function snapshotEtagOf(cookie: string, path: string): Promise<string | null> {
  const response = await SELF.fetch(`https://example.test${path}`, { headers: { Cookie: cookie } });
  await response.arrayBuffer();
  return response.headers.get("ETag");
}

describe("넘긴 편성 정리(예정 작업)", () => {
  it("넘긴 지 하루가 지난 것만 지운다", async () => {
    const g = await setupGroup(10);
    await hand(g, g.cookie, "keep-me-fresh");
    const now = Date.now();
    expect(await pruneDraftHandoffs(env, now + HANDOFF_KEEP_MS - 60_000)).toBe(0);
    expect((await snapshot(g)).draftHandoff?.id).toBe("keep-me-fresh");
    expect(await pruneDraftHandoffs(env, now + HANDOFF_KEEP_MS + 60_000)).toBeGreaterThanOrEqual(1);
    expect((await snapshot(g)).draftHandoff).toBeNull();
  });
});
