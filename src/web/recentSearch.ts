import { normalizeForSearch } from "../shared/search";

// 전적 검색의 최근 검색어. 이 기기(localStorage)에만, 모임마다 따로 둔다. 저장이 막혀 있어도(사생활 보호 창 등) 검색은 된다.

/** 남기는 최근 검색어 수. */
export const RECENT_SEARCH_LIMIT = 8;
/** 한 검색어의 최대 길이(이보다 길면 남기지 않는다). */
const MAX_QUERY_LENGTH = 50;

export function recentSearchKey(groupId: string): string {
  return `naejeon.recentSearch.${groupId}`;
}

/** 목록 맨 앞에 넣는다. 정규화해서 같은 검색어는 하나만 남기고, 최대 limit개. */
export function addRecentSearch(list: readonly string[], query: string, limit = RECENT_SEARCH_LIMIT): string[] {
  const q = query.trim();
  if (q === "" || q.length > MAX_QUERY_LENGTH || normalizeForSearch(q) === "") return [...list];
  const key = normalizeForSearch(q);
  return [q, ...list.filter((item) => normalizeForSearch(item) !== key)].slice(0, limit);
}

export function loadRecentSearches(groupId: string): string[] {
  try {
    const raw = localStorage.getItem(recentSearchKey(groupId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, RECENT_SEARCH_LIMIT);
  } catch {
    return [];
  }
}

export function saveRecentSearches(groupId: string, list: readonly string[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(recentSearchKey(groupId));
    else localStorage.setItem(recentSearchKey(groupId), JSON.stringify(list));
  } catch {
    // 저장하지 못하면 이번 방문에만 남는다.
  }
}
