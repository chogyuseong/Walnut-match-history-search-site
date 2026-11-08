/**
 * 배포 뒤 옛 탭의 지연 로딩 실패를 새로 고침 한 번으로 복구한다.
 *
 * 왜 생기나: 화면 조각 파일 이름에는 내용 해시가 붙는다(/assets/Graphs-HASH.js). 새로 배포하면 옛 조각이 사라지는데,
 * 배포 전에 열어 둔 탭은 옛 index.html이 알려 준 옛 이름으로 조각을 요청한다. 정적 자산 설정이
 * not_found_handling: "single-page-application"(wrangler.jsonc)이라 없는 파일 요청에 index.html(200, text/html)이
 * 오고, 브라우저는 그것을 JS 모듈로 읽지 못해 import()가 실패한다.
 *
 * 처리: import()가 실패하면 이 탭 세션에서 아직 새로 고치지 않았을 때만 location.reload()를 한 번 한다(새 index.html이
 * 새 조각 이름을 알려 준다). 이미 한 번 했으면(새로 고친 뒤에도 실패 = 진짜 오류) 원래 오류를 그대로 던져
 * 오류 경계(ErrorBoundary, errorReport.tsx)가 "문제가 생겼어요" 화면을 보여 주게 한다.
 * 오프라인이면 새로 고쳐도 브라우저 오류 화면만 나오므로 새로 고치지 않는다.
 */

/** 이 탭 세션에서 조각 실패로 새로 고친 적이 있는지 적어 두는 sessionStorage 키. */
export const CHUNK_RELOAD_KEY = "naejeon:chunk-reload";

let reloading = false;

/** 조각 실패로 새로 고치는 중인지(새로 고침이 끝날 때까지 화면을 대체 화면으로 둔다). */
export function isReloadingForChunk(): boolean {
  return reloading;
}

/**
 * 조각을 받지 못해 생긴 오류 메시지인지. 오류 수집에서 거르는 데 쓴다(errorReport.tsx).
 * 배포 직후 옛 탭이나 순간적인 네트워크 끊김에서 나며, 코드로 고칠 수 있는 오류가 아니다.
 * - Chrome·Edge: "Failed to fetch dynamically imported module: …"
 * - Firefox: "error loading dynamically imported module: …"
 * - Safari: "Importing a module script failed."
 * - 브라우저 콘솔류: "Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type …"
 * - Vite 미리 받기: "Unable to preload CSS for …"
 */
export function isModuleLoadError(message: string): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Failed to load module script|Expected a JavaScript(?:-or-Wasm)? module script|Unable to preload CSS/i.test(
    message,
  );
}

/**
 * 이 세션에서 처음이면 새로 고침을 시작하고 true. 이미 한 번 했거나, 오프라인이거나, 저장소를 못 쓰면(표시를 남길 수 없어
 * 새로 고침이 되풀이될 수 있음) false.
 */
export function reloadOnceForChunk(): boolean {
  if (reloading) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  reloading = true;
  location.reload();
  return true;
}

/** 끝나지 않는 약속. 새로 고치는 동안 지연 로딩 화면을 대체 화면("불러오는 중…")에 머물게 한다. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/**
 * import()를 감싼다. 실패하면 한 번 새로 고치고(그동안 끝나지 않음), 이미 새로 고쳤으면 원래 오류를 던진다.
 * Vite의 vite:preloadError를 취소한 경우(아래) import()가 undefined로 끝나므로 그때도 새로 고침을 기다린다.
 */
export async function importWithReload<M>(load: () => Promise<M>): Promise<M> {
  let m: M;
  try {
    m = await load();
  } catch (error) {
    if (reloadOnceForChunk()) return never<M>();
    throw error;
  }
  if (reloading) return never<M>();
  return m;
}

let installed = false;

/**
 * Vite가 조각의 의존 파일(JS·CSS)을 미리 받다 실패하면 window에 "vite:preloadError"를 낸다. 취소하지 않으면 그 오류가
 * import()의 실패가 된다. 새로 고침을 시작했으면 취소하고, 이미 한 번 했으면 그대로 두어 오류 경계로 넘긴다.
 */
export function installChunkReload(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnceForChunk()) event.preventDefault();
  });
}
