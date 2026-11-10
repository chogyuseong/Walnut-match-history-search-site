/**
 * 오류 기록(migrations/0018). 화면이 보낸 오류(POST /api/client-errors)와 서버의 예상하지 못한 오류(app.onError)를
 * 한 표에 넣고, 사이트 운영자 현황 화면(src/server/siteAdmin.ts)이 읽는다.
 *
 * 저장하지 않는 것: 계정 ID, IP, 쿠키, 요청 본문, 참가자 이름. 경로·메시지·스택은 넣기 전에 가린다
 * (src/shared/errorScrub.ts, 서버 경로는 pathForLog도 거친다). 화면이 보낸 값도 다시 가린다.
 */
import {
  browserKind,
  ERROR_MESSAGE_MAX,
  ERROR_PATH_MAX,
  ERROR_STACK_MAX,
  scrubPath,
  scrubText,
} from "../shared/errorScrub";
import { APP_VERSION } from "../shared/version";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, pathForLog, readJsonBody } from "./http";

/**
 * 보관 한도: 출처(client·server)마다 최근 이만큼만 남긴다(합쳐 최대 2배).
 * 출처를 합쳐 세면 로그인 없이 보내는 화면 오류(IP당 분당 10건)로 한도를 채워 서버 오류 기록을 밀어낼 수 있었다
 * (2026-11-10 보안 감사).
 */
export const ERROR_LOG_MAX_ROWS = 1000;
/** 보관 한도: 이 날수보다 오래된 기록은 지운다. */
export const ERROR_LOG_MAX_DAYS = 30;
/** 화면 오류 보고 본문 상한(바이트). 화면은 메시지 500자·스택 2000자로 잘라 보낸다(한글이면 약 7.5KB). */
export const MAX_CLIENT_ERROR_BODY_BYTES = 16 * 1024;

export type ErrorKind = "error" | "rejection" | "boundary" | "server";
const CLIENT_KINDS: readonly ErrorKind[] = ["error", "rejection", "boundary"];

export interface ErrorEntry {
  source: "client" | "server";
  kind: ErrorKind;
  message: string;
  stack: string | null;
  path: string | null;
  appVersion: string | null;
  browser: string | null;
}

/** 시계. 보관 기간 정리를 시험할 때 바꿔 끼운다. */
export const errorLogClock = { now: (): number => Date.now() };

/** 한 건 넣고, 보관 한도를 넘은 오래된 기록을 지운다(한 batch). 건수 한도는 넣은 기록과 같은 출처만 본다. */
export async function recordError(env: Env, entry: ErrorEntry): Promise<void> {
  const now = errorLogClock.now();
  const cutoff = new Date(now - ERROR_LOG_MAX_DAYS * 24 * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO error_logs (created_at, source, kind, message, stack, path, app_version, browser)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(
      new Date(now).toISOString(),
      entry.source,
      entry.kind,
      scrubText(entry.message, ERROR_MESSAGE_MAX) || "(메시지 없음)",
      entry.stack ? scrubText(entry.stack, ERROR_STACK_MAX) : null,
      entry.path ? scrubPath(entry.path) : null,
      entry.appVersion,
      entry.browser,
    ),
    env.DB.prepare("DELETE FROM error_logs WHERE created_at < ?1").bind(cutoff),
    env.DB.prepare(
      `DELETE FROM error_logs WHERE source = ?2
         AND id NOT IN (SELECT id FROM error_logs WHERE source = ?2 ORDER BY id DESC LIMIT ?1)`,
    ).bind(ERROR_LOG_MAX_ROWS, entry.source),
  ]);
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  // 길이는 거절하지 않고 자른다(오류 내용이 길다고 기록을 놓치지 않게).
  return value.slice(0, max * 2);
}

/** POST /api/client-errors 본문을 읽어 기록한다. */
export async function recordClientError(env: Env, req: Request): Promise<void> {
  const body = await readJsonBody(req, MAX_CLIENT_ERROR_BODY_BYTES);
  assertOnlyKeys(body, ["kind", "message", "stack", "path", "appVersion"]);
  const kind = CLIENT_KINDS.find((k) => k === body.kind);
  if (!kind) throw new ApiError(400, "INVALID_FIELD", "kind 값이 올바르지 않습니다.");
  const message = optionalText(body.message, "message", ERROR_MESSAGE_MAX) ?? "";
  const stack = optionalText(body.stack, "stack", ERROR_STACK_MAX);
  const path = optionalText(body.path, "path", ERROR_PATH_MAX);
  const version = optionalText(body.appVersion, "appVersion", 32);
  await recordError(env, {
    source: "client",
    kind,
    message,
    stack,
    path,
    appVersion: version && /^[\w.-]{1,32}$/.test(version) ? version : null,
    browser: browserKind(req.headers.get("User-Agent")),
  });
}

/** app.onError에서 부른다. 넣다가 실패해도 응답은 바꾸지 않는다(부르는 쪽이 오류를 삼킨다). */
export async function recordServerError(env: Env, path: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  await recordError(env, {
    source: "server",
    kind: "server",
    message,
    stack: error instanceof Error && error.stack ? error.stack : null,
    path: pathForLog(path),
    appVersion: APP_VERSION,
    browser: null,
  });
}
