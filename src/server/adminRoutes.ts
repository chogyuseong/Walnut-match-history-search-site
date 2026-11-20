// 로그인 없이 받는 화면 오류 보고·피드백과, 사이트 운영자 전용 현황·오류 기록·피드백 읽기 API.
import { ApiError } from "./http";
import { recordClientError } from "./errorLog";
import { clearErrorLogs, requireSiteAdmin, siteOverview } from "./siteAdmin";
import { deleteFeedback, listFeedback, submitFeedback } from "./feedback";
import { CLIENT_ERRORS_PATH, FEEDBACK_PATH } from "./routeKit";
import type { App } from "./routeKit";

export function registerAdminRoutes(app: App): void {
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

  // 피드백 보내기. 로그인 없이 받는다. 공통 앞단에서 Origin 확인과 IP별 한도(feedback-ip)를 거친다.
  app.post(FEEDBACK_PATH, async (c) => {
    await submitFeedback(c.env, c.req.raw);
    return c.json({ ok: true });
  });

  // 피드백 읽기·지우기는 사이트 운영자만(아니면 없는 경로처럼 404).
  app.get("/api/admin/feedback", async (c) => {
    await requireSiteAdmin(c.env, c.req.raw);
    return c.json({ feedback: await listFeedback(c.env) });
  });

  app.post("/api/admin/feedback/:id/delete", async (c) => {
    await requireSiteAdmin(c.env, c.req.raw);
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) throw new ApiError(400, "INVALID_FIELD", "번호가 올바르지 않습니다.");
    await deleteFeedback(c.env, id);
    return c.json({ ok: true });
  });
}
