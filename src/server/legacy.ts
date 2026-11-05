/**
 * 기존 사이트(v1) 기록 읽기. 운영자가 붙여 넣은 Apps Script 웹 앱 주소에서 공용 기록을 읽어 화면에 돌려준다.
 * 저장하지 않는다. 저장은 화면이 이름·진영·날짜를 확인한 뒤 기존 일괄 입력 경로(importMatches)로 한다.
 *
 * 읽기만 한다: 보내는 요청은 늘 {"action":"read"} 하나다. 모임 암호는 받지도 보내지도 않는다.
 *
 * SSRF 방지:
 * - 사용자가 준 주소를 그대로 요청하지 않는다. 배포 ID만 정규식으로 뽑아(src/shared/legacy.ts)
 *   https://script.google.com/macros/s/{ID}/exec 를 직접 조립한다.
 * - 리디렉션은 손으로 최대 3번, script.google.com·script.googleusercontent.com의 https만 따라간다.
 *   301·302·303 뒤에는 GET으로 받는다(브라우저와 같은 동작. 실제로 302 → .../macros/echo?... 이고, 이 주소에
 *   POST를 그대로 보내면 411이 난다). 307·308은 POST를 그대로 보낸다.
 * - 응답 크기 상한 10MB(내려받으면서 센다), 전체 시간 제한 20초, Content-Type은 application/json만.
 *   10MB인 이유: v1은 경기 20,000개까지 허용했다. 실제 응답이 522경기에 약 229KB(경기당 약 440바이트)이므로
 *   20,000경기는 약 8.8MB다. 여기에 진행 상태·기록 같은 작은 값이 붙는다. 휴지통까지 꽉 찬(20,000 + 20,000) 극단은
 *   받지 않는다(안내 문구로 알린다). Worker 메모리(128MB) 안에서 JSON을 읽기에 넉넉한 크기다.
 *
 * 실제 응답(2026-11-05, 기존 사이트 주소로 확인): POST /exec → 302 Location: https://script.googleusercontent.com/
 * macros/echo?user_content_key=... → GET → 200 application/json; charset=utf-8 → {ok, revision, payload}.
 * 웹 앱 접근 권한이 "모든 사용자"가 아니면 로그인 화면(HTML)이나 accounts.google.com 리디렉션이 온다.
 */
import { fakeLoginEnabled, readSession } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, requireString } from "./http";
import { clientIp, hit } from "./ratelimit";
import {
  isLegacyRedirectHost,
  LEGACY_URL_MESSAGES,
  legacyExecUrl,
  legacyPayloadProblem,
  legacySourceKey,
  legacySummary,
  parseLegacyChoice,
  parseLegacyUrl,
  trimLegacyMatch,
  type LegacyChoice,
  type LegacyMatch,
  type LegacySummary,
} from "../shared/legacy";

export const MAX_LEGACY_BYTES = 10 * 1024 * 1024;
export const LEGACY_TIMEOUT_MS = 20_000;
export const MAX_LEGACY_REDIRECTS = 3;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** 테스트 전용: 바깥 요청 대신 가짜 응답을 돌려주는 함수를 끼운다. */
export const legacyHooks: { fetch: Fetcher | null } = { fetch: null };

/** 로컬 브라우저 테스트(e2e) 전용 가짜 응답(배포 ID → 응답 글). sheets.ts의 시트 내용 등록과 같은 안전 조건. */
const fixtures = new Map<string, string>();

export function registerLegacyFixture(body: Record<string, unknown>): { ok: true } {
  assertOnlyKeys(body, ["url", "json"]);
  const parsed = parseLegacyUrl(requireString(body.url, "url", 1, 2000));
  if (!parsed.ok) throw new ApiError(400, "INVALID_FIELD", "url 값이 올바르지 않습니다.");
  fixtures.set(parsed.deploymentId, requireString(body.json, "json", 2, 2 * 1024 * 1024));
  return { ok: true };
}

export type LegacyFailure = "not-public" | "not-found" | "too-large" | "not-json" | "bad-format" | "refused" | "unreachable";

export const LEGACY_FAILURE_MESSAGES: Record<LegacyFailure, string> = {
  "not-public":
    "기존 사이트의 연결 주소가 공개되어 있지 않아요. Apps Script 배포 설정에서 웹 앱 '액세스 권한'이 '모든 사용자'인지, 주소가 /exec로 끝나는지 확인해 주세요.",
  "not-found": "연결 주소를 찾지 못했어요. 기존 사이트에서 쓰던 주소가 맞는지, 배포가 지워지지 않았는지 확인해 주세요.",
  "too-large": "기존 사이트의 기록이 너무 커요(10MB 초과). 휴지통을 비운 뒤 다시 읽어 주세요.",
  "not-json":
    "기존 사이트의 기록 대신 다른 화면이 왔어요. 웹 앱 '액세스 권한'이 '모든 사용자'인지, 기존 사이트에서 쓰던 /exec 주소인지 확인해 주세요.",
  "bad-format": "기존 사이트의 기록 형식이 예상과 달라요. 아무것도 가져오지 않았어요.",
  refused: "기존 사이트가 읽기를 거절했어요. 연결 주소가 맞는지 확인해 주세요.",
  unreachable: "기존 사이트에서 응답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.",
};

