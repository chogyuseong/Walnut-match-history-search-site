import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { ERROR_LOG_MAX_DAYS, ERROR_LOG_MAX_ROWS, errorLogClock, recordError } from "../src/server/errorLog";
import { rateClock } from "../src/server/ratelimit";
import { browserKind, ERROR_MESSAGE_MAX, ERROR_STACK_MAX, isNoise, scrubPath, scrubText } from "../src/shared/errorScrub";
import { direct } from "./direct";
import { api, login, setupGroup, snapshot, unique } from "./helpers";

// 오류 수집(migrations/0018, src/server/errorLog.ts): 가림 처리, 길이 자르기, 요청 수 제한, 보관 한도, 서버 오류, 4xx 제외.

const TOKEN = "Zq3vK8xP2mN7wR4tY6uB1c"; // 조회 토큰 꼴(22자)
const UUID = "2f1c9a3e-7b4d-4e8a-9c1f-0a2b3c4d5e6f";

interface Row {
  id: number;
  source: string;
  kind: string;
  message: string;
  stack: string | null;
  path: string | null;
  app_version: string | null;
  browser: string | null;
  created_at: string;
}

async function rows(): Promise<Row[]> {
  return (await env.DB.prepare("SELECT * FROM error_logs ORDER BY id").all<Row>()).results;
}

