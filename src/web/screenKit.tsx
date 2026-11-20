// 화면 조각(lazyScreens.ts로 나중에 받는 화면)이 함께 쓰는 화면 틀 부품: 화면 머리·뒤로 링크·필터 줄·요약 카드·
// 목록형 표 머리(정렬), 누적 요약 띠(KpiStrip), 확정 명단(MatchTeams), 접힌 도움말·i 설명, 하단 고정 행동.
// 같은 묶음의 다른 부품은 파일을 나눠 두었다: 라인 표시 roleIcon.tsx, 범위 고르기·주소 조건·기준 줄 routeScope.tsx,
// 칭호·티어 배지 rankBadges.tsx, 추이 선 trendLines.tsx, 승률 막대·고리·최근 승패 rateMeters.tsx.
// 모두 통계·칭호·날짜 형식 계산을 부르므로 첫 화면 껍데기(App.tsx 쪽)에서는 부르지 않는다.
// 껍데기도 쓰는 대화 상자·오류 문구·복사 버튼·키보드 감지는 ui.tsx에 있다.
import { canGoBack } from "./nav";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { isCounted, personRecords, ratePercent, sideTotals } from "../shared/stats";
import { TEAMS, type MatchView, type Snapshot } from "../shared/types";
import { TEAM_MARK, teamBoxClass, teamName, teamRoster } from "./format";
import { PosLabel } from "./roleIcon";
import { useKeyboardOpen } from "./ui";

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

/**
 * 화면의 주요 행동 하나. 평소에는 하단에 고정하고(기기 하단 안전 영역만큼 띄움),
 * 키보드가 열리면 입력란을 가리지 않도록 본문 흐름 안에 둔다.
 */
export function StickyAction(props: { children: ReactNode }) {
  const keyboardOpen = useKeyboardOpen();
  return <div className={keyboardOpen ? "action-inline" : "action-sticky"}>{props.children}</div>;
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