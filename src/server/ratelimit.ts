/**
 * 요청 수 제한(docs/P4 P4-4 "계정·IP별 요청 수 제한").
 *
 * D1 고정 창 카운터를 쓴다. Cloudflare Workers Rate Limiting 바인딩도 검토했으나
 * - 무료 요금제에서 쓸 수 있는지 공식 문서에 적혀 있지 않고,
 * - 위치(데이터센터)별로 따로 세는 "대략적인" 제한이며(문서: approximate, eventually consistent),
 * - 창 길이가 10초·60초로 고정이라 "창이 지난 뒤 다시 허용"을 로컬 테스트로 확인하기 어렵다.
 * D1 카운터는 정확하고 로컬·테스트에서 그대로 돈다. 대가로 제한 대상 요청 한 번에 D1 쓰기 1행이 든다.
 *
 * IP는 원문을 저장하지 않는다. 서명 키로 HMAC한 앞 16자만 키로 쓰고, 지난 창의 행은 바로 지운다.
 */
import type { Env } from "./env";
import { ApiError } from "./http";

export type Bucket =
  | "write-account"
  | "write-ip"
  | "auth-ip"
  | "view-ip"
  | "sheet-account"
  | "sheet-ip"
  | "heavy-account"
  | "heavy-ip"
  | "signup-ip"
  | "login-ip"
  | "recover-ip";

/** 기본 한도(창당 요청 수). wrangler 설정의 vars로 바꾼다. */
export const DEFAULT_LIMITS: Record<Bucket, number> = {
  "write-account": 60,
  "write-ip": 120,
  "auth-ip": 20,
  "view-ip": 120,
  // 구글 시트 읽기는 바깥으로 나가는 요청이라 쓰기보다 좁게 둔다(src/server/sheets.ts).
  "sheet-account": 10,
  "sheet-ip": 20,
  // 비싼 읽기(백업 내려받기·합치기 미리보기·가져오기 지문 목록). 화면이 한 번씩 부르는 경로라 넉넉히 둔다.
  "heavy-account": 60,
  "heavy-ip": 120,
  // 자체 계정(src/server/local.ts). 모든 /api/auth/* 에 걸리는 auth-ip(20)에 더해 경로별로 좁게 센다.
  // 가입은 "이미 쓰는 아이디"를 알려 주므로(아이디가 있는지 알 수 있음) 가장 좁게 둔다.
  "signup-ip": 5,
  "login-ip": 10,
  "recover-ip": 5,
};
export const DEFAULT_WINDOW_SECONDS = 60;

const LIMIT_VARS: Record<Bucket, keyof Env> = {
  "write-account": "RATE_WRITE_PER_ACCOUNT",
  "write-ip": "RATE_WRITE_PER_IP",
  "auth-ip": "RATE_AUTH_PER_IP",
  "view-ip": "RATE_VIEW_PER_IP",
  "sheet-account": "RATE_SHEET_PER_ACCOUNT",
  "sheet-ip": "RATE_SHEET_PER_IP",
  "heavy-account": "RATE_HEAVY_PER_ACCOUNT",
  "heavy-ip": "RATE_HEAVY_PER_IP",
  "signup-ip": "RATE_SIGNUP_PER_IP",
  "login-ip": "RATE_LOGIN_PER_IP",
  "recover-ip": "RATE_RECOVER_PER_IP",
};

/** 시계. 테스트에서 창이 지난 상황을 만들 때 바꿔 끼운다. */
export const rateClock = { now: (): number => Date.now() };

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limitOf(env: Env, bucket: Bucket): number {
  return positiveInt(env[LIMIT_VARS[bucket]], DEFAULT_LIMITS[bucket]);
}

export function windowSecondsOf(env: Env): number {
  return positiveInt(env.RATE_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS);
}

/** 요청한 쪽의 IP. Cloudflare가 붙이는 CF-Connecting-IP를 쓴다. 로컬에는 없을 수 있다. */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "local";
}

async function ipKey(env: Env, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`ratelimit:${env.SESSION_SECRET}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip));
  return [...new Uint8Array(mac)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 한 번 세고, 한도를 넘었으면 429를 던진다.
 * 같은 창 안의 카운트 증가는 한 문장(UPSERT ... RETURNING)이라 동시에 와도 빠짐없이 센다.
 */
export async function hit(env: Env, bucket: Bucket, subject: string): Promise<void> {
  const limit = limitOf(env, bucket);
  const windowMs = windowSecondsOf(env) * 1000;
  const now = rateClock.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const id = bucket.endsWith("-ip") ? await ipKey(env, subject) : subject;
  const key = `${bucket}:${id}`;
  const [counted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(key, windowStart),
    // 지난 창의 기록은 남겨 둘 이유가 없다.
    env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(windowStart),
  ]);
  const count = (counted?.results?.[0] as { count?: number } | undefined)?.count ?? 0;
  if (count > limit) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `요청이 너무 잦아요. ${retryAfter}초 뒤에 다시 시도해 주세요. 입력한 내용은 그대로 있어요.`,
      { retryAfter },
    );
  }
}
