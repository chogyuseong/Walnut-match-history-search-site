// 화면 조각(lazyScreens.ts로 나중에 받는 화면)이 함께 쓰는 부품: 화면 머리, 표 정렬, 승률 막대·고리, 칭호·티어 배지,
// 라인 표시, 기간 고르기 등. 통계·칭호·날짜 형식 계산을 부르므로 첫 화면 껍데기(App.tsx 쪽)에서는 부르지 않는다.
// 껍데기도 쓰는 대화 상자·오류 문구·복사 버튼·키보드 감지는 ui.tsx에 있다.
import { canGoBack, noteReplacedHash } from "./nav";
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  fractionPercent,
  isCounted,
  matchesInScope,
  matchYears,
  personRecords,
  ratePercent,
  scopeLabel,
  sideTotals,
  SMALL_SAMPLE,
  type Scope,
} from "../shared/stats";
import { ratingTierOf } from "../shared/rating";
import type { TitleGrade } from "../shared/titles";
import { TEAMS, type MatchView, type Position, type Snapshot } from "../shared/types";
import {
  heatClass,
  rateHueClass,
  type ShownStanding,
  POSITION_LABEL,
  rateTier,
  TEAM_MARK,
  teamBoxClass,
  teamName,
  teamRoster,
} from "./format";
import { useKeyboardOpen } from "./ui";

