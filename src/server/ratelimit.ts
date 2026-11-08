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
  | "recover-ip"
  | "client-error-ip"
  | "bulk-rows-account"
  | "bulk-rows-ip";

/**
 * 하루 창(UTC 0시 기준 86400초)으로 세는 예산 버킷. 요청 수가 아니라 넣은 경기 수를 센다(spendBulkRows).
 * 키 앞부분이 모두 "bulk-rows-"라서 지난 창 정리를 분 단위 버킷과 나눠 한다(cleanupStatement).
 */
const DAILY_PREFIX = "bulk-rows-";
export const BULK_WINDOW_SECONDS = 86_400;

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
  // 화면 오류 보고(로그인 없음, src/server/errorLog.ts). 화면도 분당 몇 건만 보내므로 좁게 둔다.
  "client-error-ip": 10,
  // 대량 쓰기 하루 예산(가져오기·지난 경기 입력·백업 복원으로 넣는 경기 수, 2026-11-08 보안 점검).
  // 정상 사용(예: 522경기 이전을 50경기씩 11번)은 넉넉히 들어가고, 계정·IP를 돌려 D1 무료 한도(하루 쓰기 10만 행)를
  // 다 쓰는 일을 막는다. 경기 하나가 대략 13행(경기·명단 10·이력·요청 기록)이라 3,000경기 ≈ 4만 행.
  "bulk-rows-account": 3000,
  "bulk-rows-ip": 6000,
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
  "client-error-ip": "RATE_CLIENT_ERROR_PER_IP",
  "bulk-rows-account": "RATE_BULK_ROWS_PER_ACCOUNT",
  "bulk-rows-ip": "RATE_BULK_ROWS_PER_IP",
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

/**
 * 세는 단위로 쓸 IP. IPv4는 그대로, IPv6는 앞 64비트(/64, 앞 4묶음)만 쓴다.
 * 가정·회선 하나가 보통 /64 하나를 통째로 받으므로, 주소 끝을 바꿔 가며 한도를 피하지 못하게 한다(2026-11-08 보안 점검).
 * 압축 표기(::)·앞자리 0·대소문자·영역 표시(%eth0)·끝의 IPv4 표기를 풀어 같은 /64는 같은 값이 되게 한다.
 * IPv4-mapped(::ffff:a.b.c.d)는 IPv4로 본다. 형식이 이상하면 소문자로만 바꿔 그대로 쓴다.
 */
