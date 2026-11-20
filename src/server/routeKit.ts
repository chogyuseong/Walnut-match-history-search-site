// API 라우트 파일(*Routes.ts)과 index.ts가 함께 쓰는 상수·도우미: 캐시 헤더 값, 스냅숏·비싼 읽기의 요청 수 셈, 본인 확인.
import type { Hono } from "hono";
import { readSession, recentLoginUntil } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./http";
import { clientIp, hit, spendSnapshotRows } from "./ratelimit";
import { confirmCurrentPassword, LOCAL_PROVIDER } from "./local";

/** 라우트를 등록하는 Hono 앱. index.ts가 만들어 register* 함수들에 넘긴다. */
export type App = Hono<{ Bindings: Env }>;

/** 화면 오류 보고 경로(src/server/errorLog.ts). */
export const CLIENT_ERRORS_PATH = "/api/client-errors";
/** 피드백 보내기 경로(src/server/feedback.ts, 로그인 없음). */
export const FEEDBACK_PATH = "/api/feedback";

/** 조건부 요청(ETag) 경로의 캐시 헤더: 브라우저가 저장하되 매번 If-None-Match로 확인한다. 공용 캐시는 저장하지 않는다. */
export const REVALIDATE = "private, no-cache";
/**
 * 로그아웃·탈퇴 응답에 붙인다. 위 REVALIDATE 때문에 브라우저 캐시에 스냅숏 본문(참가자 이름·조회 토큰)이 남는데,
 * 같은 기기를 다음 사람이 쓸 수 있으므로 이 사이트의 HTTP 캐시를 비우게 한다. 기기 저장소는 화면이 지운다(useApp.ts logout).
 */
export const CLEAR_CACHE = '"cache"';

/**
 * 운영자·멤버 스냅숏의 요청 수 제한(2026-11-09, ratelimit.ts "snapshot-*"). 본문을 만드는 200일 때만 부른다:
 * 304는 모임 행 1행 읽기뿐이라 세지 않는다(조회 링크와 같은 방식). ETag 헤더를 붙이기 전에 불러야 한다
 * (429 응답에 ETag·private가 붙어 브라우저가 저장하면 다음 304가 그 429 본문을 되살릴 수 있다).
 */
export async function countSnapshot(env: Env, req: Request, accountId: string, head: { next_match_no: number }): Promise<void> {
  await hit(env, "snapshot-ip", clientIp(req));
  await hit(env, "snapshot-account", accountId);
  // 하루 읽기 예산(모임 크기에 비례). 분 단위 한도만으로는 큰 모임 하나로 D1 하루 읽기를 십여 분에 다 쓸 수 있었다.
  await spendSnapshotRows(env, { accountId, ip: clientIp(req) }, head.next_match_no - 1);
}

/**
 * 비싼 읽기(HEAVY_READ: 백업 내려받기·합치기 미리보기·가져오기 지문 목록)도 스냅숏과 같은 하루 읽기 예산을 쓴다.
 * 분당 한도(heavy-*)만으로는 큰 모임 백업을 되풀이해 D1 하루 읽기 500만 행을 한 사람이 다 쓸 수 있었다(11-14 점검).
 * 셋 다 모임 경기 수에 비례해 읽으므로 비용은 snapshotCost로 어림한다(지문 목록은 그보다 적게 읽어 넉넉한 쪽이다).
 * 운영자 확인 뒤, 본문을 만들기 전에 부른다. 모임 행 1행을 더 읽는다.
 */
export async function spendHeavyRead(env: Env, req: Request, accountId: string, gid: string): Promise<void> {
  const row = await env.DB.prepare("SELECT next_match_no FROM groups WHERE id = ?1")
    .bind(gid)
    .first<{ next_match_no: number }>();
  if (!row) return;
  await spendSnapshotRows(env, { accountId, ip: clientIp(req) }, row.next_match_no - 1);
}

/**
 * 되돌리기 어려운 작업(모임 삭제·넘기기·복원·탈퇴) 앞의 본인 확인: 세션 쿠키만 훔친 사람이 모임을 지우거나 가져가지 못하게.
 * - 자체 계정: 지금 비밀번호를 한 번 더 확인한다(2026-11-10 보안 감사).
 * - 카카오·Google: 비밀번호가 없으니 최근 RECENT_LOGIN_MS 안에 로그인한 세션이어야 한다(2026-11-17 보안 점검).
 *   아니면 403 REAUTH_REQUIRED. 화면이 그 제공자로 다시 로그인하게 안내한다(details.provider). 401은 화면이
 *   "로그인이 풀렸어요"로 받으므로 쓰지 않는다.
 * - 개발용 가짜 로그인: 건너뛴다(가짜 로그인이 닫힌 곳에서는 그 세션 자체를 받지 않는다, auth.ts loadSession).
 */
export async function confirmIdentity(env: Env, req: Request, password: unknown): Promise<void> {
  const session = await readSession(env, req);
  if (!session) throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  if (session.provider === LOCAL_PROVIDER) {
    await confirmCurrentPassword(env, session.id, password);
    return;
  }
  if (session.provider === "fake") return;
  const until = recentLoginUntil(session);
  if (until === null || until < Date.now()) {
    throw new ApiError(
      403,
      "REAUTH_REQUIRED",
      "안전을 위해 다시 로그인해 주세요. 이 작업은 로그인한 지 10분 안에만 할 수 있어요.",
      { provider: session.provider },
    );
  }
}
