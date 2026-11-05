import type { Env } from "./env";
import { ApiError } from "./http";

const COOKIE_NAME = "sid";
const SESSION_DAYS = 30;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** 계정 ID와 만료 시각을 담아 서명한 세션 값을 만든다. */
export async function createSessionValue(env: Env, accountId: string): Promise<string> {
  const payload = JSON.stringify({ a: accountId, e: Date.now() + SESSION_DAYS * 86400_000 });
  const body = toBase64Url(new TextEncoder().encode(payload));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export function sessionCookie(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** 요청의 세션 쿠키를 검증해 계정 ID를 돌려준다. 없거나 만료면 null. */
export async function readAccountId(env: Env, req: Request): Promise<string | null> {
  const header = req.headers.get("Cookie") ?? "";
  const match = header.split(/;\s*/).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!match) return null;
  const value = match.slice(COOKIE_NAME.length + 1);
  const dot = value.indexOf(".");
  if (dot < 1) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  try {
    const key = await hmacKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as {
      a?: unknown;
      e?: unknown;
    };
    if (typeof payload.a !== "string" || typeof payload.e !== "number") return null;
    if (payload.e < Date.now()) return null;
    return payload.a;
  } catch {
    return null;
  }
}

export async function requireAccountId(env: Env, req: Request): Promise<string> {
  const accountId = await readAccountId(env, req);
  if (!accountId) throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  return accountId;
}

/**
 * 이 계정이 모임의 운영자인지 확인한다.
 * 모임이 없는 경우와 권한이 없는 경우에 같은 오류를 돌려줘 존재 여부를 드러내지 않는다.
 */
export async function requireOperator(env: Env, req: Request, groupId: string): Promise<string> {
  const accountId = await requireAccountId(env, req);
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM group_operators WHERE group_id = ?1 AND account_id = ?2",
  )
    .bind(groupId, accountId)
    .first<{ ok: number }>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  return accountId;
}

/** 조회 토큰으로 모임 ID를 찾는다. */
export async function groupIdFromViewToken(env: Env, token: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM groups WHERE view_token = ?1")
    .bind(token)
    .first<{ id: string }>();
  if (!row) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  return row.id;
}

/** 추측할 수 없는 조회 토큰(128비트). */
export function newViewToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}
