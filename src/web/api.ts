/**
 * 서버 호출과 실패 분류(docs/P2 P2-8).
 * - offline: 요청이 나가지 않았다 → 미저장 유지.
 * - unknown: 보냈으나 응답이 없거나 해석할 수 없다 → 저장됐는지 확인 불가.
 * - api: 서버가 이유와 함께 거절했다.
 */
export class ApiFailure extends Error {
  constructor(
    public readonly kind: "offline" | "unknown" | "api",
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: any,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15000;

/**
 * 모임 세대(백업 복원이 끝날 때마다 오름). 마지막으로 받은 스냅숏의 값을 기억했다가
 * 그 모임의 쓰기 요청에 X-Group-Generation으로 실어 보낸다. 복원 전에 열린 탭의 요청은 서버가 거절한다.
 */
const generations = new Map<string, number>();
const GROUP_PATH = /^\/api\/groups\/([^/]+)(\/|$)/;

function rememberGeneration(path: string, parsed: any): void {
  const match = /^\/api\/groups\/([^/]+)\/snapshot$/.exec(path);
  const generation = parsed?.group?.generation;
  if (match && typeof generation === "number") generations.set(match[1]!, generation);
}

function requestHeaders(method: string, path: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const gid = GROUP_PATH.exec(path)?.[1];
  if (method !== "GET" && gid && generations.has(gid)) {
    headers["X-Group-Generation"] = String(generations.get(gid));
  }
  return headers;
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiFailure("offline", "인터넷에 연결돼 있지 않아요.");
  }
  const controller = new AbortController();
  // 백업 파일 올리기는 크기가 커서 더 기다린다.
  const timer = setTimeout(() => controller.abort(), path.includes("/restore") ? TIMEOUT_MS * 4 : TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: requestHeaders(method, path, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ApiFailure("unknown", "서버 응답을 받지 못했어요.");
  } finally {
    clearTimeout(timer);
  }
  let parsed: any;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiFailure("unknown", "서버 응답을 읽지 못했어요.", response.status);
  }
  if (!response.ok) {
    const error = parsed?.error ?? {};
    throw new ApiFailure(
      "api",
      typeof error.message === "string" ? error.message : "요청을 처리하지 못했어요.",
      response.status,
      error.code,
      error.details,
    );
  }
  if (method === "GET") rememberGeneration(path, parsed);
  return parsed as T;
}

/** 요청 ID. 확인 창을 열 때 한 번 만들고 재시도에는 같은 값을 쓴다. */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * 변경 요청. 응답을 받지 못하면 같은 요청 ID로 최대 2회 다시 보낸다.
 * 서버는 같은 요청 ID를 한 번만 처리하므로 다시 보내도 중복 저장되지 않는다.
 */
export async function mutate<T>(
  path: string,
  body: { requestId: string } & Record<string, unknown>,
  method: "POST" | "PUT" = "POST",
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await call<T>(method, path, body);
    } catch (error) {
      lastError = error;
      if (!(error instanceof ApiFailure) || error.kind !== "unknown") throw error;
    }
  }
  throw lastError;
}
