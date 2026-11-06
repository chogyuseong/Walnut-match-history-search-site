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
