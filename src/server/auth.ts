import type { Env } from "./env";
import { ApiError } from "./http";

const COOKIE_NAME = "sid";
const DEFAULT_SESSION_HOURS = 720;

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
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

/** 값을 JSON으로 담아 서명한다. 세션 쿠키와 로그인 state 쿠키가 같이 쓴다. */
export async function signValue(env: Env, payload: unknown): Promise<string> {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env.SESSION_SECRET);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 서명을 확인하고 담긴 값을 돌려준다. 서명이 틀리거나 형식이 깨졌으면 null. */
export async function verifyValue(env: Env, value: string): Promise<Record<string, unknown> | null> {
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
    const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  const match = header.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

export function sessionTtlMs(env: Env): number {
  const hours = Number(env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_HOURS) * 3600_000;
}

export interface SessionAccount {
  id: string;
  provider: string;
  epoch: number;
}

/**
 * 세션 값을 만든다. 담는 것: 계정 ID, 로그인 수단, 세션 세대, 만료 시각.
 * 이름·이메일 같은 개인 정보는 담지 않는다.
 */
export async function createSessionValue(
  env: Env,
  account: SessionAccount,
  expiresAt = Date.now() + sessionTtlMs(env),
): Promise<string> {
  return signValue(env, { a: account.id, p: account.provider, v: account.epoch, e: expiresAt });
}

export function sessionCookie(env: Env, value: string): string {
  const maxAge = Math.floor(sessionTtlMs(env) / 1000);
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * 요청 주소가 이 기기 안(로컬 개발·테스트)인지. 허용 목록:
 * - localhost, *.localhost, 127.0.0.1, [::1]: 로컬 개발 서버(npm run dev, e2e, npm run seed).
 * - *.test: 통합 테스트(vitest)가 쓰는 주소(https://example.test). ".test"는 테스트용 예약 최상위 도메인이라
 *   (RFC 6761) 공개 DNS에 없고, Cloudflare가 배포된 Worker로 보내는 주소가 될 수 없다.
 */
export function isLocalRequest(req: Request): boolean {
  let host: string;
  try {
    host = new URL(req.url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".test")
  );
}

/**
 * 가짜 로그인(과 로컬 전용 테스트 훅)이 열려 있는지. 허용 목록 방식이다:
 * AUTH_MODE=fake 이고 DEPLOY_ENV=local(wrangler.jsonc 맨 위의 로컬 설정)일 때만 열린다.
 * 운영 표시가 빠진 배포(--env production 없이 배포 등)나 다른 표시(spike 등)는 닫힌다.
 * req를 주면 요청 주소가 로컬(isLocalRequest)인지도 본다. 요청이 있는 곳에서는 반드시 req를 준다:
 * DEPLOY_ENV=local인 설정이 공개 주소에 올라가도 가짜 로그인이 열리지 않게 하는 두 번째 확인이다.
 */
export function fakeLoginEnabled(env: Env, req?: Request): boolean {
  if (env.AUTH_MODE !== "fake" || env.DEPLOY_ENV !== "local") return false;
  return req === undefined || isLocalRequest(req);
}

// 같은 요청 안에서 세션 확인을 한 번만 하도록 결과를 기억한다(미들웨어와 경로가 함께 부른다).
const sessionCache = new WeakMap<Request, Promise<SessionAccount | null>>();

async function loadSession(env: Env, req: Request): Promise<SessionAccount | null> {
  const value = readCookie(req, COOKIE_NAME);
  if (!value) return null;
  const payload = await verifyValue(env, value);
  if (!payload) return null;
  if (typeof payload.a !== "string" || typeof payload.e !== "number") return null;
  // 만료된 세션은 서명이 맞아도 거절한다.
  if (payload.e <= Date.now()) return null;
  const epoch = typeof payload.v === "number" ? payload.v : 0;
  const row = await env.DB.prepare("SELECT provider, session_epoch FROM accounts WHERE id = ?1")
    .bind(payload.a)
    .first<{ provider: string; session_epoch: number }>();
  if (!row) return null;
  // 로그아웃 뒤에는 그 전에 발급한 세션을 받지 않는다.
  if (row.session_epoch !== epoch) return null;
  // 가짜 로그인이 닫혀 있으면 가짜 계정의 세션도 받지 않는다(로컬 쿠키가 운영에 섞이는 경우 대비).
  if (row.provider === "fake" && !fakeLoginEnabled(env, req)) return null;
  return { id: payload.a, provider: row.provider, epoch };
}

/** 요청의 세션 쿠키를 검증한다. 없거나 만료·변조·로그아웃된 세션이면 null. */
export function readSession(env: Env, req: Request): Promise<SessionAccount | null> {
  let cached = sessionCache.get(req);
  if (!cached) {
    cached = loadSession(env, req);
    sessionCache.set(req, cached);
  }
  return cached;
}

/** 요청의 세션 쿠키를 검증해 계정 ID를 돌려준다. 없거나 만료면 null. */
export async function readAccountId(env: Env, req: Request): Promise<string | null> {
  return (await readSession(env, req))?.id ?? null;
}

export async function requireAccountId(env: Env, req: Request): Promise<string> {
  const accountId = await readAccountId(env, req);
  if (!accountId) throw new ApiError(401, "AUTH_REQUIRED", "로그인이 필요합니다.");
  return accountId;
}

/**
 * 제공자 + 고유 ID로 계정을 찾고, 없으면 만든다. 다른 정보(이메일·이름·사진)는 받지도 저장하지도 않는다.
 */
export async function upsertAccount(
  env: Env,
  provider: string,
  subject: string,
  now: string,
): Promise<SessionAccount> {
  await env.DB.prepare(
    `INSERT INTO accounts (id, provider, subject, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (provider, subject) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), provider, subject, now)
    .run();
  const row = await env.DB.prepare(
    "SELECT id, session_epoch FROM accounts WHERE provider = ?1 AND subject = ?2",
  )
    .bind(provider, subject)
    .first<{ id: string; session_epoch: number }>();
  return { id: row!.id, provider, epoch: row!.session_epoch };
}

/** 이 계정의 모든 세션을 끝낸다(모든 기기에서 로그아웃). */
export async function revokeSessions(env: Env, accountId: string): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET session_epoch = session_epoch + 1 WHERE id = ?1")
    .bind(accountId)
    .run();
}

/** 모임에서 이 계정의 역할. owner = 대표 운영자(group_operators), co = 공동 운영자(group_co_operators). */
export type OperatorRole = "owner" | "co";

/** 요청마다 표를 다시 읽는다(캐시하지 않음): 내보낸 공동 운영자의 다음 요청은 바로 거절된다. */
export async function operatorRole(env: Env, groupId: string, accountId: string): Promise<OperatorRole | null> {
  const row = await env.DB.prepare(
    `SELECT 'owner' AS role FROM group_operators WHERE group_id = ?1 AND account_id = ?2
     UNION ALL
     SELECT 'co' AS role FROM group_co_operators WHERE group_id = ?1 AND account_id = ?2
     LIMIT 1`,
  )
    .bind(groupId, accountId)
    .first<{ role: OperatorRole }>();
  return row?.role ?? null;
}

/**
 * 이 계정이 모임의 운영자(대표 또는 공동)인지 확인한다.
 * 모임이 없는 경우와 권한이 없는 경우에 같은 오류를 돌려줘 존재 여부를 드러내지 않는다.
 */
export async function requireOperator(env: Env, req: Request, groupId: string): Promise<string> {
  const accountId = await requireAccountId(env, req);
  if (!(await operatorRole(env, groupId, accountId))) {
    throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  }
  return accountId;
}

/**
 * 대표 운영자만 하는 작업(운영자 넘기기, 모임 삭제, 백업에서 복원, 공동 운영자 초대·내보내기).
 * 공동 운영자에게는 403으로 이유를 알려 준다. 운영자가 아니면 requireOperator와 같은 404다.
 */
export async function requireOwner(env: Env, req: Request, groupId: string): Promise<string> {
  const accountId = await requireAccountId(env, req);
  const role = await operatorRole(env, groupId, accountId);
  if (!role) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  if (role !== "owner") {
    throw new ApiError(403, "OWNER_ONLY", "대표 운영자만 할 수 있어요. 대표 운영자에게 요청해 주세요.");
  }
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

/**
 * 운영 환경 설정 점검. 운영(DEPLOY_ENV=production)에서 위험한 설정이면 이유를 돌려준다.
 * 이유가 있으면 모든 API가 거절된다(index.ts).
 */
export function productionConfigProblem(env: Env): string | null {
  if (env.DEPLOY_ENV !== "production") return null;
  if (env.AUTH_MODE === "fake") return "운영 환경에서 AUTH_MODE=fake";
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return "SESSION_SECRET 없음 또는 32자 미만";
  if (
    !env.PUBLIC_ORIGIN ||
    !env.PUBLIC_ORIGIN.startsWith("https://") ||
    env.PUBLIC_ORIGIN.includes("REPLACE")
  ) {
    return "PUBLIC_ORIGIN 없음, https 아님, 또는 자리 표시값 그대로";
  }
  return null;
}
