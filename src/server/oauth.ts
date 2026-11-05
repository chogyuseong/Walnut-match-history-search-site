/**
 * 실제 로그인: 카카오(우선)·Google(대체). 둘 다 OAuth 2.0 인가 코드 흐름이다.
 *
 * 받는 것은 "제공자 + 고유 ID" 하나뿐이다.
 * - 카카오: 동의 항목을 요청하지 않는다(scope 없음). 사용자 정보 조회에서 회원번호(id)만 읽는다.
 * - Google: scope=openid 만 요청한다. ID 토큰의 sub만 읽는다.
 * 이메일·이름·사진은 요청하지 않고, 응답에 섞여 와도 읽지 않는다. 제공자 토큰은 저장하지 않는다.
 *
 * 엔드포인트는 2026-11-05에 공식 문서에서 확인했다.
 * - 카카오: https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api
 * - Google: https://developers.google.com/identity/protocols/oauth2/web-server
 *           https://developers.google.com/identity/openid-connect/openid-connect
 */
import { fromBase64Url, readCookie, signValue, toBase64Url, verifyValue } from "./auth";
import type { Env } from "./env";

export type Provider = "kakao" | "google";
export const PROVIDERS: readonly Provider[] = ["kakao", "google"];

const STATE_COOKIE = "oauth_state";
const STATE_TTL_MS = 10 * 60_000;

/** 제공자 호출. 테스트에서 가짜 응답으로 바꿔 끼운다. */
export const providerHttp = {
  fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init),
};

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string | undefined;
  /** 인가 요청에 붙이는 추가 값. */
  extra: Record<string, string>;
}

function config(env: Env, provider: Provider): ProviderConfig | null {
  if (provider === "kakao") {
    if (!env.KAKAO_CLIENT_ID) return null;
    return {
      authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
      tokenUrl: "https://kauth.kakao.com/oauth/token",
      clientId: env.KAKAO_CLIENT_ID,
      // 카카오는 클라이언트 시크릿 기능이 기본으로 켜져 있다. 켜져 있으면 토큰 요청에 반드시 넣어야 한다.
      clientSecret: env.KAKAO_CLIENT_SECRET || undefined,
      // 동의 항목(scope)을 요청하지 않는다: 회원번호만 받는다.
      extra: {},
    };
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    // openid만: 이메일·프로필 범위를 요청하지 않는다. 다시 로그인할 때 계정 선택을 보여준다.
    extra: { scope: "openid", access_type: "online", prompt: "select_account" },
  };
}

/** 키가 설정된 제공자만. 화면은 이 목록에 있는 버튼만 보여준다. */
export function enabledProviders(env: Env): Provider[] {
  return PROVIDERS.filter((p) => config(env, p) !== null);
}

export function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

/**
 * 리디렉션 URI는 고정이다: PUBLIC_ORIGIN + /api/auth/{제공자}/callback.
 * PUBLIC_ORIGIN이 없을 때(로컬 개발)만 요청 주소에서 만든다. 운영에서는 PUBLIC_ORIGIN이 없으면 기동이 거부된다.
 */
export function redirectUri(env: Env, provider: Provider, requestUrl: string): string {
  const origin = env.PUBLIC_ORIGIN?.replace(/\/+$/, "") || new URL(requestUrl).origin;
  return `${origin}/api/auth/${provider}/callback`;
}

