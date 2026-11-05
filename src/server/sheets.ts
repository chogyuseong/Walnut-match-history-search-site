/**
 * 구글 시트 읽기(작업 F). 운영자가 붙여 넣은 시트 주소의 탭을 CSV로 읽어 화면에 돌려준다.
 * 시트 내용은 저장하지 않는다. 저장은 화면이 열을 맞추고 확인한 뒤 기존 일괄 입력 경로(importMatches)로 한다.
 *
 * SSRF 방지:
 * - 사용자가 준 주소를 그대로 요청하지 않는다. src/shared/sheetUrl.ts가 문서 ID·gid만 엄격한 정규식으로 뽑고
 *   여기서는 그 값으로 https://docs.google.com/... 주소를 직접 조립한다.
 * - 리디렉션은 자동으로 따라가지 않는다(redirect: "manual"). docs.google.com과 *.googleusercontent.com의
 *   https 주소만 최대 3번 따라간다. 로그인 화면(accounts.google.com)으로 가면 비공개 시트로 본다.
 * - 응답 크기 상한 2MB(내려받으면서 센다), 전체 시간 제한 10초, Content-Type은 text/csv만 받는다.
 *
 * 실제 응답(2026-11-05, 공개 예제 시트와 비공개 시트로 확인):
 * - 공개 시트 export: 307 → *.googleusercontent.com → 200 text/csv; charset=utf-8,
 *   Content-Disposition에 "문서 제목 - 탭 이름.csv"
 * - 없는 gid: 307 → 400 text/html
 * - 비공개 시트: 401 text/html(로그인 상태가 아닌 요청)
 * - 없는 문서: 404 text/html
 */
import { fingerprinter, type SheetPlayer } from "../shared/sheetTable";
import { localDate, safeTimeZone } from "../shared/stats";
import type { Position, Team } from "../shared/types";
import { fakeLoginEnabled, readSession } from "./auth";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, requireString } from "./http";
import { clientIp, hit } from "./ratelimit";
import {
  exportUrlOf,
  findTab,
  htmlviewUrlOf,
  isAllowedRedirectHost,
  isLoginRedirect,
  parseSheetUrl,
  parseTabList,
  SHEET_URL_MESSAGES,
  sourceKeyOf,
  type SheetRef,
  type SheetTab,
} from "../shared/sheetUrl";

export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
export const SHEET_TIMEOUT_MS = 10_000;
export const MAX_SHEET_REDIRECTS = 3;

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** 테스트 전용: 바깥 요청 대신 가짜 응답을 돌려주는 함수를 끼운다(단위·통합 테스트). */
export const sheetHooks: { fetch: Fetcher | null } = { fetch: null };

/**
 * 로컬 브라우저 테스트(e2e) 전용 시트 내용. 서버가 바깥을 부르므로 브라우저 쪽에서 가로챌 수 없다.
 * fakeLoginEnabled(AUTH_MODE=fake 이고 운영 표시가 없음)일 때만 등록·사용된다. 운영에서는 등록 경로가 404이고
 * 이 표는 읽히지 않는다(test/sheets.test.ts에서 확인).
 */
const fixtures = new Map<string, string>();
/** 테스트 전용 탭 목록(문서 ID → 탭). */
const tabFixtures = new Map<string, SheetTab[]>();

export function fixturesEnabled(env: Env): boolean {
  return fakeLoginEnabled(env);
}

export async function registerFixture(env: Env, body: Record<string, unknown>): Promise<{ ok: true }> {
  if (!fixturesEnabled(env)) throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
  assertOnlyKeys(body, ["url", "csv", "tabs"]);
  const parsed = parseSheetUrl(requireString(body.url, "url", 1, 2000));
  if (!parsed.ok) throw new ApiError(400, "INVALID_FIELD", "url 값이 올바르지 않습니다.");
  const csv = requireString(body.csv, "csv", 0, 512 * 1024);
  fixtures.set(sourceKeyOf(parsed.ref), csv);
  if (body.tabs !== undefined && parsed.ref.kind === "doc") {
    if (!Array.isArray(body.tabs)) throw new ApiError(400, "INVALID_FIELD", "tabs 값이 올바르지 않습니다.");
    tabFixtures.set(
      parsed.ref.docId,
      body.tabs.map((t) => {
        const tab = t as Record<string, unknown>;
        return { name: requireString(tab.name, "tabs.name", 1, 100), gid: requireString(tab.gid, "tabs.gid", 1, 12) };
      }),
    );
  }
  return { ok: true };
}

