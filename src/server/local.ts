/**
 * 자체 계정(아이디 + 비밀번호). 카카오·Google 키 없이도 운영자가 로그인할 수 있게 한다.
 *
 * 저장(migrations/0009_local_accounts.sql):
 * - 계정 행은 accounts 표(provider = 'local', subject = 정규화한 아이디)를 그대로 쓴다. 세션·로그아웃·탈퇴도 같다.
 * - 비밀번호: HMAC-SHA-256(서버 비밀값 페퍼) → PBKDF2-HMAC-SHA-256(WebCrypto), 계정마다 무작위 16바이트 솔트,
 *   32바이트 결과. 저장 형식 `pbkdf2p-sha256$횟수$솔트$해시`. 페퍼 전의 예전 형식(`pbkdf2-sha256$…`)도 검증하고,
 *   맞으면 그 로그인에서 새 형식으로 다시 저장한다.
 *   반복 횟수는 기본 100,000(Workers 런타임이 받는 최대값), 운영 무료 요금제는 20,000(wrangler.jsonc).
 *   해시 문자열에 방식·횟수를 함께 적어, 나중에 횟수를 올리면 로그인에 성공할 때 새 횟수로 다시 저장한다. 비교는 상수 시간.
 *   - node:crypto의 scrypt는 이 프로젝트가 nodejs_compat 호환 플래그를 켜지 않아 쓸 수 없다(wrangler.jsonc).
 *   - Workers 무료 요금제의 요청당 CPU 시간(10ms)은 100,000회 계산보다 짧을 수 있다(docs/배포안내.md).
 * - 복구 코드: 160비트 무작위 값. 서버에는 SHA-256만 둔다(추측할 수 없는 값이라 느린 해시가 필요 없다).
 *
 * 악용 방지:
 * - IP별 요청 수 제한(가입 5·로그인 10·복구 5 / 60초, src/server/ratelimit.ts)과, 실패 횟수 제한
 *   (15분에 (아이디, IP)별 로그인 10번·복구 5번, 아이디 전체 100번). 없는 아이디도 똑같이 세고, 해시도 한 번 계산해
 *   응답 내용·시간이 같다. IP를 함께 세는 까닭: 아이디만 알면 남이 주인의 로그인을 막을 수 있었다(2026-11-08).
 * - 로그인 실패 문구는 하나다: "아이디 또는 비밀번호가 맞지 않아요."
 * - CSRF 방어(Origin 확인·JSON 본문)는 index.ts의 공통 앞단을 그대로 거친다. 본문은 2KB까지.
 */
import {
  normalizePassword,
  normalizeRecoveryCode,
  normalizeUsername,
  passwordProblem,
  RECOVERY_ALPHABET,
  usernameProblem,
} from "../shared/account";
import { fromBase64Url, revokeSessions, toBase64Url, type SessionAccount } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, nowIso } from "./http";
import { ipKey, rateClock } from "./ratelimit";

export const LOCAL_PROVIDER = "local";
/** 자체 계정 요청 본문 상한(바이트). 아이디·비밀번호 몇 개뿐이다. */
export const MAX_LOCAL_BODY_BYTES = 2048;
/** Workers 런타임의 PBKDF2 반복 횟수 상한. 이보다 크면 계산이 거절된다. */
export const PBKDF2_MAX_ITERATIONS = 100_000;
const PBKDF2_MIN_ITERATIONS = 10_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const RECOVERY_BYTES = 20;

/** 아이디·계정별 실패 횟수 제한(고정 창). */
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const FAILURE_LIMITS = { login: 10, recover: 5, password: 10 } as const;
/** 로그인·복구의 아이디 전체(모든 IP 합계) 실패 한도(15분 창). (아이디, IP)별 한도는 FAILURE_LIMITS. */
export const FAILURE_TOTAL_LIMIT = 100;
/**
 * 아이디별 하루(UTC) 누적 실패 한도(2026-11-10 보안 감사). 15분에 100번이면 하루 9,600번을 추측할 수 있었다.
 * 로그인·복구 각각 하루 실패가 이 값에 닿으면 그날은 15분 창의 한도가 FAILURE_TOTAL_LIMIT_THROTTLED로 줄어든다
 * (하루 최대 약 200 + 96 × 5 = 680번). 로그인에 성공해도 하루 누적은 지우지 않는다: 주인이 로그인할 때마다
 * 추측하는 쪽의 한도가 되살아나면 안 된다. 대가: 누적이 찬 날은 주인도 창당 5번 실패 뒤에는 기다려야 한다.
 */
