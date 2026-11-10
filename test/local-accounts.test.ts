import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { normalizePassword, passwordProblem } from "../src/shared/account";
import { toBase64Url } from "../src/server/auth";
import {
  FAILURE_DAILY_LIMIT,
  FAILURE_LIMITS,
  FAILURE_TOTAL_LIMIT,
  FAILURE_TOTAL_LIMIT_THROTTLED,
  hashPassword,
  INVALID_LOGIN_MESSAGE,
} from "../src/server/local";
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
      [newName(), "123456789", 400, "10자 이상"],
      // 10자 경계. 1234567890처럼 흔한 비밀번호는 길이와 상관없이 거절하므로(아래) 흔하지 않은 값으로 본다.
      [newName(), "k7#mq2zxw9", 200],
      [newName(), "가나".repeat(64), 200],
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
    // pbkdf2p: 서버 비밀값 페퍼(HMAC)를 씌운 형식(2026-11-07). 로컬 설정은 반복 횟수 기본값(100000).
    expect(row!.password_hash).toMatch(/^pbkdf2p-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
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

describe("짐작하기 쉬운 비밀번호(2026-11-10 보안 감사)", () => {
  it("공용 규칙: 흔한 비밀번호, 아이디가 들어간 비밀번호, 한 글자 반복을 거절한다", () => {
    const fullwidth = [..."password12"].map((ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join("");
    for (const weak of ["1234567890", "qwertyuiop", "Password12", "PASSWORD123", "1q2w3e4r5t", fullwidth]) {
      expect(passwordProblem(weak, "someone"), weak).toContain("너무 흔한 비밀번호");
    }
    expect(passwordProblem("walnut2026", "walnut")).toContain("아이디를 넣을 수 없어요");
    expect(passwordProblem("My-WALNUT!", "walnut")).toContain("아이디를 넣을 수 없어요");
    expect(passwordProblem("walnut____", "walnut____")).toContain("아이디와 같은 비밀번호");
    expect(passwordProblem("aaaaaaaaaa", "someone")).toContain("한 글자만 되풀이한");
    expect(passwordProblem("가가가가가가가가가가", "someone")).toContain("한 글자만 되풀이한");
    // 아이디를 모르는 화면(비밀번호 바꾸기)에서는 아이디 검사만 건너뛴다.
    expect(passwordProblem("walnut2026", "")).toBeNull();
    expect(passwordProblem("aaaaaaaaab", "someone")).toBeNull();
    // 최소 길이(10자)는 흔한 비밀번호 검사보다 먼저 본다.
    expect(passwordProblem("k7#mq2zxw", "someone")).toContain("10자 이상");
    expect(passwordProblem(PASSWORD, "someone")).toBeNull();
  });

  it("가입에서 거절하고 이유를 알려준다", async () => {
    const name = newName();
    for (const [password, message] of [
      ["qwertyuiop", "너무 흔한 비밀번호"],
      [`${name}!!`, "아이디를 넣을 수 없어요"],
      ["1111111111", "한 글자만 되풀이한"],
    ]) {
      const result = await signup(name, password);
      expect(result.status, password).toBe(400);
      expect(result.body.error.code).toBe("INVALID_CREDENTIALS_FORMAT");
      expect(result.body.error.message).toContain(message);
      expect(result.cookie).toBeNull();
    }
    expect((await signup(name)).status).toBe(200);
  });

  it("비밀번호 바꾸기·복구 코드로 다시 정하기에서도 거절한다. 서버는 아이디를 알므로 아이디가 들어간 값도 막는다", async () => {
    const s = await signup();
    for (const [newPassword, message] of [
      ["password12", "너무 흔한 비밀번호"],
      [`x${s.username.toUpperCase()}`, "아이디를 넣을 수 없어요"],
      ["zzzzzzzzzz", "한 글자만 되풀이한"],
    ]) {
      const changed = await call("POST", "/api/account/password", { currentPassword: PASSWORD, newPassword }, { cookie: s.cookie });
      expect(changed.status, newPassword).toBe(400);
      expect(changed.body.error.message).toContain(message);
      const recovered = await call("POST", "/api/auth/recover", {
        username: s.username,
        recoveryCode: s.body.recoveryCode,
        newPassword,
      });
      expect(recovered.status, newPassword).toBe(400);
      expect(recovered.body.error.message).toContain(message);
    }
    // 거절된 시도로 비밀번호도 복구 코드도 바뀌지 않았다.
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(200);
    const done = await call("POST", "/api/auth/recover", {
      username: s.username,
      recoveryCode: s.body.recoveryCode,
      newPassword: "after recovery",
    });
    expect(done.status).toBe(200);
  });

  it("규칙 전에 정한 흔한 비밀번호로도 로그인은 된다(새로 정할 때만 본다)", async () => {
    const s = await signup();
    await env.DB.prepare(
      "UPDATE local_credentials SET password_hash = ?2 WHERE account_id = (SELECT id FROM accounts WHERE provider = 'local' AND subject = ?1)",
    )
      .bind(s.username, await hashPassword(env as unknown as Env, "12345678"))
      .run();
    expect((await call("POST", "/api/auth/login", { username: s.username, password: "12345678" })).status).toBe(200);
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

  it("(아이디, IP)별로 15분에 10번 틀리면 그 IP에서는 맞는 비밀번호도 잠시 거절하고, 창이 지나면 다시 된다. 없는 아이디도 같다", async () => {
    let now = Math.floor(Date.now() / 900_000) * 900_000 + 30 * 900_000 + 1000;
    rateClock.now = () => now;
    const s = await signup();
    const ghost = newName();
    const ip = unique("ip");
    for (const username of [s.username, ghost]) {
      for (let i = 0; i < FAILURE_LIMITS.login; i++) {
        expect((await call("POST", "/api/auth/login", { username, password: "nope nope" }, { ip })).status).toBe(400);
      }
      const locked = await call("POST", "/api/auth/login", { username, password: PASSWORD }, { ip });
      expect(locked.status).toBe(429);
      expect(locked.body.error.message).toContain("틀린 시도가 너무 많아요");
    }
    now += 900_000;
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD }, { ip })).status).toBe(200);
  });

  it("다른 IP에서 아무리 틀려도(아이디 전체 한도 전까지) 본인 IP의 로그인은 막히지 않는다", async () => {
    const now = Math.floor(Date.now() / 900_000) * 900_000 + 31 * 900_000 + 1000;
    rateClock.now = () => now;
    const s = await signup();
    const attacker = unique("ip");
    for (let i = 0; i < FAILURE_LIMITS.login + 5; i++) {
      const r = await call("POST", "/api/auth/login", { username: s.username, password: "nope nope" }, { ip: attacker });
      expect(r.status).toBe(i < FAILURE_LIMITS.login ? 400 : 429);
    }
    // IPv6 같은 /64 안에서 주소를 바꿔도 같은 IP로 센다.
    const v6 = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:7`;
    for (let i = 0; i < FAILURE_LIMITS.login; i++) {
      await call("POST", "/api/auth/login", { username: s.username, password: "nope nope" }, { ip: `${v6}::${i + 1}` });
    }
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD }, { ip: `${v6}::99` })).status).toBe(429);
    const mine = await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD }, { ip: unique("ip") });
    expect(mine.status).toBe(200);
    // 성공하면 그 아이디의 실패 기록(모든 IP)이 지워져 공격자 IP도 다시 시도할 수 있다(아이디 전체 한도도 초기화).
    expect((await call("POST", "/api/auth/login", { username: s.username, password: "nope nope" }, { ip: attacker })).status).toBe(400);
  });

  it("아이디 전체 한도: IP를 바꿔 가며 15분에 100번 틀리면 모든 IP에서 잠시 거절한다", async () => {
    const now = Math.floor(Date.now() / 900_000) * 900_000 + 32 * 900_000 + 1000;
    rateClock.now = () => now;
    const s = await signup();
    for (let i = 0; i < FAILURE_TOTAL_LIMIT; i++) {
      expect((await call("POST", "/api/auth/login", { username: s.username, password: "nope nope" })).status).toBe(400);
    }
    const locked = await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD });
    expect(locked.status).toBe(429);
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

describe("페퍼·반복 횟수(2026-11-07)", () => {
  /** 페퍼 전의 예전 형식(pbkdf2-sha256$…) 해시를 만든다. */
  async function legacyHash(password: string, iterations: number): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(normalizePassword(password)), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    return `pbkdf2-sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
  }

  async function storedHash(username: string): Promise<string> {
    const row = await env.DB.prepare(
      "SELECT c.password_hash FROM local_credentials c JOIN accounts a ON a.id = c.account_id WHERE a.provider = 'local' AND a.subject = ?1",
    )
      .bind(username)
      .first<{ password_hash: string }>();
    return row!.password_hash;
  }

  async function setHash(username: string, hash: string): Promise<void> {
    await env.DB.prepare(
      "UPDATE local_credentials SET password_hash = ?2 WHERE account_id = (SELECT id FROM accounts WHERE provider = 'local' AND subject = ?1)",
    )
      .bind(username, hash)
      .run();
  }

  it("예전 형식(페퍼 없음) 해시로도 로그인되고, 그 로그인에서 새 형식(pbkdf2p)으로 다시 저장된다", async () => {
    const s = await signup();
    await setHash(s.username, await legacyHash(PASSWORD, 100_000));
    // 틀린 비밀번호는 예전 형식에서도 거절하고, 다시 저장하지 않는다.
    expect((await call("POST", "/api/auth/login", { username: s.username, password: "wrong password" })).status).toBe(400);
    expect(await storedHash(s.username)).toMatch(/^pbkdf2-sha256\$100000\$/);
    const ok = await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await storedHash(s.username)).toMatch(/^pbkdf2p-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
    // 새 형식으로 다시 로그인된다.
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(200);
  });

  it("운영 설정(20000회)에서: 가입은 20000회 새 형식, 예전 형식 100000회는 20000회 새 형식으로, 새 형식 100000회는 그대로", async () => {
    const low = { PASSWORD_PBKDF2_ITERATIONS: "20000" } as Partial<Env>;
    const a = await call("POST", "/api/auth/signup", { username: newName(), password: PASSWORD }, { overrides: low });
    expect(a.status).toBe(200);
    const legacyUser = newName();
    expect((await call("POST", "/api/auth/signup", { username: legacyUser, password: PASSWORD })).status).toBe(200);
    // 100000회 새 형식(기본 설정으로 가입) → 20000 설정으로 로그인해도 약하게 바꾸지 않는다.
    const strong = await storedHash(legacyUser);
    expect(strong).toMatch(/^pbkdf2p-sha256\$100000\$/);
    expect((await call("POST", "/api/auth/login", { username: legacyUser, password: PASSWORD }, { overrides: low })).status).toBe(200);
    expect(await storedHash(legacyUser)).toBe(strong);
    // 예전 형식은 페퍼를 씌워 지금 설정(20000)으로 다시 저장한다.
    await setHash(legacyUser, await legacyHash(PASSWORD, 100_000));
    expect((await call("POST", "/api/auth/login", { username: legacyUser, password: PASSWORD }, { overrides: low })).status).toBe(200);
    expect(await storedHash(legacyUser)).toMatch(/^pbkdf2p-sha256\$20000\$/);
  });

  it("비밀번호 페퍼(PASSWORD_PEPPER)가 다르면 비밀번호가 맞지 않고, 세션 키(SESSION_SECRET)만 달라서는 그대로 맞는다", async () => {
    const s = await signup();
    const otherPepper = { PASSWORD_PEPPER: "another-pepper-for-pepper-check-0123456789" } as Partial<Env>;
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD }, { overrides: otherPepper })).status).toBe(400);
    // 세션 키를 바꿔도(유출 뒤 교체) 비밀번호는 그대로다. 2026-11-10 전에는 세션 키가 페퍼여서 함께 무효가 됐다.
    const otherSession = { SESSION_SECRET: "another-secret-for-session-check-0123456789" } as Partial<Env>;
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD }, { overrides: otherSession })).status).toBe(200);
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(200);
  });

  it("아이디별 하루 누적 실패가 200번에 닿으면 그날은 15분에 5번만 받는다. 로그인에 성공해도 누적은 남는다", async () => {
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 3 * 86_400_000;
    let now = dayStart + 1000;
    rateClock.now = () => now;
    const s = await signup();
    const fail = () => call("POST", "/api/auth/login", { username: s.username, password: "nope nope" });
    const dayRow = () =>
      env.DB.prepare("SELECT key, count FROM auth_failures WHERE key >= 'day:login:' AND key < 'day:login;' AND window_start = ?1")
        .bind(dayStart)
        .all<{ key: string; count: number }>();
    expect((await fail()).status).toBe(400);
    const first = await dayRow();
    expect(first.results.map((r) => r.count)).toEqual([1]);
    // 200번을 실제로 틀리는 대신 누적 행을 한도 직전으로 올린다.
    await env.DB.prepare("UPDATE auth_failures SET count = ?2 WHERE key = ?1 AND window_start = ?3")
      .bind(first.results[0]!.key, FAILURE_DAILY_LIMIT - 1, dayStart)
      .run();
    // 199번째까지는 보통 한도(15분에 100번)다. 이번 실패로 200이 된다.
    expect((await fail()).status).toBe(400);
    // 다음 15분 창: 누적이 찼으므로 5번만 받고 6번째는 IP가 달라도, 맞는 비밀번호여도 거절한다.
    now += 900_000;
    for (let i = 0; i < FAILURE_TOTAL_LIMIT_THROTTLED; i++) expect((await fail()).status).toBe(400);
    expect((await fail()).status).toBe(429);
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(429);
    // 다음 창에서 주인이 로그인에 성공해도 하루 누적은 지워지지 않는다(추측하는 쪽의 한도가 되살아나지 않게).
    now += 900_000;
    expect((await call("POST", "/api/auth/login", { username: s.username, password: PASSWORD })).status).toBe(200);
    expect((await dayRow()).results[0]!.count).toBeGreaterThanOrEqual(FAILURE_DAILY_LIMIT);
    for (let i = 0; i < FAILURE_TOTAL_LIMIT_THROTTLED; i++) expect((await fail()).status).toBe(400);
    expect((await fail()).status).toBe(429);
    // 날이 바뀌면 보통 한도로 돌아가고, 지난 날의 누적 행은 다음 실패 때 지워진다.
    now = dayStart + 86_400_000 + 1000;
    for (let i = 0; i < FAILURE_TOTAL_LIMIT_THROTTLED + 1; i++) expect((await fail()).status).toBe(400);
    expect((await dayRow()).results).toEqual([]);
  });

  it("[측정] 해시 한 번 계산 시간(20000회·100000회). 로컬 workerd 기준이며 운영 CPU 시간과 다를 수 있다", async () => {
    // Workers는 I/O가 끝날 때만 시계가 움직이므로 계산 앞뒤에 아주 가벼운 D1 읽기를 두고 잰다(그 대기 시간은 따로 빼 준다).
    const tick = () => env.DB.prepare("SELECT 1 AS x").first();
    const measure = async (fn: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        await tick();
        const t0 = Date.now();
        await fn();
        await tick();
        samples.push(Date.now() - t0);
      }
      samples.sort((x, y) => x - y);
      return samples[Math.floor(samples.length / 2)]!;
    };
    const base = await measure(async () => undefined);
    const report: Record<string, number> = {};
    for (const iterations of [20_000, 100_000]) {
      const e = { ...(env as unknown as Env), PASSWORD_PBKDF2_ITERATIONS: String(iterations) };
      await hashPassword(e, PASSWORD); // 데우기
      report[`pbkdf2p ${iterations}`] = Math.max(0, (await measure(() => hashPassword(e, PASSWORD))) - base);
    }
    console.log(`[측정] 비밀번호 해시 한 번(중앙값 ms, D1 왕복 ${base}ms 뺌): ${JSON.stringify(report)}`);
    expect(report["pbkdf2p 20000"]).toBeLessThanOrEqual(report["pbkdf2p 100000"]! + 1);
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
    expect(weak.body.error.message).toContain("10자 이상");

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
    const group = await call("POST", "/api/groups", { requestId: unique("req") }, { cookie: s.cookie });
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
