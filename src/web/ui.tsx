import { canGoBack } from "./nav";
import { SessionExpiredNote } from "./screens/Login";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  fractionPercent,
  isCounted,
  matchYears,
  ratePercent,
  sideTotals,
  SMALL_SAMPLE,
  type Scope,
} from "../shared/stats";
import { ratingTierOf } from "../shared/rating";
import type { TitleGrade } from "../shared/titles";
import { TEAMS, type MatchView, type Position, type Snapshot } from "../shared/types";
import { ApiFailure } from "./api";
import {
  copyText,
  formatTime,
  heatBarClass,
  type ShownStanding,
  POSITION_LABEL,
  rateTier,
  TEAM_MARK,
  teamBoxClass,
  teamName,
  teamRoster,
} from "./format";

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
 */
export function TitleBadge(props: { name: string; grade: TitleGrade | null }) {
  const { grade } = props;
  return (
    <span className={grade ? `title-chip grade-${grade}` : "title-chip"}>
      {grade && <TitleEmblem grade={grade} />}
      <span className="title-name">{props.name}</span>
    </span>
  );
}

/**
 * MMR 티어 이름표(rating.ts RATING_TIERS, LoL 시즌 2 Elo 구간). 배치 중이면 그리지 않는다.
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
 * 칭호는 구간 순서로 정한 등급 색·엠블럼으로 보여준다(TitleBadge).
 */
export function StandingNote(props: { standing: ShownStanding | undefined; placementGames: number }) {
  const s = props.standing ?? { games: 0, wins: 0, losses: 0, done: false, title: null, grade: null };
  if (!s.done) {
    return (
      <span className="standing">
        배치 진행 중 {s.games}/{props.placementGames} (누적 기준)
      </span>
    );
  }
  if (!s.title) return <span className="standing">배치 완료 (누적 기준)</span>;
  return (
    <span className="standing">
      <TitleBadge name={s.title} grade={s.grade} /> 누적 기준
    </span>
  );
}

/** 누적 경기 수, 진영별 승률, 참가자 수를 한 줄로 보여준다. 확정된 경기가 없으면 그리지 않는다. */
export function KpiStrip(props: { snapshot: Snapshot }) {
  const { snapshot } = props;
  const games = snapshot.matches.filter(isCounted).length;
  if (games === 0) return null;
  const sides = sideTotals(snapshot.matches);
  const people = snapshot.participants.filter((p) => p.status === "active").length;
  // 목록·요약의 승률은 정수(%)로 쓴다(소수 한 자리는 그래프 분석 화면에서만). 두 값의 합이 100이 되게 한다.
  const blueRate = ratePercent(sides.blueWins, sides.known);
  return (
    <p className="kpi">
      <span>
        누적 경기<strong>{games}경기</strong>
      </span>
      {sides.known > 0 && (
        <span>
          블루 : 레드 승률<strong className="blue">{blueRate}%</strong> :{" "}
          <strong className="red">{100 - blueRate}%</strong>
        </span>
      )}
      <span>
        참가자<strong>{people}명</strong>
      </span>
    </p>
  );
}

/** 대화 상자 안에서 Tab으로 갈 수 있는 요소. 숨겨진 것(크기 없음)은 뺀다. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/** 열려 있는 대화 상자(나중에 연 것이 끝). Tab 가두기는 맨 위의 창만 한다(창 위에 창을 연 경우). */
const openDialogs: HTMLElement[] = [];

/**
 * 한 번에 하나만 띄우는 확인 창. 뒤 화면은 누를 수 없다.
 * 열리면 초점을 창으로 옮기고, Tab·Shift+Tab은 창 안에서만 돈다. 닫히면 열기 전에 초점이 있던 요소로 돌려준다.
 * 창 이름은 제목(h2)을 aria-labelledby로 가리킨다.
 */
