import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionValue, signValue, toBase64Url } from "../src/server/auth";
import type { Env } from "../src/server/env";
import { providerHttp } from "../src/server/oauth";
import app from "../src/server/index";
import { cookieFrom, direct } from "./direct";
import { api, login, setupGroup, unique } from "./helpers";

// 실제 로그인(카카오·Google OAuth 2.0 인가 코드 흐름), 세션 만료, 가짜 로그인 차단(시나리오 11).
// 제공자 호출은 providerHttp.fetch를 가짜 응답으로 바꿔 끼워 확인한다.

const ORIGIN = "https://naejeon.example.test";
const OAUTH: Partial<Env> = {
  AUTH_MODE: "oauth",
  PUBLIC_ORIGIN: ORIGIN,
  KAKAO_CLIENT_ID: "kakao-rest-key",
  KAKAO_CLIENT_SECRET: "kakao-secret",
  GOOGLE_CLIENT_ID: "google-client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "google-secret",
};

const realFetch = providerHttp.fetch;
afterEach(() => {
  providerHttp.fetch = realFetch;
});

interface Call {
  url: string;
  init?: RequestInit;
}

/** 제공자 응답을 흉내 낸다. 받은 호출을 기록한다. */
function fakeProvider(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  providerHttp.fetch = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (v: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(v)));
  return `${enc({ alg: "RS256", typ: "JWT" })}.${enc(claims)}.c2lnbmF0dXJl`;
}

