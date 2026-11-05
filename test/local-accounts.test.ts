import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { FAILURE_LIMITS, INVALID_LOGIN_MESSAGE } from "../src/server/local";
import { rateClock } from "../src/server/ratelimit";
import { cookieFrom, direct } from "./direct";
import { unique } from "./helpers";

// 자체 계정(아이디 + 비밀번호): 가입·로그인·복구 코드·비밀번호 바꾸기·탈퇴·악용 방지.

const realNow = rateClock.now;
afterEach(() => {
  rateClock.now = realNow;
});

let n = 0;
/** 조건에 맞는 겹치지 않는 아이디(20자 이하). */
function newName(): string {
  n += 1;
  return `u${Date.now().toString(36)}${n}`.slice(0, 20);
}

const PASSWORD = "correct horse 1";

interface Call {
  status: number;
  body: any;
  cookie: string | null;
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  opts: { cookie?: string | null; overrides?: Partial<Env>; ip?: string; headers?: Record<string, string> } = {},
): Promise<Call> {
  const response = await direct(opts.overrides ?? {}, method, path, {
    cookie: opts.cookie ?? null,
    body,
    headers: { "CF-Connecting-IP": opts.ip ?? unique("ip"), ...(opts.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, cookie: cookieFrom(response, "sid") };
}

async function signup(username = newName(), password = PASSWORD) {
  const result = await call("POST", "/api/auth/signup", { username, password });
  return { ...result, username, password };
}

async function me(cookie: string | null, overrides: Partial<Env> = {}) {
  return (await call("GET", "/api/me", undefined, { cookie, overrides })).body as {
    accountId: string | null;
    providers: string[];
    loginMethod: string | null;
  };
}

describe("가입", () => {
  it("가입하면 바로 로그인되고, 복구 코드를 한 번 준다", async () => {
    const s = await signup();
    expect(s.status).toBe(200);
    expect(s.cookie).toMatch(/^sid=/);
    expect(s.body.recoveryCode).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    const who = await me(s.cookie);
    expect(who.accountId).toBeTruthy();
    expect(who.loginMethod).toBe("local");
    // 아이디는 /api/me 응답에도 없다.
    expect(JSON.stringify(who)).not.toContain(s.username);
  });

  it("같은 아이디는 다시 가입할 수 없다. 대문자·전각으로 바꿔 적어도 같은 아이디다", async () => {
    const s = await signup();
    expect(s.status).toBe(200);
    for (const variant of [s.username, s.username.toUpperCase()]) {
      const again = await signup(variant);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("USERNAME_TAKEN");
      expect(again.cookie).toBeNull();
    }
    // 전각 글자는 NFKC로 보통 글자가 된다.
    const fullwidth = [...s.username].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
    expect((await signup(fullwidth)).status).toBe(409);
    // 대문자로 가입해도 소문자 아이디로 로그인된다.
    const upper = `Ab_${newName()}`.slice(0, 20);
    expect((await signup(upper)).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: upper.toLowerCase(), password: PASSWORD })).status).toBe(200);
  });

  it("아이디·비밀번호 조건의 경계", async () => {
    const base = newName().slice(0, 10);
    const cases: [string, string, number, string?][] = [
      ["ab", PASSWORD, 400, "3자 이상"],
      [`${base}x`.slice(0, 3), PASSWORD, 200],
      [`${base}${"y".repeat(20)}`.slice(0, 20), PASSWORD, 200],
      [`${base}${"z".repeat(20)}`.slice(0, 21), PASSWORD, 400, "20자까지"],
      [`${base}한글`, PASSWORD, 400, "영문·숫자·밑줄"],
      [`${base}-a`, PASSWORD, 400, "영문·숫자·밑줄"],
      [`${base}sp ace`, PASSWORD, 400, "영문·숫자·밑줄"],
      [newName(), "1234567", 400, "8자 이상"],
      [newName(), "12345678", 200],
      [newName(), "가".repeat(128), 200],
      [newName(), "a".repeat(129), 400, "128자까지"],
    ];
    for (const [username, password, status, message] of cases) {
      // 3자짜리는 다른 테스트와 겹칠 수 있어 새로 고른다.
      const name = username.length === 3 ? `${Math.random().toString(36).slice(2, 5)}`.replace(/[^a-z0-9]/g, "a") : username;
      const result = await signup(name, password);
      if (status === 200 && result.status === 409) continue; // 3자 아이디가 우연히 겹친 경우
      expect(result.status, `${name} / ${password.length}자`).toBe(status);
      if (message) expect(result.body.error.message).toContain(message);
    }
    // 아이디와 같은 비밀번호(대소문자만 달라도)는 거절한다.
    const name = newName();
    const same = await signup(name, name.toUpperCase());
    expect(same.status).toBe(400);
    expect(same.body.error.message).toContain("아이디와 같은 비밀번호");
  });

  it("저장된 값은 평문이 아니다: 방식·횟수·솔트가 적힌 PBKDF2 해시와 복구 코드 해시", async () => {
    const s = await signup();
    const row = await env.DB.prepare(
      `SELECT c.password_hash, c.recovery_hash FROM local_credentials c JOIN accounts a ON a.id = c.account_id
       WHERE a.provider = 'local' AND a.subject = ?1`,
    )
      .bind(s.username)
      .first<{ password_hash: string; recovery_hash: string }>();
    expect(row!.password_hash).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    expect(row!.password_hash).not.toContain(PASSWORD);
    expect(row!.recovery_hash).toMatch(/^sha256\$[0-9a-f]{64}$/);
    const code = (s.body.recoveryCode as string).replace(/-/g, "");
    expect(row!.recovery_hash).not.toContain(code);
    // 같은 비밀번호라도 솔트가 달라 해시가 다르다.
    const t = await signup();
    const other = await env.DB.prepare(
      "SELECT c.password_hash FROM local_credentials c JOIN accounts a ON a.id = c.account_id WHERE a.subject = ?1",
    )
      .bind(t.username)
      .first<{ password_hash: string }>();
    expect(other!.password_hash).not.toBe(row!.password_hash);
  });
});

