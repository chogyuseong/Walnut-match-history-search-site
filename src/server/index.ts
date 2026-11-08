import { saveSupportCounts } from "./supportCounts";
import { Hono } from "hono";
import {
  clearSessionCookie,
  createSessionValue,
  fakeLoginEnabled,
  productionConfigProblem,
  readSession,
  requireAccountId,
  requireMember,
  requireOperator,
  requireOwner,
  revokeSessions,
  sessionCookie,
  upsertAccount,
} from "./auth";
import {
  acceptCoInvite,
  coInviteInfo,
  createCoInvite,
  listCoOperators,
  removeCoOperator,
} from "./coOperators";
import type { Env } from "./env";
import {
  acceptTransfer,
  closeSession,
  createGroup,
  createTransfer,
  transferInfo,
  createSeason,
  deleteSeason,
  ensureParticipants,
  exportBackup,
  listGroups,
  regenerateViewToken,
  renameGroup,
  saveSettings,
  startNewCycle,
  updateParticipant,
} from "./groups";
import {
  ApiError,
  assertOnlyKeys,
  assertSameOrigin,
  nowIso,
  pathForLog,
  readJsonBody,
  readOptionalJsonBody,
  requireString,
  securityHeaders,
} from "./http";
import {
  MAX_IMPORT_BODY_BYTES,
  backfillMatch,
  cancelMatch,
  confirmResult,
  correctMatch,
  endLater,
  excludeMatch,
  importMatches,
  replaceLiveParticipant,
  restoreMatch,
  saveMemo,
  setImportBatchExcluded,
  shiftMatchDates,
  startMatch,
} from "./matches";
import { addToSeries, createSeries, removeFromSeries, updateSeries } from "./series";
import { deleteAccount, deleteGroup } from "./deletion";
import {
  clearJoinEntries,
  createJoinLink,
  joinAdd,
  joinAdminView,
  joinCancel,
  joinInfoConditional,
  removeJoinEntry,
  setJoinOpen,
} from "./join";
import { mergeParticipants, previewMerge, undoMerge } from "./merge";
import {
  acceptClaim,
  anonymizeParticipant,
  claimInfo,
  createClaimLink,
  createMemberRequest,
  listMemberships,
  memberSnapshot,
  resolveMemberRequest,
  setOwnAvoid,
  unlinkByOperator,
  unlinkSelf,
} from "./members";
import { maintenanceError } from "./mutation";
import {
  beginLogin,
  clearStateCookie,
  completeLogin,
  enabledProviders,
  isProvider,
  LoginError,
} from "./oauth";
import { clientIp, hit } from "./ratelimit";
import {
  changePassword,
  confirmCurrentPassword,
  LOCAL_PROVIDER,
  localAccountsEnabled,
  login as localLogin,
  MAX_LOCAL_BODY_BYTES,
  recover as localRecover,
  regenerateRecoveryCode,
  requireLocalAccounts,
  signup as localSignup,
} from "./local";
import { applyRestore, importAsNewGroup, previewRestore } from "./restore";
import { fixturesEnabled, listImportFingerprints, readSheet, registerFixture } from "./sheets";
import { readLegacy, registerLegacyFixture } from "./legacy";
import { etagMatches, loadEtagHead, loadEtagHeadByViewToken, snapshotBody, snapshotEtag } from "./snapshot";
import { runBackups } from "./backupCron";
import { recordClientError, recordServerError } from "./errorLog";
import { clearErrorLogs, isSiteAdmin, requireSiteAdmin, siteOverview } from "./siteAdmin";

const app = new Hono<{ Bindings: Env }>();

/** 요청 수를 세는 비싼 GET 경로: 백업 내려받기, 합치기 미리보기, 가져오기 지문 목록. */
const HEAVY_READ = /^\/api\/groups\/[^/]+\/(export|merges\/preview|imports\/fingerprints)$/;
/** 화면 오류 보고 경로(src/server/errorLog.ts). */
const CLIENT_ERRORS_PATH = "/api/client-errors";

