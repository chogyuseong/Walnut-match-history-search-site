import { useEffect, useRef, useState, type ReactNode } from "react";
import { TEAMS, type MatchView, type Team } from "../shared/types";
import { ApiFailure } from "./api";
import { copyText, formatTime, POSITION_LABEL, TEAM_MARK, teamRoster } from "./format";

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
        <section key={team} className="team" aria-label={`팀 ${team}`}>
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
                <span className="pos">{entry.position ? POSITION_LABEL[entry.position] : "-"}</span>
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
