import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/server/env";
import { ApiError, CONTENT_SECURITY_POLICY, PERMISSIONS_POLICY, pathForLog, readJsonBody } from "../src/server/http";
import app from "../src/server/index";
import { rateClock } from "../src/server/ratelimit";
import { direct } from "./direct";
import { api, requestId, setupGroup, unique } from "./helpers";
import headersFile from "../public/_headers?raw";

// 검토 L5(CSRF: Origin·Content-Type), L6(본문 크기), L7(비싼 GET 요청 수), L8(로그의 토큰).

const realRateNow = rateClock.now;
afterEach(() => {
  vi.restoreAllMocks();
  rateClock.now = realRateNow;
});

/** 헤더를 그대로 실어 서버를 직접 부른다(direct는 Content-Type을 덮어쓴다). */
async function raw(
  method: string,
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
  overrides: Partial<Env> = {},
  base = "https://example.test",
): Promise<Response> {
  const request = new Request(`${base}${path}`, { method, headers: init.headers ?? {}, body: init.body });
  return await app.fetch(request, { ...(env as unknown as Env), ...overrides });
}

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as any).error?.code;
}

describe("다른 사이트의 쓰기 요청(검토 L5)", () => {
  it("Origin이 다르면 거절하고, 같거나 없으면 받는다", async () => {
    const g = await setupGroup(0);
    const json = { "Content-Type": "application/json", Cookie: g.cookie };
    const body = JSON.stringify({ name: "바뀐 이름", requestId: requestId() });
    for (const origin of ["https://evil.example", "http://example.test", "https://example.test.evil.net", "null"]) {
      const res = await raw("PATCH", `/api/groups/${g.gid}`, { headers: { ...json, Origin: origin }, body });
      expect(res.status, origin).toBe(403);
      expect(await codeOf(res)).toBe("BAD_ORIGIN");
    }
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).body.group.name).not.toBe("바뀐 이름");
    const same = await raw("PATCH", `/api/groups/${g.gid}`, { headers: { ...json, Origin: "https://example.test" }, body });
    expect(same.status).toBe(200);
    const none = await raw("PATCH", `/api/groups/${g.gid}`, { headers: json, body: JSON.stringify({ name: "또 바꿈", requestId: requestId() }) });
    expect(none.status).toBe(200);
    // 읽기(GET)는 Origin을 보지 않는다.
    const read = await raw("GET", `/api/groups/${g.gid}/snapshot`, { headers: { Cookie: g.cookie, Origin: "https://evil.example" } });
    expect(read.status).toBe(200);
  });

  it("PUBLIC_ORIGIN이 있으면 그 주소만 같은 사이트로 본다", async () => {
    const overrides = { PUBLIC_ORIGIN: "https://naejeon.example.test/" } as Partial<Env>;
    const send = (origin: string) =>
      raw("POST", "/api/auth/logout", { headers: { Origin: origin } }, overrides);
    expect((await send("https://naejeon.example.test")).status).toBe(200);
    // 요청 자신의 주소(workers.dev 쪽)여도 PUBLIC_ORIGIN이 아니면 거절한다.
    expect((await send("https://example.test")).status).toBe(403);
  });

  it("JSON 본문 경로는 Content-Type: application/json만 받는다", async () => {
    const g = await setupGroup(0);
    const body = JSON.stringify({ name: "바뀌면 안 됨" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", ""]) {
      const headers: Record<string, string> = { Cookie: g.cookie };
      if (type) headers["Content-Type"] = type;
      const res = await raw("PATCH", `/api/groups/${g.gid}`, { headers, body });
      expect(res.status, type).toBe(415);
      expect(await codeOf(res)).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    const ok = await raw("PATCH", `/api/groups/${g.gid}`, {
      headers: { Cookie: g.cookie, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ name: "바꿈", requestId: requestId() }),
    });
    expect(ok.status).toBe(200);
  });
});

