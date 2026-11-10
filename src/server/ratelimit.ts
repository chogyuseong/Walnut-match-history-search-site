/**
 * 요청 수 제한(docs/P4 P4-4 "계정·IP별 요청 수 제한").
 *
 * D1 고정 창 카운터를 쓴다. Cloudflare Workers Rate Limiting 바인딩도 검토했으나
 * - 무료 요금제에서 쓸 수 있는지 공식 문서에 적혀 있지 않고,
 * - 위치(데이터센터)별로 따로 세는 "대략적인" 제한이며(문서: approximate, eventually consistent),
 * - 창 길이가 10초·60초로 고정이라 "창이 지난 뒤 다시 허용"을 로컬 테스트로 확인하기 어렵다.
 * D1 카운터는 정확하고 로컬·테스트에서 그대로 돈다. 대가로 한도 안의 요청 한 번에 D1 쓰기 1행이 든다.
 * 한도를 넘긴 창에서는 더 쓰지 않는다(hit 주석). 거절된 요청까지 쓰기를 쓰면, 로그인 없는 사람 하나가
 * 한 IP에서 계속 보내기만 해도 D1 하루 쓰기 한도를 다 써 사이트 전체가 멈춘다(2026-11-10 보안 감사).
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
  | "snapshot-account"
  | "snapshot-ip"
  | "signup-ip"
  | "login-ip"
  | "recover-ip"
  | "client-error-ip"
  | "bulk-rows-account"
  | "bulk-rows-ip"
  | "day-strike-ip"
  | "day-snapshot-rows-account"
  | "day-snapshot-rows-ip"
  | "day-snapshot-rows-token";

/**
 * 하루 창(UTC 0시 기준 86400초)으로 세는 버킷의 키 접두어. 요청 수가 아니라 양(경기 수·읽은 행 수·벌점)을 센다.
 * 지난 창 정리를 분 단위 버킷과 나눠 한다(cleanupStatement): 분 단위 정리가 오늘 행을 지우면 예산이 초기화된다.
 * 하루 창 버킷을 새로 만들 때는 이름을 "day-"로 시작한다.
 */
