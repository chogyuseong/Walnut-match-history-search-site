import { useEffect, useState } from "react";
import type { Scope } from "../shared/stats";
import type { Snapshot } from "../shared/types";
import { arrivedByBack, noteReplacedHash } from "./nav";

// 화면 주소의 "?" 뒤 조건(기록 화면 거르기, 개인 통계·비교 기간)을 읽고 쓴다.
// 경기 상세에 갔다가 뒤로 와도 고른 조건이 남고, 주소를 그대로 보내면 같은 목록이 열리게 하려는 것이다.
// 검색 화면의 질의(q=)는 searchRoute.ts가 따로 맡는다(첫 화면 묶음이 검색 단축키 때문에 그쪽을 먼저 받는다).
//
// 쓰는 곳: 기록 화면(screens/Records.tsx, 조건 표는 그 파일의 "보기 조건 ↔ 주소"), 개인 통계·두 사람 비교(useRouteScope),
// 개인 통계 → 비교·검색 → 기록으로 갈 때 주소를 만드는 App.tsx·screens/Viewer.tsx(scopeSuffix).
//
// 조건을 바꿀 때는 history.replaceState로 지금 기록만 고친다. 고를 때마다 기록을 쌓으면 "뒤로"가 조건을 하나씩 되돌리느라
// 앞 화면으로 돌아가지 못한다. replaceState는 hashchange를 내지 않으므로 nav.ts의 지나온 주소 기록도 같이 고친다.
//
// 화면 고르기는 "?" 앞만 본다(App.tsx가 stripRouteQuery로 떼어 낸다). 그래서 조건을 더해도 어느 화면인지는 그대로이고,
// nav.ts의 screenKey도 "?" 뒤를 버리므로 조건만 바뀐 것은 다른 화면으로 가지 않은 것으로 본다(스크롤을 올리지 않는다).
//
// 새 화면에 조건을 남기려면: 처음 그릴 때 readRouteParams()로 읽어 상태를 만들고, 상태가 바뀔 때마다(useEffect)
// replaceRouteParams()로 전부 다시 적는다. 받은 값은 늘 검사한다(주소는 사람이 손으로 고치거나 오래된 링크일 수 있다).

/** 지금 주소의 "?" 뒤 조건. */
export function readRouteParams(): URLSearchParams {
  const at = location.hash.indexOf("?");
  return new URLSearchParams(at < 0 ? "" : location.hash.slice(at + 1));
}

/** 경로 + 조건 → "#/…?…". 조건이 비면 경로만. */
export function hashWith(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query === "" ? `#${path}` : `#${path}?${query}`;
}

/**
 * 지금 주소의 경로는 두고 조건만 바꾼다(기록은 쌓지 않는다).
 * 주의: 조건을 통째로 바꾼다. 화면이 남기는 조건은 매번 전부 넘겨야 하고, 빠뜨린 이름은 주소에서 사라진다.
 * 화면이 이미 다른 주소로 떠난 뒤에 부르면 그 주소의 조건을 덮어쓰므로, 화면이 떠 있는 동안(효과 안)에서만 부른다.
 */