describe("로그인", () => {
  it("맞으면 세션, 틀린 비밀번호와 없는 아이디는 같은 응답", async () => {
    const s = await signup();
    const ok = await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await me(ok.cookie)).accountId).toBe((await me(s.cookie)).accountId);

    const wrong = await call("POST", "/api/auth/login", { username: s.username, password: "wrong password" });
    const missing = await call("POST", "/api/auth/login", { username: newName(), password: "wrong password" });
    const malformed = await call("POST", "/api/auth/login", { username: "x", password: "wrong password" });
    for (const r of [wrong, missing, malformed]) {
      expect(r.status).toBe(400);
      expect(r.cookie).toBeNull();
      expect(r.body).toEqual(wrong.body);
    }
    expect(wrong.body.error.message).toBe(INVALID_LOGIN_MESSAGE);
  });

  it("아이디별로 15분에 10번 틀리면 맞는 비밀번호도 잠시 거절하고, 창이 지나면 다시 된다. 없는 아이디도 같다", async () => {
    let now = Math.floor(Date.now() / 900_000) * 900_000 + 30 * 900_000 + 1000;
    rateClock.now = () => now;
    const s = await signup();
    const ghost = newName();
    for (const username of [s.username, ghost]) {
      for (let i = 0; i < FAILURE_LIMITS.login; i++) {
        expect((await call("POST", "/api/auth/login", { username, password: "nope nope" })).status).toBe(400);
      }
      const locked = await call("POST", "/api/auth/login", { username, password: PASSWORD });
      expect(locked.status).toBe(429);
      expect(locked.body.error.message).toContain("틀린 시도가 너무 많아요");
    }
    now += 900_000;
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(200);
  });

  it("다른 사이트(Origin)에서 보낸 가입·로그인은 거절한다. JSON이 아니거나 너무 큰 본문도", async () => {
    const s = await signup();
    for (const path of ["/api/auth/signup", "/api/auth/login", "/api/auth/recover"]) {
      const evil = await call("POST", path, { username: newName(), password: PASSWORD }, {
        headers: { Origin: "https://evil.example" },
      });
      expect(evil.status).toBe(403);
      expect(evil.cookie).toBeNull();
    }
    const form = await direct({}, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": unique("ip") },
    });
    expect([400, 415]).toContain(form.status);
    const big = await call("POST", "/api/auth/login", { username: s.username, password: "x".repeat(3000) });
    expect(big.status).toBe(413);
  });
});

