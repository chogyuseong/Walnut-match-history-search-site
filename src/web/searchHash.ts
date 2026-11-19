import { noteReplacedHash } from "./nav";

// 검색 화면 주소(#/search?q=...&n=40, #/v/토큰/search?q=...)의 읽고 쓰기. 전적 검색(screens/Search.tsx)만 쓴다.
// "/" 단축키와 주소에서 질의를 떼는 것은 첫 화면이 쓰므로 searchRoute.ts에 있다. 이 파일을 거기로 합치면 첫 화면 예산을 넘는다.
//
// 질의는 해시의 "?" 뒤(q=)에 encodeURIComponent로 넣는다. 그래서 질의 안의 "/"(예: 11/7)가 화면 경로를 나누지 않는다.
// 입력하는 동안·더 보기는 history.replaceState로 지금 기록만 고치고(뒤로 가기가 글자마다 쌓이지 않게),
// 최근 검색어를 누르는 것처럼 새 검색으로 옮겨 갈 때는 기록을 하나 더 쌓는다.

/**
 * 해시를 화면 경로·질의·펼친 경기 수로 나눈다. "#/v/t/search?q=%E3%84%B1&n=40" → { path: "/v/t/search", q: "ㄱ", shown: 40 }.
 * shown은 경기 결과를 "더 보기"로 펼친 수다. 없거나 숫자가 아니면 0(펼치지 않음).
 */
function splitHash(hash: string): { path: string; q: string; shown: number } {
  const raw = hash.replace(/^#/, "");
  const at = raw.indexOf("?");
  if (at < 0) return { path: raw, q: "", shown: 0 };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw.slice(at + 1));
  } catch {
    return { path: raw.slice(0, at), q: "", shown: 0 };
  }
  const shown = Number(params.get("n"));
  return {
    path: raw.slice(0, at),
    q: params.get("q") ?? "",
    shown: Number.isInteger(shown) && shown > 0 ? shown : 0,
  };
}

/**
 * 경로 + 질의 (+ 펼친 수) → 해시("#/search?q=...&n=40"). 질의가 비면 경로만.
 * 펼친 수는 질의에 딸린 값이라 질의 없이 적지 않는다(빈 검색 화면에는 경기 목록이 없다).
 */
function hashWithQuery(path: string, q: string, shown = 0): string {
  if (q === "") return `#${path}`;
  return `#${path}?q=${encodeURIComponent(q)}${shown > 0 ? `&n=${shown}` : ""}`;
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

/** 지금 주소에 적힌 펼친 경기 수(0 = 펼치지 않음). 경기 상세에 다녀와도 같은 길이의 목록을 다시 그리는 데 쓴다. */
export function readHashShown(): number {
  return splitHash(location.hash).shown;
}

/**
 * 입력 중·더 보기: 기록을 쌓지 않고 지금 주소의 질의와 펼친 수만 바꾼다. 검색 화면이 아니면 아무것도 하지 않는다.
 * shown은 기본 쪽(20경기)보다 더 펼쳤을 때만 넘긴다. 0이면 주소에서 뺀다.
 */
export function replaceHashQuery(q: string, shown = 0): void {
  const { path, q: current, shown: currentShown } = splitHash(location.hash);
  if (!onSearchPath(path) || (current === q && currentShown === shown)) return;
  try {
    const next = hashWithQuery(path, q, shown);
    history.replaceState(history.state, "", next);
    // 지나온 주소 기록도 맞춘다. 안 맞추면 경기 상세에서 뒤로 왔을 때 새 화면으로 여겨 스크롤·초점 복원이 건너뛰어진다.
    noteReplacedHash(next);
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
