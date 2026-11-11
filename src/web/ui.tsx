// 첫 화면 껍데기(App·상단 바·로그인 상태·모임 바꾸기·오류 화면)가 쓰는 화면 부품만 둔다.
// 이 파일은 index.html의 진입 묶음에 그대로 실리므로, 통계·칭호·날짜 형식처럼 화면에서만 쓰는 계산을 부르지 않는다.
// 화면 전용 부품(머리·표·막대·배지 등)은 screenKit.tsx에 있다. 껍데기에 들어가도 되는 파일 목록은 scripts/shell-modules.mjs.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
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

/** 키보드가 내려가며 화면 높이가 바뀌는 동안 resize가 여러 번 온다. 마지막 resize 뒤 이만큼 조용하면 다 내려갔다고 본다(ms). */
const KEYBOARD_SETTLE_MS = 100;
/** 키보드를 내렸는데 화면 크기 변화 신호(resize)가 오지 않는 기기에서 더 기다리지 않고 움직이는 한도(ms). */
const KEYBOARD_CLOSE_LIMIT_MS = 600;
/**
 * 고정 머리·하단 탭을 뺀 쓸 수 있는 높이 가운데 결과가 이만큼(또는 결과 전체가) 보이면 "이미 보인다"고 치고 움직이지 않는다.
 * 390×844에서 약 300px(랭킹 줄 5개쯤). PC에서는 결과가 화면 위쪽 절반쯤에서 시작하면 그대로 둔다.
 * 낮추면 결과가 화면 아래에 한두 줄만 걸쳐도 멈춰서, 검색한 뒤 손으로 다시 내려야 하는 일이 돌아온다.
 */
const RESULT_SEEN_SHARE = 0.5;

/**
 * 키보드가 열려 있었으면 다 내려간 뒤(보이는 화면 높이가 자리 잡은 뒤)에 run을 부른다.
 * 돌려주는 함수는 기다림을 그만둔다(검색을 다시 하거나 화면을 떠날 때).
 */
function afterKeyboardCloses(keyboardWasOpen: boolean, run: () => void): () => void {
  if (!keyboardWasOpen) {
    run();
    return () => {};
  }
  const viewport = window.visualViewport;
  let settle = 0;
  const stop = () => {
    clearTimeout(settle);
    clearTimeout(limit);
    viewport?.removeEventListener("resize", onResize);
    window.removeEventListener("resize", onResize);
  };
  const finish = () => {
    stop();
    run();
  };
  const onResize = () => {
    clearTimeout(settle);
    settle = window.setTimeout(finish, KEYBOARD_SETTLE_MS);
  };
  const limit = window.setTimeout(finish, KEYBOARD_CLOSE_LIMIT_MS);
  viewport?.addEventListener("resize", onResize);
  window.addEventListener("resize", onResize);
  return stop;
}

/**
 * results가 이미 보이면 그대로 두고, 아니면 첫머리가 화면 위쪽에 오게 올린다.
 * 위아래 가림 여백은 html의 scroll-padding(상단 고정 머리·하단 탭·고정 버튼 몫)을 그대로 쓴다.
 * 대화 상자 안에서는 창 안 스크롤 상자 기준으로 최소한만 움직인다(뒤 화면을 끌고 가지 않게).
 */
function revealResults(results: HTMLElement) {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const behavior: ScrollBehavior = smooth ? "smooth" : "auto";
  if (results.closest('[role="dialog"]')) {
    results.scrollIntoView({ block: "nearest", behavior });
    return;
  }
  const root = getComputedStyle(document.documentElement);
  const padTop = parseFloat(root.scrollPaddingTop) || 0;
  const padBottom = parseFloat(root.scrollPaddingBottom) || 0;
  const viewHeight = window.visualViewport?.height ?? window.innerHeight;
  const usable = viewHeight - padTop - padBottom;
  const box = results.getBoundingClientRect();
  const seen = box.top >= padTop && box.top + Math.min(box.height, usable * RESULT_SEEN_SHARE) <= viewHeight - padBottom;
  if (!seen) results.scrollIntoView({ block: "start", behavior });
}

