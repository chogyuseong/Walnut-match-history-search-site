/**
 * 이 창에서 지나온 화면(# 주소) 기록. "← 뒤로"가 브라우저 뒤로 가기로 갈 곳이 이 사이트 안에 있는지 알 때 쓴다.
 * 새 주소로 가면 쌓고, 바로 앞 주소로 돌아오면(뒤로 가기) 뺀다. 정확한 브라우저 기록이 아니라 추정이다.
 */
const stack: string[] = typeof location === "undefined" ? [] : [location.hash];

/**
 * 주소에서 "어느 화면인지"만 뽑은 값. 이 값이 바뀌면 다른 화면으로 간 것으로 보고 스크롤을 맨 위로 올린다.
 * 조회(#/v/토큰/…)·참가 신청(#/join/토큰/…)·참가 중인 모임(#/mine/모임/…)·예시(#/demo/…)는 앞 조각이 공통이라
 * 그 뒤 조각을 화면으로 본다. 개인 통계(p)·경기(m)는 사람·경기가 바뀌면 다른 화면이다.
 * 같은 화면 안의 범위·탭(#/season/2026, #/priority/avoid 등)은 같은 값이라 스크롤을 그대로 둔다.
 */
export function screenKey(hash: string): string {
  const parts = hash
    .replace(/^#\/?/, "")
    .replace(/\?.*$/, "")
    .split("/")
    .filter((part) => part !== "");
  let rest = parts;
  let prefix = "";
  if ((parts[0] === "v" || parts[0] === "join" || parts[0] === "mine") && parts.length >= 2) {
    prefix = `${parts[0]}/${parts[1]}/`;
    rest = parts.slice(2);
  } else if (parts[0] === "demo") {
    prefix = "demo/";
    rest = parts.slice(1);
  }
  const page = rest[0] ?? "";
  const withId = page === "p" || page === "m" ? `${page}/${rest[1] ?? ""}` : page;
  return prefix + withId;
}

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", (event) => {
    const hash = location.hash;
    if (stack.length >= 2 && stack[stack.length - 2] === hash) {
      // 뒤로 가기: 브라우저가 맞추는 위치를 그대로 둔다.
      stack.pop();
      return;
    }
    if (stack[stack.length - 1] !== hash) stack.push(hash);
    const before = new URL(event.oldURL).hash;
    if (screenKey(before) !== screenKey(hash)) window.scrollTo(0, 0);
  });
}

/** 이 사이트 안에서 돌아갈 앞 화면이 있는지. */
export function canGoBack(): boolean {
  return stack.length >= 2;
}