/** 로그인 시작 → 제공자 주소와 state 쿠키를 돌려준다. */
async function startLogin(provider: string, returnPath = "#/prep", overrides = OAUTH, ip = unique("ip")) {
  const response = await direct(
    overrides,
    "GET",
    `/api/auth/${provider}/start?return=${encodeURIComponent(returnPath)}`,
    { headers: { "CF-Connecting-IP": ip } },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location")!);
  return { location, stateCookie: cookieFrom(response, "oauth_state")!, ip };
}

async function callback(
  provider: string,
  query: Record<string, string>,
  stateCookie: string | null,
  overrides = OAUTH,
) {
  return direct(overrides, "GET", `/api/auth/${provider}/callback?${new URLSearchParams(query)}`, {
    cookie: stateCookie,
    headers: { "CF-Connecting-IP": unique("ip") },
  });
}

async function me(cookie: string | null, overrides: Partial<Env> = OAUTH) {
  return (await (await direct(overrides, "GET", "/api/me", { cookie })).json()) as {
    accountId: string | null;
    authMode: string;
    providers: string[];
  };
}

describe("로그인 버튼 노출", () => {
  it("키가 있는 제공자만 알려준다(자체 계정은 켜져 있으면 늘 맨 앞)", async () => {
    expect((await me(null)).providers).toEqual(["local", "kakao", "google"]);
    expect((await me(null, { AUTH_MODE: "oauth", KAKAO_CLIENT_ID: "k" })).providers).toEqual(["local", "kakao"]);
    // Google은 ID와 시크릿이 둘 다 있어야 한다.
    expect((await me(null, { AUTH_MODE: "oauth", GOOGLE_CLIENT_ID: "g" })).providers).toEqual(["local"]);
    expect((await me(null, { ...OAUTH, LOCAL_ACCOUNTS: "off" })).providers).toEqual(["kakao", "google"]);
    expect((await me(null, { AUTH_MODE: "oauth" })).authMode).toBe("oauth");
  });

  it("키가 없는 제공자의 로그인 시작은 안내 화면으로 보낸다", async () => {
    const response = await direct({ AUTH_MODE: "oauth" }, "GET", "/api/auth/kakao/start");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/#/login-failed/not_configured");
  });
});

describe("카카오 로그인 흐름", () => {
  it("시작 → 콜백 → 세션 → 로그아웃. 회원번호만 저장한다", async () => {
    const { location, stateCookie } = await startLogin("kakao", "#/prep");
    expect(location.origin + location.pathname).toBe("https://kauth.kakao.com/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("kakao-rest-key");
    expect(location.searchParams.get("response_type")).toBe("code");
    // 리디렉션 URI는 PUBLIC_ORIGIN으로 고정(요청 주소가 달라도).
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/kakao/callback`);
    // 동의 항목을 요청하지 않는다.
    expect(location.searchParams.has("scope")).toBe(false);
    const state = location.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(stateCookie).toMatch(/^oauth_state=/);

    const kakaoId = "9007199254740993"; // 2^53 + 1: JS 숫자로 읽으면 자릿수가 깨지는 값
    const calls = fakeProvider((call) => {
      if (call.url === "https://kauth.kakao.com/oauth/token") {
        return json({ token_type: "bearer", access_token: "kakao-access", expires_in: 21599 });
      }
      if (call.url === "https://kapi.kakao.com/v2/user/me") {
        return new Response(
          `{"id":${kakaoId},"connected_at":"2026-11-05T00:00:00Z","kakao_account":{"profile_needs_agreement":true}}`,
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return json({}, 404);
    });
    const done = await callback("kakao", { code: "auth-code-1", state }, stateCookie);
    expect(done.status).toBe(302);
    expect(done.headers.get("Location")).toBe("/#/prep");
    const sid = cookieFrom(done, "sid")!;
    expect(sid).toBeTruthy();
    const sidLine = done.headers.getSetCookie().find((l) => l.startsWith("sid="))!;
    expect(sidLine).toContain("HttpOnly");
    expect(sidLine).toContain("Secure");
    expect(sidLine).toContain("SameSite=Lax");
    // state 쿠키는 한 번 쓰고 지운다.
    expect(done.headers.getSetCookie().some((l) => l.startsWith("oauth_state=;"))).toBe(true);

    // 토큰 요청: 정해진 형식, 같은 리디렉션 URI, 클라이언트 시크릿 포함.
    const tokenBody = new URLSearchParams(String(calls[0]!.init!.body));
    expect(calls[0]!.init!.method).toBe("POST");
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("auth-code-1");
    expect(tokenBody.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/kakao/callback`);
    expect(tokenBody.get("client_secret")).toBe("kakao-secret");
    // 사용자 정보 요청에 property_keys(추가 항목)를 붙이지 않는다.
    expect(calls[1]!.url).toBe("https://kapi.kakao.com/v2/user/me");
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer kakao-access");

    const signedIn = await me(sid);
    expect(signedIn.accountId).toBeTruthy();
    const row = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1")
      .bind(signedIn.accountId)
      .first<Record<string, unknown>>();
    expect(row!.provider).toBe("kakao");
    expect(row!.subject).toBe(kakaoId);
    // 계정 표에는 식별자 외의 개인 정보 열이 없다.
    expect(Object.keys(row!).sort()).toEqual(["created_at", "id", "provider", "session_epoch", "subject"]);

    // 같은 카카오 계정으로 다시 로그인하면 같은 계정이다.
    const again = await startLogin("kakao");
    const second = await callback(
      "kakao",
      { code: "auth-code-2", state: again.location.searchParams.get("state")! },
      again.stateCookie,
    );
    const sid2 = cookieFrom(second, "sid")!;
    expect((await me(sid2)).accountId).toBe(signedIn.accountId);

    // 로그아웃하면 이 계정의 이전 세션(다른 기기 포함)은 모두 거절된다.
    const out = await direct(OAUTH, "POST", "/api/auth/logout", {
      cookie: sid,
      headers: { "CF-Connecting-IP": unique("ip") },
    });
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((l) => l.startsWith("sid=;") && l.includes("Max-Age=0"))).toBe(true);
    expect((await me(sid)).accountId).toBeNull();
    expect((await me(sid2)).accountId).toBeNull();
    const write = await direct(OAUTH, "POST", "/api/groups", { cookie: sid2, body: {} });
    expect(write.status).toBe(401);
  });

  it("사용자가 동의 화면에서 취소하면 로그인하지 않는다", async () => {
    const { location, stateCookie } = await startLogin("kakao");
    const calls = fakeProvider(() => json({}));
    const done = await callback(
      "kakao",
      { error: "access_denied", error_description: "User denied access", state: location.searchParams.get("state")! },
      stateCookie,
    );
    expect(done.headers.get("Location")).toBe("/#/login-failed/denied");
    expect(cookieFrom(done, "sid")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("제공자 오류(토큰 요청 실패, 회원번호 없음)는 로그인하지 않는다", async () => {
    for (const handler of [
      () => json({ error: "invalid_grant" }, 400),
      (call: Call) =>
        call.url.includes("/oauth/token") ? json({ access_token: "x" }) : json({ connected_at: "x" }),
      () => new Response("not json", { status: 200 }),
    ]) {
      const { location, stateCookie } = await startLogin("kakao");
      fakeProvider(handler);
      const done = await callback("kakao", { code: "c", state: location.searchParams.get("state")! }, stateCookie);
      expect(done.headers.get("Location")).toBe("/#/login-failed/provider_error");
      expect(cookieFrom(done, "sid")).toBeNull();
    }
  });
});

describe("state 확인(CSRF 방지)", () => {
  it("state가 다르거나, 쿠키가 없거나, 다른 제공자 것이거나, 만료되면 거절하고 제공자를 부르지 않는다", async () => {
    const calls = fakeProvider(() => json({ access_token: "x" }));
    const { location, stateCookie } = await startLogin("kakao");
    const state = location.searchParams.get("state")!;

    const wrong = await callback("kakao", { code: "c", state: `${state}x` }, stateCookie);
    expect(wrong.headers.get("Location")).toBe("/#/login-failed/state_mismatch");
    const noCookie = await callback("kakao", { code: "c", state }, null);
    expect(noCookie.headers.get("Location")).toBe("/#/login-failed/state_mismatch");
    const otherProvider = await callback("google", { code: "c", state }, stateCookie);
    expect(otherProvider.headers.get("Location")).toBe("/#/login-failed/state_mismatch");

    const expired = `oauth_state=${await signValue(env as unknown as Env, {
      s: "fixed-state",
      p: "kakao",
      r: "#/",
      e: Date.now() - 1000,
    })}`;
    const late = await callback("kakao", { code: "c", state: "fixed-state" }, expired);
    expect(late.headers.get("Location")).toBe("/#/login-failed/state_mismatch");

    // 서명을 바꾼 state 쿠키도 거절한다.
    const forged = `${stateCookie.slice(0, -2)}xx`;
    const tampered = await callback("kakao", { code: "c", state }, forged);
    expect(tampered.headers.get("Location")).toBe("/#/login-failed/state_mismatch");

    for (const r of [wrong, noCookie, otherProvider, late, tampered]) expect(cookieFrom(r, "sid")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("돌아갈 화면은 같은 사이트의 해시 주소만 받는다", async () => {
    fakeProvider((call) =>
      call.url.includes("/oauth/token") ? json({ access_token: "x" }) : json({ id: 42 }),
    );
    const { location, stateCookie } = await startLogin("kakao", "https://evil.example/");
    const done = await callback("kakao", { code: "c", state: location.searchParams.get("state")! }, stateCookie);
    expect(done.headers.get("Location")).toBe("/#/");
  });
});

describe("Google 로그인 흐름", () => {
  it("openid 범위만 요청하고 ID 토큰의 sub만 쓴다", async () => {
    const { location, stateCookie } = await startLogin("google", "#/group");
    expect(location.origin + location.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("scope")).toBe("openid");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    const sub = unique("google-sub");
    const calls = fakeProvider(() =>
      json({
        access_token: "g-access",
        token_type: "Bearer",
        id_token: fakeIdToken({
          iss: "https://accounts.google.com",
          aud: OAUTH.GOOGLE_CLIENT_ID,
          sub,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      }),
    );
    const done = await callback("google", { code: "g-code", state: location.searchParams.get("state")! }, stateCookie);
    expect(done.headers.get("Location")).toBe("/#/group");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    const sid = cookieFrom(done, "sid")!;
    const account = await me(sid);
    const row = await env.DB.prepare("SELECT provider, subject FROM accounts WHERE id = ?1")
      .bind(account.accountId)
      .first<{ provider: string; subject: string }>();
    expect(row).toEqual({ provider: "google", subject: sub });
  });

  it("ID 토큰의 대상·발급자·만료가 맞지 않으면 거절한다", async () => {
    const good = {
      iss: "accounts.google.com",
      aud: OAUTH.GOOGLE_CLIENT_ID,
      sub: "s",
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    for (const claims of [
      { ...good, aud: "someone-else" },
      { ...good, iss: "https://evil.example" },
      { ...good, exp: Math.floor(Date.now() / 1000) - 10 },
    ]) {
      const { location, stateCookie } = await startLogin("google");
      fakeProvider(() => json({ id_token: fakeIdToken(claims) }));
      const done = await callback("google", { code: "c", state: location.searchParams.get("state")! }, stateCookie);
      expect(done.headers.get("Location")).toBe("/#/login-failed/provider_error");
      expect(cookieFrom(done, "sid")).toBeNull();
    }
  });
});

describe("세션 만료와 가짜 로그인 차단", () => {
  it("만료된 세션은 서명이 맞아도 거절한다(조회·쓰기 모두)", async () => {
    const g = await setupGroup(10);
    const accountId = (await api(g.cookie, "GET", "/api/me")).body.accountId as string;
    const expired = `sid=${await createSessionValue(
      env as unknown as Env,
      { id: accountId, provider: "fake", epoch: 0 },
      Date.now() - 1000,
    )}`;
    expect((await api(expired, "GET", "/api/me")).body.accountId).toBeNull();
    expect((await api(expired, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(401);
    const rename = await api(expired, "PATCH", `/api/groups/${g.gid}`, { name: "바뀌면 안 됨" });
    expect(rename.status).toBe(401);
    // 만료 전 세션은 그대로 된다.
    const fresh = `sid=${await createSessionValue(
      env as unknown as Env,
      { id: accountId, provider: "fake", epoch: 0 },
      Date.now() + 60_000,
    )}`;
    expect((await api(fresh, "GET", "/api/me")).body.accountId).toBe(accountId);
    const snap = await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`);
    expect(snap.body.group.name).not.toBe("바뀌면 안 됨");
  });

  it("AUTH_MODE가 fake가 아니면 가짜 로그인 경로가 닫히고 가짜 계정 세션도 거절한다", async () => {
    const closed = await direct(OAUTH, "POST", "/api/auth/fake-login", { body: { subject: "x" } });
    expect(closed.status).toBe(404);
    expect(cookieFrom(closed, "sid")).toBeNull();
    const fakeCookie = await login();
    expect((await me(fakeCookie, { AUTH_MODE: "fake" })).accountId).toBeTruthy();
    expect((await me(fakeCookie, OAUTH)).accountId).toBeNull();
    expect((await me(null, OAUTH)).authMode).toBe("oauth");
  });

  it("운영 표시(DEPLOY_ENV=production)와 AUTH_MODE=fake가 함께면 모든 API를 거절한다", async () => {
    const prod: Partial<Env> = {
      DEPLOY_ENV: "production",
      AUTH_MODE: "fake",
      PUBLIC_ORIGIN: ORIGIN,
      SESSION_SECRET: "x".repeat(40),
    };
    for (const [method, path] of [
      ["GET", "/api/health"],
      ["POST", "/api/auth/fake-login"],
      ["GET", "/api/me"],
    ] as const) {
      const response = await direct(prod, method, path, method === "POST" ? { body: { subject: "x" } } : {});
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CONFIG_ERROR");
    }
    // 운영 설정이 올바르면 동작하고, 가짜 로그인은 없다.
    const ok = { ...prod, AUTH_MODE: "oauth" };
    expect((await direct(ok, "GET", "/api/health")).status).toBe(200);
    expect((await direct(ok, "POST", "/api/auth/fake-login", { body: { subject: "x" } })).status).toBe(404);
    // 비밀값이 짧거나 주소가 자리 표시값이면 거절한다.
    expect((await direct({ ...ok, SESSION_SECRET: "short" }, "GET", "/api/health")).status).toBe(503);
    expect(
      (await direct({ ...ok, PUBLIC_ORIGIN: "https://REPLACE-WITH-YOUR-DOMAIN" }, "GET", "/api/health")).status,
    ).toBe(503);
  });
});

describe("가짜 로그인·테스트 훅은 허용 목록으로만 열린다(검토 L1)", () => {
  /** 요청 주소(호스트)를 바꿔 서버를 직접 부른다. */
  async function at(base: string, overrides: Partial<Env>, method: string, path: string, body?: unknown, cookie?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (cookie) headers.Cookie = cookie;
    const request = new Request(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return app.fetch(request, { ...(env as unknown as Env), ...overrides });
  }
  const fixture = { url: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd/edit#gid=0", csv: "a" };

  it("운영 표시가 없거나(DEPLOY_ENV 없음) 다른 표시(spike)면 AUTH_MODE=fake여도 닫힌다", async () => {
    const cookie = await login();
    for (const deployEnv of [undefined, "spike", "staging", ""]) {
      const overrides = { AUTH_MODE: "fake", DEPLOY_ENV: deployEnv } as Partial<Env>;
      expect((await at("https://example.test", overrides, "POST", "/api/auth/fake-login", { subject: "x" })).status, String(deployEnv)).toBe(404);
      expect((await at("https://example.test", overrides, "POST", "/api/test/sheet-fixture", fixture, cookie)).status).toBe(404);
      const meBody = (await (await at("https://example.test", overrides, "GET", "/api/me")).json()) as any;
      expect(meBody.authMode).toBe("oauth");
    }
  });

  it("DEPLOY_ENV=local이어도 공개 주소로 온 요청에는 가짜 로그인·테스트 훅이 404이고 가짜 계정 세션도 받지 않는다", async () => {
    const cookie = await login();
    const local = { AUTH_MODE: "fake", DEPLOY_ENV: "local" } as Partial<Env>;
    for (const base of ["https://naejeon-v2.someone.workers.dev", "https://naejeon.example.com", "http://192.168.0.10:8787"]) {
      const res = await at(base, local, "POST", "/api/auth/fake-login", { subject: "x" });
      expect(res.status, base).toBe(404);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect((await at(base, local, "POST", "/api/test/sheet-fixture", fixture, cookie)).status, base).toBe(404);
      const meBody = (await (await at(base, local, "GET", "/api/me", undefined, cookie)).json()) as any;
      expect(meBody.authMode).toBe("oauth");
      expect(meBody.accountId).toBeNull();
    }
  });

  it("로컬 주소(localhost·127.0.0.1·테스트용 .test)에서는 그대로 열린다", async () => {
    const local = { AUTH_MODE: "fake", DEPLOY_ENV: "local" } as Partial<Env>;
    for (const base of ["http://127.0.0.1:8787", "http://localhost:8787", "https://example.test"]) {
      const res = await at(base, local, "POST", "/api/auth/fake-login", { subject: unique("local") });
      expect(res.status, base).toBe(200);
      const meBody = (await (await at(base, local, "GET", "/api/me")).json()) as any;
      expect(meBody.authMode).toBe("fake");
    }
  });
});