export function ipSubject(ip: string): string {
  if (!ip.includes(":")) return ip;
  let text = ip.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const groups = expandIpv6(text);
  if (!groups) return text;
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** IPv6 주소를 16비트 묶음 8개로 푼다. 형식이 틀리면 null. */
function expandIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (i === pieces.length - 1 && piece.includes(".")) {
        const octets = piece.split(".");
        if (octets.length !== 4 || !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return null;
        const [a, b, c, d] = octets.map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** IP를 저장용 키로 바꾼다(서명 키 HMAC 앞 16자, IPv6는 /64 단위). 자체 계정 실패 횟수(local.ts)도 쓴다. */
export async function ipKey(env: Env, ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`ratelimit:${env.SESSION_SECRET}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ipSubject(ip)));
  return [...new Uint8Array(mac)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 지난 창의 기록은 남겨 둘 이유가 없다. 다만 창 길이가 다른 버킷(하루 예산)끼리는 따로 지운다:
 * 분 단위 버킷의 정리가 오늘 하루 예산 행(window_start = 오늘 0시)을 지우면 예산이 초기화된다.
 * 키 범위 비교("bulk-rows-" 이상 "bulk-rows." 미만)는 접두어 비교와 같다('.'은 '-' 다음 글자).
 */
function cleanupStatement(env: Env, bucket: Bucket, windowStart: number): D1PreparedStatement {
  return bucket.startsWith(DAILY_PREFIX)
    ? env.DB.prepare("DELETE FROM rate_limits WHERE key >= ?2 AND key < ?3 AND window_start < ?1").bind(
        windowStart,
        DAILY_PREFIX,
        `${DAILY_PREFIX.slice(0, -1)}.`,
      )
    : env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1 AND NOT (key >= ?2 AND key < ?3)").bind(
        windowStart,
        DAILY_PREFIX,
        `${DAILY_PREFIX.slice(0, -1)}.`,
      );
}

async function bucketKey(env: Env, bucket: Bucket, subject: string): Promise<string> {
  const id = bucket.endsWith("-ip") ? await ipKey(env, subject) : subject;
  return `${bucket}:${id}`;
}

/**
 * 한 번 세고, 한도를 넘었으면 429를 던진다.
 * 같은 창 안의 카운트 증가는 한 문장(UPSERT ... RETURNING)이라 동시에 와도 빠짐없이 센다.
 * windowSeconds를 주지 않으면 RATE_WINDOW_SECONDS(기본 60초) 창을 쓴다.
 */
export async function hit(
  env: Env,
  bucket: Bucket,
  subject: string,
  windowSeconds: number = windowSecondsOf(env),
): Promise<void> {
  const limit = limitOf(env, bucket);
  const windowMs = windowSeconds * 1000;
  const now = rateClock.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const key = await bucketKey(env, bucket, subject);
  const [counted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(key, windowStart),
    cleanupStatement(env, bucket, windowStart),
  ]);
  const count = (counted?.results?.[0] as { count?: number } | undefined)?.count ?? 0;
  if (count > limit) {
    await countLimited(env, bucket, now);
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `요청이 너무 잦아요. ${retryAfter}초 뒤에 다시 시도해 주세요. 입력한 내용은 그대로 있어요.`,
      { retryAfter },
    );
  }
}

/** 대량 쓰기(가져오기·지난 경기 입력·복원)를 한 사람. 하루 예산을 계정·IP 둘 다에서 쓴다. */
export interface BulkActor {
  accountId: string;
  ip: string;
}

export const BULK_LIMIT_MESSAGE = "오늘 넣을 수 있는 경기 수를 넘었어요.";

/**
 * 대량 쓰기 하루 예산에서 경기 rows개를 쓴다(계정당·IP당, UTC 하루 창). 둘 중 하나라도 넘으면 429이고 아무것도 쓰지 않는다:
 * 확인(보호 문장)과 더하기를 한 batch로 실행하므로 넘친 요청이 예산을 깎지 않고, 동시에 와도 한도를 넘지 않는다.
 * 요청 수 제한(hit)과 달리 거절된 요청은 세지 않는다(큰 묶음 하나가 거절돼도 작은 묶음은 그날 계속 넣을 수 있다).
 * 부르는 쪽은 입력 검증을 끝낸 뒤, 쓰기 직전에 부른다. 같은 요청 ID의 재시도(runMutation 재생)에서는 부르지 않는다.
 */
export async function spendBulkRows(env: Env, actor: BulkActor, rows: number): Promise<void> {
  if (!Number.isInteger(rows) || rows <= 0) return;
  const windowMs = BULK_WINDOW_SECONDS * 1000;
  const now = rateClock.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const buckets: [Bucket, string][] = [
    ["bulk-rows-account", await bucketKey(env, "bulk-rows-account", actor.accountId)],
    ["bulk-rows-ip", await bucketKey(env, "bulk-rows-ip", actor.ip)],
  ];
  const over = async (bucket: Bucket): Promise<never> => {
    await countLimited(env, bucket, now);
    const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    const hours = Math.max(1, Math.ceil(retryAfter / 3600));
    throw new ApiError(
      429,
      "RATE_LIMITED",
      `${BULK_LIMIT_MESSAGE} 약 ${hours}시간 뒤(한국 시각 오전 9시)에 다시 시도해 주세요. 입력한 내용은 그대로 있어요.`,
      { retryAfter },
    );
  };
  // 한 번에 하루 한도보다 많으면 볼 것도 없이 거절한다.
  const tooBig = buckets.find(([bucket]) => rows > limitOf(env, bucket));
  if (tooBig) return over(tooBig[0]);
  try {
    await env.DB.batch([
      // 더하면 한도를 넘는 버킷이 하나라도 있으면 batch 전체를 실패시킨다(guard_state_conflict).
      ...buckets.map(([bucket, key]) =>
        env.DB.prepare(
          `INSERT INTO guard (state_conflict)
           SELECT 1 FROM rate_limits WHERE key = ?1 AND window_start = ?2 AND count + ?3 > ?4`,
        ).bind(key, windowStart, rows, limitOf(env, bucket)),
      ),
      ...buckets.map(([, key]) =>
        env.DB.prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3`,
        ).bind(key, windowStart, rows),
      ),
      cleanupStatement(env, "bulk-rows-account", windowStart),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("guard_state_conflict")) throw error;
    // 어느 쪽이 넘었는지는 현황 화면 기록(rate_limit_hits)에만 쓴다. 거절할 때만 한 번 더 읽는다.
    const counts = await env.DB.prepare("SELECT key, count FROM rate_limits WHERE key IN (?1, ?2) AND window_start = ?3")
      .bind(buckets[0]![1], buckets[1]![1], windowStart)
      .all<{ key: string; count: number }>();
    const exceeded = buckets.find(
      ([bucket, key]) => (counts.results.find((r) => r.key === key)?.count ?? 0) + rows > limitOf(env, bucket),
    );
    return over(exceeded?.[0] ?? "bulk-rows-account");
  }
}

/** 한도에 걸린 횟수 기록(rate_limit_hits)을 남겨 두는 날수. */
export const RATE_HIT_KEEP_DAYS = 30;

/**
 * 한도에 걸린 횟수를 날짜(UTC)·종류별로 더한다(사이트 운영자 현황 화면, migrations/0018). 누가 걸렸는지는 남기지 않는다.
 * 걸린 요청에서만 쓰므로 정상 요청에는 비용이 없다. 실패해도 429 응답은 그대로다.
 */
async function countLimited(env: Env, bucket: Bucket, now: number): Promise<void> {
  const day = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - RATE_HIT_KEEP_DAYS * 24 * 3600_000).toISOString().slice(0, 10);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_limit_hits (day, bucket, count) VALUES (?1, ?2, 1)
         ON CONFLICT (day, bucket) DO UPDATE SET count = count + 1`,
      ).bind(day, bucket),
      env.DB.prepare("DELETE FROM rate_limit_hits WHERE day < ?1").bind(oldest),
    ]);
  } catch {
    // 세지 못해도 제한은 그대로 건다.
  }
}
