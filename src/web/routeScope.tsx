// 범위(오늘·시즌·연도·전체) 고르기, 그 범위를 화면 주소에 적고 읽는 함수, 범위 아래의 기준 줄(ScopeBasis).
// 기록·개인 통계·두 사람 비교·그래프·랭킹·검색이 쓴다.
import { useEffect, useState } from "react";
import { noteReplacedHash } from "./nav";
import { isCounted, matchesInScope, matchYears, scopeLabel, type Scope } from "../shared/stats";
import type { MatchView, Snapshot } from "../shared/types";

/**
 * 범위 고르기: 오늘 · 시즌 · 연도 · 전체. 기록·개인 통계가 함께 쓴다(그래프는 같은 값을 목록으로 고른다).
 * 연도는 경기가 있는 해만, 모임 시간대 기준으로 나온다.
 */
export function ScopePicker(props: {
  snapshot: Snapshot;
  scope: Scope;
  onChange: (scope: Scope) => void;
}) {
  const { snapshot, scope, onChange } = props;
  const years = matchYears(snapshot);
  return (
    <div className="segmented scope-picker" role="group" aria-label="범위">
      <button
        type="button"
        aria-pressed={scope.kind === "today"}
        onClick={() => onChange({ kind: "today" })}
      >
        오늘
      </button>
      {snapshot.seasons.length > 0 && (
        <select
          aria-label="시즌 선택"
          className={scope.kind === "season" ? "chosen" : undefined}
          value={scope.kind === "season" ? scope.seasonId : ""}
          onChange={(e) => {
            if (e.target.value !== "") onChange({ kind: "season", seasonId: e.target.value });
          }}
        >
          <option value="">시즌</option>
          {snapshot.seasons.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {years.length > 0 && (
        <select
          aria-label="연도 선택"
          className={scope.kind === "year" ? "chosen" : undefined}
          value={scope.kind === "year" ? String(scope.year) : ""}
          onChange={(e) => {
            if (e.target.value !== "") onChange({ kind: "year", year: Number(e.target.value) });
          }}
        >
          <option value="">연도</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}년
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        aria-pressed={scope.kind === "all"}
        onClick={() => onChange({ kind: "all" })}
      >
        전체
      </button>
    </div>
  );
}

/* ---------- 주소의 보기 조건 ---------- */
// 화면 주소의 "?" 뒤 조건(기록 화면 거르기, 개인 통계·비교 기간)을 읽고 쓴다.
// 경기 상세에 갔다가 뒤로 와도 고른 조건이 남고, 주소를 그대로 보내면 같은 목록이 열리게 하려는 것이다.
// 검색 화면의 질의(q=)는 searchRoute.ts가 따로 맡는다(첫 화면 묶음이 검색 단축키 때문에 그쪽을 먼저 받는다).
//
// 쓰는 곳: 기록 화면(screens/Records.tsx, 조건 표는 screens/recordsView.tsx "보기 조건 ↔ 주소"), 개인 통계·두 사람 비교·그래프(useRouteScope),
// 기록·그래프 → 개인 통계, 개인 통계 → 비교로 갈 때 기간을 잇는 주소 꼬리(scopeSuffix).
// 예전에는 routeQuery.ts 한 파일이었다. 그래프 화면까지 쓰게 되자 따로 둔 파일이 화면 조각 하나로 늘어 첫 화면의
// 주소 미리 받기 목록이 커져서(check:bundle 예산 17KB) screenKit.tsx 안으로 옮겼었다. 지금은 파일만 따로 두고
// vite.config.ts의 screenKit 묶음 설정으로 같은 조각에 넣는다.
// 기록 화면의 뒤로 가기 스크롤 복원은 scrollMemory.ts.
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
 * 주의: 주소 조건을 통째로 scope와 extra로 바꾼다. 화면이 남기려는 다른 조건은 extra로 넘겨야 사라지지 않는다
 * (두 사람 비교의 회차 session=).
 * 지워진 시즌을 가리키는 주소로 열면 전체 기간으로 연다(scopeFromParam이 null을 준다).
 */
export function useRouteScope(
  snapshot: Snapshot,
  screenId: string,
  extra: Record<string, string> = {},
): [Scope, (scope: Scope) => void] {
  const [scope, setScope] = useState<Scope>(
    () => scopeFromParam(readRouteParams().get("scope"), snapshot) ?? { kind: "all" },
  );
  const extraQuery = new URLSearchParams(extra).toString();
  useEffect(() => {
    const params = new URLSearchParams(extraQuery);
    if (scope.kind !== "all") params.set("scope", scopeParam(scope));
    replaceRouteParams(params);
  }, [scope, screenId, extraQuery]);
  return [scope, setScope];
}

/** 그래프의 범위 목록이 쓰는 값. "all" · "today" · "season:ID" · "year:2026". */
export function scopeValue(scope: Scope): string {
  if (scope.kind === "season") return `season:${scope.seasonId}`;
  if (scope.kind === "year") return `year:${scope.year}`;
  return scope.kind;
}

export function scopeFromValue(value: string): Scope {
  if (value.startsWith("season:")) return { kind: "season", seasonId: value.slice(7) };
  if (value.startsWith("year:")) return { kind: "year", year: Number(value.slice(5)) };
  return value === "today" ? { kind: "today" } : { kind: "all" };
}

/**
 * 기준 줄: 이 화면의 숫자가 어떤 경기로 센 것인지. 기록·개인 통계·비교·그래프·랭킹·검색이 범위 고르기 바로 아래
 * (범위가 없는 화면은 화면 머리 바로 아래) 같은 자리·같은 말로 둔다. 화면을 옮겨 다닐 때 승률·경기 수가 달라지는
 * 까닭(범위가 다름, MMR은 누적, 결과 미입력·제외는 안 셈)을 한곳에서 읽게 하려는 것이라, 화면마다 문구를 따로 만들지 않는다.
 *
 * 1줄: "오늘|시즌 이름|2026년|전체 누적 · (참여) 확정 N경기". 2줄: 누적 값 안내와 세지 않은 경기.
 * matches를 주면 그 경기로 센다(개인 통계는 그 사람이 뛴 경기). 비우면 범위 안 모임 경기 전체다.
 * 세는 규칙은 stats.ts isCounted(확정 + 승리 팀 있음)와 같아야 한다. 규칙을 바꾸면 여기 숫자도 따라 바뀐다.
 */
/** 범위를 고를 수 없는 화면(랭킹·검색)의 기준 줄 범위: 모임 전체 누적. */
export const ALL_TIME_SCOPE: Scope = { kind: "all" };

export function ScopeBasis(props: {
  snapshot: Snapshot;
  /** 범위를 고를 수 없는 화면(랭킹·검색)은 { kind: "all" }. */
  scope: Scope;
  matches?: readonly MatchView[];
  /** 개인 통계처럼 "그 사람이 뛴" 경기를 셀 때 "참여". */
  countPrefix?: string;
  /** 경기 수를 빼고 규칙만 쓴다(비교: 두 사람의 경기 수가 달라 한 숫자로 못 쓴다). */
  noCount?: boolean;
}) {
  const { snapshot, scope } = props;
  const pool = props.matches ?? matchesInScope(snapshot, scope);
  const counted = pool.filter(isCounted).length;
  const skipped = [
    ["진행 중", pool.filter((m) => m.state === "in_progress").length],
    ["결과 미입력", pool.filter((m) => m.state === "awaiting_result").length],
    ["전적 제외", pool.filter((m) => m.state === "excluded").length],
  ] as const;
  const shownSkips = skipped.filter(([, n]) => n > 0);
  const skipText =
    props.noCount || shownSkips.length === 0
      ? "결과 미입력·전적 제외 경기는 세지 않아요"
      : `${shownSkips.map(([label, n]) => `${label} ${n}`).join("·")}경기는 세지 않아요`;
  const label = scope.kind === "all" ? "전체 누적" : scopeLabel(snapshot, scope);
  return (
    <p className="scope-basis">
      <span className="scope-basis-head">기준</span>
      <span className="scope-basis-body">
        <span className="scope-basis-main">
          {label}
          {!props.noCount && ` · ${props.countPrefix ?? ""}확정 ${counted}경기`}
        </span>
        <span>
          {scope.kind === "all" ? "" : "MMR·칭호·배치는 누적 · "}
          {skipText}
        </span>
      </span>
    </p>
  );
}