/** 라인 아이콘. 디자인 키트가 직접 그린 도형이며 게임의 공식 아이콘이 아니다. */
const ROLE_SHAPES: Record<Position, ReactNode> = {
  top: (
    <>
      <path d="M4 4H19L15.5 7.5H7.5V15.5L4 19V4Z" fill="currentColor" />
      <path
        d="M9.5 9.5H19V19H9.5V9.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeOpacity="0.35"
      />
    </>
  ),
  jungle: (
    <>
      <path
        d="M12 3L16.5 9.5L12 21L7.5 9.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M5 8L10 13M19 8L14 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  mid: (
    <>
      <path d="M19 5L5 19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M4 4H11L8.5 6.5H6.5V8.5L4 11V4Z" fill="currentColor" fillOpacity="0.45" />
      <path d="M20 20H13L15.5 17.5H17.5V15.5L20 13V20Z" fill="currentColor" fillOpacity="0.45" />
    </>
  ),
  adc: (
    <>
      <path d="M20 20H5L8.5 16.5H16.5V8.5L20 5V20Z" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="2.5" stroke="currentColor" strokeWidth="1.6" strokeOpacity="0.45" />
    </>
  ),
  support: (
    <>
      <path
        d="M12 4L19 7.5V12.5C19 16.5 16 19.5 12 21C8 19.5 5 16.5 5 12.5V7.5L12 4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 8V16M8.5 11.5H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

/**
 * 라인 아이콘만(꾸밈). 뜻은 곁의 글자가 전해야 한다.
 * pos-{라인} 클래스로 라인별 색(styles.css의 --pos-*)이 들어간다(2026-11-09, 준비 화면에서 라인이 한눈에 보이게).
 */
export function RoleIcon(props: { position: Position }) {
  return (
    <svg className={`role-icon pos-${props.position}`} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {ROLE_SHAPES[props.position]}
    </svg>
  );
}

/** 라인 이름과 아이콘. 아이콘은 꾸밈이고 뜻은 글자가 전한다. */
export function PosLabel(props: { position: Position | null }) {
  if (!props.position) return <span className="pos">-</span>;
  // data-pos로 글자와 아이콘에 같은 라인 색을 준다(styles.css .pos[data-pos]).
  return (
    <span className="pos" data-pos={props.position}>
      <RoleIcon position={props.position} />
      {POSITION_LABEL[props.position]}
    </span>
  );
}

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
// 쓰는 곳: 기록 화면(screens/Records.tsx, 조건 표는 그 파일의 "보기 조건 ↔ 주소"), 개인 통계·두 사람 비교·그래프(useRouteScope),
// 기록·그래프 → 개인 통계, 개인 통계 → 비교로 갈 때 기간을 잇는 주소 꼬리(scopeSuffix).
// 예전에는 routeQuery.ts 한 파일이었다. 그래프 화면까지 쓰게 되자 따로 둔 파일이 화면 조각 하나로 늘어 첫 화면의
// 주소 미리 받기 목록이 커졌고(check:bundle 예산 17KB), 이 코드를 쓰는 화면은 모두 이 파일을 쓰므로 여기로 옮겼다.
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
 * 칭호 엠블럼. 등급(구간 순서)마다 직접 그린 단순한 도형이다(게임의 랭크 엠블럼을 본뜨지 않았다).
 * 1 왕관 · 2 보석 · 3 별 · 4 방패 · 5 검 · 6 깃발 · 7 새싹 · 8 고리. 꾸밈이고 뜻은 옆의 이름 글자가 전한다.
 * 등급 수(titles.ts TITLE_GRADE_COUNT)와 개수가 같아야 한다(Record 타입이 빠진 등급을 잡는다).
 */
const TITLE_EMBLEMS: Record<TitleGrade, ReactNode> = {
  1: <path d="M3 18.5H21M4 16L3 7L8.5 11L12 4.5L15.5 11L21 7L20 16H4Z" />,
  2: <path d="M7.5 4H16.5L21 9L12 20L3 9L7.5 4ZM3 9H21M9.5 4L12 9L14.5 4M12 9V20" />,
  3: <path d="M12 3.5L14.6 9L20.5 9.6L16 13.6L17.3 19.5L12 16.5L6.7 19.5L8 13.6L3.5 9.6L9.4 9L12 3.5Z" />,
  4: (
    <>
      <path d="M12 3.5L19 6.5V12C19 16 16.2 19 12 20.5C7.8 19 5 16 5 12V6.5L12 3.5Z" />
      <path d="M12 8V16" />
    </>
  ),
  5: <path d="M17.5 4H20V6.5L10.5 16L8 13.5L17.5 4ZM6 12L12 18M8.5 15.5L4.5 19.5" />,
  6: <path d="M6 20.5V4M6 4.5H18L15.5 8.5L18 12.5H6" />,
  7: <path d="M12 20.5V11M12 12.5C12 8.5 9.5 6.5 5 6.5C5 10.5 7.5 12.5 12 12.5ZM12 11C12 7.5 14.5 5 19 5C19 9 16.5 11 12 11Z" />,
  8: <path d="M12 4.5A7.5 7.5 0 1 0 12 19.5A7.5 7.5 0 1 0 12 4.5ZM12 9A3 3 0 1 0 12 15A3 3 0 1 0 12 9Z" />,
};

/** 칭호 엠블럼 하나(꾸밈, 화면 읽기에서 숨김). 색은 둘러싼 요소의 grade-N 클래스를 따른다. */
export function TitleEmblem(props: { grade: TitleGrade }) {
  return (
    <svg className="title-emblem" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {TITLE_EMBLEMS[props.grade]}
    </svg>
  );
}

/**
 * 칭호 표식: 엠블럼 + 이름, 등급 색. 칭호가 나오는 모든 화면이 이것 하나를 쓴다.
 * grade가 없으면(알 수 없는 이름 등) 예전처럼 색 없는 테두리 표식이다.
 * compact: 목록 줄(홈 상위 5명·플레이어 랭킹·MMR 순위표·그래프 개인별·검색 결과)에서 쓰는 꼴로, 테두리 없이
 * 등급 색 글자 + 작은 엠블럼만 둔다. 테두리 배지는 개인 통계·두 사람 비교 요약·랭킹 시상대처럼 한 사람을 크게 보일 때.
 */
export function TitleBadge(props: { name: string; grade: TitleGrade | null; compact?: boolean }) {
  const { grade } = props;
  const base = props.compact ? "title-chip compact" : "title-chip";
  return (
    <span className={grade ? `${base} grade-${grade}` : base}>
      {grade && <TitleEmblem grade={grade} />}
      <span className="title-name">{props.name}</span>
    </span>
  );
}

/**
 * MMR 티어 이름표(rating.ts RATING_TIERS, S~D). 배치 중이면 그리지 않는다.
 * 칭호(TitleBadge)는 테두리형 알약이라 이것은 채움형 네모로 두어 나란히 서도 구분되게 한다.
 */
export function RatingTierBadge(props: { rating: number; placed: boolean }) {
  const tier = ratingTierOf(props.rating, props.placed);
  if (!tier) return null;
  return (
    <span className={`mmr-tier mmr-tier-${tier.key}`}>
      <span className="sr-only">MMR 티어 </span>
      {tier.name}
    </span>
  );
}

/**
 * 배치·칭호 표시. 누적 기준이며 범위 필터와 무관하다(docs/P2 P2-11).
 * 배치 중은 "배치 진행 중 7/10"(10은 모임 설정의 배치 경기 수)으로만 쓰고 낮은 실력처럼 보이게 하지 않는다.
 * 칭호는 구간 순서로 정한 등급 색·엠블럼으로 보여준다(TitleBadge). compact는 목록 줄용(TitleBadge 참고).
 */
export function StandingNote(props: {
  standing: ShownStanding | undefined;
  placementGames: number;
  compact?: boolean;
  /** 목록 머리에 "누적 기준"을 이미 한 번 적었으면 줄마다 되풀이하지 않는다(요약 화면 랭킹 상위). */
  basisInHeading?: boolean;
}) {
  const s = props.standing ?? { games: 0, wins: 0, losses: 0, done: false, title: null, grade: null };
  const basis = props.basisInHeading ? null : "누적 기준";
  if (!s.done) {
    return (
      <span className="standing">
        배치 진행 중 {s.games}/{props.placementGames}
        {basis && ` (${basis})`}
      </span>
    );
  }
  if (!s.title) return <span className="standing">배치 완료{basis && ` (${basis})`}</span>;
  return (
    <span className="standing">
      <TitleBadge name={s.title} grade={s.grade} compact={props.compact} />
      {basis && ` ${basis}`}
    </span>
  );
}

/**
 * 누적 경기 수, 진영별 승률, 참가자 수를 한 줄로 보여준다. 확정된 경기가 없으면 그리지 않는다.
 * 진영 승률은 "54% ▬▬▬ 46%"처럼 두 숫자 사이에 블루·레드 비율 막대를 둔다(2026-11-10 요약 화면 시안의 상단 띠).
 * 참가자는 확정 경기를 한 번이라도 한 사람이다(보관한 사람 포함). 랭킹 "24명"·그래프 분석 참가자와 같은 수여야 해서
 * 활성 명단 수로 세지 않는다.
 * hideGames: 바로 위 기준 줄(ScopeBasis)이 확정 경기 수를 이미 말하는 화면(기록)에서 같은 숫자를 두 번 쓰지 않게 뺀다.
 */
export function KpiStrip(props: { snapshot: Snapshot; hideGames?: boolean }) {
  const { snapshot } = props;
  const games = snapshot.matches.filter(isCounted).length;
  if (games === 0) return null;
  const sides = sideTotals(snapshot.matches);
  const people = personRecords(snapshot.matches).size;
  // 목록·요약의 승률은 정수(%)로 쓴다(소수 한 자리는 그래프 분석 화면에서만). 두 값의 합이 100이 되게 한다.
  const blueRate = ratePercent(sides.blueWins, sides.known);
  return (
    <p className="kpi">
      {!props.hideGames && (
        <span>
          누적 경기<strong>{games}경기</strong>
        </span>
      )}
      {sides.known > 0 && (
        // 숫자 사이의 막대는 같은 비율을 그림으로 한 번 더 보여 줄 뿐이라 읽지 않는다(숫자가 뜻을 전한다).
        <span className="kpi-sides">
          블루 : 레드 승률<strong className="blue">{blueRate}%</strong>
          <span className="kpi-split" aria-hidden="true">
            <span className="kpi-split-blue" style={{ flexGrow: blueRate }} />
            <span className="kpi-split-red" style={{ flexGrow: 100 - blueRate }} />
          </span>
          <span className="sr-only"> : </span>
          <strong className="red">{100 - blueRate}%</strong>
        </span>
      )}
      <span>
        참가자<strong>{people}명</strong>
      </span>
    </p>
  );
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

/**
 * 확정 명단. 좁은 화면에서는 두 팀을 위아래로 쌓는다(CSS).
 * 팀 이름·테두리는 teamName 규칙: 진영이 정해진 경기는 "블루팀"/"레드팀"과 그 색, 모르면 "팀 A"/"팀 B"와 중립 테두리.
 */
export function MatchTeams(props: {
  match: MatchView;
  nameOf: (id: string) => string;
  highlightId?: string | null;
  /** 있으면 사람 줄이 버튼이 된다(진행 중 화면의 "다른 사람으로 교체"). 화면 읽기 이름은 "{포지션} {이름} 교체". */
  onPick?: (participantId: string) => void;
  /**
   * 있으면 챔피언을 기록한 사람의 이름 밑에 챔피언 이름을 적는다(경기 상세). 챔피언 목록(src/shared/champions.ts)을
   * 이 부품을 쓰는 모든 화면 조각에 싣지 않으려고 이름 바꾸기 함수를 부르는 화면에서 받는다.
   */
  championName?: (key: string) => string;
  /** 있으면 챔피언 이름 옆에 초상화를 둔다(championPortrait.tsx). 같은 까닭으로 부르는 화면에서 받는다. */
  championPortrait?: (key: string) => ReactNode;
}) {
  return (
    <div className="teams">
      {TEAMS.map((team) => (
        <section
          key={team}
          className={teamBoxClass(team, props.match.teamASide)}
          aria-label={teamName(team, props.match.teamASide)}
        >
          <h3>
            <span aria-hidden="true">{TEAM_MARK[team]}</span> {teamName(team, props.match.teamASide)}
          </h3>
          <ul>
            {teamRoster(props.match, team).map((entry) =>
              props.onPick ? (
                <li key={entry.participantId}>
                  <button type="button" className="row" onClick={() => props.onPick!(entry.participantId)}>
                    <PosLabel position={entry.position} />
                    <span className="name" title={props.nameOf(entry.participantId)}>
                      {props.nameOf(entry.participantId)}
                    </span>
                    <span className="sr-only"> 교체</span>
                  </button>
                </li>
              ) : (
                <li
                  key={entry.participantId}
                  className={entry.participantId === props.highlightId ? "row me" : "row"}
                >
                  <PosLabel position={entry.position} />
                  {entry.champion && props.championName ? (
                    <>
                    {props.championPortrait?.(entry.champion)}
                    <span className="name-stack">
                      <span className="name" title={props.nameOf(entry.participantId)}>
                        {props.nameOf(entry.participantId)}
                      </span>
                      <span className="champ-name">
                        <span className="sr-only">챔피언 </span>
                        {props.championName(entry.champion)}
                      </span>
                    </span>
                    </>
                  ) : (
                    <span className="name" title={props.nameOf(entry.participantId)}>
                      {props.nameOf(entry.participantId)}
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * 화면의 주요 행동 하나. 평소에는 하단에 고정하고(기기 하단 안전 영역만큼 띄움),
 * 키보드가 열리면 입력란을 가리지 않도록 본문 흐름 안에 둔다.
 */
/**
 * 접힌 도움말(2026-11-08 위계 정리). 긴 안내문은 여기에 넣고 화면에는 한 줄만 남긴다.
 * 글은 DOM에 그대로 있어 검색·테스트가 찾을 수 있고, 펼치면 보통 안내문처럼 읽힌다.
 */
export function Help(props: { label?: string; children: ReactNode }) {
  return (
    <details className="help">
      <summary>{props.label ?? "도움말"}</summary>
      <div className="help-body">{props.children}</div>
    </details>
  );
}

/**
 * 제목·꼬리표 옆의 작은 i 버튼. 누르면 바로 아래에 짧은 설명이 펼쳐진다.
 * Help(접힌 "도움말")와 달리 "이 숫자는 무엇으로 정하나" 같은 한두 문장짜리에 쓴다.
 * 터치 화면에서는 title 풍선이 뜨지 않아 누르는 방식으로 했다.
 */
export function InfoTip(props: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="info-tip"
        aria-label={`${props.label} 설명`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="info-tip-dot" aria-hidden="true">
          i
        </span>
      </button>
      {open && (
        <span id={id} className="info-tip-body" role="note">
          {props.children}
        </span>
      )}
    </>
  );
}

export function StickyAction(props: { children: ReactNode }) {
  const keyboardOpen = useKeyboardOpen();
  return <div className={keyboardOpen ? "action-inline" : "action-sticky"}>{props.children}</div>;
}

/**
 * 최근 승패. 최근 경기가 왼쪽이고, 칸 없이 "승패승" 글자로 쓴다(승은 승리 글자색, 패는 패배 글자색).
 * 색만이 아니라 글자로도 구분하고, 읽는 사람에게는 "최근 5경기 승 패 승…"처럼 읽힌다.
 * 2026-11-17 전에는 색칸이었고 요약 화면 상위 5명만 글자였다. 칸이 줄마다 10개씩 쌓여 랭킹 화면에서 가장 시끄러워 글자로 통일했다.
 */
export function FormDots(props: { results: readonly boolean[]; label?: string }) {
  if (props.results.length === 0) return null;
  return (
    <span className="form-dots">
      <span className="sr-only">{props.label ?? `최근 ${props.results.length}경기`}</span>
      {props.results.map((won, i) => (
        <span key={i} className={won ? "form-dot win" : "form-dot loss"}>
          {won ? "승" : "패"}
        </span>
      ))}
    </span>
  );
}


/**
 * 추이 그래프의 틀: 왼쪽에 세로 눈금 세 개(위·가운데·아래), 아래에 가로 구간 숫자 세 개(처음·중간·끝).
 * SVG는 preserveAspectRatio="none"으로 늘어나므로 글자는 SVG 밖 HTML에 둔다. 눈금이 없으면 선의 높이가 어느 정도인지
 * 가늠할 수 없다는 피드백으로 넣었다.
 */
function TrendFrame(props: { yTicks: [string, string, string]; xTicks: [string, string, string]; children: ReactNode }) {
  return (
    <div className="trend-plot">
      <div className="trend-y" aria-hidden="true">
        {props.yTicks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
      {props.children}
      <div className="trend-x" aria-hidden="true">
        {props.xTicks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * 누적 승률 추이(작은 선 그래프). 그래프 화면의 .viz-root 색 변수를 쓴다.
 * 50% 기준선을 두고, 처음·끝 값은 글자로 함께 적는다.
 */
export function TrendLine(props: { points: readonly { game: number; rate: number }[] }) {
  const { points } = props;
  if (points.length < 2) return null;
  const W = 300;
  const H = 72;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  // 세로축은 50%를 가운데에 두고 위아래를 같은 폭으로 잡는다(최소 ±20%p). 위아래 4px 여백.
  const spread = Math.min(0.5, Math.max(0.2, ...points.map((p) => Math.abs(p.rate - 0.5))) + 0.02);
  const x = (game: number) => ((game - first.game) / Math.max(1, last.game - first.game)) * W;
  const y = (rate: number) => 4 + ((0.5 + spread - rate) / (spread * 2)) * (H - 8);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.game).toFixed(1)},${y(p.rate).toFixed(1)}`).join("");
  const pct = (r: number) => `${fractionPercent(r)}%`;
  const midGame = Math.round((first.game + last.game) / 2);
  return (
    <figure className="trend trend-rate viz-root">
      <TrendFrame
        yTicks={[pct(0.5 + spread), "50%", pct(0.5 - spread)]}
        xTicks={[`${first.game}경기`, `${midGame}경기`, `${last.game}경기`]}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`누적 승률 추이: ${first.game}경기째 ${pct(first.rate)}에서 ${last.game}경기째 ${pct(last.rate)}, 위아래 끝 ${pct(0.5 + spread)} / ${pct(0.5 - spread)}`}
        >
          <rect x="0" y="0" width={W} height={H} className="trend-bg" />
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="trend-mid" vectorEffect="non-scaling-stroke" />
          <path d={path} className="trend-path" vectorEffect="non-scaling-stroke" />
        </svg>
      </TrendFrame>
      <figcaption className="trend-caption">
        <span>누적 승률 추이</span>
        <span>
          {first.game}경기째 {pct(first.rate)} → <strong>{last.game}경기째 {pct(last.rate)}</strong>
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * MMR 추이(작은 선 그래프). TrendLine과 같은 모양·클래스이고, 가운데 기준선이 시작값(모임 설정)이다.
 * 세로축은 시작값을 가운데에 두고 위아래를 같은 폭으로 잡는다(최소 ±50). 처음·끝 값은 글자로 함께 적는다.
 * points: 0경기째(시작값)부터. rating.ts ratingTrend의 결과.
 */
export function RatingTrendLine(props: { points: readonly { game: number; rating: number }[]; start: number }) {
  const { points } = props;
  if (points.length < 2) return null;
  const W = 300;
  const H = 72;
  const MID = props.start;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const spread = Math.max(50, ...points.map((p) => Math.abs(p.rating - MID))) * 1.05;
  const x = (game: number) => ((game - first.game) / Math.max(1, last.game - first.game)) * W;
  const y = (rating: number) => 4 + ((MID + spread - rating) / (spread * 2)) * (H - 8);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.game).toFixed(1)},${y(p.rating).toFixed(1)}`).join("");
  const n = (r: number) => String(Math.round(r));
  const at = (game: number) => (game === 0 ? "시작" : `${game}경기째`);
  const midGame = Math.round((first.game + last.game) / 2);
  return (
    <figure className="trend trend-rating viz-root">
      <TrendFrame
        yTicks={[n(MID + spread), String(MID), n(MID - spread)]}
        xTicks={[first.game === 0 ? "시작" : `${first.game}경기`, `${midGame}경기`, `${last.game}경기`]}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`MMR 추이: ${at(first.game)} ${n(first.rating)}에서 ${last.game}경기째 ${n(last.rating)}, 위아래 끝 ${n(MID + spread)} / ${n(MID - spread)}`}
        >
          <rect x="0" y="0" width={W} height={H} className="trend-bg" />
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="trend-mid" vectorEffect="non-scaling-stroke" />
          <path d={path} className="trend-path" vectorEffect="non-scaling-stroke" />
        </svg>
      </TrendFrame>
      <figcaption className="trend-caption">
        <span>MMR 추이</span>
        <span>
          {at(first.game)} {n(first.rating)} → <strong>{last.game}경기째 {n(last.rating)}</strong>
        </span>
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// 개인 통계·검색의 작은 그림. 그림은 보조이고 정확한 값은 언제나 옆의 숫자·글자다.
// 그래서 그림은 화면 읽기 프로그램에 읽히지 않게 숨긴다(aria-hidden). 색은 그래프 화면의 .viz-root 값을 쓴다.

export type MeterTone = "rate" | "blue" | "red" | "share";

/**
 * 가로 막대 하나. value는 0~1.
 * tone: rate(승률) · blue/red(진영 색) · share(비중, 중립색). muted면 색 없이 속 빈 막대로 그린다.
 * heat: 승률 3단 클래스(heatClass). 승률 막대만 준다.
 * mid: 50% 기준선.
 */
export function Meter(props: {
  value: number;
  tone?: MeterTone;
  heat?: string;
  mid?: boolean;
  muted?: boolean;
  small?: boolean;
}) {
  const width = Math.max(0, Math.min(1, props.value)) * 100;
  const tone = props.muted ? "muted" : (props.tone ?? "rate");
  const heat = !props.muted && tone === "rate" && props.heat ? ` ${props.heat}` : "";
  return (
    <span className={props.small ? "meter meter-sm viz-root" : "meter viz-root"} aria-hidden="true">
      <span className={`meter-fill tone-${tone}${heat}`} style={{ width: `${width}%` }} />
      {props.mid && <span className="meter-mid" />}
    </span>
  );
}

/**
 * 승률 막대(50% 기준선 포함). 기록이 없으면 빈 막대다.
 * 승률 막대는 승률 3단(heatClass: 높음(55% 이상) 강조색 · 45~54% 주요 글자 · 낮음 보조 글자)을 따르고,
 * SMALL_SAMPLE경기 미만이면 속 빈 막대로 그린다(rateTier·"자료 적음"과 같은 규칙).
 * 진영 막대(blue·red)는 진영을 가리키는 색이라 표본·승률과 관계없이 진영 색을 쓴다.
 */
export function RateBar(props: {
  wins: number;
  games: number;
  tone?: MeterTone;
  small?: boolean;
  /** 승률 3단 대신 승률 여섯 색(rateHueClass, 그래프 분석·요약과 같다). 검색 결과가 쓴다. */
  hued?: boolean;
}) {
  const { wins, games } = props;
  const tone = props.tone ?? "rate";
  return (
    <Meter
      value={games === 0 ? 0 : wins / games}
      tone={tone}
      heat={tone === "rate" ? (props.hued ? rateHueClass(wins, games) : heatClass(wins, games)) : undefined}
      mid
      muted={tone === "rate" && games < SMALL_SAMPLE}
      small={props.small}
    />
  );
}

/** 승·패 비율 막대. 왼쪽이 승(승리 색 채움), 오른쪽이 패(패배 색 테두리만, 속 빈 막대). 가운데 50% 기준선. */
export function WinLossBar(props: { wins: number; losses: number }) {
  const { wins, losses } = props;
  if (wins + losses === 0) return <Meter value={0} mid />;
  return (
    <span className="wl-bar" aria-hidden="true">
      <span className="wl-win" style={{ flexGrow: wins }} />
      <span className="wl-loss" style={{ flexGrow: losses }} />
      <span className="meter-mid" />
    </span>
  );
}

/**
 * 승률 고리(도넛). 채운 호가 승률이고 아래쪽 눈금이 50%다. 가운데에 승률을 크게 적는다.
 * 호와 가운데 숫자는 승률 여섯 색(rateHueClass, 개인별 승률 막대와 같다). 5경기 미만은 색 없이.
 * 숫자는 바로 옆 요약 줄에도 그대로 있으므로 고리 전체를 화면 읽기에서 숨긴다.
 */
export function RateRing(props: { wins: number; games: number }) {
  const { wins, games } = props;
  if (games === 0) return null;
  const rate = wins / games;
  const R = 26;
  const C = 2 * Math.PI * R;
  const muted = games < SMALL_SAMPLE;
  return (
    <div className="ring viz-root" aria-hidden="true">
      <svg viewBox="0 0 68 68">
        <circle className="ring-track" cx="34" cy="34" r={R} />
        <circle
          className={muted ? "ring-fill tone-muted" : `ring-fill ${rateHueClass(wins, games) || heatClass(wins, games)}`}
          cx="34"
          cy="34"
          r={R}
          strokeDasharray={`${(rate * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 34 34)"
        />
        <line className="ring-mid" x1="34" x2="34" y1={34 + R - 7} y2={34 + R + 7} />
      </svg>
      <span className="ring-text">
        <strong className={muted ? rateTier(wins, games) : `rate ${rateHueClass(wins, games)}`}>{ratePercent(wins, games)}%</strong>
        <span>승률</span>
      </span>
    </div>
  );
}

/**
 * 화면 위의 "← 뒤로". 이 사이트 안에서 온 화면이 있으면 그곳으로(검색에서 왔으면 검색으로) 돌아가고,
 * 링크로 바로 들어와 앞 화면이 없으면 label이 가리키는 화면(fallback)으로 간다.
 */
export function BackLink(props: { label: string; fallback: () => void }) {
  const back = canGoBack();
  return (
    <button type="button" className="link" onClick={() => (back ? history.back() : props.fallback())}>
      {back ? "← 뒤로" : props.label}
    </button>
  );
}

/* ---------- 화면 틀(2026-11-10 구조 정리) ----------
   읽는 화면(요약·검색·기록·랭킹·분석·개인 통계·비교·시즌 요약·운영자 오늘)은 같은 순서로 짠다:
   화면 머리(ScreenHead) → 필터 줄(FilterBar) → 요약 카드 줄(.stat-cards 안의 StatCard) → 본문 표(SortHead 목록 또는 dataTable.tsx의 DataTable).
   폭은 styles.css의 --page-wide(읽는 화면, .screen.page-wide 또는 .screen.cols)와 --page-narrow(양식 화면, 그냥 .screen) 둘뿐이다. */

/**
 * 화면 머리: 왼쪽에 제목과 한 줄 설명, 오른쪽에 동작. 운영자 화면의 "지금 할 입력"(지난 경기 입력 등)은 actions 자리에 둔다.
 * 모임 링크·예시 모임에는 입력 동작이 없으니 actions를 비우면 되고, 틀(제목·설명 줄)은 같다.
 * badge는 h1 밖에 둔다: 제목 이름(heading name)에 "보관"·"진행 중" 같은 글자가 섞이지 않게.
 */
export function ScreenHead(props: {
  title: ReactNode;
  /** 제목 위 한 줄(← 뒤로). */
  back?: ReactNode;
  badge?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={props.className ? `screen-head page-head ${props.className}` : "screen-head page-head"}>
      {props.back && <div className="page-back">{props.back}</div>}
      <div className="page-title">
        <div className="page-title-line">
          <h1>{props.title}</h1>
          {props.badge}
        </div>
        {props.desc && <p className="page-desc">{props.desc}</p>}
      </div>
      {props.actions && <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

/**
 * 필터 줄: 구간 탭(.segmented, 예: ScopePicker)·고르기 상자·검색 칸을 한 줄에 붙여 놓는다. 좁으면 줄을 바꾼다.
 * 안의 .segmented는 칸 사이가 붙은 한 덩어리 탭으로 그려진다(styles.css .filter-bar .segmented).
 * meta는 오른쪽 끝의 작은 글(기준·갱신 시각 같은 것).
 */
export function FilterBar(props: { label: string; children: ReactNode; meta?: ReactNode; className?: string }) {
  return (
    <div className={props.className ? `filter-bar ${props.className}` : "filter-bar"} role="group" aria-label={props.label}>
      {props.children}
      {props.meta && <span className="filter-meta">{props.meta}</span>}
    </div>
  );
}

/**
 * 요약 카드: 제목 → (이름 같은 한 줄) → 큰 수치 하나 → "라벨 … 값" 줄 몇 개. 여러 장을 .stat-cards로 감싸 한 줄에 놓는다.
 * 값이 없을 때(기록이 적은 새 모임)는 value에 "—"를 넘기고 rows를 비우면 카드 높이만 유지된다.
 */
export function StatCard(props: {
  title: ReactNode;
  lead?: ReactNode;
  value: ReactNode;
  rows?: readonly (readonly [ReactNode, ReactNode])[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={props.className ? `stat-card ${props.className}` : "stat-card"}>
      <p className="stat-card-title">{props.title}</p>
      {props.lead && <p className="stat-card-lead">{props.lead}</p>}
      <p className="stat-card-value">{props.value}</p>
      {props.rows && props.rows.length > 0 && (
        <dl className="stat-card-rows">
          {props.rows.map(([label, value], i) => (
            <div key={i}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {props.children}
    </div>
  );
}

export type SortDir = "asc" | "desc";
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/** 정렬 화살표. 지금 정렬 열은 방향(▼ 큰 값부터 · ▲ 작은 값부터), 나머지는 눌러 볼 수 있다는 표시(↕). */
export function SortArrow(props: { active: boolean; dir: SortDir }) {
  return (
    <span className="dt-arrow" aria-hidden="true">
      {props.active ? (props.dir === "desc" ? "▼" : "▲") : "↕"}
    </span>
  );
}

/**
 * 목록형 표의 머리 줄. 줄이 listitem(목록)이어야 하는 순위표(랭킹·플레이어 랭킹)에 쓴다: 묶음 소제목·행 펼침이 줄 사이에
 * 끼고, 기존 화면·테스트가 "줄 = listitem"에 기대기 때문이다. 표 의미(aria-sort)가 필요한 새 화면은 DataTable을 쓴다.
 * 칸 배치는 머리 줄과 줄이 같은 grid-template-columns를 쓰도록 화면 CSS가 정한다(cls가 칸 이름).
 * 정렬 열은 버튼이고 지금 정렬은 aria-pressed로 알린다. 버튼 이름은 열 이름 그대로다(화살표는 읽지 않는다).
 * 좁은 화면(768px 미만)에서는 정렬 버튼만 칩 한 줄로 남고 나머지 머리 칸은 숨는다(styles.css .dt-head).
 */
export function SortHead<K extends string>(props: {
  label: string;
  cells: readonly { cls: string; label: ReactNode; sort?: K; num?: boolean }[];
  sort: SortState<K>;
  onSort: (key: K) => void;
  className?: string;
}) {
  return (
    <div className={props.className ? `dt-head ${props.className}` : "dt-head"} role="group" aria-label={props.label}>
      {props.cells.map((cell, i) => {
        const cls = `dt-h ${cell.cls}${cell.num ? " num" : ""}`;
        if (!cell.sort) {
          return (
            <span key={i} className={cls}>
              {cell.label}
            </span>
          );
        }
        const active = props.sort.key === cell.sort;
        return (
          <span key={i} className={`${cls} sortable`}>
            <button
              type="button"
              className={active ? "dt-sort is-active" : "dt-sort"}
              aria-pressed={active}
              onClick={() => props.onSort(cell.sort!)}
            >
              {/* 선택 밑줄은 이 글자 묶음에만 긋는다. 버튼은 44px 누르는 폭이라 버튼에 그으면 글자보다 넓다. */}
              <span className="dt-sort-text">
                {cell.label}
                <SortArrow active={active} dir={props.sort.dir} />
              </span>
            </button>
          </span>
        );
      })}
    </div>
  );
}

/**
 * 표의 칸 사이 이음 글자. 넓은 화면에서는 칸이 나뉘어 있어 보이지 않게(크기 0) 두고, 좁은 화면에서 칸이 한 줄로 합쳐질 때는
 * 보인다. 화면 읽기·글자 복사·검색에서는 늘 "70% · 7승 3패 (10경기)"처럼 한 문장으로 이어진다.
 */
export function Glue(props: { children: string }) {
  return <span className="glue">{props.children}</span>;
}

/**
 * 화면 폭 조건(matchMedia)을 따라가는 값. 표와 카드처럼 DOM 자체가 다른 두 모양 중 하나만 그릴 때 쓴다
 * (둘 다 그려 CSS로 숨기면 같은 버튼이 두 번 있어 화면 읽기·테스트가 헷갈린다).
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
