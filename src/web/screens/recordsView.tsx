// 기록 화면(Records.tsx)의 보기 조건: 경기 거르기 칸(사람·이긴 진영·라인·승패)과, 그 조건을 주소 "?" 뒤에 남기고 읽는 규칙.
// 주소 이름 표는 아래 "보기 조건 ↔ 주소" 주석에 있다. 이미 공유된 링크가 있으니 이름을 바꾸지 않는다.
import { useMemo } from "react";
import type { MatchFilter, RankingSort, WinnerSideFilter } from "../../shared/insights";
import { matchesInScope, type Scope } from "../../shared/stats";
import { POSITIONS, type MatchView, type Position, type Snapshot } from "../../shared/types";
import { POSITION_LABEL } from "../format";
import { readRouteParams, scopeFromParam, scopeParam } from "../routeScope";

/** 한 번에 보여주는 경기 카드 수. "더 보기"로 같은 수만큼 더 연다. */
export const PAGE = 30;

const WINNER_SIDE_LABEL: Record<WinnerSideFilter, string> = {
  blue: "블루 승",
  red: "레드 승",
  unknown: "진영 미상",
};

/** 거른 조건을 한 줄 글로. */
export function filterText(filter: MatchFilter, nameOf: (id: string) => string): string {
  const parts: string[] = [];
  const [anchor] = filter.people;
  if (filter.people.length === 1) parts.push(`${nameOf(anchor!)} 참가`);
  if (filter.people.length > 1) parts.push(`${filter.people.map(nameOf).join("·")} 모두 참가`);
  if (anchor && filter.position) parts.push(`${nameOf(anchor)} ${POSITION_LABEL[filter.position]}`);
  if (anchor && filter.result) parts.push(`${nameOf(anchor)} ${filter.result === "win" ? "승" : "패"}`);
  if (filter.winnerSide) parts.push(WINNER_SIDE_LABEL[filter.winnerSide]);
  return parts.join(" · ");
}

/** 경기에 나온 사람(이름순). 거를 사람 고르기의 선택지. */
function useCandidates(scoped: readonly MatchView[], nameOf: (id: string) => string): string[] {
  return useMemo(() => {
    const ids = new Set<string>();
    for (const m of scoped) for (const r of m.roster) ids.add(r.participantId);
    return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ko"));
  }, [scoped, nameOf]);
}

/**
 * 경기 거르기 중 화면 맨 위 필터 줄에 들어가는 두 칸: 사람(여러 명이면 모두 함께 뛴 경기)·이긴 팀의 진영.
 * 고른 사람 칩과 첫 번째 사람의 라인·승패는 경기 목록 위(MatchFilterPeople)에 둔다(사람을 고른 뒤에만 생긴다).
 */