export type SheetFailure =
  | "private"
  | "not-found"
  | "bad-tab"
  | "too-large"
  | "not-csv"
  | "unreachable"
  | "tab-list"
  | "pub-tab";

export const SHEET_FAILURE_MESSAGES: Record<SheetFailure, string> = {
  private:
    "시트가 비공개라 읽을 수 없어요. 시트의 공유 설정을 '링크가 있는 모든 사용자(보기)'로 바꾸거나, 표를 복사해 붙여 넣어 주세요.",
  "not-found": "시트를 찾지 못했어요. 주소가 맞는지, 시트가 지워지지 않았는지 확인해 주세요.",
  "bad-tab": "주소의 탭(gid)을 이 시트에서 찾지 못했어요. 가져올 탭을 연 상태에서 주소를 다시 복사해 주세요.",
  "too-large": "시트가 너무 커요(2MB 초과). 가져올 범위만 새 탭에 복사한 뒤 그 탭의 주소를 넣어 주세요.",
  "not-csv":
    "시트를 표로 받지 못했어요. 공유 설정을 '링크가 있는 모든 사용자(보기)'로 바꾸거나, 표를 복사해 붙여 넣어 주세요.",
  unreachable: "구글 시트에서 응답을 받지 못했어요. 잠시 뒤 다시 시도하거나, 표를 복사해 붙여 넣어 주세요.",
  "tab-list":
    "시트의 탭 목록을 읽지 못했어요. 가져올 탭을 연 상태에서 주소창의 주소(끝에 gid=숫자가 있는 주소)를 복사해 붙여 넣어 주세요.",
  "pub-tab": "웹에 게시한 주소는 탭 이름으로 읽을 수 없어요. 가져올 탭을 연 상태의 주소를 붙여 넣어 주세요.",
};

function failure(kind: SheetFailure, status: 400 | 404 | 413 = 400): ApiError {
  return new ApiError(status, `SHEET_${kind.toUpperCase().replace(/-/g, "_")}`, SHEET_FAILURE_MESSAGES[kind], {
    reason: kind,
  });
}

/** Content-Disposition의 파일 이름("문서 제목 - 탭 이름.csv")에서 제목을 뽑는다. */
export function titleFromDisposition(header: string | null): string | null {
  if (!header) return null;
  let name: string | null = null;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      name = decodeURIComponent(star[1]!.trim());
    } catch {
      name = null;
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header);
    name = plain ? plain[1]! : null;
  }
  if (name === null) return null;
  const title = name.replace(/\.csv$/i, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (title === "" || title === "data") return null;
  return [...title].slice(0, 100).join("");
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > limit) throw failure("too-large", 413);
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
      throw failure("too-large", 413);
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

export interface SheetReadResult {
  csv: string;
  title: string | null;
  sourceKey: string;
  ref: SheetRef;
  /** 주소에 탭 번호가 없었을 때(또는 탭 이름으로 읽었을 때) 이 문서의 탭 목록. 못 얻으면 없다. */
  tabs?: SheetTab[];
  /** 읽은 탭(탭 목록을 얻었을 때). */
  tab?: SheetTab;
}

/** 검증된 시트 참조로 CSV를 받아 온다. 실패는 사용자 안내가 담긴 ApiError로 던진다. */
export async function fetchSheetCsv(ref: SheetRef, fetcher: Fetcher): Promise<{ csv: string; title: string | null }> {
  const { text, response } = await fetchGoogle(exportUrlOf(ref), fetcher, "text/csv");
  return { csv: text, title: titleFromDisposition(response.headers.get("Content-Disposition")) };
}