export function Dialog(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  // 창이 열릴 때 한 번만 초점을 옮긴다. 다시 그릴 때마다 옮기면 입력 중인 칸에서 초점이 빠진다.
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog) openDialogs.push(dialog);
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose.current();
      if (event.key !== "Tab" || !dialog || openDialogs[openDialogs.length - 1] !== dialog) return;
      const items = focusablesIn(dialog);
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const index = dialog ? openDialogs.lastIndexOf(dialog) : -1;
      if (index >= 0) openDialogs.splice(index, 1);
      // 닫힌 뒤 초점을 연 요소로 돌려준다. 그 요소가 화면에서 사라졌으면 그대로 둔다.
      // 화면이 그 자리로 튀지 않게 스크롤은 하지 않는다(창은 화면 위에 떠 있었으므로 보통 연 요소가 보인다).
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className="overlay" role="presentation">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-head">
          <h2 id={titleId}>{props.title}</h2>
          <button type="button" className="link" onClick={props.onClose}>
            닫기
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** 저장 상태 문구. 서버가 확인하기 전에는 "저장됨"을 쓰지 않는다. */
export function ErrorNote(props: { error: unknown; onCheck?: () => void }) {
  const { error } = props;
  if (!error) return null;
  if (error instanceof ApiFailure) {
    if (error.kind === "offline") {
      return (
        <p className="note warn" role="alert">
          인터넷에 연결돼 있지 않아 저장하지 못했어요. 입력은 그대로 있어요.
        </p>
      );
    }
    if (error.kind === "unknown") {
      return (
        <p className="note warn" role="alert">
          저장됐는지 확인하지 못했어요. 입력은 그대로 있어요.{" "}
          {props.onCheck && (
            <button type="button" className="link" onClick={props.onCheck}>
              확인하기
            </button>
          )}
        </p>
      );
    }
    if (error.status === 401) return <SessionExpiredNote />;
    if (error.code === "VERSION_CONFLICT") {
      return (
        <p className="note warn" role="alert">
          그 사이 내용이 바뀌었어요. 입력은 그대로 있어요. 최신 상태를 확인한 뒤 다시 저장해 주세요.
        </p>
      );
    }
    return (
      <p className="note warn" role="alert">
        {error.message}
      </p>
    );
  }
  return (
    <p className="note warn" role="alert">
      알 수 없는 문제가 생겼어요. 다시 시도해 주세요.
    </p>
  );
}