export const FAILURE_DAILY_LIMIT = 200;
export const FAILURE_TOTAL_LIMIT_THROTTLED = 5;
const DAY_MS = 86_400_000;
type FailureKind = keyof typeof FAILURE_LIMITS;

export const INVALID_LOGIN_MESSAGE = "아이디 또는 비밀번호가 맞지 않아요.";
export const INVALID_RECOVERY_MESSAGE = "아이디 또는 복구 코드가 맞지 않아요.";

type Body = Record<string, unknown>;

export function localAccountsEnabled(env: Env): boolean {
  return (env.LOCAL_ACCOUNTS ?? "").trim().toLowerCase() !== "off";
}

export function requireLocalAccounts(env: Env): void {
  if (!localAccountsEnabled(env)) throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
}

function iterationsOf(env: Env): number {
  const n = Number(env.PASSWORD_PBKDF2_ITERATIONS);
  if (!Number.isInteger(n)) return PBKDF2_MAX_ITERATIONS;
  return Math.min(PBKDF2_MAX_ITERATIONS, Math.max(PBKDF2_MIN_ITERATIONS, n));
}

/* ------------------------------ 해시 ------------------------------ */

/** 예전 형식(페퍼 없음). 읽기만 하고, 맞으면 다음 로그인 때 새 형식으로 다시 저장한다. */
const SCHEME_PLAIN = "pbkdf2-sha256";
/** 지금 형식: 비밀번호에 서버 비밀값(페퍼)으로 HMAC-SHA-256을 한 번 씌운 뒤 PBKDF2. */
const SCHEME_PEPPERED = "pbkdf2p-sha256";

/**
 * 페퍼: PBKDF2에 넣기 전에 PASSWORD_PEPPER(접두어 "password-pepper:"로 아이디 해시와 구분)로 HMAC-SHA-256을 씌운다.
 * DB만 새어 나가면(서버 비밀값은 그대로) 반복 횟수를 낮춘 운영(20,000회)에서도 비밀번호를 오프라인으로 추측할 수 없다.
 * 세션 서명 키(SESSION_SECRET)와 다른 비밀값이다(2026-11-10): 세션 키는 비밀번호에 영향 없이 바꿀 수 있다.
 * 주의: PASSWORD_PEPPER를 바꾸면 이 형식의 비밀번호는 모두 맞지 않게 된다(복구 코드로만 다시 정할 수 있다. docs/배포안내.md).
 */
async function pepper(env: Env, password: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`password-pepper:${env.PASSWORD_PEPPER}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizePassword(password)));
  return new Uint8Array(mac);
}

async function pbkdf2(
  env: Env,
  password: string,
  salt: Uint8Array,
  iterations: number,
  peppered: boolean,
): Promise<Uint8Array> {
  const material = peppered ? await pepper(env, password) : new TextEncoder().encode(normalizePassword(password));
  const key = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** 길이가 같은 두 값을 상수 시간으로 비교한다(길이가 다르면 바로 false: 길이는 비밀이 아니다). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function hashPassword(env: Env, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iterations = iterationsOf(env);
  const hash = await pbkdf2(env, password, salt, iterations, true);
  return `${SCHEME_PEPPERED}$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/**
 * 저장된 해시와 비교한다. ok와 함께, 다시 저장할지(outdated)를 돌려준다:
 * - 예전 형식(pbkdf2-sha256, 페퍼 없음)은 맞으면 늘 다시 저장한다(새 형식으로 바꾼다).
 * - 지금 형식은 지금 설정보다 반복 횟수가 적을 때만 다시 저장한다(설정을 낮춰도 강한 해시는 그대로 둔다).
 */
export async function verifyPassword(
  env: Env,
  password: string,
  stored: string,
): Promise<{ ok: boolean; outdated: boolean }> {
  const parts = stored.split("$");
  const iterations = Number(parts[1]);
  const scheme = parts[0];
  if (
    parts.length !== 4 ||
    (scheme !== SCHEME_PLAIN && scheme !== SCHEME_PEPPERED) ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    return { ok: false, outdated: false };
  }
  const peppered = scheme === SCHEME_PEPPERED;
  const actual = await pbkdf2(env, password, fromBase64Url(parts[2]!), iterations, peppered);
  const ok = constantTimeEqual(actual, fromBase64Url(parts[3]!));
  return { ok, outdated: ok && (!peppered || iterations < iterationsOf(env)) };
}

/** 없는 아이디로 로그인할 때도 같은 시간이 걸리게 같은 방식·횟수로 한 번 계산한다. 결과는 버린다. */
async function dummyVerify(env: Env, password: string): Promise<void> {
  await pbkdf2(env, password, new Uint8Array(SALT_BYTES), iterationsOf(env), true);
}

/** 새 복구 코드: 화면에 보여줄 값(XXXX-XXXX-…)과 저장할 해시. */
export async function newRecoveryCode(): Promise<{ code: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_BYTES));
  // 160비트를 5비트씩 32글자로 적는다.
  let bits = 0;
  let value = 0;
  let text = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  const code = text.match(/.{4}/g)!.join("-");
  return { code, hash: await recoveryHash(text) };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function recoveryHash(normalized: string): Promise<string> {
  return `sha256$${await sha256Hex(`recovery\n${normalized}`)}`;
}

