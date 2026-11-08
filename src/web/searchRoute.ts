import { useEffect, useRef } from "react";
import { go } from "./useApp";

// 검색 화면 주소(#/search?q=..., #/v/토큰/search?q=...)의 읽고 쓰기와 "/" 단축키.
// 화면(screens/Search.tsx)과 따로 둔 것은 첫 화면 묶음(App.tsx)이 주소 처리만 할 때 검색 화면 코드까지 받지 않게 하기 위해서다.
//
// 질의는 해시의 "?" 뒤(q=)에 encodeURIComponent로 넣는다. 그래서 질의 안의 "/"(예: 11/7)가 화면 경로를 나누지 않는다.
// 입력하는 동안은 history.replaceState로 지금 기록만 고치고(뒤로 가기가 글자마다 쌓이지 않게),
// 최근 검색어를 누르는 것처럼 새 검색으로 옮겨 갈 때는 기록을 하나 더 쌓는다.

/** 해시를 화면 경로와 질의로 나눈다. "#/v/t/search?q=%E3%84%B1" → { path: "/v/t/search", q: "ㄱ" }. */
export function splitHash(hash: string): { path: string; q: string } {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  if (at < 0) return { path: raw, q: "" };
  let q: string;
  try {
    q = new URLSearchParams(raw.slice(at + 1)).get("q") ?? "";
  } catch {
    q = "";
  }
  return { path: raw.slice(0, at), q };
}

/** 경로 + 질의 → 해시("#/search?q=..."). 질의가 비면 경로만. */
export function hashWithQuery(path: string, q: string): string {
  return q === "" ? `#${path}` : `#${path}?q=${encodeURIComponent(q)}`;
}

/**
 * useRoute()가 "/"로 나눈 주소에서 "?" 뒤(질의)를 떼어 낸 화면 경로. 화면 고르기는 이 값으로 한다.
 * ["v", "토큰", "search?q=a"] → ["v", "토큰", "search"].
 */
export function stripRouteQuery(route: readonly string[]): string[] {
  const joined = route.join("/");
  const at = joined.indexOf("?");
  if (at < 0) return [...route];
  return joined
    .slice(0, at)
    .split("/")
    .filter((part) => part !== "");
}

/** 지금 주소가 검색 화면인지(경로의 마지막 조각이 "search"). */
function onSearchPath(path: string): boolean {
  const parts = path.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] === "search";
}

/** 지금 주소의 질의. */
export function readHashQuery(): string {
  return splitHash(location.hash).q;
}

/** 입력 중: 기록을 쌓지 않고 지금 주소의 질의만 바꾼다. 검색 화면이 아니면 아무것도 하지 않는다. */
export function replaceHashQuery(q: string): void {
  const { path, q: current } = splitHash(location.hash);
  if (!onSearchPath(path) || current === q) return;
  try {
    history.replaceState(history.state, "", hashWithQuery(path, q));
  } catch {
    // 주소를 고치지 못해도 검색은 된다.
  }
}

/** 새 검색으로 옮겨 간다(뒤로 가기로 앞 검색에 돌아올 수 있게 기록을 하나 쌓는다). */
export function pushHashQuery(q: string): void {
  const { path, q: current } = splitHash(location.hash);
  if (!onSearchPath(path) || current === q) return;
  location.hash = hashWithQuery(path, q).slice(1);
}

/** "/"를 눌렀을 때 갈 검색 화면 경로. 참가 신청 화면처럼 검색이 없는 곳은 null. */
export function searchPathFor(route: readonly string[]): string | null {
  const [page, id] = route;
  if (page === "join") return null;
  if (page === "v" && id) return `/v/${id}/search`;
  if (page === "mine" && id) return `/mine/${id}/search`;
  if (page === "demo") return "/demo/search";
  return "/search";
}

/** 검색 입력 칸에 초점을 달라는 요청. 검색 화면이 늦게 그려져도(화면 코드·기록을 받는 중) 받아 갈 수 있게 남겨 둔다. */
export const SEARCH_FOCUS_EVENT = "naejeon:search-focus";
let focusRequestedAt = 0;
/** 요청이 이보다 오래되면 버린다(검색 화면이 끝내 열리지 않은 경우 나중에 엉뚱하게 초점이 가지 않게). */
const FOCUS_REQUEST_TTL = 10_000;

export function requestSearchFocus(): void {
  focusRequestedAt = Date.now();
  window.dispatchEvent(new Event(SEARCH_FOCUS_EVENT));
}

/** 남아 있는 초점 요청을 받아 간다(한 번만 true). */
export function takeSearchFocus(): boolean {
  const pending = focusRequestedAt > 0 && Date.now() - focusRequestedAt < FOCUS_REQUEST_TTL;
  focusRequestedAt = 0;
  return pending;
}

/** 글을 넣는 요소(입력 칸·선택·편집 영역)에 초점이 있는지. */
function typingInto(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

/**
 * 단축키 "/": 입력 요소에 초점이 없을 때 누르면 검색 화면으로 가서 입력 칸에 초점을 준다.
 * 창(대화 상자)이 열려 있거나 수정 키(Ctrl·Alt·Meta)를 함께 누르면 무시한다. App에서 한 번만 건다.
 */
export function useSearchShortcut(route: readonly string[]): void {
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.defaultPrevented) return;
      if (typingInto(event.target) || typingInto(document.activeElement)) return;
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      const target = searchPathFor(routeRef.current);
      if (!target) return;
      // "/"가 브라우저의 빠른 찾기를 열거나 초점을 받은 입력 칸에 찍히지 않게 한다.
      event.preventDefault();
      requestSearchFocus();
      const current = stripRouteQuery(routeRef.current);
      if (`/${current.join("/")}` !== target) go(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