export function MatchFilterSelects(props: {
  scoped: readonly MatchView[];
  filter: MatchFilter;
  onChange: (filter: MatchFilter) => void;
  nameOf: (id: string) => string;
}) {
  const { filter, onChange, nameOf } = props;
  const candidates = useCandidates(props.scoped, nameOf);
  const hasPerson = filter.people.length > 0;
  return (
    <>
      <label>
        사람
        <select
          aria-label="거를 사람 추가"
          value=""
          onChange={(e) => {
            if (e.target.value === "") return;
            onChange({ ...filter, people: [...filter.people, e.target.value] });
          }}
        >
          <option value="">{hasPerson ? "함께 뛴 사람 추가" : "사람 고르기"}</option>
          {candidates
            .filter((id) => !filter.people.includes(id))
            .map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
        </select>
      </label>
      <label>
        이긴 진영
        <select
          aria-label="이긴 진영"
          value={filter.winnerSide ?? ""}
          onChange={(e) =>
            onChange({ ...filter, winnerSide: (e.target.value || null) as WinnerSideFilter | null })
          }
        >
          <option value="">진영 모두</option>
          <option value="blue">블루 승</option>
          <option value="red">레드 승</option>
          <option value="unknown">진영 미상</option>
        </select>
      </label>
    </>
  );
}

/** 고른 사람 칩과 첫 번째 사람의 라인·승패. 사람을 고르기 전에는 그리지 않는다. */
export function MatchFilterPeople(props: {
  filter: MatchFilter;
  onChange: (filter: MatchFilter) => void;
  nameOf: (id: string) => string;
}) {
  const { filter, onChange, nameOf } = props;
  if (filter.people.length === 0) return null;
  const anchorName = nameOf(filter.people[0]!);
  return (
    <div className="match-filter" role="group" aria-label="경기 거르기">
      <div className="filter-people">
        {filter.people.map((id, i) => (
          <button
            key={id}
            type="button"
            className="chip"
            aria-label={`${nameOf(id)} 조건 빼기`}
            onClick={() => {
              const people = filter.people.filter((p) => p !== id);
              // 기준(첫 사람)이 바뀌면 그 사람에게 걸린 라인·승패 조건도 지운다.
              onChange(
                i === 0
                  ? { ...filter, people, position: null, result: null }
                  : { ...filter, people },
              );
            }}
          >
            {i === 0 && filter.people.length > 1 ? "기준 " : ""}
            {nameOf(id)} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="filter-row">
        <label>
          {anchorName}의 라인
          <select
            aria-label="라인"
            value={filter.position ?? ""}
            onChange={(e) =>
              onChange({ ...filter, position: (e.target.value || null) as Position | null })
            }
          >
            <option value="">라인 모두</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {anchorName}의 승패
          <select
            aria-label="승패"
            value={filter.result ?? ""}
            onChange={(e) =>
              onChange({
                ...filter,
                result: (e.target.value || null) as MatchFilter["result"],
              })
            }
          >
            <option value="">승패 모두</option>
            <option value="win">승</option>
            <option value="loss">패</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/* ---------- 보기 조건 ↔ 주소(2026-11-18) ----------
   기록 화면의 보기 조건을 주소 "?" 뒤에 남긴다. 경기 상세에 다녀와도, 새로 고쳐도, 주소를 남에게 보내도 같은 목록이 열린다.
   운영자(#/records), 모임 링크(#/v/토큰/records), 참가 중인 모임(#/mine/모임/records), 예시(#/demo/records)가 같은 규칙을 쓴다.

   주소 이름 | 뜻                                    | 적지 않을 때(기본값)
   scope    | 범위 all·today·season.ID·year.2026    | 늘 적는다(아래 readRecordsView 참고)
   who      | 거를 사람 ID, 쉼표로 이음(첫 사람 = 기준) | 사람 조건 없음
   pos      | 기준인 사람의 라인                       | 라인 모두
   res      | 기준인 사람의 승패 win·loss              | 승패 모두
   side     | 이긴 진영 blue·red·unknown              | 진영 모두
   sort     | 플레이어 랭킹 정렬 wins·games·rating      | rate(승률)
   line     | 플레이어 랭킹의 라인                      | 모든 라인
   n        | 경기 목록에 펼친 개수                     | PAGE(30)

   조건을 하나 더 남기려면 세 곳을 함께 고친다: RecordsView(모양), readRecordsView(읽기·검사), recordsParams(쓰기).
   이 표도 같이 고친다. 이름은 주소에 그대로 보이므로 짧고 뜻이 드러나게, 이미 공유된 링크가 깨지지 않게 바꾸지 않는다.
   랭킹 이름 검색 칸(query)은 일부러 남기지 않는다: 잠깐 찾아보는 용도라 뒤로 왔을 때 걸러진 순위표가 남으면 오히려 헷갈린다.
   다른 화면에서 조건을 붙여 기록 화면을 열 때(검색의 "참가 경기 보기" 등)도 이 이름을 쓴다(App.tsx·Viewer.tsx). */

/** 기록 화면에서 주소(#/records?…)에 남기는 보기 조건. */
interface RecordsView {
  scope: Scope;
  filter: MatchFilter;
  sort: RankingSort;
  /** 플레이어 랭킹의 라인(경기 거르기의 라인 filter.position과 따로다). */
  line: Position | null;
  /** 경기 목록에 펼친 개수. 뒤로 왔을 때 스크롤 위치가 같은 경기를 가리키려면 이것도 남겨야 한다. */
  shown: number;
}

// 주소에서 받아도 되는 값 목록. 타입(RankingSort 등)에 값을 더하면 여기에도 더해야 주소로 열 수 있다
// (빠뜨리면 그 값은 주소에서 무시되고 기본값으로 열릴 뿐 오류는 나지 않는다).
const RANKING_SORTS: readonly RankingSort[] = ["rate", "wins", "games", "rating"];
const RESULT_FILTERS: readonly MatchFilter["result"][] = ["win", "loss"];
const WINNER_SIDES: readonly WinnerSideFilter[] = ["blue", "red", "unknown"];

/** 주소 값이 허용 목록에 있으면 그 값, 없으면(빈 값·오타·옛 이름) null. */
function pickOne<T extends string>(value: string | null, allowed: readonly (T | null)[]): T | null {
  return allowed.includes(value as T) ? (value as T) : null;
}

/**
 * 주소 조건 → 보기 조건. 손으로 고친 주소나 지워진 사람·시즌이 있어도 화면이 깨지지 않게 모르는 값은 기본값으로 둔다.
 * 범위가 주소에 없으면 예전처럼 최근 세션에 경기가 있을 때만 "오늘", 아니면 전체로 연다.
 * 주의:
 * - 합치기로 사라진 사람 ID는 participants에 없어서 조건에서 빠진다(남은 사람으로 바꿔 주지는 않는다).
 * - 라인·승패는 기준인 사람이 있을 때만 뜻이 있어(MatchFilter 주석) 사람이 없으면 버린다.
 * - 화면이 처음 그려질 때 한 번만 부른다. 그 뒤로는 화면 상태가 주인이고 주소는 따라 적힐 뿐이다.
 */
export function readRecordsView(snapshot: Snapshot): RecordsView {
  const params = readRouteParams();
  const known = new Set(snapshot.participants.map((p) => p.id));
  const people = [...new Set((params.get("who") ?? "").split(",").filter((id) => known.has(id)))];
  const scope =
    scopeFromParam(params.get("scope"), snapshot) ??
    (matchesInScope(snapshot, { kind: "today" }).length > 0 ? { kind: "today" } : { kind: "all" });
  const shown = Number(params.get("n"));
  return {
    scope,
    filter: {
      people,
      position: people.length > 0 ? pickOne(params.get("pos"), POSITIONS) : null,
      result: people.length > 0 ? pickOne(params.get("res"), RESULT_FILTERS) : null,
      winnerSide: pickOne(params.get("side"), WINNER_SIDES),
    },
    sort: pickOne(params.get("sort"), RANKING_SORTS) ?? "rate",
    line: pickOne(params.get("line"), POSITIONS),
    shown: Number.isInteger(shown) && shown > PAGE ? shown : PAGE,
  };
}

/**
 * 보기 조건 → 주소 조건. 주소가 짧게 남도록 기본값은 적지 않는다.
 * 범위만은 늘 적는다: 범위의 기본값은 "오늘 경기가 있는지"에 따라 바뀌어서, 빼 두면 다음 날 같은 주소가 다른 목록을 연다.
 */
export function recordsParams(view: RecordsView): URLSearchParams {
  const params = new URLSearchParams({ scope: scopeParam(view.scope) });
  const { filter } = view;
  if (filter.people.length > 0) params.set("who", filter.people.join(","));
  if (filter.position) params.set("pos", filter.position);
  if (filter.result) params.set("res", filter.result);
  if (filter.winnerSide) params.set("side", filter.winnerSide);
  if (view.sort !== "rate") params.set("sort", view.sort);
  if (view.line) params.set("line", view.line);
  if (view.shown > PAGE) params.set("n", String(view.shown));
  return params;
}

/**
 * "이 조건으로 공유"에 넣을 주소. 운영자 주소(#/records)는 로그인한 운영자만 열 수 있어서, 모임 링크가 있으면
 * 모임 링크의 기록 화면(#/v/토큰/records)으로 바꿔 보낸다. 모임 링크·예시 모임에서는 지금 주소 그대로다.
 * 운영자인데 모임 링크가 없으면 보낼 주소가 없어 null(버튼을 숨긴다).
 * 참가 중인 모임(#/mine/…)은 지금 주소를 그대로 준다. 받는 사람도 그 모임에 로그인해 있어야 열린다.
 */
export function shareLinkOf(snapshot: Snapshot, params: URLSearchParams): string | null {
  const query = params.toString();
  if (location.hash.startsWith("#/records")) {
    const token = snapshot.group.viewToken;
    return token ? `${location.origin}/#/v/${token}/records?${query}` : null;
  }
  // 주소는 효과(useEffect)에서 고치므로 그리는 순간의 location.hash는 한 박자 늦을 수 있다. 경로만 쓰고 조건은 새로 붙인다.
  const path = location.hash.replace(/\?.*$/, "");
  return `${location.origin}${location.pathname}${path}?${query}`;
}
