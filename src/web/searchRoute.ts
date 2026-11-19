import { useEffect, useRef } from "react";
import { go } from "./useApp";

// 첫 화면 묶음(App.tsx)이 쓰는 검색 주소 처리: 주소에서 질의 떼기와 "/" 단축키.
// 질의·펼친 수를 읽고 쓰는 것은 검색 화면만 쓰므로 searchHash.ts에 따로 두었다. 첫 화면 예산(check:bundle 17KB)이 빠듯해
// 검색 화면 전용 코드를 여기에 더하면 예산을 넘는다.

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
      if (document.querySelector("dialog[open]")) return;
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