app.onError(async (error, c) => {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
      if (retryAfter) c.header("Retry-After", String(retryAfter));
    }
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    );
  }
  // 예상하지 못한 오류: 내부 내용을 응답에 싣지 않는다.
  console.error(JSON.stringify({ at: nowIso(), path: pathForLog(c.req.path), error: String(error) }));
  // 오류 기록 표에도 넣는다(가린 값만, src/server/errorLog.ts). 넣다가 실패해도 응답은 그대로다.
  // 사용자 실수(ApiError: 4xx·점검 503)는 위에서 돌아가므로 여기 오지 않는다.
  // 응답을 늦추지 않게 Workers의 waitUntil로 넘긴다(실행 문맥이 없는 직접 호출·테스트에서는 기다린다).
  const recording = recordServerError(c.env, c.req.path, error).catch(() => undefined);
  try {
    c.executionCtx.waitUntil(recording);
  } catch {
    await recording;
  }
  return c.json({ error: { code: "INTERNAL", message: "서버 오류가 발생했습니다." } }, 500);
});

// 보안 헤더(src/server/http.ts securityHeaders). 오류 응답에도 붙도록 가장 바깥에서 넣는다.
app.use("*", async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(securityHeaders(c.env.DEPLOY_ENV))) c.header(name, value);
});

// API 응답은 캐시하지 않는다. 조건부 요청을 쓰는 스냅숏·조회·참가 신청 경로만 경로 안에서
// "private, no-cache"(저장은 하되 쓸 때마다 서버에 확인)를 정하고, 여기서는 덮어쓰지 않는다.
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

/** 조건부 요청(ETag) 경로의 캐시 헤더: 브라우저가 저장하되 매번 If-None-Match로 확인한다. 공용 캐시는 저장하지 않는다. */
const REVALIDATE = "private, no-cache";

// 운영 환경 안전장치: 운영(DEPLOY_ENV=production)에서 가짜 로그인이 켜져 있거나 필수 값이 없으면
// 어떤 API도 처리하지 않는다. 이유는 응답에 싣지 않고 로그에만 남긴다.
app.use("/api/*", async (c, next) => {
  const problem = productionConfigProblem(c.env);
  if (problem) {
    console.error(JSON.stringify({ at: nowIso(), config: problem }));
    throw new ApiError(503, "CONFIG_ERROR", "서비스 설정을 확인하는 중입니다. 잠시 뒤 다시 시도해 주세요.");
  }
  await next();
});

// CSRF 두 번째 방어: 상태를 바꾸는 요청에 Origin이 있으면 서비스 주소와 같아야 한다(src/server/http.ts).
// 요청 수를 세기 전에 거절해 다른 사이트의 요청이 한도를 쓰지 못하게 한다.
app.use("/api/*", async (c, next) => {
  assertSameOrigin(c.req.raw, c.env.PUBLIC_ORIGIN);
  await next();
});