export function replaceRouteParams(params: URLSearchParams): void {
  const at = location.hash.indexOf("?");
  const path = (at < 0 ? location.hash : location.hash.slice(0, at)).replace(/^#/, "");
  const next = hashWith(path, params);
  if (next === location.hash) return;
  try {
    history.replaceState(history.state, "", next);
    noteReplacedHash(next);
  } catch {
    // 주소를 고치지 못해도 화면은 그대로 쓸 수 있다(뒤로 올 때 조건만 처음으로 돌아간다).
  }
}

/**
 * 범위 → 주소 값. "all"·"today"·"season.시즌ID"·"year.2026".
 * 시즌 요약 주소(seasonRoute.ts)의 "year/2026"과 달리 "/"를 쓰지 않는다: 주소 조건 안의 "/"는 화면 경로로 오해받기 쉽다.
 */
export function scopeParam(scope: Scope): string {
  if (scope.kind === "season") return `season.${scope.seasonId}`;
  if (scope.kind === "year") return `year.${scope.year}`;
  return scope.kind;
}

/** 주소 값 → 범위. 지워진 시즌, 모르는 값은 null(화면 기본값을 쓴다). */
export function scopeFromParam(value: string | null, snapshot: Snapshot): Scope | null {
  if (value === "all" || value === "today") return { kind: value };
  if (value?.startsWith("season.")) {
    const seasonId = value.slice("season.".length);
    return snapshot.seasons.some((s) => s.id === seasonId) ? { kind: "season", seasonId } : null;
  }
  if (value?.startsWith("year.")) {
    const year = value.slice("year.".length);
    return /^\d{4}$/.test(year) ? { kind: "year", year: Number(year) } : null;
  }
  return null;
}

/**
 * 다른 화면으로 갈 때 기간을 이어 주는 주소 꼬리("?scope=…"). 전체 기간이면 붙이지 않는다(받는 화면의 기본값이 전체라서).
 * 받는 화면이 useRouteScope를 써야 이어진다. 기록 화면은 기본값이 달라("오늘"일 수 있다) 이 꼬리 대신 scope를 직접 적는다.
 */
export function scopeSuffix(scope: Scope | undefined): string {
  return scope && scope.kind !== "all" ? `?scope=${encodeURIComponent(scopeParam(scope))}` : "";
}

/**
 * 주소의 scope=로 시작하고, 고른 기간을 다시 주소에 적는 기간 상태(개인 통계·두 사람 비교).
 * screenId: 같은 화면 부품이 남은 채 사람만 바뀌면(개인 통계 → 다른 사람) 새 주소에도 기간을 다시 적으려고 받는다.
 * 주의: 주소 조건을 통째로 scope 하나로 바꾼다. 이 화면들에 다른 조건을 더하면 여기서 함께 적어야 한다.
 * 지워진 시즌을 가리키는 주소로 열면 전체 기간으로 연다(scopeFromParam이 null을 준다).
 */
export function useRouteScope(snapshot: Snapshot, screenId: string): [Scope, (scope: Scope) => void] {
  const [scope, setScope] = useState<Scope>(
    () => scopeFromParam(readRouteParams().get("scope"), snapshot) ?? { kind: "all" },
  );
  useEffect(() => {
    replaceRouteParams(new URLSearchParams(scope.kind === "all" ? {} : { scope: scopeParam(scope) }));
  }, [scope, screenId]);
  return [scope, setScope];
}

/**
 * 주소별 마지막 스크롤 위치. 열쇠는 "?" 뒤 조건까지 포함한 주소 전체라, 같은 기록 화면이라도 조건이 다르면 따로 기억한다.
 * 이 창 메모리에만 둔다(새로 고치면 사라진다). 새로 고친 뒤에는 브라우저 자체 복원에 맡긴다.
 * nav.ts가 아니라 여기에 둔 것은 nav.ts가 첫 화면 묶음에 들어가기 때문이다(check:bundle 예산 17KB, 이 파일은 지연 로딩).
 */
const scrollByHash = new Map<string, number>();

/**
 * 뒤로 가기로 이 화면에 돌아오면 떠날 때의 스크롤 위치로 되돌린다. 기록 화면처럼 "더 보기"로 길어지는 목록에 쓴다.
 * 브라우저도 위치를 되돌리지만, 그 순간에는 앞 화면(경기 상세 등)이 그려져 있어 페이지 길이가 짧아 끝까지 못 간다.
 * 주의:
 * - 목록 길이(더 보기 개수)도 주소에 남겨 두어야 같은 위치가 같은 경기를 가리킨다(Records.tsx의 n=).
 * - 뒤로 가기 판단은 nav.ts(arrivedByBack)가 한다. nav.ts의 hashchange 처리가 화면보다 먼저 돌아야 맞는다.
 * - 화면이 처음 그려질 때 한 번만 맞춘다. 스냅숏을 다시 받는 중이라 목록이 늦게 그려지는 경우까지 기다리지는 않는다.
 */
export function useScrollMemory(): void {
  useEffect(() => {
    if (arrivedByBack()) {
      const saved = scrollByHash.get(location.hash);
      // 이번 화면이 다 그려진 다음 프레임에 맞춘다.
      if (saved !== undefined) requestAnimationFrame(() => window.scrollTo(0, saved));
    }
    // 떠나는 순간(다음 화면이 scrollTo(0, 0)으로 올린 것)의 스크롤도 들어오지만, 그때는 주소가 이미 다음 화면이라
    // 그 화면 몫으로 적힌다. 이 화면의 위치는 덮이지 않는다.
    const remember = () => scrollByHash.set(location.hash, window.scrollY);
    window.addEventListener("scroll", remember, { passive: true });
    return () => window.removeEventListener("scroll", remember);
  }, []);
}
