import { env } from "cloudflare:test";
import app from "../src/server/index";
import type { Env } from "../src/server/env";

/**
 * 서버를 설정값을 바꿔 직접 부른다(SELF는 wrangler.jsonc의 값만 쓴다).
 * 같은 로컬 D1을 쓰므로 SELF로 만든 모임·계정을 그대로 쓸 수 있다.
 */
export async function direct(
  overrides: Partial<Env>,
  method: string,
  path: string,
  options: { cookie?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const request = new Request(`https://example.test${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  return app.fetch(request, { ...(env as unknown as Env), ...overrides });
}

/** 응답의 Set-Cookie에서 "이름=값"만 꺼낸다. */
export function cookieFrom(response: Response, name: string): string | null {
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}