// 요청 수 제한(계정·IP별). 로그인 경로, 조회 토큰·인수 링크 경로, 모든 쓰기 경로에 건다.
app.use("/api/*", async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const ip = clientIp(c.req.raw);
  if (path.startsWith("/api/auth/")) {
    try {
      await hit(c.env, "auth-ip", ip);
    } catch (error) {
      // 로그인 시작·콜백은 화면 이동이라 JSON 대신 안내 화면으로 보낸다.
      if (method === "GET" && error instanceof ApiError && error.status === 429) {
        return c.redirect("/#/login-failed/rate_limited");
      }
      throw error;
    }
  } else if (method === "GET") {
    if (path.startsWith("/api/view/") || path.startsWith("/api/join/")) {
      // 조회 링크·참가 신청 공개 조회는 경로 안에서 센다(countViewUnlessNotModified): ETag가 맞아 304로 답하는
      // 요청은 세지 않아 D1 쓰기(rate_limits 1행)를 쓰지 않는다. 2026-11-08, docs/개선-서버-2026-11-08.md 4절.
    } else if (
      path.startsWith("/api/transfer/") ||
      path.startsWith("/api/co-invite/") ||
      path.startsWith("/api/claim/")
    ) {
      await hit(c.env, "view-ip", ip);
    } else if (HEAVY_READ.test(path)) {
      // 비싼 읽기(모임 전체를 읽음): IP·계정별로 센다. 운영자 스냅숏과 /api/me는 화면이 자주 부르는
      // 가벼운 경로라 세지 않는다(세면 정상 사용이 한도에 걸린다).
      await hit(c.env, "heavy-ip", ip);
      const session = await readSession(c.env, c.req.raw);
      if (session) await hit(c.env, "heavy-account", session.id);
    }
  } else if (method === "POST" && path === CLIENT_ERRORS_PATH) {
    // 화면 오류 보고(로그인 없음): 자기 한도만 센다. 쓰기 한도를 쓰면 오류가 잦은 화면에서 저장까지 막힌다.
    await hit(c.env, "client-error-ip", ip);
  } else if (method !== "HEAD" && method !== "OPTIONS") {
    // 참가 신청(로그인 없음, 토큰이 권한)은 조회 토큰 한도도 함께 센다.
    if (path.startsWith("/api/join/")) await hit(c.env, "view-ip", ip);
    await hit(c.env, "write-ip", ip);
    const session = await readSession(c.env, c.req.raw);
    if (session) await hit(c.env, "write-account", session.id);
  }
  await next();
});

/**
 * 모임 쓰기의 공통 앞단(경로 안의 runMutation 검사와 겹쳐도 안전하다).
 * - 운영자 확인을 먼저 해서, 권한이 없으면 점검 여부도 드러내지 않는다.
 * - 점검 중(복원이 진행 중이거나 중간에 멈춤)이면 복원·모임 삭제 경로 말고는 거절한다
 *   (중간에 멈춘 모임도 지울 수 있어야 한다).
 * - 화면이 보낸 모임 세대(X-Group-Generation)가 지금과 다르면 거절한다: 복원 전에 열린 탭의 요청.
 */
app.use("/api/groups/*", async (c, next) => {
  const method = c.req.method;
  const parts = c.req.path.split("/");
  const gid = parts[3];
  if (method === "GET" || method === "HEAD" || !gid) return next();
  await requireOperator(c.env, c.req.raw, gid);
  if (parts[4] !== "restore") {
    const row = await c.env.DB.prepare("SELECT maintenance, generation FROM groups WHERE id = ?1")
      .bind(gid)
      .first<{ maintenance: number; generation: number }>();
    if (!row) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
    if (row.maintenance === 1 && parts[4] !== "delete") throw maintenanceError();
    const sent = c.req.header("X-Group-Generation");
    if (sent !== undefined && sent !== String(row.generation)) {
      throw new ApiError(
        409,
        "GROUP_RESTORED",
        "이 모임이 백업에서 복원됐어요. 화면을 새로 고친 뒤 다시 해 주세요.",
        { generation: row.generation },
      );
    }
  }
  return next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

/* ---------------------------- 인증 ---------------------------- */

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
  const begun = await beginLogin(c.env, provider, c.req.url, c.req.query("return") ?? "#/");
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
  c.header("Set-Cookie", clearSessionCookie());
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
  const account = await localLogin(c.env, await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES));
  c.header("Set-Cookie", sessionCookie(c.env, await createSessionValue(c.env, account)));
  return c.json({ ok: true });
});