describe("요청 수 제한(IP)", () => {
  function fixClock() {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 20 * 60_000 + 1000;
    rateClock.now = () => now;
  }
  it("가입·로그인·복구는 IP별 한도를 넘으면 429", async () => {
    fixClock();
    const LIMITS: Partial<Env> = { RATE_SIGNUP_PER_IP: "2", RATE_LOGIN_PER_IP: "3", RATE_RECOVER_PER_IP: "2" };
    const ip = unique("ip");
    const send = (path: string, body: unknown) => call("POST", path, body, { overrides: LIMITS, ip });
    expect((await send("/api/auth/signup", { username: newName(), password: PASSWORD })).status).toBe(200);
    expect((await send("/api/auth/signup", { username: newName(), password: PASSWORD })).status).toBe(200);
    expect((await send("/api/auth/signup", { username: newName(), password: PASSWORD })).status).toBe(429);
    for (let i = 0; i < 3; i++) {
      expect((await send("/api/auth/login", { username: newName(), password: "nope nope" })).status).toBe(400);
    }
    expect((await send("/api/auth/login", { username: newName(), password: "nope nope" })).status).toBe(429);
    const recoverBody = { username: newName(), recoveryCode: "AAAA", newPassword: "new password 1" };
    expect((await send("/api/auth/recover", recoverBody)).status).toBe(400);
    expect((await send("/api/auth/recover", recoverBody)).status).toBe(400);
    expect((await send("/api/auth/recover", recoverBody)).status).toBe(429);
    // 다른 IP는 영향이 없다.
    expect((await call("POST", "/api/auth/signup", { username: newName(), password: PASSWORD }, { overrides: LIMITS })).status).toBe(200);
  });
});

describe("비밀번호 바꾸기·복구 코드", () => {
  it("비밀번호를 바꾸면 다른 기기의 세션은 끝나고 이 기기는 이어진다", async () => {
    const s = await signup();
    const other = await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD });
    const wrong = await call("POST", "/api/account/password", { currentPassword: "nope nope", newPassword: "brand new pw" }, { cookie: s.cookie });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("WRONG_PASSWORD");
    const weak = await call("POST", "/api/account/password", { currentPassword: PASSWORD, newPassword: "short" }, { cookie: s.cookie });
    expect(weak.status).toBe(400);
    expect(weak.body.error.message).toContain("8자 이상");

    const changed = await call("POST", "/api/account/password", { currentPassword: PASSWORD, newPassword: "brand new pw" }, { cookie: s.cookie });
    expect(changed.status).toBe(200);
    expect(changed.cookie).toMatch(/^sid=/);
    expect((await me(changed.cookie)).accountId).toBeTruthy();
    expect((await me(other.cookie)).accountId).toBeNull();
    expect((await me(s.cookie)).accountId).toBeNull();
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(400);
    expect((await call("POST", "/api/auth/login", { username: s.username, password: "brand new pw" })).status).toBe(200);
  });

  it("복구 코드로 비밀번호를 다시 정한다: 코드는 한 번만, 새 코드 발급, 기존 세션 끝", async () => {
    const s = await signup();
    const firstCode = s.body.recoveryCode as string;
    const bad = await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: "AAAA-BBBB", newPassword: "after recovery" });
    const ghost = await call("POST", "/api/auth/recover", { username: newName(), recoveryCode: firstCode, newPassword: "after recovery" });
    expect(bad.status).toBe(400);
    expect(ghost.body).toEqual(bad.body);

    // 소문자·공백으로 적어도 같은 코드다.
    const typed = firstCode.toLowerCase().replace(/-/g, " ");
    const done = await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: typed, newPassword: "after recovery" });
    expect(done.status).toBe(200);
    expect(done.body.recoveryCode).not.toBe(firstCode);
    expect((await me(done.cookie)).accountId).toBeTruthy();
    expect((await me(s.cookie)).accountId).toBeNull();
    // 쓴 코드는 다시 못 쓴다. 새 코드는 된다.
    expect((await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: firstCode, newPassword: "again again" })).status).toBe(400);
    expect((await call("POST", "/api/auth/login", { username: s.username, password: "after recovery" })).status).toBe(200);
    const again = await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: done.body.recoveryCode, newPassword: "third password" });
    expect(again.status).toBe(200);
  });

  it("로그인한 상태에서 복구 코드를 새로 받으면(지금 비밀번호 확인) 이전 코드는 못 쓴다", async () => {
    const s = await signup();
    expect((await call("POST", "/api/account/recovery-code", { password: "nope nope" }, { cookie: s.cookie })).status).toBe(400);
    const fresh = await call("POST", "/api/account/recovery-code", { password: PASSWORD }, { cookie: s.cookie });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCode).not.toBe(s.body.recoveryCode);
    expect((await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: s.body.recoveryCode, newPassword: "x new password" })).status).toBe(400);
    expect((await call("POST", "/api/auth/recover", { username: s.username, recoveryCode: fresh.body.recoveryCode, newPassword: "x new password" })).status).toBe(200);
  });
});