const DAILY_PREFIXES = ["bulk-rows-", "day-"] as const;
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
  // 운영자·멤버 스냅숏(모임 전체를 읽는 가장 비싼 GET, 2026-11-09). 본문을 만드는 200만 세고 304는 세지 않는다
  // (조회 링크와 같은 방식). 화면은 탭으로 돌아올 때·자기 저장 뒤에 다시 읽고, 자료가 그대로면 304라 정상 사용은
  // 분당 몇 번이다. 한도가 없으면 한 계정이 큰 모임(522경기 ≈ 6천~7천 행, 추정)을 If-None-Match 없이 반복 호출해
  // D1 하루 읽기 500만 행을 몇십 분 만에 다 쓴다. 계정 60이면 그 속도를 분당 약 40만 행으로 묶는다.
  // 쓰기 한도(write-account 60)와 같게 둔다: 저장할 때마다 자료가 바뀌어 다시 읽기가 200이 되므로(티어 화면처럼
  // 사람마다 눌러 저장하는 경우), 스냅숏 한도가 쓰기 한도보다 작으면 저장은 되고 다시 읽기만 429가 난다.
  // IP는 다른 버킷처럼 계정의 두 배(같은 집·같은 회선의 운영자 둘).
  "snapshot-account": 60,
  "snapshot-ip": 120,
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
  // IP 하루 벌점(2026-11-10 보안 감사): 분 단위 창에서 한도에 걸릴 때마다 1. 이 값에 닿으면 그 IP의 "-ip" 버킷은
  // UTC 하루가 끝날 때까지 쓰기 없이 429다(hit). PC방·같은 와이파이처럼 여럿이 한 IP를 나눠 쓰는 저녁에 몇 번 걸리는
  // 것은 정상이라 넉넉히 둔다. 한도 아래로만 보내는 요청은 벌점이 쌓이지 않는다(그 비용은 분 단위 한도가 묶는다).
  "day-strike-ip": 20,
  // 스냅숏 200의 하루 읽기 예산(읽은 행 수 추정, snapshotCost). D1 무료 하루 읽기 500만 행을 한 계정·한 IP·한 조회 링크가
  // 혼자 다 쓰지 못하게 한다. 정상 사용 추정(docs/개선-경험-설계-2026-11-10.md B-1): 저녁 6경기·보는 사람 10명에
  // 100경기 모임 약 40만 행, 522경기 모임 약 200만 행. IP·조회 링크 400만은 100경기 모임에 10배, 522경기 모임에 2배다.
  // 큰 모임에서 10배를 줄 수는 없다(정상 사용이 이미 하루 한도의 40%). 더 넓히려면 응답 본문 캐시가 먼저다(snapshot.ts snapshotBody).
  // 계정은 운영자 한 사람의 몫(저장마다 다시 읽기 200, 저녁 약 100번 × 522경기 약 7천 행 = 70만 행)의 4배.
  "day-snapshot-rows-account": 3_000_000,
  "day-snapshot-rows-ip": 4_000_000,
  "day-snapshot-rows-token": 4_000_000,
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
  "snapshot-account": "RATE_SNAPSHOT_PER_ACCOUNT",
  "snapshot-ip": "RATE_SNAPSHOT_PER_IP",
  "signup-ip": "RATE_SIGNUP_PER_IP",
  "login-ip": "RATE_LOGIN_PER_IP",
  "recover-ip": "RATE_RECOVER_PER_IP",
  "client-error-ip": "RATE_CLIENT_ERROR_PER_IP",
  "bulk-rows-account": "RATE_BULK_ROWS_PER_ACCOUNT",
  "bulk-rows-ip": "RATE_BULK_ROWS_PER_IP",
  "day-strike-ip": "RATE_STRIKES_PER_IP_DAY",
  "day-snapshot-rows-account": "RATE_SNAPSHOT_ROWS_PER_ACCOUNT_DAY",
  "day-snapshot-rows-ip": "RATE_SNAPSHOT_ROWS_PER_IP_DAY",
  "day-snapshot-rows-token": "RATE_SNAPSHOT_ROWS_PER_TOKEN_DAY",
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

/**
 * 요청한 쪽의 IP. Cloudflare가 붙이는 CF-Connecting-IP를 쓴다. 로컬에는 없을 수 있다.
 *
 * CF-Worker 헤더가 있는 요청(다른 Worker가 fetch()로 보낸 것)은 헤더 값과 상관없이 버킷 하나("worker")로 센다
 * (2026-11-10 보안 감사). 값을 키에 넣으면, 누가 이 헤더를 마음대로 붙일 수 있는 경우 값을 바꿔 가며 한도를 피한다.
 * 고정 버킷이면 헤더를 붙여도 공용 버킷 하나에 모일 뿐이다. 정상 사용자는 Worker를 거치지 않으므로 영향이 없다.
 *
 * staging 실측(2026-11-10): Worker의 하위 요청에서 Cloudflare가 cf-worker를 그 Worker의 zone
 * (`<계정>.workers.dev`)으로 덮어쓰고 x-real-ip도 덮어썼다. 보내는 쪽이 요청마다 cf-worker 값을 바꿔도 한도(30)를 넘는
 * 31번째부터 429였다. 같은 계정의 workers.dev끼리 fetch는 기본 설정에서 오류 1042로 막히고 보내는 Worker에
 * global_fetch_strictly_public 호환 플래그가 있어야 나갔다.
 */
