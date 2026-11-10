// 첫 화면 껍데기(App·상단 바·로그인 상태·모임 바꾸기·오류 화면)가 쓰는 화면 부품만 둔다.
// 이 파일은 index.html의 진입 묶음에 그대로 실리므로, 통계·칭호·날짜 형식처럼 화면에서만 쓰는 계산을 부르지 않는다.
// 화면 전용 부품(머리·표·막대·배지 등)은 screenKit.tsx에 있다. 껍데기에 들어가도 되는 파일 목록은 scripts/shell-modules.mjs.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiFailure } from "./api";
import { SessionExpiredNote } from "./sessionExpiredNote";

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

/** 클립보드에 복사한다. 실패하면 false를 돌려주고 호출한 쪽이 글 상자를 보여준다. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
