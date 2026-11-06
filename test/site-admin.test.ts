import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { rateClock } from "../src/server/ratelimit";
import { direct } from "./direct";
import { api, login, playConfirmed, rosterOf, setupGroup, unique } from "./helpers";

// 사이트 운영자 현황(GET /api/admin/overview, src/server/siteAdmin.ts).
// 사이트 운영자는 SITE_ADMIN_ACCOUNT_IDS로만 정한다. 아니면(일반 계정·모임 운영자·공동 운영자·비로그인) 404.

async function accountIdOf(cookie: string): Promise<string> {
  return (await api(cookie, "GET", "/api/me")).body.accountId as string;
}

function asAdmin(ids: string): Partial<Env> {
  return { SITE_ADMIN_ACCOUNT_IDS: ids };
}

const realNow = rateClock.now;
afterEach(() => {
  rateClock.now = realNow;
});

describe("사이트 운영자 확인", () => {
  it("목록이 비어 있으면 아무도 못 본다(404)", async () => {
    const cookie = await login();
    const response = await direct(asAdmin(""), "GET", "/api/admin/overview", { cookie });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("일반 계정·모임 운영자·공동 운영자·비로그인은 404, 목록의 계정만 200", async () => {
    const admin = await login();
    const adminId = await accountIdOf(admin);
    const config = asAdmin(`someone-else, ${adminId}`);

    const plain = await login();
    const owner = await setupGroup(2);
    // 공동 운영자
    const invite = await api(owner.cookie, "POST", `/api/groups/${owner.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);

    for (const cookie of [null, plain, owner.cookie, co]) {
      const response = await direct(config, "GET", "/api/admin/overview", { cookie });
      expect(response.status).toBe(404);
      const me = (await (await direct(config, "GET", "/api/me", { cookie })).json()) as Record<string, unknown>;
      expect(me.siteAdmin).toBeUndefined();
    }
    expect((await direct(config, "GET", "/api/admin/overview", { cookie: admin })).status).toBe(200);
    const me = (await (await direct(config, "GET", "/api/me", { cookie: admin })).json()) as Record<string, unknown>;
    expect(me.siteAdmin).toBe(true);
    // 설정이 없는 서버(기본 SELF)에서는 같은 계정도 사이트 운영자가 아니다.
    expect((await api(admin, "GET", "/api/me")).body.siteAdmin).toBeUndefined();
  });

  it("로컬 전용 꼴 fake:로그인이름은 그 가짜 계정에만 맞는다", async () => {
    const subject = unique("site-admin");
    const cookie = await login(subject);
    const other = await login();
    expect((await direct(asAdmin(`fake:${subject}`), "GET", "/api/admin/overview", { cookie })).status).toBe(200);
    expect((await direct(asAdmin(`fake:${subject}`), "GET", "/api/admin/overview", { cookie: other })).status).toBe(404);
    // 가짜 로그인이 닫힌 설정(AUTH_MODE=oauth)에서는 이 꼴을 받지 않는다(가짜 세션 자체도 받지 않는다).
    expect(
      (await direct({ ...asAdmin(`fake:${subject}`), AUTH_MODE: "oauth" }, "GET", "/api/admin/overview", { cookie }))
        .status,
    ).toBe(404);
  });
});

describe("현황 응답", () => {
  it("전체 수치만: 모임 이름·참가자 이름·경기 내용·계정 ID가 없다", async () => {
    const groupName = unique("비밀모임이름");
    const owner = await login();
    const created = await api(owner, "POST", "/api/groups", { name: groupName });
    const gid = created.body.id as string;
    const names = Array.from({ length: 10 }, (_, i) => unique(`비밀참가자${i}`));
    const people = (await api(owner, "POST", `/api/groups/${gid}/participants`, { names })).body.participants;
    const match = await playConfirmed({ cookie: owner, gid, people }, rosterOf(people));
    const memo = await api(owner, "POST", `/api/groups/${gid}/matches/${match.id}/memo`, {
      requestId: unique("req"),
      memo: "비밀메모내용",
      baseMemo: null,
    });
    expect(memo.status).toBe(200);

    const admin = await login();
    const adminId = await accountIdOf(admin);
    const response = await direct(asAdmin(adminId), "GET", "/api/admin/overview", { cookie: admin });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.totals.accounts).toBeGreaterThanOrEqual(2);
    expect(body.totals.groups).toBeGreaterThanOrEqual(1);
    expect(body.totals.matches).toBeGreaterThanOrEqual(1);
    expect(body.totals.participants).toBeGreaterThanOrEqual(10);
    expect(body.recent.map((r: { days: number }) => r.days)).toEqual([7, 30]);
    expect(body.recent[0].activeGroups).toBeGreaterThanOrEqual(1);
    expect(body.recent[0].newGroups).toBeGreaterThanOrEqual(1);
    expect(body.recent[0].newAccounts).toBeGreaterThanOrEqual(2);
    expect(text).not.toContain(groupName);
    for (const name of names) expect(text).not.toContain(name);
    expect(text).not.toContain("비밀메모내용");
    expect(text).not.toContain(gid);
    expect(text).not.toContain(match.id);
    expect(text).not.toContain(adminId);
    expect(Object.keys(body).sort()).toEqual(["errors", "generatedAt", "rateLimited", "recent", "totals"]);
  });

  it("오류 목록은 같은 오류를 묶어 건수와 스택을 주고, 요청 수 제한에 걸린 횟수도 준다. 비우기는 사이트 운영자만", async () => {
    const message = unique("현황테스트오류");
    for (let i = 0; i < 3; i++) {
      const sent = await api(null, "POST", "/api/client-errors", {
        kind: "boundary",
        message,
        stack: `Error: ${message}\n    at Comp (app.js:1:1)`,
        path: "#/records",
      });
      expect(sent.status).toBe(200);
    }
    // 한도에 한 번 걸리게 한다.
    rateClock.now = () => Math.floor(Date.now() / 60_000) * 60_000 + 30 * 60_000 + 1000;
    const ip = unique("ip");
    const limits = { RATE_CLIENT_ERROR_PER_IP: "1" };
    for (let i = 0; i < 2; i++) {
      await direct(limits, "POST", "/api/client-errors", {
        body: { kind: "error", message: "x" },
        headers: { "CF-Connecting-IP": ip },
      });
    }
    rateClock.now = realNow;

    const admin = await login();
    const config = asAdmin(await accountIdOf(admin));
    const body = (await (await direct(config, "GET", "/api/admin/overview", { cookie: admin })).json()) as any;
    const group = body.errors.groups.find((g: { message: string }) => g.message === message);
    expect(group).toMatchObject({ source: "client", kind: "boundary", path: "#/records", count: 3 });
    expect(group.stack).toContain("at Comp");
    expect(body.errors.total).toBeGreaterThanOrEqual(3);
    expect(body.errors.byKind.some((k: { kind: string }) => k.kind === "boundary")).toBe(true);
    expect(body.rateLimited.find((r: { bucket: string }) => r.bucket === "client-error-ip").last30).toBeGreaterThanOrEqual(1);

    // 비우기: 일반 계정은 404, 사이트 운영자는 지운다.
    const plain = await login();
    expect((await direct(config, "POST", "/api/admin/errors/clear", { cookie: plain, body: {} })).status).toBe(404);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM error_logs").first<{ n: number }>())!.n).toBeGreaterThan(0);
    const cleared = await direct(config, "POST", "/api/admin/errors/clear", { cookie: admin, body: {} });
    expect(cleared.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM error_logs").first<{ n: number }>())!.n).toBe(0);
  });
});