describe("탈퇴·백업·끄기", () => {
  it("자체 계정 탈퇴는 비밀번호를 확인하고, 비밀번호·복구 행을 함께 지운다. 같은 아이디로 다시 가입할 수 있다", async () => {
    const s = await signup();
    const accountId = (await me(s.cookie)).accountId!;
    const noPassword = await call("POST", "/api/account/delete", { confirm: "탈퇴" }, { cookie: s.cookie });
    expect(noPassword.status).toBe(400);
    const wrong = await call("POST", "/api/account/delete", { confirm: "탈퇴", password: "nope nope" }, { cookie: s.cookie });
    expect(wrong.body.error.code).toBe("WRONG_PASSWORD");
    const ok = await call("POST", "/api/account/delete", { confirm: "탈퇴", password: PASSWORD }, { cookie: s.cookie });
    expect(ok.status).toBe(200);
    const left = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM accounts WHERE id = ?1) AS accounts,
              (SELECT COUNT(*) FROM local_credentials WHERE account_id = ?1) AS creds,
              (SELECT COUNT(*) FROM auth_failures WHERE key = ?2) AS failures`,
    )
      .bind(accountId, `password:${accountId}`)
      .first<{ accounts: number; creds: number; failures: number }>();
    expect(left).toEqual({ accounts: 0, creds: 0, failures: 0 });
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(400);
    expect((await signup(s.username)).status).toBe(200);
  });

  it("백업 파일에는 아이디·비밀번호 해시·복구 코드가 들어가지 않는다", async () => {
    const s = await signup();
    const group = await call("POST", "/api/groups", {}, { cookie: s.cookie });
    const backup = await direct({}, "GET", `/api/groups/${group.body.id}/export`, { cookie: s.cookie });
    expect(backup.status).toBe(200);
    const text = await backup.text();
    expect(text).not.toContain(s.username);
    expect(text).not.toContain("pbkdf2");
    expect(text).not.toContain("sha256$");
    expect(text).not.toContain((s.body.recoveryCode as string).slice(0, 9));
  });

  it("LOCAL_ACCOUNTS=off면 자체 계정 경로가 모두 404이고 로그인 수단 목록에서 빠진다", async () => {
    const OFF: Partial<Env> = { LOCAL_ACCOUNTS: "off" };
    const s = await signup();
    expect((await me(null)).providers).toContain("local");
    expect((await me(null, OFF)).providers).not.toContain("local");
    for (const [path, body] of [
      ["/api/auth/signup", { username: newName(), password: PASSWORD }],
      ["/api/auth/login", { username: s.username, password: PASSWORD }],
      ["/api/auth/recover", { username: s.username, recoveryCode: s.body.recoveryCode, newPassword: "new password" }],
      ["/api/account/password", { currentPassword: PASSWORD, newPassword: "new password" }],
      ["/api/account/recovery-code", { password: PASSWORD }],
    ] as const) {
      const r = await call("POST", path, body, { cookie: s.cookie, overrides: OFF });
      expect(r.status, path).toBe(404);
      expect(r.cookie).toBeNull();
    }
  });

  it("운영 설정 점검은 OAuth 키가 없어도 자체 계정만으로 통과한다", async () => {
    const PROD: Partial<Env> = {
      DEPLOY_ENV: "production",
      AUTH_MODE: "oauth",
      SESSION_SECRET: "x".repeat(40),
      PUBLIC_ORIGIN: "https://naejeon.example.test",
    };
    const who = await me(null, PROD);
    expect(who.providers).toEqual(["local"]);
  });
});
