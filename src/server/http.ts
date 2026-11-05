/** 클라이언트에 그대로 전달되는 오류. code는 화면 문구를 고르는 데 쓴다. */
export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 404 | 409 | 413 | 503,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const MAX_BODY_BYTES = 16 * 1024;

/** 본문 크기를 확인하고 JSON 객체로 읽는다. */
export async function readJsonBody(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "요청이 너무 큽니다.");
  }
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