describe("본문 크기(검토 L6)", () => {
  function counting(chunk: Uint8Array, count: number): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= count) return controller.close();
        pulled += 1;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 }); // 읽을 때만 만든다(미리 채우지 않음).
    return { stream, pulled: () => pulled };
  }

  async function errorOf(promise: Promise<unknown>): Promise<ApiError | null> {
    try {
      await promise;
      return null;
    } catch (e) {
      return e as ApiError;
    }
  }

  it("Content-Length가 상한보다 크면 본문을 읽지 않고 바로 거절한다", async () => {
    const { stream, pulled } = counting(new TextEncoder().encode("{}"), 1);
    const req = new Request("https://example.test/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: stream,
    });
    const error = await errorOf(readJsonBody(req, 1024));
    expect(error?.status).toBe(413);
    expect(pulled()).toBe(0);
  });

  it("길이가 없는 스트림은 읽다가 상한을 넘는 순간 멈춘다", async () => {
    const { stream, pulled } = counting(new Uint8Array(512).fill(0x20), 1000);
    const req = new Request("https://example.test/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
    });
    const error = await errorOf(readJsonBody(req, 4096));
    expect(error?.status).toBe(413);
    expect(pulled()).toBeLessThan(20);
  });

  it("한글 본문은 바이트로 센다. 상한 안이면 그대로 읽는다", async () => {
    const text = JSON.stringify({ name: "가".repeat(100) });
    const make = () =>
      new Request("https://example.test/x", { method: "POST", headers: { "Content-Type": "application/json" }, body: text });
    expect((await readJsonBody(make(), 400)).name).toBe("가".repeat(100));
    expect((await errorOf(readJsonBody(make(), 200)))?.status).toBe(413);
  });

  it("경로별 상한: 보통 경로는 16KB를 넘으면 413", async () => {
    const g = await setupGroup(0);
    const res = await raw("PATCH", `/api/groups/${g.gid}`, {
      headers: { Cookie: g.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(20 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("비싼 GET 경로의 요청 수 제한(검토 L7)", () => {
  it("백업 내려받기·합치기 미리보기·지문 목록은 계정별 한도를 넘으면 429", async () => {
    const g = await setupGroup(2);
    // 세 번의 요청이 60초 창의 경계를 넘으면 숫자가 처음부터 다시 세어져 가끔 실패했다. 창 가운데에 시계를 고정한다.
    const fixed = Math.floor(Date.now() / 60_000) * 60_000 + 50 * 60_000 + 30_000;
    rateClock.now = () => fixed;
    const limits = { RATE_HEAVY_PER_ACCOUNT: "2", RATE_HEAVY_PER_IP: "1000" } as Partial<Env>;
    for (const path of [
      `/api/groups/${g.gid}/export`,
      `/api/groups/${g.gid}/merges/preview?source=${g.people[0]!.id}&target=${g.people[1]!.id}`,
      `/api/groups/${g.gid}/imports/fingerprints`,
    ]) {
      const fresh = await setupGroup(2);
      const target = path.replace(g.gid, fresh.gid).replace(g.people[0]!.id, fresh.people[0]!.id).replace(g.people[1]!.id, fresh.people[1]!.id);
      const ip = unique("ip");
      const send = () => direct(limits, "GET", target, { cookie: fresh.cookie, headers: { "CF-Connecting-IP": ip } });
      expect((await send()).status, target).toBe(200);
      expect((await send()).status, target).toBe(200);
      const third = await send();
      expect(third.status, target).toBe(429);
      expect(third.headers.get("Retry-After")).toBeTruthy();
    }
  });

  it("운영자 스냅숏과 /api/me는 세지 않는다", async () => {
    const g = await setupGroup(0);
    const limits = { RATE_HEAVY_PER_ACCOUNT: "1", RATE_HEAVY_PER_IP: "1" } as Partial<Env>;
    for (let i = 0; i < 3; i++) {
      expect((await direct(limits, "GET", `/api/groups/${g.gid}/snapshot`, { cookie: g.cookie })).status).toBe(200);
      expect((await direct(limits, "GET", "/api/me", { cookie: g.cookie })).status).toBe(200);
    }
  });
});

describe("보안 헤더(2026-11-07)", () => {
  const expected = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": PERMISSIONS_POLICY,
    "x-frame-options": "DENY",
  };

  it("API 응답(정상·오류·없는 경로)에 CSP·nosniff·Referrer-Policy·Permissions-Policy가 붙는다", async () => {
    const g = await setupGroup(0);
    const responses = [
      await raw("GET", "/api/health"),
      await raw("GET", `/api/groups/${g.gid}/snapshot`, { headers: { Cookie: g.cookie } }),
      await raw("GET", "/api/nope"),
      await raw("PATCH", `/api/groups/${g.gid}`, { headers: { Cookie: g.cookie, "Content-Type": "text/plain" }, body: "x" }),
    ];
    for (const res of responses) {
      for (const [name, value] of Object.entries(expected)) expect(res.headers.get(name), `${res.status} ${name}`).toBe(value);
      // HSTS는 운영에서만.
      expect(res.headers.get("strict-transport-security")).toBeNull();
    }
    const csp = CONTENT_SECURITY_POLICY;
    for (const part of ["default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "connect-src 'self'", "img-src 'self' data: blob:"]) {
      expect(csp).toContain(part);
    }
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    // 챔피언 초상화(Data Dragon)만 그림 출처로 더했다. 정적 화면 헤더(public/_headers)도 같은 값이어야 한다.
    expect(csp).toContain("img-src 'self' data: blob: https://ddragon.leagueoflegends.com;");
    expect(headersFile).toContain(`Content-Security-Policy: ${csp}`);
  });

  it("운영(DEPLOY_ENV=production)에서는 HSTS도 붙는다(설정 오류 503 응답에도)", async () => {
    const res = await raw("GET", "/api/health", {}, { DEPLOY_ENV: "production" } as Partial<Env>);
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(res.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
  });
});

describe("로그에 토큰을 남기지 않는다(검토 L8)", () => {
  it("경로의 조회 토큰·인수 토큰을 가린다", () => {
    expect(pathForLog("/api/view/AbCdEf123_-x")).toBe("/api/view/[token]");
    expect(pathForLog("/api/transfer/secret-token/accept")).toBe("/api/transfer/[token]/accept");
    expect(pathForLog("/api/groups/g1/snapshot")).toBe("/api/groups/g1/snapshot");
  });

  it("500 오류 로그 문자열에 토큰이 없다", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const broken = {
      prepare() {
        throw new Error("테스트: DB 실패");
      },
      batch() {
        throw new Error("테스트: DB 실패");
      },
    } as unknown as D1Database;
    const token = "VeryS3cretViewToken_abc";
    const res = await raw("GET", `/api/view/${token}`, {}, { DB: broken, RATE_VIEW_PER_IP: "100000" });
    expect(res.status).toBe(500);
    const transfer = await raw("GET", `/api/transfer/${token}`, {}, { DB: broken });
    expect(transfer.status).toBe(500);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(token);
    expect(lines.join("\n")).toContain("/api/view/[token]");
  });
});