/** 문서의 탭 목록(htmlview 페이지에서). 비공개면 "private", 목록을 못 찾으면 "tab-list". */
export async function fetchTabList(ref: SheetRef, fetcher: Fetcher): Promise<SheetTab[]> {
  const url = htmlviewUrlOf(ref);
  if (url === null) throw failure("pub-tab");
  const { text } = await fetchGoogle(url, fetcher, "text/html");
  const tabs = parseTabList(text);
  if (tabs.length === 0) throw failure("tab-list");
  return tabs;
}

/**
 * 구글 문서 주소를 리디렉션을 손으로 따라가며 받는다(docs.google.com·*.googleusercontent.com의 https만, 최대 3번).
 * 받는 형식(want)이 아닌 응답은 받지 않는다. 로그인 화면으로 가는 리디렉션은 비공개로 본다.
 */
async function fetchGoogle(
  start: string,
  fetcher: Fetcher,
  want: "text/csv" | "text/html",
): Promise<{ text: string; response: Response }> {
  let url = start;
  const deadline = AbortSignal.timeout(SHEET_TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_SHEET_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        redirect: "manual",
        signal: deadline,
        headers: { Accept: want },
      });
    } catch {
      throw failure("unreachable");
    }
    const status = response.status;
    if (status !== 200) await response.body?.cancel().catch(() => undefined);
    if (status >= 300 && status < 400) {
      const location = response.headers.get("Location");
      if (!location) throw failure("unreachable");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw failure("unreachable");
      }
      if (isLoginRedirect(next)) throw failure("private");
      if (next.protocol !== "https:" || next.port !== "" || next.username !== "" || !isAllowedRedirectHost(next.hostname)) {
        // 구글 밖으로 보내는 리디렉션은 따라가지 않는다.
        throw failure("unreachable");
      }
      url = next.toString();
      continue;
    }
    if (status === 401 || status === 403) throw failure("private");
    if (status === 404) throw failure("not-found", 404);
    if (status === 400) throw failure("bad-tab");
    if (status !== 200) throw failure("unreachable");
    const type = (response.headers.get("Content-Type") ?? "").toLowerCase();
    if (!type.startsWith(want)) {
      await response.body?.cancel().catch(() => undefined);
      // 로그인 화면 HTML이 200으로 오는 경우도 비공개로 본다.
      if (want === "text/csv") throw failure(type.startsWith("text/html") ? "private" : "not-csv");
      throw failure("tab-list");
    }
    let text: string;
    try {
      text = await readLimited(response, MAX_SHEET_BYTES);
    } catch (error) {
      // 내려받는 중 시간 제한에 걸리거나 연결이 끊겼다.
      if (error instanceof ApiError) throw error;
      throw failure("unreachable");
    }
    return { text, response };
  }
  throw failure("unreachable");
}

