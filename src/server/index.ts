import { saveSupportCounts } from "./supportCounts";
import { Hono } from "hono";
import {
  clearSessionCookie,
  createSessionValue,
  fakeLoginEnabled,
  groupIdFromViewToken,
  productionConfigProblem,
  readSession,
  requireAccountId,
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
  requireString,
} from "./http";
import {
  backfillMatch,
  cancelMatch,
  confirmResult,
  correctMatch,
  endLater,
  excludeMatch,
  importMatches,
  MAX_IMPORT_BODY_BYTES,
  restoreMatch,
  saveMemo,
  setImportBatchExcluded,
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
  joinInfo,
  removeJoinEntry,
  setJoinOpen,
} from "./join";
import { mergeParticipants, previewMerge, undoMerge } from "./merge";
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
import { buildSnapshot } from "./snapshot";

const app = new Hono<{ Bindings: Env }>();

/** 요청 수를 세는 비싼 GET 경로: 백업 내려받기, 합치기 미리보기, 가져오기 지문 목록. */
const HEAVY_READ = /^\/api\/groups\/[^/]+\/(export|merges\/preview|imports\/fingerprints)$/;

app.onError((error, c) => {
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
  return c.json({ error: { code: "INTERNAL", message: "서버 오류가 발생했습니다." } }, 500);
});

// API 응답은 캐시하지 않는다.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

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
    if (
      path.startsWith("/api/view/") ||
      path.startsWith("/api/transfer/") ||
      path.startsWith("/api/co-invite/") ||
      path.startsWith("/api/join/")
    ) {
      await hit(c.env, "view-ip", ip);
    } else if (HEAVY_READ.test(path)) {
      // 비싼 읽기(모임 전체를 읽음): IP·계정별로 센다. 운영자 스냅숏과 /api/me는 화면이 자주 부르는
      // 가벼운 경로라 세지 않는다(세면 정상 사용이 한도에 걸린다).
      await hit(c.env, "heavy-ip", ip);
      const session = await readSession(c.env, c.req.raw);
      if (session) await hit(c.env, "heavy-account", session.id);
    }
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
    groups: await listGroups(c.env, session.id),
    authMode,
    providers,
    // 화면이 비밀번호 바꾸기를 보여줄지 정하는 데 쓴다. 아이디는 돌려주지 않는다.
    loginMethod: session.provider === LOCAL_PROVIDER ? "local" : session.provider === "fake" ? "fake" : "oauth",
  });
});

/* ---------------------------- 모임 ---------------------------- */

app.post("/api/groups", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await createGroup(c.env, accountId, await readJsonBody(c.req.raw)));
});

app.get("/api/groups/:gid/snapshot", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await buildSnapshot(c.env, gid, "operator"));
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
  await deleteSeason(c.env, gid, c.req.param("sid"));
  return c.json({ ok: true });
});

app.post("/api/groups/:gid/view-token", async (c) => {
  const gid = c.req.param("gid");
  await requireOperator(c.env, c.req.raw, gid);
  return c.json({ viewToken: await regenerateViewToken(c.env, gid) });
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

app.get("/api/join/:token", async (c) => c.json(await joinInfo(c.env, c.req.param("token"))));

app.post("/api/join/:token", async (c) =>
  c.json(await joinAdd(c.env, c.req.param("token"), await readJsonBody(c.req.raw))),
);

app.post("/api/join/:token/cancel", async (c) =>
  c.json(await joinCancel(c.env, c.req.param("token"), await readJsonBody(c.req.raw))),
);

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
app.get("/api/view/:token", async (c) => {
  const gid = await groupIdFromViewToken(c.env, c.req.param("token"));
  // 칭호 구간·점검 여부는 buildSnapshot의 조회용 허용 목록에서 붙는다(snapshot.ts의 viewerSettings).
  return c.json(await buildSnapshot(c.env, gid, "viewer"));
});

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
});

export default app;
