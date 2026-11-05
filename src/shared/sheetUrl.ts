/**
 * 구글 시트 주소에서 문서 ID와 탭(gid)을 뽑고, 서버가 읽을 CSV 내보내기 주소를 직접 조립한다.
 *
 * 사용자가 준 주소는 절대 그대로 요청하지 않는다(SSRF 방지). 여기서 엄격한 정규식으로 ID만 뽑아
 * https://docs.google.com/... 주소를 새로 만든다.
 *
 * 받는 주소(2026-11-05 실제 요청으로 확인):
 * - 편집·보기 주소: https://docs.google.com/spreadsheets/d/{문서 ID}/edit?gid=123#gid=123
 *   → https://docs.google.com/spreadsheets/d/{문서 ID}/export?format=csv&gid=123
 *   ("링크가 있는 모든 사용자 보기" 공유가 필요하다. 비공개면 401 + HTML.)
 * - 웹에 게시한 주소: https://docs.google.com/spreadsheets/d/e/2PACX-.../pubhtml (또는 /pub?output=csv)
 *   → https://docs.google.com/spreadsheets/d/e/{게시 ID}/pub?gid=123&single=true&output=csv
 *
 * gviz(/gviz/tq?tqx=out:csv)는 쓰지 않는다: 없는 gid를 주면 오류 대신 첫 탭을 돌려줘서
 * 다른 탭을 모르고 가져올 위험이 있다(실제 요청으로 확인). export는 없는 gid에 400을 준다.
 */

export type SheetRef =
  | { kind: "doc"; docId: string; gid: string | null }
  | { kind: "pub"; pubId: string; gid: string | null };

export type SheetUrlProblem = "empty" | "not-url" | "not-google-sheet" | "bad-id" | "bad-gid";

const DOC_ID = /^[A-Za-z0-9_-]{25,100}$/;
const PUB_ID = /^2PACX-[A-Za-z0-9_-]{20,200}$/;
const GID = /^\d{1,12}$/;
const MAX_URL_LENGTH = 2000;

export const SHEET_URL_MESSAGES: Record<SheetUrlProblem, string> = {
  empty: "시트 주소를 붙여 넣어 주세요.",
  "not-url": "주소 형식이 아니에요. 브라우저 주소창의 주소를 통째로 복사해 붙여 넣어 주세요.",
  "not-google-sheet":
    "구글 시트 주소가 아니에요. https://docs.google.com/spreadsheets/d/... 로 시작하는 주소를 붙여 넣어 주세요.",
  "bad-id": "주소에서 시트 문서 ID를 찾지 못했어요. 시트를 연 상태에서 주소창의 주소를 다시 복사해 주세요.",
  "bad-gid": "주소의 탭 번호(gid)를 읽지 못했어요. 가져올 탭을 연 상태에서 주소를 다시 복사해 주세요.",
};

/** 주소의 gid: 쿼리(?gid=)와 해시(#gid=) 모두 본다. 여러 개면 해시 쪽(지금 열린 탭)을 쓴다. */
function readGid(url: URL): string | null | "bad" {
  const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("gid");
  const fromQuery = url.searchParams.get("gid");
  const gid = fromHash ?? fromQuery;
  if (gid === null || gid === "") return null;
  return GID.test(gid) ? gid : "bad";
}

export function parseSheetUrl(input: string): { ok: true; ref: SheetRef } | { ok: false; problem: SheetUrlProblem } {
  const text = input.trim();
  if (text === "") return { ok: false, problem: "empty" };
  if (text.length > MAX_URL_LENGTH || /\s/.test(text)) return { ok: false, problem: "not-url" };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, problem: "not-url" };
  }
  // 호스트는 정확히 docs.google.com, https, 사용자 정보·포트 없음.
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return { ok: false, problem: "not-google-sheet" };
  }
  const parts = url.pathname.split("/").filter((p) => p !== "");
  // /spreadsheets/d/{id}/... 또는 /spreadsheets/u/0/d/{id}/... (여러 계정으로 로그인한 경우)
  let at = 0;
  if (parts[at] !== "spreadsheets") return { ok: false, problem: "not-google-sheet" };
  at += 1;
  if (parts[at] === "u" && /^\d{1,2}$/.test(parts[at + 1] ?? "")) at += 2;
  if (parts[at] !== "d") return { ok: false, problem: "not-google-sheet" };
  at += 1;
  const gid = readGid(url);
  if (gid === "bad") return { ok: false, problem: "bad-gid" };
  if (parts[at] === "e") {
    const pubId = parts[at + 1] ?? "";
    if (!PUB_ID.test(pubId)) return { ok: false, problem: "bad-id" };
    return { ok: true, ref: { kind: "pub", pubId, gid } };
  }
  const docId = parts[at] ?? "";
  if (!DOC_ID.test(docId)) return { ok: false, problem: "bad-id" };
  return { ok: true, ref: { kind: "doc", docId, gid } };
}

