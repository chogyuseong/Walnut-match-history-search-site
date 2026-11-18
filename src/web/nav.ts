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

/**
 * 마지막 주소 바뀜이 뒤로 가기였는지. 화면이 그려질 때 기억해 둔 스크롤 위치로 돌아갈지 정한다(routeQuery.ts useScrollMemory).
 * 이 파일의 hashchange 처리는 모듈을 읽을 때 걸려 화면(useRoute)의 처리보다 먼저 돈다. 그래서 새 화면이 그려질 때는
 * 이미 이번 이동이 뒤로 가기였는지 정해져 있다. 이 순서가 바뀌면(이 처리를 효과 안으로 옮기는 등) 복원이 엇나간다.
 */
let cameBack = false;

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", (event) => {
    const hash = location.hash;
    if (stack.length >= 2 && stack[stack.length - 2] === hash) {
      // 뒤로 가기: 브라우저가 맞추는 위치를 그대로 둔다(기억해 둔 위치가 있는 화면은 routeQuery.ts useScrollMemory가 다시 맞춘다).
      stack.pop();
      cameBack = true;
      return;
    }
    cameBack = false;
    if (stack[stack.length - 1] !== hash) stack.push(hash);
    const before = new URL(event.oldURL).hash;
    if (screenKey(before) !== screenKey(hash)) window.scrollTo(0, 0);
  });
}

/** 이 사이트 안에서 돌아갈 앞 화면이 있는지. */
export function canGoBack(): boolean {
  return stack.length >= 2;
}

/**
 * history.replaceState로 지금 주소를 고쳤을 때(화면 안 조건을 주소에 넣을 때) 지나온 주소 기록의 맨 끝도 맞춘다.
 * 고치지 않으면 뒤로 왔을 때 주소가 기록과 달라 새 화면으로 간 것으로 보고 맨 위로 올려 버린다.
 */
export function noteReplacedHash(hash: string): void {
  if (stack.length > 0) stack[stack.length - 1] = hash;
}

/** 마지막 주소 바뀜이 뒤로 가기였는지. 기록 화면의 스크롤 복원(routeQuery.ts useScrollMemory)이 쓴다. */
export function arrivedByBack(): boolean {
  return cameBack;
}