async function lastRow(): Promise<Row> {
  return (await env.DB.prepare("SELECT * FROM error_logs ORDER BY id DESC LIMIT 1").first<Row>())!;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch("https://example.test/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const realRateNow = rateClock.now;
const realLogNow = errorLogClock.now;
afterEach(() => {
  rateClock.now = realRateNow;
  errorLogClock.now = realLogNow;
});

describe("가림 처리(공용 함수)", () => {
  it("경로의 토큰·ID 칸을 가리고 화면 이름·경기 번호만 남긴다", () => {
    expect(scrubPath(`#/v/${TOKEN}/p/${UUID}`)).toBe("#/v/[token]/p/[id]");
    expect(scrubPath(`#/join/abc`)).toBe("#/join/[token]");
    expect(scrubPath(`/api/view/${TOKEN}`)).toBe("/api/view/[token]");
    expect(scrubPath(`/api/groups/${UUID}/matches/${UUID}/result`)).toBe("/api/groups/[id]/matches/[id]/result");
    expect(scrubPath(`#/v/${TOKEN}/m/12`)).toBe("#/v/[token]/m/12");
    expect(scrubPath(`#/season/year/2026`)).toBe("#/season/year/2026");
    expect(scrubPath(`/api/groups/x?token=${TOKEN}`)).toBe("/api/groups/x?[가림]");
  });

  it("메시지·스택 속 주소와 토큰처럼 보이는 값을 가리고 길이를 자른다", () => {
    const text = scrubText(
      `GET https://naejeon.example.com/api/view/${TOKEN}?x=1 실패, id ${UUID}, token=abc123 a@b.com sid: zzz`,
      ERROR_MESSAGE_MAX,
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(UUID);
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("a@b.com");
    expect(text).not.toContain("zzz");
    expect(text).toContain("https://naejeon.example.com/api/view/[token]?[가림]");
    // 스택의 파일:줄:칸은 남는다.
    expect(scrubText("at f (https://x.test/assets/index-B4xY3kL9.js:1:234)", 500)).toBe(
      "at f (https://x.test/assets/index-B4xY3kL9.js:1:234)",
    );
    const long = scrubText("가".repeat(5000), ERROR_MESSAGE_MAX);
    expect(long.length).toBe(ERROR_MESSAGE_MAX);
    expect(browserKind("Mozilla/5.0 (iPhone) AppleWebKit Version/17 Mobile Safari/604.1")).toBe("Safari 모바일");
    expect(browserKind(null)).toBeNull();
  });

  it("고칠 수 없는 잡음(다른 출처 Script error, ResizeObserver 경고)은 화면이 보내지 않는다", () => {
    expect(isNoise("Script error.", null)).toBe(true);
    expect(isNoise("Script error.", "at x")).toBe(false);
    expect(isNoise("ResizeObserver loop completed with undelivered notifications.", null)).toBe(true);
    expect(isNoise("TypeError: x is undefined", null)).toBe(false);
  });
});

describe("POST /api/client-errors", () => {
  it("로그인 없이 받고, 경로·메시지·스택의 토큰·ID를 가려 저장한다. 계정·IP·쿠키는 저장하지 않는다", async () => {
    const cookie = await login();
    const ip = "203.0.113.77";
    const response = await post(
      {
        kind: "error",
        message: `TypeError: 못 읽음 https://example.test/#/v/${TOKEN}/now ${UUID}`,
        stack: `TypeError\n    at x (https://example.test/assets/app.js:1:2)\n    at y (/api/join/${TOKEN})`,
        path: `#/v/${TOKEN}/p/${UUID}`,
        appVersion: "2026.11.06",
      },
      { Cookie: cookie, "CF-Connecting-IP": ip, "User-Agent": "Mozilla/5.0 (X11) Chrome/130.0 Safari/537.36" },
    );
    expect(response.status).toBe(200);
    const row = await lastRow();
    expect(row.source).toBe("client");
    expect(row.kind).toBe("error");
    expect(row.path).toBe("#/v/[token]/p/[id]");
    expect(row.app_version).toBe("2026.11.06");
    expect(row.browser).toBe("Chrome");
    const all = JSON.stringify(row);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(UUID);
    expect(all).not.toContain(ip);
    expect(all).not.toContain(cookie.split("=")[1]!.slice(0, 20));
    // 표에 계정·IP·쿠키·본문을 담을 칸이 없다.
    const columns = (await env.DB.prepare("PRAGMA table_info(error_logs)").all<{ name: string }>()).results.map(
      (c) => c.name,
    );
    expect(columns.sort()).toEqual(
      ["app_version", "browser", "created_at", "id", "kind", "message", "path", "source", "stack"].sort(),
    );
  });

  it("긴 메시지·스택은 잘라서 저장한다", async () => {
    const response = await post({ kind: "rejection", message: "가".repeat(900), stack: "나".repeat(3500) });
    expect(response.status).toBe(200);
    const row = await lastRow();
    expect(row.message.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX);
    expect(row.stack!.length).toBeLessThanOrEqual(ERROR_STACK_MAX);
    expect(row.path).toBeNull();
  });

  it("JSON만, 크기 제한, 모르는 항목·종류 거절, 다른 사이트 Origin 거절", async () => {
    const before = (await rows()).length;
    expect((await post("message=x", { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post({ kind: "error", message: "x".repeat(20_000) })).status).toBe(413);
    expect((await post({ kind: "error", message: "x", cookie: "sid=1" })).status).toBe(400);
    expect((await post({ kind: "server", message: "x" })).status).toBe(400);
    expect((await post({ kind: "error", message: "x" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await rows()).length).toBe(before);
  });

  it("IP별 요청 수 제한: 한도를 넘으면 429이고 걸린 횟수를 센다(누구인지는 남기지 않는다)", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000 + 20 * 60_000 + 1000;
    rateClock.now = () => now;
    const ip = unique("ip");
    const limits: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_CLIENT_ERROR_PER_IP: "2" };
    const send = () =>
      direct(limits, "POST", "/api/client-errors", {
        body: { kind: "error", message: "반복 오류" },
        headers: { "CF-Connecting-IP": ip },
      });
    const day = new Date(now).toISOString().slice(0, 10);
    const hitsBefore =
      (await env.DB.prepare("SELECT count FROM rate_limit_hits WHERE day = ?1 AND bucket = 'client-error-ip'")
        .bind(day)
        .first<{ count: number }>())?.count ?? 0;
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    const hits = await env.DB.prepare("SELECT * FROM rate_limit_hits WHERE day = ?1 AND bucket = 'client-error-ip'")
      .bind(day)
      .first<{ count: number }>();
    expect(hits!.count).toBe(hitsBefore + 1);
    expect(Object.keys(hits!).sort()).toEqual(["bucket", "count", "day"]);
    // 오류 보고 한도는 쓰기 한도와 따로다: 다른 사람의 쓰기는 영향이 없다.
    now += 60_000;
    expect((await send()).status).toBe(200);
  });
});

describe("보관 한도", () => {
  it(`최근 ${ERROR_LOG_MAX_ROWS}건과 ${ERROR_LOG_MAX_DAYS}일을 넘은 기록은 넣을 때 지운다`, async () => {
    const old = new Date(Date.now() - (ERROR_LOG_MAX_DAYS + 1) * 24 * 3600_000).toISOString();
    await env.DB.prepare(
      "INSERT INTO error_logs (created_at, source, kind, message) VALUES (?1, 'client', 'error', '오래된 오류')",
    )
      .bind(old)
      .run();
    // 한도보다 많이 채운다.
    const stmts = Array.from({ length: ERROR_LOG_MAX_ROWS + 20 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO error_logs (created_at, source, kind, message) VALUES (?1, 'client', 'error', ?2)",
      ).bind(new Date().toISOString(), `채움 ${i}`),
    );
    await env.DB.batch(stmts);
    await recordError(env as unknown as Env, {
      source: "client",
      kind: "error",
      message: "새 오류",
      stack: null,
      path: null,
      appVersion: null,
      browser: null,
    });
    const all = await rows();
    expect(all.length).toBe(ERROR_LOG_MAX_ROWS);
    expect(all.some((r) => r.message === "오래된 오류")).toBe(false);
    expect(all.at(-1)!.message).toBe("새 오류");
    expect(all.some((r) => r.message === "채움 0")).toBe(false);
  });

  it("건수 한도는 출처마다 따로다: 화면 오류가 아무리 쌓여도 서버 오류 기록은 지워지지 않는다", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare("DELETE FROM error_logs").run();
    await env.DB.batch(
      Array.from({ length: 3 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO error_logs (created_at, source, kind, message) VALUES (?1, 'server', 'error', ?2)",
        ).bind(now, `서버 ${i}`),
      ),
    );
    // 로그인 없이 보낼 수 있는 화면 오류로 한도를 넘게 채운 뒤, 화면 오류를 하나 더 넣는다.
    await env.DB.batch(
      Array.from({ length: ERROR_LOG_MAX_ROWS + 20 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO error_logs (created_at, source, kind, message) VALUES (?1, 'client', 'error', ?2)",
        ).bind(now, `화면 ${i}`),
      ),
    );
    const entry = { kind: "error", stack: null, path: null, appVersion: null, browser: null } as const;
    await recordError(env as unknown as Env, { ...entry, source: "client", message: "화면 새 오류" });
    const count = async (source: string) =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM error_logs WHERE source = ?1").bind(source).first<{ n: number }>())!.n;
    expect(await count("client")).toBe(ERROR_LOG_MAX_ROWS);
    expect(await count("server")).toBe(3);

    // 서버 오류를 넣을 때도 화면 오류 수와 상관없이 서버 몫만 본다.
    await recordError(env as unknown as Env, { ...entry, source: "server", message: "서버 새 오류" });
    expect(await count("server")).toBe(4);
    expect(await count("client")).toBe(ERROR_LOG_MAX_ROWS);
  });
});

/** 특정 SQL만 실패시키는 DB(나머지는 진짜 DB로 넘긴다). */
function failingDb(match: (sql: string) => boolean): D1Database {
  const real = env.DB;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (match(sql)) throw new Error(`boom: 일부러 낸 오류 token=${TOKEN} ${UUID}`);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("서버 오류 기록", () => {
  it("예상하지 못한 서버 오류는 가린 값으로 기록하고, 응답에는 내부 내용을 싣지 않는다", async () => {
    const g = await setupGroup(2);
    const token = (await snapshot(g)).group.viewToken!;
    const response = await direct({ DB: failingDb((sql) => sql.includes("WHERE view_token")) }, "GET", `/api/view/${token}`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("boom");
    const row = await lastRow();
    expect(row.source).toBe("server");
    expect(row.kind).toBe("server");
    expect(row.path).toBe("/api/view/[token]");
    expect(row.message).toContain("boom");
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain(UUID);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("기록을 넣다가 실패해도 응답은 그대로 500 INTERNAL이다", async () => {
    const g = await setupGroup(2);
    const token = (await snapshot(g)).group.viewToken!;
    const before = (await rows()).length;
    const response = await direct(
      { DB: failingDb((sql) => sql.includes("WHERE view_token") || sql.includes("error_logs")) },
      "GET",
      `/api/view/${token}`,
    );
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
    expect((await rows()).length).toBe(before);
  });

  it("사용자 실수(4xx)는 기록하지 않는다", async () => {
    const before = (await rows()).length;
    const cookie = await login();
    expect((await api(null, "POST", "/api/groups", {})).status).toBe(401);
    expect((await api(cookie, "GET", `/api/groups/${UUID}/snapshot`)).status).toBe(404);
    expect((await api(cookie, "POST", "/api/groups", { nope: 1 })).status).toBe(400);
    expect((await api(null, "GET", "/api/view/no-such-token")).status).toBe(404);
    expect((await rows()).length).toBe(before);
  });
});