async function recoveryMatches(input: string, stored: string): Promise<boolean> {
  const actual = new TextEncoder().encode(await recoveryHash(normalizeRecoveryCode(input)));
  return constantTimeEqual(actual, new TextEncoder().encode(stored));
}

/* ------------------------------ 실패 횟수 ------------------------------ */

/** 아이디는 원문 대신 비밀값(PASSWORD_PEPPER)으로 만든 HMAC 앞 16자로 센다(요청 수 제한의 IP와 같은 방식). */
async function nameKey(env: Env, username: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`auth-failures:${env.PASSWORD_PEPPER}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  return [...new Uint8Array(mac)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 계정 탈퇴 때 지울 실패 기록의 키 접두어. 각 키 자체와 "키:IP" 꼴(아래 failureKeys)을 함께 지운다(failureKeyRange).
 */
export async function failureKeysFor(env: Env, username: string, accountId: string): Promise<string[]> {
  const hashed = await nameKey(env, username);
  return [`login:${hashed}`, `recover:${hashed}`, `password:${accountId}`, `day:login:${hashed}`, `day:recover:${hashed}`];
}

/** 키 자체와 "키:…"를 고르는 SQL 조건(?1 = 키). 범위 비교라 LIKE 와일드카드 걱정이 없다(';'는 ':' 다음 글자). */
export const FAILURE_KEY_MATCH = "(key = ?1 OR (key >= ?1 || ':' AND key < ?1 || ';'))";

/**
 * 이 시도에 걸리는 실패 기록 키와 한도.
 * - password(로그인한 계정의 지금 비밀번호 확인): 계정 하나, FAILURE_LIMITS.password.
 * - login·recover: (아이디, IP) 조합에 FAILURE_LIMITS[kind], 아이디 전체에 FAILURE_TOTAL_LIMIT.
 *   아이디만으로 세면 남이 아이디를 알기만 해도 틀린 비밀번호 10번으로 주인의 로그인을 막을 수 있었다(2026-11-08 보안 점검).
 *   IP를 바꿔 가며 추측하는 것은 아이디 전체 한도(15분 100번)와 IP별 요청 수 제한(login-ip)이 막는다.
 */
async function failureKeys(
  env: Env,
  kind: FailureKind,
  subject: string,
  ip: string,
): Promise<{ windowed: { key: string; limit: number }[]; daily: string | null }> {
  if (kind === "password") return { windowed: [{ key: `password:${subject}`, limit: FAILURE_LIMITS.password }], daily: null };
  const total = `${kind}:${await nameKey(env, subject)}`;
  return {
    windowed: [
      { key: `${total}:${await ipKey(env, ip)}`, limit: FAILURE_LIMITS[kind] },
      { key: total, limit: FAILURE_TOTAL_LIMIT },
    ],
    daily: `day:${total}`,
  };
}

function failureWindow(): { start: number; retryAfter: number; dayStart: number } {
  const now = rateClock.now();
  const start = Math.floor(now / FAILURE_WINDOW_MS) * FAILURE_WINDOW_MS;
  return {
    start,
    retryAfter: Math.max(1, Math.ceil((start + FAILURE_WINDOW_MS - now) / 1000)),
    dayStart: Math.floor(now / DAY_MS) * DAY_MS,
  };
}

function tooManyFailures(retryAfter: number): ApiError {
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return new ApiError(
    429,
    "RATE_LIMITED",
    `틀린 시도가 너무 많아요. ${minutes}분 뒤에 다시 시도해 주세요.`,
    { retryAfter },
  );
}

/** 이 창에서 실패가 한도에 닿았으면(키 하나라도) 계산하기 전에 거절한다. */
async function assertNotLocked(env: Env, kind: FailureKind, subject: string, ip: string): Promise<void> {
  const { windowed, daily } = await failureKeys(env, kind, subject, ip);
  const { start, retryAfter, dayStart } = failureWindow();
  const rows = await env.DB.prepare(
    `SELECT key, count FROM auth_failures
     WHERE (key IN (SELECT value FROM json_each(?1)) AND window_start = ?2) OR (key = ?3 AND window_start = ?4)`,
  )
    .bind(JSON.stringify(windowed.map((k) => k.key)), start, daily ?? "", dayStart)
    .all<{ key: string; count: number }>();
  const countOf = (key: string) => rows.results.find((r) => r.key === key)?.count ?? 0;
  // 오늘 이 아이디의 실패가 이미 많으면 아이디 전체 한도(창당)를 좁힌다. (아이디, IP)별 한도는 원래 더 작거나 같다.
  const throttled = daily !== null && countOf(daily) >= FAILURE_DAILY_LIMIT;
  const locked = windowed.some(
    ({ key, limit }) => countOf(key) >= (throttled ? Math.min(limit, FAILURE_TOTAL_LIMIT_THROTTLED) : limit),
  );
  if (locked) throw tooManyFailures(retryAfter);
}

async function recordFailure(env: Env, kind: FailureKind, subject: string, ip: string): Promise<void> {
  const { windowed, daily } = await failureKeys(env, kind, subject, ip);
  const { start, dayStart } = failureWindow();
  const add = (key: string, windowStart: number) =>
    env.DB.prepare(
      `INSERT INTO auth_failures (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1`,
    ).bind(key, windowStart);
  await env.DB.batch([
    ...windowed.map(({ key }) => add(key, start)),
    ...(daily ? [add(daily, dayStart)] : []),
    // 지난 창 정리. 하루 누적 행("day:…")은 15분 창 정리에서 빼고 날이 바뀌면 지운다(';'는 ':' 다음 글자).
    env.DB.prepare("DELETE FROM auth_failures WHERE window_start < ?1 AND NOT (key >= 'day:' AND key < 'day;')").bind(start),
    env.DB.prepare("DELETE FROM auth_failures WHERE window_start < ?1 AND key >= 'day:' AND key < 'day;'").bind(dayStart),
  ]);
}

/** 성공하면 그 아이디(또는 계정)의 실패 기록을 IP와 상관없이 모두 지운다. */
async function clearFailures(env: Env, kind: FailureKind, subject: string): Promise<void> {
  const prefix = kind === "password" ? `password:${subject}` : `${kind}:${await nameKey(env, subject)}`;
  await env.DB.prepare(`DELETE FROM auth_failures WHERE ${FAILURE_KEY_MATCH}`).bind(prefix).run();
}

/* ------------------------------ 입력 ------------------------------ */

function stringField(body: Body, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

/** 가입·비밀번호 바꾸기에서 조건을 어기면 무엇이 틀렸는지 알려준다. */
function checkNewCredentials(username: string, password: string): void {
  const problem = usernameProblem(username) ?? passwordProblem(password, username);
  if (problem) throw new ApiError(400, "INVALID_CREDENTIALS_FORMAT", problem);
}

interface CredentialRow {
  id: string;
  session_epoch: number;
  password_hash: string;
  recovery_hash: string;
}

async function findLocal(env: Env, username: string): Promise<CredentialRow | null> {
  return env.DB.prepare(
    `SELECT a.id, a.session_epoch, c.password_hash, c.recovery_hash
     FROM accounts a JOIN local_credentials c ON c.account_id = a.id
     WHERE a.provider = ?1 AND a.subject = ?2`,
  )
    .bind(LOCAL_PROVIDER, username)
    .first<CredentialRow>();
}

async function findLocalById(env: Env, accountId: string): Promise<(CredentialRow & { subject: string }) | null> {
  return env.DB.prepare(
    `SELECT a.id, a.subject, a.session_epoch, c.password_hash, c.recovery_hash
     FROM accounts a JOIN local_credentials c ON c.account_id = a.id
     WHERE a.id = ?1 AND a.provider = ?2`,
  )
    .bind(accountId, LOCAL_PROVIDER)
    .first<CredentialRow & { subject: string }>();
}

/* ------------------------------ 동작 ------------------------------ */

/** 가입. 성공하면 세션을 만들 계정과, 한 번만 보여줄 복구 코드를 돌려준다. */
export async function signup(env: Env, body: Body): Promise<{ account: SessionAccount; recoveryCode: string }> {
  assertOnlyKeys(body, ["username", "password"]);
  const username = normalizeUsername(stringField(body, "username", 64));
  const password = stringField(body, "password", 512);
  checkNewCredentials(username, password);

  const taken = () => new ApiError(409, "USERNAME_TAKEN", "이미 쓰는 아이디예요. 다른 아이디를 골라 주세요.");
  const exists = await env.DB.prepare("SELECT 1 AS ok FROM accounts WHERE provider = ?1 AND subject = ?2")
    .bind(LOCAL_PROVIDER, username)
    .first<{ ok: number }>();
  if (exists) throw taken();

  const id = crypto.randomUUID();
  const now = nowIso();
  const recovery = await newRecoveryCode();
  const passwordHash = await hashPassword(env, password);
  try {
    // 계정 행과 비밀번호 행을 한 번에 넣는다. 같은 아이디가 동시에 가입하면 유일 조건에 걸려 둘 다 들어가지 않는다.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO accounts (id, provider, subject, created_at) VALUES (?1, ?2, ?3, ?4)").bind(
        id,
        LOCAL_PROVIDER,
        username,
        now,
      ),
      env.DB.prepare(
        "INSERT INTO local_credentials (account_id, password_hash, recovery_hash, updated_at) VALUES (?1, ?2, ?3, ?4)",
      ).bind(id, passwordHash, recovery.hash, now),
    ]);
  } catch (error) {
    if (String(error instanceof Error ? error.message : error).includes("UNIQUE")) throw taken();
    throw error;
  }
  return { account: { id, provider: LOCAL_PROVIDER, epoch: 0 }, recoveryCode: recovery.code };
}

/** 로그인. 아이디가 없든 비밀번호가 틀리든 같은 오류·같은 계산량이다. */
export async function login(env: Env, body: Body, ip: string): Promise<SessionAccount> {
  assertOnlyKeys(body, ["username", "password"]);
  const username = normalizeUsername(stringField(body, "username", 64));
  const password = stringField(body, "password", 512);
  await assertNotLocked(env, "login", username, ip);
  const row = usernameProblem(username) === null ? await findLocal(env, username) : null;
  let ok = false;
  let outdated = false;
  if (row) ({ ok, outdated } = await verifyPassword(env, password, row.password_hash));
  else await dummyVerify(env, password);
  if (!row || !ok) {
    await recordFailure(env, "login", username, ip);
    throw new ApiError(400, "INVALID_LOGIN", INVALID_LOGIN_MESSAGE);
  }
  await clearFailures(env, "login", username);
  if (outdated) {
    await env.DB.prepare("UPDATE local_credentials SET password_hash = ?2, updated_at = ?3 WHERE account_id = ?1")
      .bind(row.id, await hashPassword(env, password), nowIso())
      .run();
  }
  return { id: row.id, provider: LOCAL_PROVIDER, epoch: row.session_epoch };
}

/**
 * 복구 코드로 비밀번호를 다시 정한다. 성공하면 다른 기기의 세션을 모두 끝내고 새 복구 코드를 준다
 * (쓴 코드는 다시 쓸 수 없다).
 */
export async function recover(
  env: Env,
  body: Body,
  ip: string,
): Promise<{ account: SessionAccount; recoveryCode: string }> {
  assertOnlyKeys(body, ["username", "recoveryCode", "newPassword"]);
  const username = normalizeUsername(stringField(body, "username", 64));
  const code = stringField(body, "recoveryCode", 128);
  const newPassword = stringField(body, "newPassword", 512);
  // 새 비밀번호의 조건은 아이디가 있는지와 상관없이 알려줘도 된다.
  const problem = passwordProblem(newPassword, username);
  if (problem) throw new ApiError(400, "INVALID_CREDENTIALS_FORMAT", problem);
  await assertNotLocked(env, "recover", username, ip);
  const row = usernameProblem(username) === null ? await findLocal(env, username) : null;
  const ok = row ? await recoveryMatches(code, row.recovery_hash) : (await recoveryMatches(code, "sha256$"), false);
  if (!row || !ok) {
    await recordFailure(env, "recover", username, ip);
    throw new ApiError(400, "INVALID_RECOVERY", INVALID_RECOVERY_MESSAGE);
  }
  const recovery = await newRecoveryCode();
  const passwordHash = await hashPassword(env, newPassword);
  // 코드 확인과 바꾸기 사이에 같은 코드로 다른 요청이 먼저 바꿨으면(recovery_hash가 달라짐) 아무것도 하지 않는다.
  const [updated] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE local_credentials SET password_hash = ?2, recovery_hash = ?3, updated_at = ?4
       WHERE account_id = ?1 AND recovery_hash = ?5`,
    ).bind(row.id, passwordHash, recovery.hash, nowIso(), row.recovery_hash),
    env.DB.prepare(
      `UPDATE accounts SET session_epoch = session_epoch + 1
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM local_credentials WHERE account_id = ?1 AND recovery_hash = ?2)`,
    ).bind(row.id, recovery.hash),
  ]);
  if ((updated?.meta.changes ?? 0) === 0) {
    throw new ApiError(400, "INVALID_RECOVERY", INVALID_RECOVERY_MESSAGE);
  }
  await clearFailures(env, "recover", username);
  await clearFailures(env, "login", username);
  const epoch = await env.DB.prepare("SELECT session_epoch FROM accounts WHERE id = ?1")
    .bind(row.id)
    .first<{ session_epoch: number }>();
  return { account: { id: row.id, provider: LOCAL_PROVIDER, epoch: epoch!.session_epoch }, recoveryCode: recovery.code };
}