function failure(kind: LegacyFailure, detail?: string): ApiError {
  return new ApiError(
    kind === "too-large" ? 413 : kind === "not-found" ? 404 : 400,
    `LEGACY_${kind.toUpperCase().replace(/-/g, "_")}`,
    detail ? `${LEGACY_FAILURE_MESSAGES[kind]} (${detail})` : LEGACY_FAILURE_MESSAGES[kind],
    { reason: kind },
  );
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw failure("too-large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw failure("too-large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

/** Apps Script에 읽기 요청을 보내고 응답 글(JSON)을 받는다. 실패는 사용자 안내가 담긴 ApiError로 던진다. */
export async function fetchLegacyText(deploymentId: string, fetcher: Fetcher): Promise<string> {
  let url = legacyExecUrl(deploymentId);
  let method: "POST" | "GET" = "POST";
  const deadline = AbortSignal.timeout(LEGACY_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_LEGACY_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetcher(
        url,
        method === "POST"
          ? {
              method: "POST",
              redirect: "manual",
              signal: deadline,
              headers: { "Content-Type": "text/plain;charset=utf-8", Accept: "application/json" },
              // 읽기만 한다. 암호는 보내지 않는다(v1 storage.js: 읽기는 암호가 필요 없다).
              body: JSON.stringify({ action: "read" }),
            }
          : { method: "GET", redirect: "manual", signal: deadline, headers: { Accept: "application/json" } },
      );
    } catch {
      throw failure("unreachable");
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("Location");
      if (!location) throw failure("unreachable");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw failure("unreachable");
      }
      const host = next.hostname.toLowerCase();
      if (host === "accounts.google.com" || /ServiceLogin|signin/i.test(next.pathname)) throw failure("not-public");
      if (next.protocol !== "https:" || next.port !== "" || next.username !== "" || !isLegacyRedirectHost(host)) {
        // 구글 Apps Script 밖으로 보내는 리디렉션은 따라가지 않는다.
        throw failure("unreachable");
      }
      if (status === 301 || status === 302 || status === 303) method = "GET";
      url = next.toString();
      continue;
    }
    const type = (response.headers.get("Content-Type") ?? "").toLowerCase();
    if (status === 401 || status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("not-public");
    }
    if (status === 404) {
      await response.body?.cancel().catch(() => undefined);
      throw failure("not-found");
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw failure(type.startsWith("text/html") ? "not-public" : "unreachable");
    }
    if (!type.startsWith("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      // 접근 권한이 "모든 사용자"가 아니면 로그인 화면(HTML)이 200으로 온다.
      throw failure(type.startsWith("text/html") ? "not-public" : "not-json");
    }
    try {
      return await readLimited(response, MAX_LEGACY_BYTES);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw failure("unreachable");
    }
  }
  throw failure("unreachable");
}

/** 응답 글을 검증해 가져올 경기와 요약으로 바꾼다. 하나라도 어긋나면 아무것도 돌려주지 않는다. */
export function readLegacyResponse(text: string): { matches: LegacyMatch[]; summary: LegacySummary; revision: number | null } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw failure("not-json");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw failure("bad-format");
  const d = data as Record<string, unknown>;
  if (d.ok !== true) throw failure("refused");
  const problem = legacyPayloadProblem(d.payload);
  if (problem !== null) throw failure("bad-format", problem);
  const payload = d.payload as Record<string, unknown>;
  return {
    matches: (payload.matches as LegacyMatch[]).map(trimLegacyMatch),
    summary: legacySummary(payload),
    revision: Number.isInteger(d.revision) ? (d.revision as number) : null,
  };
}

export interface LegacyReadResult {
  sourceKey: string;
  matches: LegacyMatch[];
  summary: LegacySummary;
  revision: number | null;
  /** 이 주소로 전에 가져올 때 고른 날짜 기준(가장 최근 묶음). 없으면 null. */
  remembered: LegacyChoice | null;
}

/** 이 출처로 가져온 가장 최근 묶음의 선택. */
async function rememberedChoice(env: Env, groupId: string, sourceKey: string): Promise<LegacyChoice | null> {
  const row = await env.DB.prepare(
    `SELECT options FROM import_batches WHERE group_id = ?1 AND source_key = ?2 AND options IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(groupId, sourceKey)
    .first<{ options: string }>();
  if (!row) return null;
  try {
    return parseLegacyChoice(JSON.parse(row.options));
  } catch {
    return null;
  }
}

/** POST /api/groups/:gid/legacy/read — 운영자 확인은 앞단(index.ts)에서 끝났다. */
export async function readLegacy(env: Env, req: Request, groupId: string, body: Record<string, unknown>): Promise<LegacyReadResult> {
  assertOnlyKeys(body, ["url"]);
  const parsed = parseLegacyUrl(requireString(body.url, "url", 1, 2000));
  if (!parsed.ok) {
    throw new ApiError(400, "LEGACY_URL_INVALID", LEGACY_URL_MESSAGES[parsed.problem], { reason: parsed.problem });
  }
  // 바깥 요청이므로 시트 읽기와 같은 좁은 한도를 함께 쓴다.
  await hit(env, "sheet-ip", clientIp(req));
  const session = await readSession(env, req);
  if (session) await hit(env, "sheet-account", session.id);

  const testMode = fakeLoginEnabled(env);
  let text: string;
  if (testMode && fixtures.has(parsed.deploymentId)) {
    text = fixtures.get(parsed.deploymentId)!;
  } else {
    const fetcher: Fetcher = legacyHooks.fetch ?? ((url, init) => fetch(url, init));
    text = await fetchLegacyText(parsed.deploymentId, fetcher);
  }
  const read = readLegacyResponse(text);
  const sourceKey = legacySourceKey(parsed.deploymentId);
  return { sourceKey, ...read, remembered: await rememberedChoice(env, groupId, sourceKey) };
}
