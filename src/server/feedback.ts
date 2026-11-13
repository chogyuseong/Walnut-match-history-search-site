/**
 * 피드백(migrations/0028, 시험 운영 기간). 화면 #/feedback이 로그인 없이 보내고(POST /api/feedback),
 * 사이트 운영자만 사이트 관리 화면에서 읽고 지운다(GET /api/admin/feedback, POST /api/admin/feedback/:id/delete).
 *
 * 저장하지 않는 것: 계정 ID, IP, 쿠키, 연락처. 브라우저는 종류만(errorScrub.ts browserKind).
 * 도배는 IP별 분당 한도(ratelimit.ts feedback-ip)와 보관 건수 한도로 묶는다. 한도에 자주 걸리는 IP는
 * 하루 벌점(day-strike-ip)으로 그날 막힌다.
 */
import { browserKind } from "../shared/errorScrub";
import { FEEDBACK_MAX_CHARS, FEEDBACK_MIN_CHARS } from "../shared/feedback";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, readJsonBody } from "./http";

/** 보관 건수. 넘으면 오래된 것부터 지운다. 도배가 들어와도 표가 이 크기 이상 커지지 않는다. */
export const FEEDBACK_MAX_ROWS = 500;
/** 보관 기간(일). 시험 운영 기간보다 넉넉히. 개인정보 처리방침의 보관 기간과 같게 둔다. */
export const FEEDBACK_MAX_DAYS = 180;
/** 본문 상한(바이트). 한글 1000자 ≈ 3KB에 JSON 껍데기를 더해도 넉넉하다. */
const MAX_FEEDBACK_BODY_BYTES = 8 * 1024;
/** 사이트 관리 화면에 한 번에 보여 주는 건수(최근 것부터). 보관 한도와 같아 전부 나온다. */
const FEEDBACK_LIST_MAX = FEEDBACK_MAX_ROWS;

export interface FeedbackEntry {
  id: number;
  createdAt: string;
  body: string;
  appVersion: string | null;
  browser: string | null;
}

/** 시계. 보관 기간 정리를 시험할 때 바꿔 끼운다. */
export const feedbackClock = { now: (): number => Date.now() };

/** POST /api/feedback. 글 한 건을 넣고 보관 한도를 넘은 오래된 글을 지운다(한 batch). */
export async function submitFeedback(env: Env, req: Request): Promise<void> {
  const payload = await readJsonBody(req, MAX_FEEDBACK_BODY_BYTES);
  assertOnlyKeys(payload, ["body", "appVersion"]);
  if (typeof payload.body !== "string") throw new ApiError(400, "INVALID_FIELD", "내용을 적어 주세요.");
  const body = payload.body.trim();
  if (body.length < FEEDBACK_MIN_CHARS) {
    throw new ApiError(400, "FEEDBACK_TOO_SHORT", `${FEEDBACK_MIN_CHARS}자 이상 적어 주세요.`);
  }
  if (body.length > FEEDBACK_MAX_CHARS) {
    throw new ApiError(400, "FEEDBACK_TOO_LONG", `${FEEDBACK_MAX_CHARS}자까지 보낼 수 있어요.`);
  }
  const version = typeof payload.appVersion === "string" && /^[\w.-]{1,32}$/.test(payload.appVersion) ? payload.appVersion : null;
  const now = feedbackClock.now();
  const cutoff = new Date(now - FEEDBACK_MAX_DAYS * 24 * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO feedback (created_at, body, app_version, browser) VALUES (?1, ?2, ?3, ?4)").bind(
      new Date(now).toISOString(),
      body,
      version,
      browserKind(req.headers.get("User-Agent")),
    ),
    env.DB.prepare("DELETE FROM feedback WHERE created_at < ?1").bind(cutoff),
    env.DB.prepare("DELETE FROM feedback WHERE id NOT IN (SELECT id FROM feedback ORDER BY id DESC LIMIT ?1)").bind(
      FEEDBACK_MAX_ROWS,
    ),
  ]);
}

/** 사이트 운영자용 목록(최근 것부터). 부르는 쪽이 requireSiteAdmin을 먼저 거친다. */
export async function listFeedback(env: Env): Promise<FeedbackEntry[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, body, app_version, browser FROM feedback ORDER BY id DESC LIMIT ?1",
  )
    .bind(FEEDBACK_LIST_MAX)
    .all<{ id: number; created_at: string; body: string; app_version: string | null; browser: string | null }>();
  return results.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    body: r.body,
    appVersion: r.app_version,
    browser: r.browser,
  }));
}

/** 한 건 지우기. 없는 번호도 오류 없이 지나간다(두 번 누른 경우). */
export async function deleteFeedback(env: Env, id: number): Promise<void> {
  await env.DB.prepare("DELETE FROM feedback WHERE id = ?1").bind(id).run();
}