/** POST /api/groups/:gid/sheets/read — 운영자 확인은 앞단(index.ts)에서 끝났다. */
export async function readSheet(env: Env, req: Request, body: Record<string, unknown>): Promise<SheetReadResult> {
  assertOnlyKeys(body, ["url", "tab"]);
  const parsed = parseSheetUrl(requireString(body.url, "url", 1, 2000));
  if (!parsed.ok) {
    throw new ApiError(400, "SHEET_URL_INVALID", SHEET_URL_MESSAGES[parsed.problem], { reason: parsed.problem });
  }
  const tabName = body.tab === undefined || body.tab === null ? null : requireString(body.tab, "tab", 1, 100);
  // 바깥 요청이므로 쓰기 한도와 별도로 더 좁은 한도를 건다.
  await hit(env, "sheet-ip", clientIp(req));
  const session = await readSession(env, req);
  if (session) await hit(env, "sheet-account", session.id);

  const fetcher: Fetcher = sheetHooks.fetch ?? ((url, init) => fetch(url, init));
  const testMode = fixturesEnabled(env);
  const tabList = async (): Promise<SheetTab[]> => {
    if (testMode && parsed.ref.kind === "doc" && tabFixtures.has(parsed.ref.docId)) return tabFixtures.get(parsed.ref.docId)!;
    return fetchTabList(parsed.ref, fetcher);
  };
  let ref = parsed.ref;
  let tabs: SheetTab[] | undefined;
  let tab: SheetTab | undefined;
  if (tabName !== null) {
    // 탭 이름 → gid. 이름이 없으면 엉뚱한 탭을 읽지 않고 탭 목록과 함께 알린다.
    if (ref.kind !== "doc") throw failure("pub-tab");
    tabs = await tabList();
    const found = findTab(tabs, tabName);
    if (!found) {
      throw new ApiError(400, "SHEET_TAB_NOT_FOUND", `'${tabName}' 탭을 이 시트에서 찾지 못했어요. 아래 목록에서 골라 주세요.`, {
        reason: "tab-not-found",
        tabs: tabs.map((t) => t.name),
      });
    }
    tab = found;
    ref = { ...ref, gid: found.gid };
  } else if (ref.kind === "doc" && ref.gid === null) {
    // 주소에 탭 번호가 없으면 첫 탭을 읽는다. 다른 탭을 고를 수 있게 탭 목록도 함께 준다(못 얻으면 없이).
    try {
      tabs = await tabList();
      tab = tabs[0];
    } catch {
      tabs = undefined;
    }
  }

  // 출처 열쇠: 탭 이름으로 읽었으면 찾은 gid, 아니면 주소 그대로(gid가 없으면 "first", 이전과 같다).
  const sourceKey = sourceKeyOf(ref);
  const extra = { ...(tabs ? { tabs } : {}), ...(tab ? { tab } : {}) };
  if (testMode && fixtures.has(sourceKey)) {
    return { csv: fixtures.get(sourceKey)!, title: "테스트 시트", sourceKey, ref, ...extra };
  }
  const { csv, title } = await fetchSheetCsv(ref, fetcher);
  return { csv, title, sourceKey, ref, ...extra };
}

type ImportFingerprintRow = {
  fingerprint: string;
  rowKey: string | null;
  sourceKey: string | null;
  state: string;
  matchNo: number;
};

/** 경기 하나의 지문(저장된 것 또는 내용으로 계산한 것). 지난 경기 한 건 입력은 한 경기에 두 줄이 나온다. */
export type MatchFingerprint = ImportFingerprintRow & { matchId: string };