app.post("/api/auth/recover", async (c) => {
  requireLocalAccounts(c.env);
  await hit(c.env, "recover-ip", clientIp(c.req.raw));
  const { account, recoveryCode } = await localRecover(c.env, await readJsonBody(c.req.raw, MAX_LOCAL_BODY_BYTES));
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
    // 사이트 운영자(src/server/siteAdmin.ts)에게만 붙인다. 화면이 현황 메뉴를 보여줄지 정한다.
    ...((await isSiteAdmin(c.env, c.req.raw)) ? { siteAdmin: true } : {}),
  });
});

/* ---------------------------- 오류 기록 · 사이트 운영자 현황 ---------------------------- */

// 화면 오류 보고. 로그인 없이 받는다. 공통 앞단에서 Origin 확인과 IP별 한도(client-error-ip)를 거친다.
// 본문은 JSON만, 16KB까지. 계정·IP·쿠키는 저장하지 않는다(src/server/errorLog.ts).
app.post(CLIENT_ERRORS_PATH, async (c) => {
  await recordClientError(c.env, c.req.raw);
  return c.json({ ok: true });
});

// 사이트 운영자만. 아니면 없는 경로처럼 404. 전체 수치와 오류 기록만 돌려준다(모임 안의 자료는 없음).
app.get("/api/admin/overview", async (c) => {
  await requireSiteAdmin(c.env, c.req.raw);
  return c.json(await siteOverview(c.env));
});

app.post("/api/admin/errors/clear", async (c) => {
  await requireSiteAdmin(c.env, c.req.raw);
  return c.json({ cleared: await clearErrorLogs(c.env) });
});

/* ---------------------------- 모임 ---------------------------- */

app.post("/api/groups", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await createGroup(c.env, accountId, await readJsonBody(c.req.raw)));
});

// 운영자 스냅숏. ETag(모임 행 1행만 읽어 계산)가 화면이 가진 것과 같으면 304로 답해 나머지를 읽지 않는다.
// 응답 본문은 예전과 같다(헤더만 더함). 브라우저 fetch는 304를 저장해 둔 본문으로 바꿔 주므로 화면 변경이 필요 없다.
app.get("/api/groups/:gid/snapshot", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  const head = await loadEtagHead(c.env, gid);
  if (!head) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  const etag = await snapshotEtag(c.env, head, "operator");
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE);
  if (etagMatches(c.req.header("If-None-Match"), etag)) return c.body(null, 304);
  return c.json(await snapshotBody(c.env, gid, "operator", etag));
});

app.patch("/api/groups/:gid", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await renameGroup(c.env, gid, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/participants", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({
    participants: await ensureParticipants(c.env, gid, await readJsonBody(c.req.raw)),
  });
});

app.patch("/api/groups/:gid/participants/:pid", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await updateParticipant(c.env, gid, c.req.param("pid"), await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.put("/api/groups/:gid/settings", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await saveSettings(c.env, gid, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/rotation/new-cycle", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await startNewCycle(c.env, gid, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

// 서포터 횟수 직접 입력: 여러 사람의 횟수를 한 번에 정한다(운영자·공동 운영자).
app.post("/api/groups/:gid/rotation/counts", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await saveSupportCounts(c.env, gid, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/session/close", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await closeSession(c.env, gid, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/seasons", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await createSeason(c.env, gid, await readJsonBody(c.req.raw)));
});

app.delete("/api/groups/:gid/seasons/:sid", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await deleteSeason(c.env, gid, c.req.param("sid"), await readOptionalJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/view-token", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({ viewToken: await regenerateViewToken(c.env, gid, await readOptionalJsonBody(c.req.raw)) });
});

/* ---------------------------- 백업 복원 ---------------------------- */

// 검증과 요약만 한다(아무것도 쓰지 않음). 복원은 대표 운영자만 한다.
app.post("/api/groups/:gid/restore/preview", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await previewRestore(c.env, gid, c.req.raw));
});

// 같은 모임 복구. 운영자·공동 운영자·조회 토큰은 바뀌지 않는다. 대표 운영자만.
app.post("/api/groups/:gid/restore", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await applyRestore(c.env, gid, c.req.raw));
});

