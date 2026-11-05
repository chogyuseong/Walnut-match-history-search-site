import { useEffect, useRef, useState, type ReactNode } from "react";
import { isCounted, sideTotals } from "../shared/stats";
import {
  sideOfTeam,
  TEAMS,
  type MatchView,
  type Position,
  type Snapshot,
  type Team,
} from "../shared/types";
import { ApiFailure } from "./api";
import { copyText, formatTime, POSITION_LABEL, TEAM_MARK, teamRoster } from "./format";

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

/** 라인 이름과 아이콘. 아이콘은 꾸밈이고 뜻은 글자가 전한다. */
export function PosLabel(props: { position: Position | null }) {
  if (!props.position) return <span className="pos">-</span>;
  return (
    <span className="pos">
      <svg className="role-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        {ROLE_SHAPES[props.position]}
      </svg>
      {POSITION_LABEL[props.position]}
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
  const percent = (wins: number) => ((wins / sides.known) * 100).toFixed(1);
  return (
    <p className="kpi">
      <span>
        누적 경기<strong>{games}경기</strong>
      </span>
      {sides.known > 0 && (
        <span>
          블루 : 레드 승률<strong className="blue">{percent(sides.blueWins)}%</strong> :{" "}
          <strong className="red">{percent(sides.redWins)}%</strong>
        </span>
      )}
      <span>
        참가자<strong>{people}명</strong>
      </span>
    </p>
  );
}

/** 한 번에 하나만 띄우는 확인 창. 뒤 화면은 누를 수 없다. */
export function Dialog(props: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  // 창이 열릴 때 한 번만 초점을 옮긴다. 다시 그릴 때마다 옮기면 입력 중인 칸에서 초점이 빠진다.
  useEffect(() => {
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="overlay" role="presentation">
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="dialog-head">
          <h2>{props.title}</h2>
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
    if (error.status === 401) {
      return (
        <p className="note warn" role="alert">
          다시 로그인해 주세요. 입력은 그대로 있어요.
        </p>
      );
    }
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

/** 팀 상자의 클래스. 진영이 정해진 경기만 블루·레드 색을 입힌다. */
function teamClass(side: string | null): string {
  return side === "blue" || side === "red" ? `team side-${side}` : "team";
}

/** 확정 명단. 좁은 화면에서는 두 팀을 위아래로 쌓는다(CSS). */
export function MatchTeams(props: {
  match: MatchView;
  nameOf: (id: string) => string;
  highlightId?: string | null;
  sideOf?: (team: Team) => string | null;
}) {
  return (
    <div className="teams">
      {TEAMS.map((team) => (
        <section
          key={team}
          className={teamClass(sideOfTeam(team, props.match.teamASide))}
          aria-label={`팀 ${team}`}
        >
          <h3>
            <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team}
            {props.sideOf?.(team) ? <span className="side"> · {props.sideOf(team)}</span> : null}
          </h3>
          <ul>
            {teamRoster(props.match, team).map((entry) => (
              <li
                key={entry.participantId}
                className={entry.participantId === props.highlightId ? "row me" : "row"}
              >
                <PosLabel position={entry.position} />
                <span className="name" title={props.nameOf(entry.participantId)}>
                  {props.nameOf(entry.participantId)}
                </span>
              </li>
            ))}
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

/** 화면 키보드가 열려 있는지. 열려 있으면 하단 고정 버튼을 본문 안으로 옮긴다. */
export function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setOpen(window.innerHeight - viewport.height > 150);
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
  return open;
}

/**
 * 화면의 주요 행동 하나. 평소에는 하단에 고정하고(기기 하단 안전 영역만큼 띄움),
 * 키보드가 열리면 입력란을 가리지 않도록 본문 흐름 안에 둔다.
 */
export function StickyAction(props: { children: ReactNode }) {
  const keyboardOpen = useKeyboardOpen();
  return <div className={keyboardOpen ? "action-inline" : "action-sticky"}>{props.children}</div>;
}