/** 모임 시간대의 HH:MM. */
function zonedHourMinute(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: safeTimeZone(timeZone), hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

/**
 * 지문을 남기지 않은 지난 경기의 지문을 내용으로 계산한다(저장하지 않는다).
 * - 지문 없는 일괄 입력(0007 이전의 붙여 넣기, 지문을 보내지 않는 이전 화면): 붙여 넣기는 늘 한국 시간 정오에
 *   넣었으므로 한국 날짜를 날짜로, 시각은 없음으로 본다.
 * - 지난 경기 한 건 입력: 모임 시간대의 날짜만으로 한 지문과 날짜+시각(HH:MM)으로 한 지문을 함께 낸다.
 *   시트에 시각 열이 없으면 앞의 것, 있으면 뒤의 것과 견줘진다.
 * 이름은 지금 참가자 이름을 쓴다. 넣은 뒤 이름을 바꿨거나 합쳤거나 라인을 고친 경기는 맞지 않을 수 있다.
 */
async function computedFingerprints(env: Env, groupId: string): Promise<MatchFingerprint[]> {
  const group = await env.DB.prepare("SELECT timezone FROM groups WHERE id = ?1")
    .bind(groupId)
    .first<{ timezone: string }>();
  const timeZone = group?.timezone ?? "Asia/Seoul";
  const rows = await env.DB.prepare(
    `SELECT m.id AS id, m.source AS source, m.state AS state, m.match_no AS match_no, m.played_at AS played_at,
            m.winner_team AS winner_team, r.team AS team, r.position AS position, p.name AS name
     FROM matches m
     JOIN match_roster r ON r.group_id = m.group_id AND r.match_id = m.id
     JOIN participants p ON p.group_id = r.group_id AND p.id = r.participant_id
     WHERE m.group_id = ?1 AND m.import_fingerprint IS NULL
       AND m.source IN ('import', 'backfill') AND m.state IN ('confirmed', 'excluded')
       AND m.winner_team IS NOT NULL
     ORDER BY m.played_at, m.match_no`,
  )
    .bind(groupId)
    .all<{
      id: string;
      source: string;
      state: string;
      match_no: number;
      played_at: string;
      winner_team: Team;
      team: Team;
      position: Position | null;
      name: string;
    }>();
  const matches = new Map<
    string,
    { id: string; source: string; state: string; matchNo: number; playedAt: string; winner: Team; A: SheetPlayer[]; B: SheetPlayer[] }
  >();
  for (const r of rows.results) {
    let m = matches.get(r.id);
    if (!m) {
      m = { id: r.id, source: r.source, state: r.state, matchNo: r.match_no, playedAt: r.played_at, winner: r.winner_team, A: [], B: [] };
      matches.set(r.id, m);
    }
    m[r.team].push({ name: r.name, position: r.position });
  }
  const dateOnly = fingerprinter();
  const withTime = fingerprinter();
  const out: MatchFingerprint[] = [];
  for (const m of matches.values()) {
    if (m.A.length !== 5 || m.B.length !== 5) continue;
    const content = { teamA: m.A, teamB: m.B, winner: m.winner };
    const row = (fingerprint: string): MatchFingerprint => ({
      matchId: m.id,
      fingerprint,
      rowKey: null,
      sourceKey: null,
      state: m.state,
      matchNo: m.matchNo,
    });
    if (m.source === "import") {
      out.push(row(dateOnly({ ...content, date: localDate(m.playedAt, "Asia/Seoul"), time: null })));
    } else {
      const date = localDate(m.playedAt, timeZone);
      out.push(row(dateOnly({ ...content, date, time: null })));
      out.push(row(withTime({ ...content, date, time: zonedHourMinute(m.playedAt, timeZone) })));
    }
  }
  return out;
}

/**
 * 이 모임의 모든 지문: 일괄 입력으로 넣으며 저장한 지문과, 지문 없는 예전 일괄 입력·지난 경기 한 건 입력의
 * 내용으로 계산한 지문(computedFingerprints). 다시 가져오기 비교와 일괄 입력·복구의 중복 검사가 함께 쓴다.
 */
export async function groupFingerprints(env: Env, groupId: string): Promise<MatchFingerprint[]> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS id, m.import_fingerprint AS fingerprint, m.import_row_key AS row_key, b.source_key AS source_key,
            m.state AS state, m.match_no AS match_no
     FROM matches m
     LEFT JOIN import_batches b ON b.group_id = m.group_id AND b.id = m.import_batch_id
     WHERE m.group_id = ?1 AND m.import_fingerprint IS NOT NULL
     ORDER BY m.match_no`,
  )
    .bind(groupId)
    .all<{ id: string; fingerprint: string; row_key: string | null; source_key: string | null; state: string; match_no: number }>();
  return [
    ...rows.results.map((r) => ({
      matchId: r.id,
      fingerprint: r.fingerprint,
      rowKey: r.row_key,
      sourceKey: r.source_key,
      state: r.state,
      matchNo: r.match_no,
    })),
    ...(await computedFingerprints(env, groupId)),
  ];
}

/**
 * GET /api/groups/:gid/imports/fingerprints — 이 모임에 일괄 입력으로 넣은 경기의 지문.
 * 화면이 다시 가져오기에서 이미 들어간 경기와 바뀐 줄을 가려내는 데 쓴다.
 * 지문을 남기지 않은 예전 일괄 입력·지난 경기 한 건 입력도 내용으로 계산해 함께 준다(computedFingerprints).
 */
export async function listImportFingerprints(
  env: Env,
  groupId: string,
): Promise<{ imports: ImportFingerprintRow[] }> {
  return {
    imports: (await groupFingerprints(env, groupId)).map(({ matchId: _id, ...rest }) => rest),
  };
}