// 다른 모임(또는 빈 환경)의 백업을 새 모임으로 가져온다.
app.post("/api/restore/new-group", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await importAsNewGroup(c.env, accountId, c.req.raw));
});

/* ---------------------------- 모임·계정 삭제 ---------------------------- */

// 모임 삭제(되돌릴 수 없음). 화면이 실행 직전에 백업을 내려받는다. 대표 운영자만.
app.post("/api/groups/:gid/delete", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await deleteGroup(c.env, gid, await readJsonBody(c.req.raw)));
});

// 계정 삭제(탈퇴). 운영 중인 모임이 있으면 거절한다. 성공하면 세션 쿠키를 지운다.
app.post("/api/account/delete", async (c) => {
  const session = await readSession(c.env, c.req.raw);
  if (!session) throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  const accountId = session.id;
  const body = await readJsonBody(c.req.raw);
  // 자체 계정은 비밀번호를 한 번 더 확인한다(세션 쿠키만 훔친 사람이 계정을 지우지 못하게).
  if (session.provider === LOCAL_PROVIDER) {
    await confirmCurrentPassword(c.env, accountId, body.password);
  }
  delete body.password;
  await deleteAccount(c.env, accountId, body);
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

/* ---------------------------- 중복 참가자 합치기 ---------------------------- */

// 미리보기: 옮길 경기 수, 겹치는 경기, 합친 뒤 승패·배치·칭호. 아무것도 쓰지 않는다.
app.get("/api/groups/:gid/merges/preview", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(
    await previewMerge(c.env, gid, { sourceId: c.req.query("source"), targetId: c.req.query("target") }),
  );
});

app.post("/api/groups/:gid/merges", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await mergeParticipants(c.env, gid, await readJsonBody(c.req.raw)));
});

app.post("/api/groups/:gid/merges/:mid/undo", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await undoMerge(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw)));
});

app.get("/api/groups/:gid/export", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await exportBackup(c.env, gid));
});

/* ---------------------------- 경기 ---------------------------- */

app.post("/api/groups/:gid/matches/start", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({ match: await startMatch(c.env, gid, await readJsonBody(c.req.raw)) });
});

app.post("/api/groups/:gid/matches/backfill", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({ match: await backfillMatch(c.env, gid, await readJsonBody(c.req.raw)) });
});

app.post("/api/groups/:gid/matches/import", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(
    await importMatches(c.env, gid, await readJsonBody(c.req.raw, MAX_IMPORT_BODY_BYTES)),
  );
});

// 구글 시트 읽기(내용은 저장하지 않고 돌려주기만 한다). src/server/sheets.ts
app.post("/api/groups/:gid/sheets/read", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await readSheet(c.env, c.req.raw, await readJsonBody(c.req.raw)));
});

// 기존 사이트(v1) 기록 읽기(읽기만, 저장하지 않는다). src/server/legacy.ts
app.post("/api/groups/:gid/legacy/read", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await readLegacy(c.env, c.req.raw, gid, await readJsonBody(c.req.raw)));
});

// 다시 가져오기에서 이미 들어간 경기를 가려내기 위한 지문 목록.
app.get("/api/groups/:gid/imports/fingerprints", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await listImportFingerprints(c.env, gid));
});

// 로컬 브라우저 테스트 전용 시트 내용 등록. AUTH_MODE=fake(운영 표시 없음)가 아니면 404.
app.post("/api/test/sheet-fixture", async (c) => {
  // 환경(AUTH_MODE=fake, DEPLOY_ENV=local)과 요청 주소(로컬) 둘 다 맞아야 열린다(src/server/auth.ts).
  if (!fixturesEnabled(c.env) || !fakeLoginEnabled(c.env, c.req.raw)) {
    throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  }
  await requireAccountId(c.env, c.req.raw);
  return c.json(await registerFixture(c.env, await readJsonBody(c.req.raw, 600 * 1024)));
});