export function clientIp(req: Request): string {
  if (req.headers.get("CF-Worker")) return "worker";
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

/** 하루 창 버킷의 키를 고르는 SQL 조건. 범위 비교("day-" 이상 "day." 미만)는 접두어 비교와 같다('.'은 '-' 다음 글자). */
const DAILY_KEY_SQL = DAILY_PREFIXES.map((p) => `(key >= '${p}' AND key < '${p.slice(0, -1)}.')`).join(" OR ");

/**
 * 지난 창의 기록은 남겨 둘 이유가 없다. 다만 분 단위 버킷과 하루 창 버킷은 따로 지운다:
 * 분 단위 버킷의 정리가 오늘 하루 창 행(window_start = 오늘 0시)을 지우면 예산·벌점이 초기화된다.
 */
function cleanupStatement(env: Env, kind: "minute" | "daily", windowStart: number): D1PreparedStatement {
  return env.DB.prepare(
    `DELETE FROM rate_limits WHERE window_start < ?1 AND ${kind === "daily" ? "" : "NOT "}(${DAILY_KEY_SQL})`,
  ).bind(windowStart);
}

async function bucketKey(env: Env, bucket: Bucket, subject: string): Promise<string> {
  const id = bucket.endsWith("-ip") ? await ipKey(env, subject) : subject;
  return `${bucket}:${id}`;
}

/** UTC 하루 창의 시작과, 창이 끝날 때까지 남은 초. */
function dayWindow(now: number): { start: number; retryAfter: number } {
  const windowMs = BULK_WINDOW_SECONDS * 1000;
  const start = Math.floor(now / windowMs) * windowMs;
  return { start, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}

/** 하루 창이 다시 열리는 때를 한국 시각으로 적은 말. UTC 0시 = 한국 오전 9시. */
export function dayResetPhrase(now: number): string {
  const kstHour = new Date(now + 9 * 3600_000).getUTCHours();
  return `${kstHour < 9 ? "오늘" : "내일"} 오전 9시(한국 시각)`;
}

/**
 * 한 번 세고, 한도를 넘었으면 429를 던진다.
 * 같은 창 안의 카운트 증가는 한 문장(UPSERT ... RETURNING)이라 동시에 와도 빠짐없이 센다.
 * windowSeconds를 주지 않으면 RATE_WINDOW_SECONDS(기본 60초) 창을 쓴다.
 *
 * 카운트는 limit + 1에서 멈춘다. DO UPDATE에 WHERE를 걸면 SQLite는 조건이 거짓일 때 행을 바꾸지 않고
 * RETURNING도 아무 행을 돌려주지 않는다(DO NOTHING과 같다). 그래서
 * - 처음 넘는 요청(count가 limit + 1이 됨)만 쓰고, 한도에 걸린 횟수(rate_limit_hits)도 그때 한 번 더한다.
 * - 그 뒤 같은 창의 요청은 결과가 비어 쓰기 없이 429다. 지난 창 정리(cleanupStatement)도 지울 행이 없으니 쓰지 않는다
 *   (이 창의 첫 요청이 이미 지웠다).
 * 따라서 현황 화면의 "한도 걸림"은 걸린 요청 수가 아니라 (버킷 키, 창)마다 1이다.
 *
 * IP 버킷("-ip")은 하루 벌점도 본다(day-strike-ip, 2026-11-10 보안 감사). 창에서 처음 한도를 넘을 때마다 그 IP의
 * 벌점 행(UTC 하루 창)에 1을 더하고, 벌점이 한도에 닿은 IP는 그날 남은 시간 동안 세지도 쓰지도 않고 429다
 * (같은 batch 안에서 벌점 행을 읽어 확인한다: 왕복은 그대로 1회, 읽기 1행이 는다).
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
  const day = dayWindow(now);
  const strike = bucket.endsWith("-ip")
    ? { key: await bucketKey(env, "day-strike-ip", subject), limit: limitOf(env, "day-strike-ip") }
    : null;
  const results = await env.DB.batch([
    strike
      ? env.DB.prepare(
          `INSERT INTO rate_limits (key, window_start, count)
           SELECT ?1, ?2, 1 WHERE NOT EXISTS (
             SELECT 1 FROM rate_limits WHERE key = ?4 AND window_start = ?5 AND count >= ?6
           )
           ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE rate_limits.count <= ?3
           RETURNING count`,
        ).bind(key, windowStart, limit, strike.key, day.start, strike.limit)
      : env.DB.prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
           ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 WHERE rate_limits.count <= ?3
           RETURNING count`,
        ).bind(key, windowStart, limit),
    cleanupStatement(env, "minute", windowStart),
    ...(strike
      ? [env.DB.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2").bind(strike.key, day.start)]
      : []),
  ]);
  if (strike) {
    const strikes = (results[2]?.results?.[0] as { count: number } | undefined)?.count ?? 0;
    if (strikes >= strike.limit) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        `오늘 이 인터넷 주소에서 요청 한도에 너무 여러 번 걸렸어요. ${dayResetPhrase(now)} 이후에 다시 시도해 주세요.`,
        { retryAfter: day.retryAfter, daily: true },
      );
    }
  }
  const row = results[0]?.results?.[0] as { count: number } | undefined;
  // 행이 없으면 이 창은 이미 한도를 넘겼다(위 WHERE가 거짓이라 바꾸지 않음).
  if (!row || row.count > limit) {
    if (row) {
      const strikes = await countLimited(env, bucket, now, strike ? { key: strike.key, dayStart: day.start } : null);
      // 이 벌점으로 그 IP가 오늘 막히기 시작했다. 현황 화면에서 보이게 한 번 센다(막힌 뒤의 요청은 쓰기가 없어 세지 않는다).
      if (strike && strikes === strike.limit) await countLimited(env, "day-strike-ip", now, null);
    }
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
  await spendDaily(
    env,
    [
      ["bulk-rows-account", actor.accountId],
      ["bulk-rows-ip", actor.ip],
    ],
    rows,
    (_now, retryAfter) =>
      `${BULK_LIMIT_MESSAGE} 약 ${Math.max(1, Math.ceil(retryAfter / 3600))}시간 뒤(한국 시각 오전 9시)에 다시 시도해 주세요. 입력한 내용은 그대로 있어요.`,
  );
}

/** 스냅숏 하나를 만들 때 D1에서 읽는 행 수 추정: 경기당 약 13행(경기·명단 10·이력), 나머지(참가자·시즌 등)는 고정 300. */
export function snapshotCost(matchCount: number): number {
  return 300 + 13 * Math.max(0, matchCount);
}

export const SNAPSHOT_BUDGET_MESSAGE = "오늘 이 모임 기록을 받아 갈 수 있는 양을 넘었어요.";

/**
 * 스냅숏 200 응답의 하루 읽기 예산(2026-11-10 보안 감사). 본문을 만들기 직전에 부른다(304는 부르지 않는다).
 * 누가 쓰는지: 운영자·멤버 스냅숏은 계정과 IP, 조회 링크는 IP와 그 모임(조회 링크 버킷. 토큰 대신 모임 ID로 세어
 * 토큰 원문을 키에 남기지 않고, 링크를 다시 만들어도 그날 예산이 이어진다).
 */
export async function spendSnapshotRows(
  env: Env,
  who: { accountId?: string; ip: string; viewGroupId?: string },
  matchCount: number,
): Promise<void> {
  const spends: [Bucket, string][] = [["day-snapshot-rows-ip", who.ip]];
  if (who.accountId) spends.push(["day-snapshot-rows-account", who.accountId]);
  if (who.viewGroupId) spends.push(["day-snapshot-rows-token", who.viewGroupId]);
  await spendDaily(
    env,
    spends,
    snapshotCost(matchCount),
    (now) => `${SNAPSHOT_BUDGET_MESSAGE} ${dayResetPhrase(now)} 이후에 다시 열 수 있어요.`,
  );
}

/**
 * 하루 창 버킷 여러 개에서 amount를 한꺼번에 쓴다. 하나라도 넘으면 429이고 아무것도 쓰지 않는다
 * (확인하는 보호 문장과 더하기가 한 batch).
 */
async function spendDaily(
  env: Env,
  spends: [Bucket, string][],
  amount: number,
  message: (now: number, retryAfter: number) => string,
): Promise<void> {
  if (!Number.isInteger(amount) || amount <= 0) return;
  const now = rateClock.now();
  const { start: windowStart, retryAfter } = dayWindow(now);
  const buckets: [Bucket, string][] = [];
  for (const [bucket, subject] of spends) buckets.push([bucket, await bucketKey(env, bucket, subject)]);
  const over = async (bucket: Bucket): Promise<never> => {
    await countLimited(env, bucket, now, null);
    throw new ApiError(429, "RATE_LIMITED", message(now, retryAfter), { retryAfter, daily: true });
  };
  // 한 번에 하루 한도보다 많으면 볼 것도 없이 거절한다.
  const tooBig = buckets.find(([bucket]) => amount > limitOf(env, bucket));
  if (tooBig) return over(tooBig[0]);
  try {
    await env.DB.batch([
      // 더하면 한도를 넘는 버킷이 하나라도 있으면 batch 전체를 실패시킨다(guard_state_conflict).
      ...buckets.map(([bucket, key]) =>
        env.DB.prepare(
          `INSERT INTO guard (state_conflict)
           SELECT 1 FROM rate_limits WHERE key = ?1 AND window_start = ?2 AND count + ?3 > ?4`,
        ).bind(key, windowStart, amount, limitOf(env, bucket)),
      ),
      ...buckets.map(([, key]) =>
        env.DB.prepare(
          `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT (key, window_start) DO UPDATE SET count = count + ?3`,
        ).bind(key, windowStart, amount),
      ),
      cleanupStatement(env, "daily", windowStart),
    ]);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes("guard_state_conflict")) throw error;
    // 어느 쪽이 넘었는지는 현황 화면 기록(rate_limit_hits)에만 쓴다. 거절할 때만 한 번 더 읽는다.
    const counts = await env.DB.prepare(
      "SELECT key, count FROM rate_limits WHERE key IN (SELECT value FROM json_each(?1)) AND window_start = ?2",
    )
      .bind(JSON.stringify(buckets.map(([, key]) => key)), windowStart)
      .all<{ key: string; count: number }>();
    const exceeded = buckets.find(
      ([bucket, key]) => (counts.results.find((r) => r.key === key)?.count ?? 0) + amount > limitOf(env, bucket),
    );
    return over(exceeded?.[0] ?? buckets[0]![0]);
  }
}

/** 한도에 걸린 횟수 기록(rate_limit_hits)을 남겨 두는 날수. */
export const RATE_HIT_KEEP_DAYS = 30;

/**
 * 한도에 걸린 횟수를 날짜(UTC)·종류별로 더한다(사이트 운영자 현황 화면, migrations/0018). 누가 걸렸는지는 남기지 않는다.
 * 창마다 처음 걸린 요청에서만 쓰므로(hit) 정상 요청과 그 뒤의 거절에는 비용이 없다. 실패해도 429 응답은 그대로다.
 * strike가 있으면(IP 버킷) 그 IP의 하루 벌점도 같은 batch에서 1 올리고, 올린 뒤의 벌점을 돌려준다(없거나 실패하면 null).
 */
async function countLimited(
  env: Env,
  bucket: Bucket,
  now: number,
  strike: { key: string; dayStart: number } | null,
): Promise<number | null> {
  const day = new Date(now).toISOString().slice(0, 10);
  const oldest = new Date(now - RATE_HIT_KEEP_DAYS * 24 * 3600_000).toISOString().slice(0, 10);
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO rate_limit_hits (day, bucket, count) VALUES (?1, ?2, 1)
         ON CONFLICT (day, bucket) DO UPDATE SET count = count + 1`,
      ).bind(day, bucket),
      env.DB.prepare("DELETE FROM rate_limit_hits WHERE day < ?1").bind(oldest),
      ...(strike
        ? [
            env.DB.prepare(
              `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
               ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
               RETURNING count`,
            ).bind(strike.key, strike.dayStart),
            cleanupStatement(env, "daily", strike.dayStart),
          ]
        : []),
    ]);
    return (results[2]?.results?.[0] as { count: number } | undefined)?.count ?? null;
  } catch {
    // 세지 못해도 제한은 그대로 건다.
    return null;
  }
}
