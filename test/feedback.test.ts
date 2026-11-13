import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { FEEDBACK_MAX_DAYS, FEEDBACK_MAX_ROWS, feedbackClock } from "../src/server/feedback";
import { rateClock } from "../src/server/ratelimit";
import { FEEDBACK_MAX_CHARS } from "../src/shared/feedback";
import { direct } from "./direct";
import { api, login, unique } from "./helpers";

// 피드백(migrations/0028, src/server/feedback.ts): 로그인 없이 보내고 사이트 운영자만 읽고 지운다.

const realRate = rateClock.now;
const realFeedback = feedbackClock.now;
afterEach(() => {
  rateClock.now = realRate;
  feedbackClock.now = realFeedback;
});

const send = (body: unknown, limits: Partial<Env> = {}, ip = unique("ip")) =>
  direct(limits, "POST", "/api/feedback", { body, headers: { "CF-Connecting-IP": ip } });

async function count(): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM feedback").first<{ n: number }>())!.n;
}

async function asSiteAdmin(): Promise<{ cookie: string; config: Partial<Env> }> {
  const cookie = await login();
  const id = (await api(cookie, "GET", "/api/me")).body.accountId as string;
  return { cookie, config: { SITE_ADMIN_ACCOUNT_IDS: id } };
}

describe("피드백 보내기", () => {
  it("로그인 없이 보내면 앞뒤 공백을 뺀 글과 브라우저 종류만 남는다(계정·IP 없음)", async () => {
    const response = await direct({}, "POST", "/api/feedback", {
      body: { body: "  준비 화면에서 섞기 버튼이 안 보여요  ", appVersion: "abc123" },
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1" },
    });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM feedback ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(row!.body).toBe("준비 화면에서 섞기 버튼이 안 보여요");
    expect(row!.app_version).toBe("abc123");
    expect(typeof row!.browser).toBe("string");
    expect(Object.keys(row!).sort()).toEqual(["app_version", "body", "browser", "created_at", "id"]);
  });

  it("너무 짧거나 길거나 모르는 칸이 있으면 400이고 저장하지 않는다", async () => {
    const before = await count();
    expect((await send({ body: "ㅇㅇ" })).status).toBe(400);
    expect((await send({ body: "가".repeat(FEEDBACK_MAX_CHARS + 1) })).status).toBe(400);
    expect((await send({ body: "충분히 긴 글이에요", contact: "010" })).status).toBe(400);
    expect((await send({ body: 12345 })).status).toBe(400);
    expect(await count()).toBe(before);
    expect((await send({ body: "가".repeat(FEEDBACK_MAX_CHARS) })).status).toBe(200);
  });

  it("IP별 분당 한도를 넘으면 429, 다음 창에는 다시 받는다", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000 + 30 * 60_000 + 1000;
    rateClock.now = () => now;
    const ip = unique("ip");
    const limits: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_FEEDBACK_PER_IP: "2" };
    expect((await send({ body: "첫 번째 의견" }, limits, ip)).status).toBe(200);
    expect((await send({ body: "두 번째 의견" }, limits, ip)).status).toBe(200);
    expect((await send({ body: "세 번째 의견" }, limits, ip)).status).toBe(429);
    now += 60_000;
    expect((await send({ body: "네 번째 의견" }, limits, ip)).status).toBe(200);
  });

  it("보관 한도: 기간이 지난 글은 지우고 건수는 한도를 넘지 않는다", async () => {
    const old = new Date(Date.now() - (FEEDBACK_MAX_DAYS + 1) * 24 * 3600_000).toISOString();
    await env.DB.prepare("INSERT INTO feedback (created_at, body) VALUES (?1, '오래된 의견')").bind(old).run();
    const filler = Array.from({ length: FEEDBACK_MAX_ROWS }, () =>
      env.DB.prepare("INSERT INTO feedback (created_at, body) VALUES (?1, '채움')").bind(new Date().toISOString()),
    );
    await env.DB.batch(filler);
    expect((await send({ body: "새로 온 의견" })).status).toBe(200);
    expect(await count()).toBe(FEEDBACK_MAX_ROWS);
    expect(await env.DB.prepare("SELECT 1 FROM feedback WHERE body = '오래된 의견'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM feedback WHERE body = '새로 온 의견'").first()).not.toBeNull();
  });
});

describe("피드백 읽기·지우기", () => {
  it("사이트 운영자만 읽고 지운다. 다른 계정·비로그인은 404", async () => {
    await send({ body: "운영자만 읽는 의견" });
    const { cookie, config } = await asSiteAdmin();
    const other = await login();
    expect((await direct(config, "GET", "/api/admin/feedback", { cookie: other })).status).toBe(404);
    expect((await direct(config, "GET", "/api/admin/feedback")).status).toBe(404);

    const list = await direct(config, "GET", "/api/admin/feedback", { cookie });
    expect(list.status).toBe(200);
    const { feedback } = (await list.json()) as { feedback: { id: number; body: string }[] };
    const mine = feedback.find((f) => f.body === "운영자만 읽는 의견")!;
    expect(feedback[0]!.id).toBeGreaterThanOrEqual(mine.id);

    expect((await direct(config, "POST", `/api/admin/feedback/${mine.id}/delete`, { cookie: other })).status).toBe(404);
    expect((await direct(config, "POST", `/api/admin/feedback/${mine.id}/delete`, { cookie })).status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM feedback WHERE id = ?1").bind(mine.id).first()).toBeNull();
  });
});