/** 서버가 요청할 주소. ID는 parseSheetUrl(또는 isValidRef)로 검증한 값만 받는다. */
export function exportUrlOf(ref: SheetRef): string {
  if (!isValidRef(ref)) throw new Error("invalid sheet ref");
  if (ref.kind === "doc") {
    // gid가 없으면 export는 첫 탭을 준다.
    const gid = ref.gid === null ? "" : `&gid=${ref.gid}`;
    return `https://docs.google.com/spreadsheets/d/${ref.docId}/export?format=csv${gid}`;
  }
  const gid = ref.gid === null ? "" : `gid=${ref.gid}&single=true&`;
  return `https://docs.google.com/spreadsheets/d/e/${ref.pubId}/pub?${gid}output=csv`;
}

export function isValidRef(ref: unknown): ref is SheetRef {
  if (typeof ref !== "object" || ref === null) return false;
  const r = ref as Record<string, unknown>;
  const gidOk = r.gid === null || (typeof r.gid === "string" && GID.test(r.gid));
  if (r.kind === "doc") return typeof r.docId === "string" && DOC_ID.test(r.docId) && gidOk;
  if (r.kind === "pub") return typeof r.pubId === "string" && PUB_ID.test(r.pubId) && gidOk;
  return false;
}

/** 같은 시트·탭인지 비교하는 열쇠. 가져온 묶음의 출처와 열 맞춤 기억에 쓴다. */
export function sourceKeyOf(ref: SheetRef): string {
  return ref.kind === "doc" ? `sheet:${ref.docId}:${ref.gid ?? "first"}` : `pub:${ref.pubId}:${ref.gid ?? "first"}`;
}

/**
 * 리디렉션을 따라가도 되는 호스트: 시트 문서 주소(docs.google.com)와 내려받기 주소(*.googleusercontent.com)만.
 * 다른 구글 하위 도메인(sites.google.com, script.google.com 등)은 사용자가 내용을 올릴 수 있는 곳이라 따라가지 않는다.
 * 로그인 화면(accounts.google.com)으로 가는 리디렉션은 따라가지 않고 비공개 시트로 판정한다(isLoginRedirect, 먼저 확인).
 */
export function isAllowedRedirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "docs.google.com" || host.endsWith(".googleusercontent.com");
}

/** 로그인 화면으로 보내는 리디렉션인지(비공개 시트). */
export function isLoginRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "accounts.google.com" || /ServiceLogin|signin/i.test(url.pathname);
}

/* ------------------------------------------------------------------ */
/* 탭 이름으로 읽기                                                       */
/* ------------------------------------------------------------------ */

/**
 * 탭 목록을 얻는 주소(문서 주소만). 공개 시트의 htmlview 페이지에는 탭마다
 * `items.push({name: "탭 이름", pageUrl: "...", gid: "123", ...})`가 들어 있다(2026-11-05 실제 응답으로 확인).
 * gviz의 sheet=탭이름은 없는 이름에 오류 대신 첫 탭을 돌려줘서(실제 확인) 쓰지 않는다. 이름 → gid를 여기서 찾고
 * 내용은 늘 export?gid=로 읽으므로, 이름이 틀리면 엉뚱한 탭이 아니라 "탭을 찾지 못함"이 된다.
 */
export function htmlviewUrlOf(ref: SheetRef): string | null {
  if (!isValidRef(ref) || ref.kind !== "doc") return null;
  return `https://docs.google.com/spreadsheets/d/${ref.docId}/htmlview`;
}

export interface SheetTab {
  name: string;
  gid: string;
}

function unescapeJs(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === "n") return "\n";
    if (e === "t") return "\t";
    return e;
  });
}

/** htmlview 페이지에서 탭 목록(이름, gid)을 순서대로 뽑는다. 못 찾으면 빈 목록. */
export function parseTabList(html: string): SheetTab[] {
  const out: SheetTab[] = [];
  const seen = new Set<string>();
  const pattern = /\{name:\s*"((?:[^"\\]|\\.){0,400})",\s*pageUrl:\s*"(?:[^"\\]|\\.)*",\s*gid:\s*"(\d{1,12})"/g;
  for (const m of html.matchAll(pattern)) {
    const gid = m[2]!;
    if (seen.has(gid)) continue;
    seen.add(gid);
    out.push({ name: unescapeJs(m[1]!), gid });
  }
  return out;
}

/** 탭 이름 비교용(앞뒤 공백·유니코드 정규화·대소문자). */
export function tabNameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** 이름이 정확히(정규화 후) 같은 탭. 같은 이름이 둘 이상이면 고를 수 없으니 null. */
export function findTab(tabs: readonly SheetTab[], name: string): SheetTab | null {
  const key = tabNameKey(name);
  const hits = tabs.filter((t) => tabNameKey(t.name) === key);
  return hits.length === 1 ? hits[0]! : null;
}

/** 주소 칸에 넣은 글이 구글 시트 주소처럼 보이는지(기존 사이트 주소 칸에서 안내할 때). */
export function looksLikeSheetUrl(input: string): boolean {
  return /(^|\/\/)docs\.google\.com\/spreadsheets/i.test(input.trim());
}
