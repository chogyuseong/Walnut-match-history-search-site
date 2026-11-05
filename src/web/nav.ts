/**
 * 이 창에서 지나온 화면(# 주소) 기록. "← 뒤로"가 브라우저 뒤로 가기로 갈 곳이 이 사이트 안에 있는지 알 때 쓴다.
 * 새 주소로 가면 쌓고, 바로 앞 주소로 돌아오면(뒤로 가기) 뺀다. 정확한 브라우저 기록이 아니라 추정이다.
 */
const stack: string[] = typeof location === "undefined" ? [] : [location.hash];

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const hash = location.hash;
    if (stack.length >= 2 && stack[stack.length - 2] === hash) stack.pop();
    else if (stack[stack.length - 1] !== hash) stack.push(hash);
  });
}

/** 이 사이트 안에서 돌아갈 앞 화면이 있는지. */
export function canGoBack(): boolean {
  return stack.length >= 2;
}