export function SavedBadge(props: { at: string | null | undefined; timeZone?: string }) {
  if (!props.at) return null;
  return <span className="badge ok">저장됨 · {formatTime(props.at, props.timeZone)} 확인</span>;
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
                  <span className="name" title={props.nameOf(entry.participantId)}>
                    {props.nameOf(entry.participantId)}
                  </span>
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 복사 버튼. 클립보드가 거부되면 선택할 수 있는 글 상자를 그 자리에 보여준다. */
export function CopyButton(props: { label: string; text: () => string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  const [manualText, setManualText] = useState("");
  return (
    <span className="copy">
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          const text = props.text();
          if (await copyText(text)) {
            setState("copied");
            setTimeout(() => setState("idle"), 2500);
          } else {
            setManualText(text);
            setState("manual");
          }
        }}
      >
        {state === "copied" ? "복사했어요" : props.label}
      </button>
      {state === "manual" && (
        <label className="manual-copy">
          복사하지 못했어요. 아래 글을 길게 눌러 직접 복사해 주세요.
          <textarea readOnly value={manualText} rows={8} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}
    </span>
  );
}

/** 글자를 입력하는 칸인지(화면 키보드가 열리는 칸). 체크 상자·라디오·버튼은 아니다. */
function isTextField(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !["checkbox", "radio", "button", "submit", "file", "range", "color"].includes(el.type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

/** 키보드가 차지했다고 보는 최소 높이(px). 주소창이 접히고 펴지는 정도는 넘는다. */
const KEYBOARD_GAP = 150;

/**
 * 화면 키보드가 열려 있는지. 기기마다 키보드가 화면을 줄이는 방식이 둘이라 둘 다 본다.
 * - 보이는 영역(visualViewport)만 줄어드는 방식: 창 높이와 보이는 영역 높이의 차.
 * - 창(innerHeight) 자체가 줄어드는 방식: 입력 칸에 초점이 있는 동안 창이 평소보다 낮아진 정도.
 * 열려 있으면 하단 고정 버튼을 본문 안으로 옮기고 하단 탭을 숨긴다(입력 칸을 가리지 않게).
 */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let baseHeight = window.innerHeight;
    let baseWidth = window.innerWidth;
    const viewport = window.visualViewport;
    const update = () => {
      // 가로·세로를 돌리면 기준을 새로 잡는다.
      if (window.innerWidth !== baseWidth) {
        baseWidth = window.innerWidth;
        baseHeight = window.innerHeight;
      }
      const focused = isTextField(document.activeElement);
      if (!focused) baseHeight = window.innerHeight;
      else baseHeight = Math.max(baseHeight, window.innerHeight);
      const visualGap = viewport ? window.innerHeight - viewport.height : 0;
      const layoutGap = baseHeight - window.innerHeight;
      setOpen(visualGap > KEYBOARD_GAP || (focused && layoutGap > KEYBOARD_GAP));
    };
    // 초점이 빠질 때는 다음 칸으로 옮겨 가는 중일 수 있어 한 박자 뒤에 본다.
    const later = () => setTimeout(update, 0);
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return open;
}

/** 키보드가 열려 있으면 <html data-keyboard="open">을 단다. CSS가 좁은 화면의 하단 탭을 숨긴다. */
export function useKeyboardFlag(): void {
  const open = useKeyboardOpen();
  useEffect(() => {
    if (open) document.documentElement.dataset.keyboard = "open";
    else delete document.documentElement.dataset.keyboard;
  }, [open]);
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

export function StickyAction(props: { children: ReactNode }) {
  const keyboardOpen = useKeyboardOpen();
  return <div className={keyboardOpen ? "action-inline" : "action-sticky"}>{props.children}</div>;
}

/**
 * 최근 승패 칸. 최근 경기가 왼쪽이다. 색만이 아니라 칸 안의 글자(승·패)로도 구분한다.
 * 읽는 사람에게는 "최근 5경기 승 패 승…"처럼 읽힌다.
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
 * tone: rate(승률) · blue/red(진영 색) · share(비중, 중립색). muted면 색 없이 회색으로 그린다.
 * heat: 승률 색 단계 클래스(heatBarClass). 승률 막대만 준다.
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
 * 승률 막대는 승률 색 단계(heatBarClass: 45~55% 기본 색, 높을수록 붉게, 낮을수록 가라앉게)를 따르고,
 * SMALL_SAMPLE경기 미만이면 색으로 강조하지 않는다(rateTier·"자료 적음"과 같은 규칙).
 * 진영 막대(blue·red)는 진영을 가리키는 색이라 표본·승률과 관계없이 진영 색을 쓴다.
 */
export function RateBar(props: { wins: number; games: number; tone?: MeterTone; small?: boolean }) {
  const { wins, games } = props;
  const tone = props.tone ?? "rate";
  return (
    <Meter
      value={games === 0 ? 0 : wins / games}
      tone={tone}
      heat={tone === "rate" ? heatBarClass(wins, games) : undefined}
      mid
      muted={tone === "rate" && games < SMALL_SAMPLE}
      small={props.small}
    />
  );
}

/** 승·패 비율 막대. 왼쪽이 승(승리 색), 오른쪽이 패(패배 색, 빗금). 가운데 50% 기준선. */
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
          className={muted ? "ring-fill tone-muted" : `ring-fill ${heatBarClass(wins, games)}`}
          cx="34"
          cy="34"
          r={R}
          strokeDasharray={`${(rate * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 34 34)"
        />
        <line className="ring-mid" x1="34" x2="34" y1={34 + R - 7} y2={34 + R + 7} />
      </svg>
      <span className="ring-text">
        <strong className={rateTier(wins, games)}>{ratePercent(wins, games)}%</strong>
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