// 로컬 브라우저 테스트 전용 기존 사이트 응답 등록. 시트 내용 등록과 같은 조건이 아니면 404.
app.post("/api/test/legacy-fixture", async (c) => {
  if (!fixturesEnabled(c.env) || !fakeLoginEnabled(c.env, c.req.raw)) {
    throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  }
  await requireAccountId(c.env, c.req.raw);
  return c.json(registerLegacyFixture(await readJsonBody(c.req.raw, 2.5 * 1024 * 1024)));
});

app.post("/api/groups/:gid/imports/:bid", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(
    await setImportBatchExcluded(c.env, gid, c.req.param("bid"), await readJsonBody(c.req.raw)),
  );
});

/* ---------------------------- 운영자 교체 ---------------------------- */

app.post("/api/groups/:gid/transfer", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await createTransfer(c.env, gid));
});

app.get("/api/transfer/:token", async (c) => c.json(await transferInfo(c.env, c.req.param("token"))));

app.post("/api/transfer/:token/accept", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await acceptTransfer(c.env, accountId, c.req.param("token")));
});

/* ---------------------------- 공동 운영자 ---------------------------- */
// src/server/coOperators.ts. 초대·목록·내보내기는 대표 운영자만, 나가기는 공동 운영자 본인.

app.get("/api/groups/:gid/co-operators", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await listCoOperators(c.env, gid));
});

app.post("/api/groups/:gid/co-operators/invite", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  return c.json(await createCoInvite(c.env, gid));
});

// 공동 운영자가 스스로 나간다. 대표 운영자는 나갈 수 없다(넘기거나 삭제).
app.post("/api/groups/:gid/co-operators/leave", async (c) => {
  const gid = c.req.param("gid");
  const accountId = await requireOperator(c.env, c.req.raw, gid);
  await removeCoOperator(c.env, gid, accountId);
  return c.json({ ok: true });
});

app.delete("/api/groups/:gid/co-operators/:aid", async (c) => {
  const gid = c.req.param("gid");
  await requireOwner(c.env, c.req.raw, gid);
  await removeCoOperator(c.env, gid, c.req.param("aid"));
  return c.json({ ok: true });
});

app.get("/api/co-invite/:token", async (c) => c.json(await coInviteInfo(c.env, c.req.param("token"))));

app.post("/api/co-invite/:token/accept", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await acceptCoInvite(c.env, accountId, c.req.param("token")));
});

/* ---------------------------- 참가 신청 링크 ---------------------------- */
// src/server/join.ts. 운영 경로는 대표·공동 운영자, 공개 경로(/api/join/:token)는 로그인 없음.

app.get("/api/groups/:gid/join", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await joinAdminView(c.env, gid));
});

// 만들기·다시 만들기(이전 링크 무효). 토큰 원문은 이 응답에서 한 번만 준다.
app.post("/api/groups/:gid/join/link", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await createJoinLink(c.env, gid));
});

app.post("/api/groups/:gid/join/open", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await setJoinOpen(c.env, gid, await readJsonBody(c.req.raw));
  return c.json(await joinAdminView(c.env, gid));
});

app.post("/api/groups/:gid/join/clear", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await clearJoinEntries(c.env, gid, await readJsonBody(c.req.raw));
  return c.json(await joinAdminView(c.env, gid));
});

app.post("/api/groups/:gid/join/remove", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await removeJoinEntry(c.env, gid, await readJsonBody(c.req.raw));
  return c.json(await joinAdminView(c.env, gid));
});

