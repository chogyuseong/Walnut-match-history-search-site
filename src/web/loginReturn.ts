/**
 * 로그인 뒤 돌아갈 화면(검토 L8).
 *
 * 돌아갈 # 주소를 로그인 시작 주소의 쿼리(?return=#/v/<조회 토큰>)로 보내면 토큰이 서버 접근 로그에 남는다.
 * 그래서 주소는 이 탭의 기기 저장소(sessionStorage)에 두고, 서버에는 고정 값 "#/login-return"만 보낸다.
 * 서버는 로그인이 끝나면 /#/login-return 으로 보내고, 화면은 처음 그리기 전에 저장해 둔 주소로 바꾼다.
 * 제공자(카카오·Google)로 갔다 오는 동안 같은 탭이라 sessionStorage가 남아 있다.
 */
const KEY = "naejeon.loginReturn";
export const LOGIN_RETURN_HASH = "#/login-return";

/** 로그인 시작 직전에 지금 화면을 기억한다. */
export function rememberLoginReturn(hash: string): void {
  try {
    sessionStorage.setItem(KEY, hash);
  } catch {
    // 저장소를 못 쓰면 로그인 뒤 첫 화면으로 간다.
  }
}

/** 로그인 시작 주소. reauth면 되돌리기 어려운 작업 전 다시 로그인(서버가 카카오에 prompt=login을 붙인다). */
export function loginStartUrl(provider: "kakao" | "google", reauth = false): string {
  return `/api/auth/${provider}/start?return=${encodeURIComponent(LOGIN_RETURN_HASH)}${reauth ? "&reauth=1" : ""}`;
}

/** 로그인 버튼을 누르는 순간 지금 화면을 기억한다(화면을 그릴 때가 아니라 누를 때의 주소). */
export function rememberCurrentScreen(): void {
  const hash = location.hash;
  rememberLoginReturn(hash.startsWith("#/") && !hash.startsWith("#/login") ? hash : "#/");
}

/** 기억해 둔 화면으로 주소를 바꾼다(기록을 남기지 않음). "#/login-return"일 때만 동작한다. */
export function resolveLoginReturn(): void {
  if (typeof location === "undefined" || location.hash !== LOGIN_RETURN_HASH) return;
  let saved: string | null;
  try {
    saved = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    saved = null;
  }
  const target =
    saved && /^#\/[^\s]{0,500}$/.test(saved) && !saved.startsWith("#/login") ? saved : "#/";
  history.replaceState(null, "", `${location.pathname}${location.search}${target}`);
}

// 이 모듈은 main.tsx가 가장 먼저 불러온다: 화면 모듈(nav.ts의 기록 등)이 주소를 읽기 전에 바꾼다.
resolveLoginReturn();
