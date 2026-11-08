/** 클라이언트에 그대로 전달되는 오류. code는 화면 문구를 고르는 데 쓴다. */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const MAX_BODY_BYTES = 16 * 1024;

function tooLarge(): ApiError {
  return new ApiError(413, "BODY_TOO_LARGE", "요청이 너무 큽니다.");
}

/**
 * 본문을 maxBytes까지만 읽는다(검토 L6).
 * - Content-Length가 있고 상한보다 크면 읽지 않고 바로 거절한다.
 * - 길이가 없거나 거짓이어도 스트림으로 읽으면서 상한을 넘는 순간 읽기를 멈추고 거절한다(전체를 메모리에 올리지 않는다).
 */
export async function readBodyText(req: Request, maxBytes: number): Promise<string> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > maxBytes) throw tooLarge();
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** JSON 본문 경로는 Content-Type: application/json만 받는다(검토 L5: 다른 사이트의 단순 form·text 요청 차단). */
export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(";")[0]!.trim().toLowerCase() === "application/json";
}

/** 형식(Content-Type)과 본문 크기를 확인하고 JSON 객체로 읽는다. */
export async function readJsonBody(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers.get("Content-Type"))) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "요청 형식이 올바르지 않습니다(JSON만 받습니다).");
  }
  const text = await readBodyText(req, maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "요청 형식이 올바르지 않습니다.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "INVALID_JSON", "요청 형식이 올바르지 않습니다.");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 본문이 없을 수 있는 DELETE·POST 경로(시즌 지우기·조회 링크 다시 만들기·연결 끊기).
 * Content-Type이 없고 본문 길이가 0이거나 없으면 빈 객체, 그 밖에는 readJsonBody와 같다.
 * 2026-11-08부터 이 경로들도 { requestId }가 필수라, 본문 없는 예전 요청은 415가 아니라 400(requestId)으로 답한다.
 */
export async function readOptionalJsonBody(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = req.headers.get("Content-Type");
  const length = req.headers.get("Content-Length");
  if (type === null && (req.body === null || length === "0")) return {};
  return readJsonBody(req, maxBytes);
}

/**
 * 보안 헤더(2026-11-07). API 응답(index.ts 공통 앞단)과 정적 화면(public/_headers)이 같은 값을 쓴다.
 * 값을 바꾸면 public/_headers도 함께 바꾼다(test/security.test.ts가 API 쪽을 확인한다).
 * - 외부 출처: 글꼴 CSS·글꼴 파일(Pretendard, cdn.jsdelivr.net, src/web/index.html). 그 밖에는 모두 같은 출처.
 * - 화면에 인라인 스크립트는 없다(빌드된 index.html은 모듈 스크립트 파일 하나). 인라인 스타일은 React style 속성 때문에 허용.
 * - img-src의 data:·blob:은 공유 이미지(캔버스)·백업 파일 내려받기(Blob URL)에 쓴다.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "font-src 'self' https://cdn.jsdelivr.net data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";

/** HSTS는 운영(DEPLOY_ENV=production)에서만 붙인다(로컬 http 개발 주소를 브라우저가 https로 고정하지 않게). */
export function securityHeaders(deployEnv: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "X-Frame-Options": "DENY",
  };
  if (deployEnv === "production") headers["Strict-Transport-Security"] = "max-age=31536000";
  return headers;
}

/**
 * 상태를 바꾸는 요청(GET·HEAD·OPTIONS 밖)의 Origin 확인(검토 L5). 세션 쿠키의 SameSite=Lax에 더해 두는 두 번째 방어다.
 * - Origin 헤더가 없으면 통과한다(같은 사이트 화면의 일부 요청, 서버 간 호출·테스트·npm run seed).
 *   브라우저는 다른 사이트에서 보내는 POST·PUT·PATCH·DELETE에 항상 Origin을 붙인다.
 * - 있으면 서비스 주소와 같아야 한다: PUBLIC_ORIGIN이 있으면 그 값, 없으면(로컬 개발) 요청 자신의 주소.
 *   "null"(샌드박스·개인정보 리디렉션)도 거절한다.
 */
export function assertSameOrigin(req: Request, publicOrigin: string | undefined): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = req.headers.get("Origin");
  if (origin === null) return;
  const expected = publicOrigin?.replace(/\/+$/, "") || new URL(req.url).origin;
  if (origin !== expected) {
    throw new ApiError(403, "BAD_ORIGIN", "다른 사이트에서 보낸 요청은 받지 않습니다.");
  }
}

/**
 * 로그에 남길 경로. 조회 토큰(/api/view/:token), 인수 링크 토큰(/api/transfer/:token),
 * 공동 운영자 초대 토큰(/api/co-invite/:token), 참가 신청 토큰(/api/join/:token),
 * 참가자 연결 링크 토큰(/api/claim/:token, migrations/0019)은 그 자체로 권한이라 가린다(검토 L8).
 */
export function pathForLog(path: string): string {
  return path.replace(/^\/api\/(view|transfer|co-invite|join|claim)\/[^/]+/, "/api/$1/[token]");
}

/** 허용한 필드만 있는지 확인한다. */
export function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new ApiError(400, "UNKNOWN_FIELD", `허용하지 않는 항목입니다: ${key}`);
    }
  }
}

export function requireString(value: unknown, field: string, min = 1, max = 200): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

export function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value as T;
}

export function requireIsoTime(value: unknown, field: string): string {
  const text = requireString(value, field, 10, 40);
  const time = Date.parse(text);
  if (Number.isNaN(time)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return new Date(time).toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
