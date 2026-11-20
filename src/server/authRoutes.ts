// 로그인·계정 API: 개발용 가짜 로그인, 카카오·Google 로그인, 자체 계정(가입·로그인·복구·비밀번호), /api/me.
// 요청 수 한도(auth-ip)와 Origin 확인은 index.ts 공통 앞단에서 먼저 거친다.
import { clearSessionCookie, createSessionValue, fakeLoginEnabled, readSession, recentLoginUntil, requireAccountId, revokeSessions, sessionCookie, upsertAccount } from "./auth";
import { listGroups } from "./groups";
import { ApiError, assertOnlyKeys, nowIso, readJsonBody, requireString } from "./http";
import { listMemberships } from "./members";
import { beginLogin, clearStateCookie, completeLogin, enabledProviders, isProvider, LoginError } from "./oauth";
import { clientIp, hit } from "./ratelimit";
import { changePassword, LOCAL_PROVIDER, localAccountsEnabled, login as localLogin, MAX_LOCAL_BODY_BYTES, recover as localRecover, regenerateRecoveryCode, requireLocalAccounts, signup as localSignup } from "./local";
import { isSiteAdmin } from "./siteAdmin";
import { CLEAR_CACHE } from "./routeKit";
import type { App } from "./routeKit";

export function registerAuthRoutes(app: App): void {
  // 로컬·테스트 전용 로그인. AUTH_MODE=fake, DEPLOY_ENV=local, 로컬 요청 주소가 모두 맞을 때만 있다(허용 목록).
  app.post("/api/auth/fake-login", async (c) => {
    if (!fakeLoginEnabled(c.env, c.req.raw)) throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
    const body = await readJsonBody(c.req.raw);
    assertOnlyKeys(body, ["subject"]);
    const subject = requireString(body.subject, "subject", 1, 64);
    const account = await upsertAccount(c.env, "fake", subject, nowIso());
    c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
    return c.json({ accountId: account.id });
  });

  // 실제 로그인 시작: 제공자 인가 화면으로 보낸다. 키가 없는 제공자는 열리지 않는다.
  app.get("/api/auth/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.redirect("/#/login-failed/not_configured");
    const begun = await beginLogin(c.env, provider, c.req.url, c.req.query("return") ?? "#/", c.req.query("reauth") === "1");
    if (!begun) return c.redirect("/#/login-failed/not_configured");
    c.header("Set-Cookie", begun.setCookie);
    return c.redirect(begun.location);
  });

  // 제공자에서 돌아오는 곳. 리디렉션 URI는 PUBLIC_ORIGIN + 이 경로로 고정이다.
  app.get("/api/auth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    c.header("Set-Cookie", clearStateCookie());
    if (!isProvider(provider)) return c.redirect("/#/login-failed/not_configured");
    try {
      const { subject, returnPath } = await completeLogin(c.env, provider, c.req.raw);
      const account = await upsertAccount(c.env, provider, subject, nowIso());
      c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)), {
        append: true,
      });
      return c.redirect(`/${returnPath}`);
    } catch (error) {
      if (error instanceof LoginError) {
        // 제공자 응답 내용(토큰·식별자)은 남기지 않는다. 실패 종류만 남긴다.
        console.error(JSON.stringify({ at: nowIso(), login: provider, failed: error.reason }));
        return c.redirect(`/#/login-failed/${error.reason}`);
      }
      throw error;
    }
  });

  // 로그아웃: 이 계정의 모든 세션(다른 기기 포함)을 끝낸다. 쿠키만 지우면 복사된 쿠키가 만료까지 살아 있다.
  app.post("/api/auth/logout", async (c) => {
    const session = await readSession(c.env, c.req.raw);
    if (session) await revokeSessions(c.env, session.id);
    c.header("Set-Cookie", clearSessionCookie(c.env));
    c.header("Clear-Site-Data", CLEAR_CACHE);
    return c.json({ ok: true });
  });

  /* ------------------------- 자체 계정(아이디 + 비밀번호) ------------------------- */
  // src/server/local.ts. LOCAL_ACCOUNTS=off면 모두 404. 공통 앞단의 Origin 확인과 auth-ip 한도를 거친 뒤
  // 경로별 IP 한도(가입·로그인·복구)를 한 번 더 센다.

  app.post("/api/auth/signup", async (c) => {
    requireLocalAccounts(c.env);
    await hit(c.env, "signup-ip", clientIp(c.req.raw));
    const { account, recoveryCode } = await localSignup(c.env, await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES));
    c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
    return c.json({ ok: true, recoveryCode });
  });

  app.post("/api/auth/login", async (c) => {
    requireLocalAccounts(c.env);
    await hit(c.env, "login-ip", clientIp(c.req.raw));
    const account = await localLogin(c.env, await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES), clientIp(c.req.raw));
    c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
    return c.json({ ok: true });
  });

  app.post("/api/auth/recover", async (c) => {
    requireLocalAccounts(c.env);
    await hit(c.env, "recover-ip", clientIp(c.req.raw));
    const { account, recoveryCode } = await localRecover(
      c.env,
      await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES),
      clientIp(c.req.raw),
    );
    c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
    return c.json({ ok: true, recoveryCode });
  });

  // 비밀번호 바꾸기: 지금 비밀번호 확인. 다른 기기의 세션은 끝나고 이 기기는 새 세션으로 이어진다.
  app.post("/api/account/password", async (c) => {
    requireLocalAccounts(c.env);
    const accountId = await requireAccountId(c.env, c.req.raw);
    const account = await changePassword(c.env, accountId, await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES));
    c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
    return c.json({ ok: true });
  });

  // 복구 코드 새로 받기: 지금 비밀번호 확인. 이전 코드는 바로 못 쓰게 된다.
  app.post("/api/account/recovery-code", async (c) => {
    requireLocalAccounts(c.env);
    const accountId = await requireAccountId(c.env, c.req.raw);
    const recoveryCode = await regenerateRecoveryCode(
      c.env,
      accountId,
      await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES),
    );
    return c.json({ recoveryCode });
  });

  app.get("/api/me", async (c) => {
    const authMode = fakeLoginEnabled(c.env, c.req.raw) ? "fake" : "oauth";
    // 로그인 수단: 자체 계정(켜져 있으면) + 키가 있는 카카오·Google.
    const providers = [...(localAccountsEnabled(c.env) ? [LOCAL_PROVIDER] : []), ...enabledProviders(c.env)];
    const session = await readSession(c.env, c.req.raw);
    if (!session) return c.json({ accountId: null, groups: [], authMode, providers, loginMethod: null });
    return c.json({
      accountId: session.id,
      // 운영하는 모임(대표·공동). 뜻은 그대로다. 참가자로 연결한 모임은 memberships에 따로 준다(migrations/0019).
      groups: await listGroups(c.env, session.id),
      memberships: await listMemberships(c.env, session.id),
      authMode,
      providers,
      // 화면이 비밀번호 바꾸기를 보여줄지 정하는 데 쓴다. 아이디는 돌려주지 않는다.
      loginMethod: session.provider === LOCAL_PROVIDER ? "local" : session.provider === "fake" ? "fake" : "oauth",
      // 카카오·Google: 어느 제공자로 다시 로그인할지, 되돌리기 어려운 작업을 언제까지 할 수 있는지(confirmIdentity).
      ...(session.provider === "kakao" || session.provider === "google"
        ? {
            provider: session.provider,
            recentLoginUntil: (() => {
              const until = recentLoginUntil(session);
              return until === null ? null : new Date(until).toISOString();
            })(),
          }
        : {}),
      // 사이트 운영자(src/server/siteAdmin.ts)에게만 붙인다. 화면이 현황 메뉴를 보여줄지 정한다.
      ...((await isSiteAdmin(c.env, c.req.raw)) ? { siteAdmin: true } : {}),
    });
  });
}