// 로그인 없이도 쓴다. 로그인한 멤버면 계정을 넘겨 본인 확인 신청·내 이름 표시에 쓴다(src/server/join.ts).
// 조건부 요청: 링크 행 1행으로 ETag를 만들고, 같으면 304(명단·신청을 읽지 않는다).
app.get("/api/join/:token", async (c) => {
  const accountId = (await readSession(c.env, c.req.raw))?.id ?? null;
  // 요청 수 제한(view-ip)은 304가 아닐 때만 센다(joinInfoConditional의 count, 조회 링크와 같은 방식).
  const result = await joinInfoConditional(
    c.env,
    c.req.param("token"),
    accountId,
    c.req.header("If-None-Match") ?? null,
    () => hit(c.env, "view-ip", clientIp(c.req.raw)),
  );
  c.header("ETag", result.etag);
  c.header("Cache-Control", REVALIDATE);
  // 로그인 여부에 따라 본문이 다르다(ETag에 계정을 넣었다). 중간 캐시가 섞지 않게 알린다.
  c.header("Vary", "Cookie");
  if (result.notModified) return c.body(null, 304);
  return c.json(result.view);
});

app.post("/api/join/:token", async (c) =>
  c.json(
    await joinAdd(
      c.env,
      c.req.param("token"),
      await readJsonBody(c.req.raw),
      (await readSession(c.env, c.req.raw))?.id ?? null,
    ),
  ),
);

app.post("/api/join/:token/cancel", async (c) =>
  c.json(
    await joinCancel(
      c.env,
      c.req.param("token"),
      await readJsonBody(c.req.raw),
      (await readSession(c.env, c.req.raw))?.id ?? null,
    ),
  ),
);

/* ---------------------------- 참가자 본인 연결 · 멤버 ---------------------------- */
// src/server/members.ts. 연결 링크 만들기·끊기·요청 처리·익명 처리는 운영자(대표·공동, 공통 앞단 requireOperator).
// 멤버 경로(/api/member/:gid/...)는 운영자 경로와 따로 requireMember로만 연다(운영자 경로는 멤버에게 열리지 않는다).

app.post("/api/groups/:gid/participants/:pid/claim-link", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await createClaimLink(c.env, gid, c.req.param("pid")));
});

app.delete("/api/groups/:gid/participants/:pid/link", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await unlinkByOperator(c.env, gid, c.req.param("pid"), await readOptionalJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/participants/:pid/anonymize", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await anonymizeParticipant(c.env, gid, c.req.param("pid"), await readJsonBody(c.req.raw)));
});

app.post("/api/groups/:gid/member-requests/:rid/resolve", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  await resolveMemberRequest(c.env, gid, c.req.param("rid"), await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.get("/api/claim/:token", async (c) => c.json(await claimInfo(c.env, c.req.param("token"))));

app.post("/api/claim/:token/accept", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await acceptClaim(c.env, accountId, c.req.param("token")));
});

app.get("/api/member/:gid/snapshot", async (c) => {
  const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
  return c.json(await memberSnapshot(c.env, ctx));
});

app.put("/api/member/:gid/avoid", async (c) => {
  const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
  await setOwnAvoid(c.env, ctx, await readJsonBody(c.req.raw));
  return c.json({ ok: true });
});

app.post("/api/member/:gid/requests", async (c) => {
  const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
  return c.json(await createMemberRequest(c.env, ctx, await readJsonBody(c.req.raw)));
});

app.post("/api/member/:gid/unlink", async (c) => {
  const ctx = await requireMember(c.env, c.req.raw, c.req.param("gid"));
  await unlinkSelf(c.env, ctx);
  return c.json({ ok: true });
});

const matchActions = {
  "end-later": endLater,
  result: confirmResult,
  cancel: cancelMatch,
  exclude: excludeMatch,
  restore: restoreMatch,
  correct: correctMatch,
  // 경기 메모(migrations/0016). 진행 중·결과 대기·확정 경기.
  memo: saveMemo,
} as const;

