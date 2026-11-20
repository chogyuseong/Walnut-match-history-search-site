// Worker 진입점. Hono 앱을 만들고 모든 API가 거치는 공통 앞단(오류 응답, 보안·캐시 헤더, 운영 설정 확인, Origin 확인,
// 요청 수 한도, 모임 쓰기의 운영자·점검·세대 확인)을 건 뒤, 경로 묶음(*Routes.ts)을 등록한다.
// 앞단은 경로보다 먼저 등록해야 걸린다. 맨 끝의 /api/* 404는 모든 경로 묶음 뒤에 둔다.
import { pruneDraftHandoffs } from "./draftHandoff";
import { Hono } from "hono";
import { productionConfigProblem, readSession, requireOperator } from "./auth";
import type { Env } from "./env";
import { ApiError, assertSameOrigin, canConsoleLog, nowIso, securityHeaders } from "./http";
import { maintenanceError } from "./mutation";
import { clientIp, hit } from "./ratelimit";
import { runBackups } from "./backupCron";
import { recordServerError } from "./errorLog";
import { CLIENT_ERRORS_PATH, FEEDBACK_PATH } from "./routeKit";
import { registerAuthRoutes } from "./authRoutes";
import { registerAdminRoutes } from "./adminRoutes";
import { registerGroupRoutes } from "./groupRoutes";
import { registerMatchRoutes } from "./matchRoutes";
import { registerMemberRoutes } from "./memberRoutes";
import { registerViewRoutes } from "./viewRoutes";

const app = new Hono<{ Bindings: Env }>();

/** 요청 수를 세는 비싼 GET 경로: 백업 내려받기, 합치기 미리보기, 가져오기 지문 목록. */
const HEAVY_READ = /^\/api\/groups\/[^/]+\/(export|merges\/preview|imports\/fingerprints)$/;

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
  if (canConsoleLog(c.req.path)) {
    console.error(JSON.stringify({ at: nowIso(), path: c.req.path, error: String(error) }));
  }
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


// 운영 환경 안전장치: 로컬(DEPLOY_ENV=local)이 아닌 곳에서 가짜 로그인이 켜져 있거나 필수 값이 없으면
// 어떤 API도 처리하지 않는다(auth.ts productionConfigProblem). 이유는 응답에 싣지 않고 로그에만 남긴다.
app.use("/api/*", async (c, next) => {
  const problem = productionConfigProblem(c.env);
  if (problem) {
    if (canConsoleLog(c.req.path)) console.error(JSON.stringify({ at: nowIso(), config: problem }));
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
  // HEAD는 GET과 같은 처리를 거쳐(Hono가 GET 경로로 보낸다) 본문만 빠진다. 같은 한도로 센다(2026-11-08 보안 점검).
  const method = c.req.method === "HEAD" ? "GET" : c.req.method;
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
      // 비싼 읽기(모임 전체를 읽음): IP·계정별로 센다. /api/me는 화면이 자주 부르는 가벼운 경로라 세지 않는다.
      // 운영자·멤버 스냅숏은 경로 안에서 200일 때만 센다(countSnapshot, 304는 세지 않음).
      await hit(c.env, "heavy-ip", ip);
      const session = await readSession(c.env, c.req.raw);
      if (session) await hit(c.env, "heavy-account", session.id);
    }
  } else if (method === "POST" && path === CLIENT_ERRORS_PATH) {
    // 화면 오류 보고(로그인 없음): 자기 한도만 센다. 쓰기 한도를 쓰면 오류가 잦은 화면에서 저장까지 막힌다.
    await hit(c.env, "client-error-ip", ip);
  } else if (method === "POST" && path === FEEDBACK_PATH) {
    // 피드백(로그인 없음): 자기 한도만 센다.
    await hit(c.env, "feedback-ip", ip);
  } else if (method !== "OPTIONS") {
    const session = await readSession(c.env, c.req.raw);
    const join = path.startsWith("/api/join/");
    // 세션 없는 쓰기는 세지 않는다(2026-11-10 보안 감사). 참가 신청(토큰이 권한) 말고는 모두 로그인이 필요해 DB를
    // 건드리기 전에 401·404로 끝나는데, 세면 그 요청마다 D1 쓰기 1행이 들어 로그인 없는 한 사람이 하루 쓰기 한도를 축낸다.
    // 로그인 없이 쓰는 경로를 새로 만들면 여기에 더한다(로그인·가입은 위의 auth-ip, 오류 보고는 client-error-ip, 피드백은 feedback-ip).
    if (session || join) {
      // 참가 신청(로그인 없음, 토큰이 권한)은 조회 토큰 한도도 함께 센다.
      if (join) await hit(c.env, "view-ip", ip);
      await hit(c.env, "write-ip", ip);
      if (session) await hit(c.env, "write-account", session.id);
    }
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

registerAuthRoutes(app);
registerAdminRoutes(app);
registerGroupRoutes(app);
registerMatchRoutes(app);
registerMemberRoutes(app);
registerViewRoutes(app);

app.all("/api/*", () => {
  throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
});

/**
 * Worker 진입점. fetch는 Hono 앱, scheduled는 자동 백업(src/server/backupCron.ts, wrangler.jsonc의 triggers.crons)과
 * 오래된 넘긴 편성 정리(src/server/draftHandoff.ts).
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
    // 이어받지 않은 넘긴 편성 정리(draftHandoff.ts). 행이 없으면 쓰기 0행이라 실행마다 불러도 된다.
    ctx.waitUntil(
      pruneDraftHandoffs(env, controller.scheduledTime).catch((error: unknown) =>
        console.error(JSON.stringify({ at: nowIso(), cron: controller.cron, handoffPrune: String(error) })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

export default worker;