/**
 * 검색 칸에서 검색 키(Enter)를 누르면 키보드를 내리고 결과 첫머리로 옮긴다. 휴대폰에서 검색 뒤 손으로 내려야 결과가
 * 보이던 것을 없애려는 것이다. 글자를 치는 동안에는 아무것도 하지 않는다(입력할 때마다 화면이 튀지 않게).
 * 쓰는 법: 결과 목록과 "일치하는 이름이 없어요" 안내를 함께 감싼 요소에 ref={results}, tabIndex={-1}을 달고
 * 검색 칸에 onKeyDown={onSearchKey}, enterKeyHint="search"를 단다.
 * 화면 키보드를 내려야 하는 기기(키보드가 열려 있거나 주 입력이 터치)에서만 초점을 결과 감싼 요소로 옮긴다.
 * 그래야 키보드가 내려가고 화면 읽기 사용자가 결과 첫머리부터 듣는다. tabIndex -1이라 Tab 순서에는 끼지 않는다.
 * PC(마우스·실물 키보드)에서는 초점을 검색 칸에 그대로 둔다. 옮기면 검색어를 고치려고 다시 눌러야 하고, 초점 위치도 안 보인다.
 * 터치 조건까지 보는 까닭: 키보드 열림 감지(useKeyboardOpen)가 안 되는 휴대폰 브라우저에서 초점을 안 옮기면 키보드가 떠서 결과를 가린다.
 * Enter가 이미 다른 일을 하는 칸(새 이름 넣기·챔피언 고르기)에는 쓰지 않는다.
 */
export function useSearchJump<T extends HTMLElement>() {
  const results = useRef<T>(null);
  const frame = useRef(0);
  const stopWaiting = useRef<() => void>(() => {});
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      stopWaiting.current();
    },
    [],
  );

  // 한 프레임 미룬다: 폼 제출(전적 검색)과 React 다시 그리기가 먼저 끝나야 결과 요소가 제자리에 있다.
  // 같은 Enter가 두 번 와도(조합 확정 Enter를 두 번 내보내는 브라우저) 앞의 예약을 지우므로 한 번만 움직인다.
  function scheduleJump(input: HTMLInputElement, keyboardWasOpen: boolean, dismissKeyboard: boolean) {
    cancelAnimationFrame(frame.current);
    stopWaiting.current();
    frame.current = requestAnimationFrame(() => {
      const target = results.current;
      if (input.value.trim() === "" || !target?.isConnected) {
        if (dismissKeyboard) input.blur();
        return;
      }
      if (dismissKeyboard) target.focus({ preventScroll: true });
      stopWaiting.current = afterKeyboardCloses(keyboardWasOpen, () => {
        if (target.isConnected) revealResults(target);
      });
    });
  }

  function onSearchKey(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    const input = event.currentTarget;
    // 키를 누른 순간에 잰다. 초점이 옮겨 간 뒤에는 키보드 열림 표시가 곧 꺼져 판단이 흔들린다.
    const keyboardWasOpen = document.documentElement.dataset.keyboard === "open";
    const dismissKeyboard = keyboardWasOpen || window.matchMedia("(pointer: coarse)").matches;
    // 한글 조합 중 Enter: 이 순간에는 마지막 글자가 아직 입력값에 없다. 조합이 끝난 뒤에 옮겨야 글자가 빠지지 않는다.
    // 자판에 따라 검색 키 한 번이 곧 이 Enter라서, 무시하면 검색 키를 두 번 눌러야 하는 기기가 생긴다.
    if (event.nativeEvent.isComposing) {
      input.addEventListener("compositionend", () => scheduleJump(input, keyboardWasOpen, dismissKeyboard), { once: true });
      return;
    }
    // Safari는 조합이 끝난 직후의 Enter를 keyCode 229로 보낸다. 이미 입력값에 들어간 뒤라 그대로 옮긴다.
    scheduleJump(input, keyboardWasOpen, dismissKeyboard);
  }

  return { results, onSearchKey };
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
