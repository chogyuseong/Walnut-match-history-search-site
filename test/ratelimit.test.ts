import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { rateClock } from "../src/server/ratelimit";
import { direct } from "./direct";
import { login, setupGroup, unique } from "./helpers";

// 계정·IP별 요청 수 제한(docs/P4 P4-4 위험 표). 한도 직전·초과·창이 지난 뒤를 확인한다.

const LIMITS: Partial<Env> = {
  RATE_WINDOW_SECONDS: "60",
  RATE_WRITE_PER_ACCOUNT: "3",
  RATE_WRITE_PER_IP: "5",
  RATE_AUTH_PER_IP: "2",
  RATE_VIEW_PER_IP: "3",
};

const realNow = rateClock.now;
afterEach(() => {
  rateClock.now = realNow;
});

/**
 * 창 경계 직후로 시계를 고정한다(경계에 걸려 창이 바뀌는 일을 막는다).
 * 준비 단계(모임 만들기)에서 센 요청과 섞이지 않게 10분 뒤의 창을 쓴다.
 */
function fixClock(): { advance: (ms: number) => void } {
  let now = Math.floor(Date.now() / 60_000) * 60_000 + 10 * 60_000 + 1000;
  rateClock.now = () => now;
  return { advance: (ms) => (now += ms) };
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return ((await response.json()) as { error: { code: string; message: string } }).error;
}

