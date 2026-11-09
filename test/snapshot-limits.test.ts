import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { rateClock } from "../src/server/ratelimit";
import type { Snapshot } from "../src/shared/types";
import { direct } from "./direct";
import { api, login, setupGroup, unique, type TestGroup } from "./helpers";

// 2026-11-09 서버 후속(docs/개선-서버-2026-11-09.md): 운영자·멤버 스냅숏의 요청 수 제한(200만 셈, 304는 세지 않음)과
// 멤버 스냅숏의 조건부 요청(ETag·304).

const realNow = rateClock.now;
afterEach(() => {
  rateClock.now = realNow;
});

/** 창 경계 직후로 시계를 고정한다. 다른 테스트·준비 단계와 섞이지 않게 30분 뒤의 창을 쓴다. */
function fixClock(): void {
  const now = Math.floor(Date.now() / 60_000) * 60_000 + 30 * 60_000 + 1000;
  rateClock.now = () => now;
}

/** g의 참가자 pid를 새 계정과 연결한다. */
async function link(g: TestGroup, pid: string): Promise<string> {
  const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${pid}/claim-link`)).body.token as string;
  const member = await login();
  expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);
  return member;
}

function getter(limits: Partial<Env>, path: string, cookie: string, ip = unique("ip")) {
  return (etag?: string) =>
    direct(limits, "GET", path, {
      cookie,
      headers: { "CF-Connecting-IP": ip, ...(etag ? { "If-None-Match": etag } : {}) },
    });
}

describe("스냅숏 요청 수 제한(200만 셈)", () => {
  it("운영자 스냅숏: 계정 한도 30, 31번째 200 요청은 429. 304는 세지 않고 한도에 걸려도 304는 된다", async () => {
    const g = await setupGroup(2);
    fixClock();
    const limits: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_SNAPSHOT_PER_ACCOUNT: "30", RATE_SNAPSHOT_PER_IP: "1000" };
    const get = getter(limits, `/api/groups/${g.gid}/snapshot`, g.cookie);
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    for (let i = 0; i < 10; i++) expect((await get(etag)).status).toBe(304);
    // 304를 열 번 받았어도 200은 서른 번까지 된다.
    for (let i = 2; i <= 30; i++) expect((await get()).status, `${i}번째 200`).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    // 429에는 ETag·private 캐시 헤더가 붙지 않는다(브라우저가 저장해 304로 되살리지 않게).
    expect(over.headers.get("ETag")).toBeNull();
    expect(over.headers.get("Cache-Control")).toBe("no-store");
    expect((await get(etag)).status).toBe(304);
  });

  it("운영자 스냅숏: IP 한도는 계정이 달라도 합쳐 센다", async () => {
    const a = await setupGroup(2);
    const b = await setupGroup(2);
    fixClock();
    const ip = unique("ip");
    const limits: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_SNAPSHOT_PER_ACCOUNT: "100", RATE_SNAPSHOT_PER_IP: "2" };
    expect((await getter(limits, `/api/groups/${a.gid}/snapshot`, a.cookie, ip)()).status).toBe(200);
    expect((await getter(limits, `/api/groups/${b.gid}/snapshot`, b.cookie, ip)()).status).toBe(200);
    expect((await getter(limits, `/api/groups/${b.gid}/snapshot`, b.cookie, ip)()).status).toBe(429);
    // 다른 IP는 영향이 없다.
    expect((await getter(limits, `/api/groups/${a.gid}/snapshot`, a.cookie)()).status).toBe(200);
  });

  it("멤버 스냅숏: 304는 세지 않고 200은 센다", async () => {
    const g = await setupGroup(2);
    const member = await link(g, g.people[0]!.id);
    fixClock();
    const limits: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_SNAPSHOT_PER_ACCOUNT: "2", RATE_SNAPSHOT_PER_IP: "1000" };
    const get = getter(limits, `/api/member/${g.gid}/snapshot`, member);
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    for (let i = 0; i < 5; i++) expect((await get(etag)).status).toBe(304);
    expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(over.headers.get("ETag")).toBeNull();
    expect((await get(etag)).status).toBe(304);
  });
});

describe("멤버 스냅숏 ETag(304)", () => {
  it("ETag를 주고 같은 ETag면 304, 내 요청을 남기거나 운영자가 처리하면 ETag가 바뀐다", async () => {
    const g = await setupGroup(3);
    const pid = g.people[0]!.id;
    const member = await link(g, pid);
    const get = getter({}, `/api/member/${g.gid}/snapshot`, member);

    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(first.headers.get("Vary")).toContain("Cookie");
    const body = (await first.json()) as Snapshot;
    expect(body.me!.participantId).toBe(pid);
    expect(body.me!.requests).toEqual([]);

    const again = await get(etag);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(etag);

    // 내 요청을 남긴다 → ETag가 바뀌고 본문에 요청이 보인다.
    const created = await api(member, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "지워 주세요" });
    expect(created.status).toBe(200);
    const afterCreate = await get(etag);
    expect(afterCreate.status).toBe(200);
    const etag2 = afterCreate.headers.get("ETag")!;
    expect(etag2).not.toBe(etag);
    expect(((await afterCreate.json()) as Snapshot).me!.requests.map((r) => r.status)).toEqual(["open"]);
    expect((await get(etag2)).status).toBe(304);

    // 운영자가 처리한다(요청 상태 open → done) → ETag가 바뀐다.
    const resolved = await api(g.cookie, "POST", `/api/groups/${g.gid}/member-requests/${created.body.id}/resolve`, {
      status: "done",
      reply: "처리했어요",
    });
    expect(resolved.status).toBe(200);
    const afterResolve = await get(etag2);
    expect(afterResolve.status).toBe(200);
    const etag3 = afterResolve.headers.get("ETag")!;
    expect(etag3).not.toBe(etag2);
    expect(((await afterResolve.json()) as Snapshot).me!.requests[0]).toMatchObject({ status: "done", reply: "처리했어요" });
    expect((await get(etag3)).status).toBe(304);
  });

  it("같은 모임이라도 멤버마다(참가자·계정) ETag가 다르고, 남의 ETag로는 304를 받지 못한다", async () => {
    const g = await setupGroup(3);
    const memberA = await link(g, g.people[0]!.id);
    const memberB = await link(g, g.people[1]!.id);
    const path = `/api/member/${g.gid}/snapshot`;
    const etagA = (await getter({}, path, memberA)()).headers.get("ETag")!;
    const etagB = (await getter({}, path, memberB)()).headers.get("ETag")!;
    expect(etagA).not.toBe(etagB);
    const crossed = await getter({}, path, memberB)(etagA);
    expect(crossed.status).toBe(200);
    expect(((await crossed.json()) as Snapshot).me!.participantId).toBe(g.people[1]!.id);
    // 조회 링크의 ETag와도 다르다(같은 모임 행이라도 멤버 응답은 me가 더 있다).
    const token = (await api<Snapshot>(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).body.group.viewToken!;
    const viewEtag = (await direct({}, "GET", `/api/view/${token}`, { headers: { "CF-Connecting-IP": unique("ip") } }))
      .headers.get("ETag")!;
    expect(viewEtag).not.toBe(etagA);
    expect((await getter({}, path, memberA)(viewEtag)).status).toBe(200);
  });

  it("연결이 끊기면 같은 ETag를 보내도 404(304로 예전 본문을 되살리지 않는다)", async () => {
    const g = await setupGroup(2);
    const member = await link(g, g.people[0]!.id);
    const get = getter({}, `/api/member/${g.gid}/snapshot`, member);
    const etag = (await get()).headers.get("ETag")!;
    expect((await api(member, "POST", `/api/member/${g.gid}/unlink`)).status).toBe(200);
    expect((await get(etag)).status).toBe(404);
  });
});