/** 로그인한 자체 계정의 현재 비밀번호를 확인한다(비밀번호 바꾸기·복구 코드 새로 받기·탈퇴). */
export async function confirmCurrentPassword(
  env: Env,
  accountId: string,
  password: unknown,
): Promise<CredentialRow & { subject: string }> {
  const row = await findLocalById(env, accountId);
  if (!row) throw new ApiError(400, "NOT_LOCAL_ACCOUNT", "아이디로 가입한 계정에서만 쓸 수 있어요.");
  if (typeof password !== "string" || password.length > 512) {
    throw new ApiError(400, "WRONG_PASSWORD", "지금 비밀번호를 입력해 주세요.");
  }
  await assertNotLocked(env, "password", accountId, "");
  const { ok } = await verifyPassword(env, password, row.password_hash);
  if (!ok) {
    await recordFailure(env, "password", accountId, "");
    throw new ApiError(400, "WRONG_PASSWORD", "지금 비밀번호가 맞지 않아요.");
  }
  await clearFailures(env, "password", accountId);
  return row;
}

/** 비밀번호 바꾸기. 다른 기기의 세션은 모두 끝나고, 이 기기에는 새 세션을 준다. */
export async function changePassword(env: Env, accountId: string, body: Body): Promise<SessionAccount> {
  assertOnlyKeys(body, ["currentPassword", "newPassword"]);
  const newPassword = stringField(body, "newPassword", 512);
  const row = await confirmCurrentPassword(env, accountId, body.currentPassword);
  const problem = passwordProblem(newPassword, row.subject);
  if (problem) throw new ApiError(400, "INVALID_CREDENTIALS_FORMAT", problem);
  await env.DB.prepare("UPDATE local_credentials SET password_hash = ?2, updated_at = ?3 WHERE account_id = ?1")
    .bind(accountId, await hashPassword(env, newPassword), nowIso())
    .run();
  await revokeSessions(env, accountId);
  const epoch = await env.DB.prepare("SELECT session_epoch FROM accounts WHERE id = ?1")
    .bind(accountId)
    .first<{ session_epoch: number }>();
  return { id: accountId, provider: LOCAL_PROVIDER, epoch: epoch!.session_epoch };
}

/** 로그인한 상태에서 복구 코드를 새로 받는다(지금 비밀번호 확인). 이전 코드는 바로 못 쓰게 된다. */
export async function regenerateRecoveryCode(env: Env, accountId: string, body: Body): Promise<string> {
  assertOnlyKeys(body, ["password"]);
  await confirmCurrentPassword(env, accountId, body.password);
  const recovery = await newRecoveryCode();
  await env.DB.prepare("UPDATE local_credentials SET recovery_hash = ?2, updated_at = ?3 WHERE account_id = ?1")
    .bind(accountId, recovery.hash, nowIso())
    .run();
  return recovery.code;
}