/** 로그인 뒤 돌아갈 화면. 같은 사이트의 해시 주소만 허용한다(다른 사이트로 보내는 데 쓰이지 않게). */
export function safeReturnPath(value: string | null | undefined): string {
  if (typeof value === "string" && /^#\/[A-Za-z0-9/_-]{0,200}$/.test(value)) return value;
  return "#/";
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function stateCookie(value: string, maxAgeSeconds: number): string {
  // 제공자에서 돌아오는 요청은 최상위 이동(GET)이라 SameSite=Lax 쿠키가 함께 온다.
  return `${STATE_COOKIE}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearStateCookie(): string {
  return stateCookie("", 0);
}

/** 로그인 시작: state를 만들어 서명 쿠키에 두고 제공자의 인가 주소를 돌려준다. */
export async function beginLogin(
  env: Env,
  provider: Provider,
  requestUrl: string,
  returnPath: string,
): Promise<{ location: string; setCookie: string } | null> {
  const cfg = config(env, provider);
  if (!cfg) return null;
  const state = randomToken();
  const cookieValue = await signValue(env, {
    s: state,
    p: provider,
    r: safeReturnPath(returnPath),
    e: Date.now() + STATE_TTL_MS,
  });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(env, provider, requestUrl),
    response_type: "code",
    state,
    ...cfg.extra,
  });
  return {
    location: `${cfg.authorizeUrl}?${params.toString()}`,
    setCookie: stateCookie(cookieValue, Math.floor(STATE_TTL_MS / 1000)),
  };
}

export type LoginFailure =
  | "state_mismatch"
  | "denied"
  | "provider_error"
  | "not_configured";

export class LoginError extends Error {
  constructor(public readonly reason: LoginFailure, detail: string) {
    super(detail);
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 콜백 처리: state 확인 → 인가 코드를 토큰으로 교환 → 고유 ID 하나를 얻는다.
 * 성공하면 제공자의 고유 ID와 돌아갈 화면을 돌려준다.
 */
export async function completeLogin(
  env: Env,
  provider: Provider,
  req: Request,
): Promise<{ subject: string; returnPath: string }> {
  const url = new URL(req.url);
  const cookie = readCookie(req, STATE_COOKIE);
  const saved = cookie ? await verifyValue(env, cookie) : null;
  const state = url.searchParams.get("state");
  if (
    !saved ||
    typeof saved.s !== "string" ||
    saved.p !== provider ||
    typeof saved.e !== "number" ||
    saved.e <= Date.now() ||
    !state ||
    !constantTimeEqual(saved.s, state)
  ) {
    throw new LoginError("state_mismatch", "state 불일치 또는 만료");
  }
  const returnPath = safeReturnPath(typeof saved.r === "string" ? saved.r : null);

  const error = url.searchParams.get("error");
  if (error) {
    // 사용자가 동의 화면에서 취소하면 access_denied가 온다(카카오·Google 공통).
    throw new LoginError(error === "access_denied" ? "denied" : "provider_error", error);
  }
  const code = url.searchParams.get("code");
  if (!code) throw new LoginError("provider_error", "인가 코드 없음");

  const cfg = config(env, provider);
  if (!cfg) throw new LoginError("not_configured", "제공자 설정 없음");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(env, provider, req.url),
    code,
  });
  if (cfg.clientSecret) form.set("client_secret", cfg.clientSecret);

  let tokenBody: Record<string, unknown>;
  try {
    const response = await providerHttp.fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: form.toString(),
    });
    if (!response.ok) throw new Error(`토큰 요청 ${response.status}`);
    tokenBody = (await response.json()) as Record<string, unknown>;
  } catch (e) {
    throw new LoginError("provider_error", e instanceof Error ? e.message : "토큰 요청 실패");
  }

  const subject =
    provider === "kakao" ? await kakaoSubject(tokenBody) : googleSubject(tokenBody, cfg.clientId);
  return { subject, returnPath };
}

/** 카카오: 사용자 정보 조회에서 회원번호(id)만 읽는다. 다른 필드는 무시한다. */
async function kakaoSubject(tokenBody: Record<string, unknown>): Promise<string> {
  const accessToken = tokenBody.access_token;
  if (typeof accessToken !== "string") throw new LoginError("provider_error", "access_token 없음");
  let text: string;
  try {
    const response = await providerHttp.fetch("https://kapi.kakao.com/v2/user/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
    });
    if (!response.ok) throw new Error(`사용자 정보 요청 ${response.status}`);
    text = await response.text();
  } catch (e) {
    throw new LoginError("provider_error", e instanceof Error ? e.message : "사용자 정보 요청 실패");
  }
  // 회원번호는 Long이라 JSON 숫자로 읽으면 자릿수가 깨질 수 있다. 원문에서 숫자 그대로 꺼낸다.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoginError("provider_error", "사용자 정보 해석 실패");
  }
  const id = (parsed as { id?: unknown } | null)?.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
    throw new LoginError("provider_error", "회원번호 없음");
  }
  for (const match of text.matchAll(/"id"\s*:\s*(\d{1,20})(?=\s*[,}])/g)) {
    if (Number(match[1]) === id) return match[1]!;
  }
  throw new LoginError("provider_error", "회원번호 없음");
}

/**
 * Google: 토큰 응답의 ID 토큰에서 sub만 읽는다.
 * ID 토큰은 우리 서버가 클라이언트 시크릿으로 Google 토큰 주소에서 HTTPS로 직접 받은 것이라
 * 서명 검증 대신 발급자·대상·만료만 확인한다(Google OpenID Connect 문서가 허용하는 방식).
 */
function googleSubject(tokenBody: Record<string, unknown>, clientId: string): string {
  const idToken = tokenBody.id_token;
  if (typeof idToken !== "string") throw new LoginError("provider_error", "id_token 없음");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new LoginError("provider_error", "id_token 형식 오류");
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]!))) as Record<string, unknown>;
  } catch {
    throw new LoginError("provider_error", "id_token 해석 실패");
  }
  const iss = claims.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new LoginError("provider_error", "발급자 불일치");
  }
  const aud = claims.aud;
  if (aud !== clientId && !(Array.isArray(aud) && aud.includes(clientId))) {
    throw new LoginError("provider_error", "대상 불일치");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new LoginError("provider_error", "만료된 id_token");
  }
  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length < 1 || sub.length > 255) {
    throw new LoginError("provider_error", "sub 없음");
  }
  return sub;
}