app.post("/api/groups/:gid/matches/:mid/:action", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  const action = c.req.param("action");
  if (!Object.hasOwn(matchActions, action)) {
    throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  }
  const handler = matchActions[action as keyof typeof matchActions];
  return c.json({
    match: await handler(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw)),
  });
});

// 날짜 일괄 정정(2026-11-08, src/server/matches.ts shiftMatchDates). 운영자·공동 운영자. 화면 "날짜 점검".
app.post("/api/groups/:gid/matches/shift-dates", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await shiftMatchDates(c.env, gid, await readJsonBody(c.req.raw)));
});

// 진행 중 경기의 사람 교체(2026-11-07, src/server/matches.ts replaceLiveParticipant). 운영자·공동 운영자.
app.patch("/api/groups/:gid/matches/:mid/roster", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({
    match: await replaceLiveParticipant(c.env, gid, c.req.param("mid"), await readJsonBody(c.req.raw)),
  });
});

/* ---------------------------- 시리즈 묶음 ---------------------------- */
// src/server/series.ts. 운영자·공동 운영자. 만들기는 확정 경기로, 시작 때 이어가기는 matches/start의 series 필드로.

app.post("/api/groups/:gid/series", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await createSeries(c.env, gid, await readJsonBody(c.req.raw)));
});

const seriesActions = {
  add: addToSeries,
  remove: removeFromSeries,
  update: updateSeries,
} as const;

app.post("/api/groups/:gid/series/:sid/:action", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  const action = c.req.param("action");
  if (!Object.hasOwn(seriesActions, action)) {
    throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  }
  const handler = seriesActions[action as keyof typeof seriesActions];
  return c.json(await handler(c.env, gid, c.req.param("sid"), await readJsonBody(c.req.raw)));
});

/* ---------------------------- 조회 링크 ---------------------------- */

// 조회 토큰은 읽기만 허용한다. 수정 경로는 모두 운영자 확인을 거친다.
// 조건부 요청: 토큰으로 모임 행 1행을 읽어 ETag를 만들고, 같으면 304(경기·명단을 읽지 않는다).
// 조회 토큰을 다시 만들면 예전 토큰은 행을 찾지 못해 404다(ETag가 같아도 304를 주지 않는다).
// 요청 수 제한(view-ip)은 304가 아닐 때만 센다: 없는 토큰(404, 토큰 맞히기 방지)과 본문을 만드는 200.
app.get("/api/view/:token", async (c) => {
  const count = () => hit(c.env, "view-ip", clientIp(c.req.raw));
  const head = await loadEtagHeadByViewToken(c.env, c.req.param("token"));
  if (!head) {
    await count();
    throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  }
  const etag = await snapshotEtag(c.env, head, "viewer");
  const notModified = etagMatches(c.req.header("If-None-Match"), etag);
  // 세기(429일 수 있음)를 ETag 헤더보다 먼저 한다: 429 응답에 ETag·private가 붙어 브라우저가 저장하면
  // 다음 304가 그 429 본문을 되살릴 수 있다.
  if (!notModified) await count();
  c.header("ETag", etag);
  c.header("Cache-Control", REVALIDATE);
  if (notModified) return c.body(null, 304);
  // 칭호 구간·점검 여부는 buildSnapshot의 조회용 허용 목록에서 붙는다(snapshot.ts의 viewerSettings).
  return c.json(await snapshotBody(c.env, head.id, "viewer", etag));
});

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
});

/**
 * Worker 진입점. fetch는 Hono 앱, scheduled는 자동 백업(src/server/backupCron.ts, wrangler.jsonc의 triggers.crons).
 * 테스트(test/direct.ts 등)는 이 객체의 fetch를 그대로 부른다.
 */
const worker = {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runBackups(env, controller.scheduledTime).then(
        (result) => console.log(JSON.stringify({ at: nowIso(), cron: controller.cron, backups: result })),
        (error: unknown) => console.error(JSON.stringify({ at: nowIso(), cron: controller.cron, error: String(error) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