describe("요청 수 제한", () => {
  it("쓰기: IP별 한도까지는 처리하고, 넘으면 429와 쉬운 안내, 창이 지나면 다시 처리한다", async () => {
    const clock = fixClock();
    const ip = unique("ip");
    const send = () =>
      direct(LIMITS, "POST", "/api/groups", { body: {}, headers: { "CF-Connecting-IP": ip } });
    // 로그인하지 않은 요청도 센다(401이어도 한도는 쓴다).
    for (let i = 0; i < 5; i++) expect((await send()).status).toBe(401);
    const over = await send();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(0);
    const error = await errorOf(over);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("요청이 너무 잦아요");
    expect(error.message).toContain("초 뒤에 다시 시도해 주세요");

    // 다른 IP는 영향이 없다.
    const other = await direct(LIMITS, "POST", "/api/groups", {
      body: {},
      headers: { "CF-Connecting-IP": unique("ip") },
    });
    expect(other.status).toBe(401);

    clock.advance(60_000);
    expect((await send()).status).toBe(401);
  });

  it("쓰기: 계정별 한도는 IP가 달라도 합쳐 센다. 한도에 걸린 요청은 아무것도 바꾸지 않는다", async () => {
    const g = await setupGroup(10);
    const clock = fixClock();
    const rename = (name: string) =>
      direct(LIMITS, "PATCH", `/api/groups/${g.gid}`, {
        cookie: g.cookie,
        body: { name, requestId: unique("req") },
        headers: { "CF-Connecting-IP": unique("ip") },
      });
    expect((await rename("이름1")).status).toBe(200);
    expect((await rename("이름2")).status).toBe(200);
    expect((await rename("이름3")).status).toBe(200); // 한도 직전(3번째)까지 처리
    const over = await rename("이름4");
    expect(over.status).toBe(429);
    const row = await env.DB.prepare("SELECT name FROM groups WHERE id = ?1")
      .bind(g.gid)
      .first<{ name: string }>();
    expect(row!.name).toBe("이름3");

    clock.advance(61_000);
    expect((await rename("이름5")).status).toBe(200);
  });

  it("로그인 경로: IP별 한도. 로그인 시작(화면 이동)은 안내 화면으로 보낸다", async () => {
    const clock = fixClock();
    const ip = unique("ip");
    const fake = () =>
      direct({ ...LIMITS, AUTH_MODE: "fake" }, "POST", "/api/auth/fake-login", {
        body: { subject: unique("u") },
        headers: { "CF-Connecting-IP": ip },
      });
    expect((await fake()).status).toBe(200);
    expect((await fake()).status).toBe(200);
    expect((await fake()).status).toBe(429);
    const start = await direct(
      { ...LIMITS, KAKAO_CLIENT_ID: "k" },
      "GET",
      "/api/auth/kakao/start",
      { headers: { "CF-Connecting-IP": ip } },
    );
    expect(start.status).toBe(302);
    expect(start.headers.get("Location")).toBe("/#/login-failed/rate_limited");
    clock.advance(60_000);
    expect((await fake()).status).toBe(200);
  });

  it("조회 토큰 경로: IP별 한도(토큰 추측 방지)", async () => {
    const clock = fixClock();
    const ip = unique("ip");
    const view = () =>
      direct(LIMITS, "GET", `/api/view/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip } });
    for (let i = 0; i < 3; i++) expect((await view()).status).toBe(404);
    expect((await view()).status).toBe(429);
    // /api/me는 세지 않는다(스냅숏 한도는 test/snapshot-limits.test.ts).
    const cookie = await login();
    const meRes = await direct(LIMITS, "GET", "/api/me", { cookie, headers: { "CF-Connecting-IP": ip } });
    expect(meRes.status).toBe(200);
    clock.advance(60_000);
    expect((await view()).status).toBe(404);
  });

  it("IP 원문은 저장하지 않고 지난 창의 기록은 지운다", async () => {
    const clock = fixClock();
    const ip = "203.0.113.77";
    await direct(LIMITS, "GET", `/api/view/x`, { headers: { "CF-Connecting-IP": ip } });
    const rows = await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
    expect(rows.results.some((r) => r.key.includes(ip))).toBe(false);
    clock.advance(120_000);
    await direct(LIMITS, "GET", `/api/view/x`, { headers: { "CF-Connecting-IP": unique("ip") } });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE window_start < ?1")
      .bind(Math.floor(rateClock.now() / 60_000) * 60_000)
      .first<{ n: number }>();
    expect(after!.n).toBe(0);
  });
  it("한도를 넘긴 창의 추가 요청은 쓰기 없이 429다: 카운트는 limit + 1에서 멈추고 걸린 횟수는 창마다 1이다", async () => {
    // 다른 테스트의 창과 섞이지 않게 37분 뒤 창을 쓴다(카운트 행을 창으로 찾는다).
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000 + 37 * 60_000;
    let now = windowStart + 1000;
    rateClock.now = () => now;
    const day = new Date(now).toISOString().slice(0, 10);
    const hitsNow = async () =>
      (await env.DB.prepare("SELECT count FROM rate_limit_hits WHERE day = ?1 AND bucket = 'view-ip'")
        .bind(day)
        .first<{ count: number }>())?.count ?? 0;
    const hitsBefore = await hitsNow();
    const ip = unique("ip");
    const view = () => direct(LIMITS, "GET", `/api/view/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip } });

    for (let i = 0; i < 3; i++) expect((await view()).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await view()).status).toBe(429);
    const counted = await env.DB.prepare("SELECT count FROM rate_limits WHERE window_start = ?1")
      .bind(windowStart)
      .all<{ count: number }>();
    expect(counted.results.map((r) => r.count)).toEqual([4]);
    expect(await hitsNow()).toBe(hitsBefore + 1);

    // 다음 창에서 다시 넘기면 그 창의 몫으로 1을 더 센다.
    now += 60_000;
    for (let i = 0; i < 3; i++) expect((await view()).status).toBe(404);
    expect((await view()).status).toBe(429);
    expect((await view()).status).toBe(429);
    expect(await hitsNow()).toBe(hitsBefore + 2);
  });

  it("다른 Worker가 보낸 요청(CF-Worker)은 CF-Connecting-IP가 달라도 zone 하나로 센다", async () => {
    fixClock();
    const zone = `${unique("zone")}.example`;
    const view = (headers: Record<string, string>) =>
      direct(LIMITS, "GET", `/api/view/${unique("nope")}`, { headers });
    for (let i = 0; i < 3; i++) {
      expect((await view({ "CF-Worker": zone, "CF-Connecting-IP": unique("ip") })).status).toBe(404);
    }
    // 대소문자·앞뒤 공백만 다른 값도 같은 zone이다.
    expect((await view({ "CF-Worker": ` ${zone.toUpperCase()} `, "CF-Connecting-IP": unique("ip") })).status).toBe(429);
    // CF-Worker가 없는 보통 요청은 IP로 따로 센다.
    expect((await view({ "CF-Connecting-IP": unique("ip") })).status).toBe(404);
  });
});
