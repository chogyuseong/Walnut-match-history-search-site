import { Hono } from "hono";
import {
  clearSessionCookie,
  createSessionValue,
  groupIdFromViewToken,
  readAccountId,
  requireAccountId,
  requireOperator,
  sessionCookie,
} from "./auth";
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
import { ApiError, assertOnlyKeys, newId, nowIso, readJsonBody, requireString } from "./http";
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
  setImportBatchExcluded,
  startMatch,
} from "./matches";
import { buildSnapshot } from "./snapshot";

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { error: { code: error.code, message: error.message, details: error.details } },
      error.status,
    );
  }
  // 예상하지 못한 오류: 내부 내용을 응답에 싣지 않는다.
  console.error(JSON.stringify({ at: nowIso(), path: c.req.path, error: String(error) }));
  return c.json({ error: { code: "INTERNAL", message: "서버 오류가 발생했습니다." } }, 500);
});

// API 응답은 캐시하지 않는다.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

app.get("/api/health", (c) => c.json({ ok: true }));

/* ---------------------------- 인증 ---------------------------- */

// 로컬·테스트 전용 로그인. 운영 배포(AUTH_MODE가 fake가 아님)에서는 존재하지 않는다.
app.post("/api/auth/fake-login", async (c) => {
  if (c.env.AUTH_MODE !== "fake") throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  const body = await readJsonBody(c.req.raw);
  assertOnlyKeys(body, ["subject"]);
  const subject = requireString(body.subject, "subject", 1, 64);
  await c.env.DB.prepare(
    `INSERT INTO accounts (id, provider, subject, created_at) VALUES (?1, 'fake', ?2, ?3)
     ON CONFLICT (provider, subject) DO NOTHING`,
  )
    .bind(newId(), subject, nowIso())
    .run();
  const account = await c.env.DB.prepare(
    "SELECT id FROM accounts WHERE provider = 'fake' AND subject = ?1",
  )
    .bind(subject)
    .first<{ id: string }>();
  c.header("Set-Cookie", sessionCookie(await createSessionValue(c.env, account!.id)));
  return c.json({ accountId: account!.id });
});

app.post("/api/auth/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const accountId = await readAccountId(c.env, c.req.raw);
  if (!accountId) return c.json({ accountId: null, groups: [], authMode: c.env.AUTH_MODE });
  return c.json({
    accountId,
    groups: await listGroups(c.env, accountId),
    authMode: c.env.AUTH_MODE,
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
  await requireOperator(c.env, c.req.raw, gid);
  return c.json(await createTransfer(c.env, gid));
});

app.get("/api/transfer/:token", async (c) => c.json(await transferInfo(c.env, c.req.param("token"))));

app.post("/api/transfer/:token/accept", async (c) => {
  const accountId = await requireAccountId(c.env, c.req.raw);
  return c.json(await acceptTransfer(c.env, accountId, c.req.param("token")));
});

const matchActions = {
  "end-later": endLater,
  result: confirmResult,
  cancel: cancelMatch,
  exclude: excludeMatch,
  restore: restoreMatch,
  correct: correctMatch,
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

/* ---------------------------- 조회 링크 ---------------------------- */

// 조회 토큰은 읽기만 허용한다. 수정 경로는 모두 운영자 확인을 거친다.
app.get("/api/view/:token", async (c) => {
  const gid = await groupIdFromViewToken(c.env, c.req.param("token"));
  return c.json(await buildSnapshot(c.env, gid, "viewer"));
});

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
});

export default app;
