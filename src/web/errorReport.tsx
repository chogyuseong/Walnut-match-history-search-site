import { Component, type ErrorInfo, type ReactNode } from "react";
import { ERROR_MESSAGE_MAX, ERROR_STACK_MAX, isNoise, scrubPath, scrubText } from "../shared/errorScrub";
import { APP_VERSION } from "../shared/version";

/**
 * 화면 오류 보고(POST /api/client-errors, src/server/errorLog.ts).
 * - 전역 오류(window error), 처리하지 않은 Promise 거절, React 오류 경계에서 보낸다.
 * - 보내기 전에 가린다(토큰·ID·주소의 쿼리, src/shared/errorScrub.ts). 서버도 다시 가린다.
 * - 같은 오류는 1분에 한 번, 모든 오류를 합쳐 1분에 REPORT_PER_MINUTE건까지만 보낸다(이 탭 기준).
 * - 보내다 실패해도 조용히 넘어간다(오류 보고가 또 오류를 내지 않게).
 */

export const REPORT_PER_MINUTE = 5;
const MINUTE_MS = 60_000;

type Kind = "error" | "rejection" | "boundary";

const sentAt = new Map<string, number>();
let windowStart = 0;
let windowCount = 0;

/** 보낼지 정한다(같은 오류 반복·분당 건수 억제). 테스트를 위해 시각을 받는다. */
export function shouldReport(signature: string, now: number): boolean {
  if (now - windowStart >= MINUTE_MS) {
    windowStart = now;
    windowCount = 0;
  }
  const last = sentAt.get(signature);
  if (last !== undefined && now - last < MINUTE_MS) return false;
  if (windowCount >= REPORT_PER_MINUTE) return false;
  windowCount += 1;
  sentAt.set(signature, now);
  return true;
}

function describe(value: unknown): { message: string; stack: string | null } {
  if (value instanceof Error) return { message: `${value.name}: ${value.message}`, stack: value.stack ?? null };
  if (typeof value === "string") return { message: value, stack: null };
  try {
    return { message: JSON.stringify(value) ?? String(value), stack: null };
  } catch {
    return { message: String(value), stack: null };
  }
}

export function reportClientError(kind: Kind, value: unknown): void {
  try {
    const { message, stack } = describe(value);
    if (isNoise(message, stack)) return;
    const safeMessage = scrubText(message, ERROR_MESSAGE_MAX);
    if (!shouldReport(`${kind}|${safeMessage}`, Date.now())) return;
    const body = JSON.stringify({
      kind,
      message: safeMessage,
      stack: stack ? scrubText(stack, ERROR_STACK_MAX) : null,
      // 화면 경로(#/…)만. 토큰·ID 칸은 가린다.
      path: scrubPath(`#${location.hash.replace(/^#/, "") || "/"}`),
      appVersion: APP_VERSION,
    });
    void fetch("/api/client-errors", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 오류 보고는 실패해도 조용히 넘어간다.
  }
}

let installed = false;

/** 전역 오류를 잡는다. 앱을 그리기 전에 한 번 부른다. */
export function installErrorReporting(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    // 이미지·스크립트 불러오기 실패(대상이 요소)는 오류 객체가 없다. 메시지가 있는 것만 보낸다.
    if (!event.error && !event.message) return;
    reportClientError("error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError("rejection", event.reason);
  });
}

/**
 * React 오류 경계. 화면을 그리다 오류가 나면 서버에 알리고 "문제가 생겼어요" 화면을 보여 준다.
 * 작성 중인 편성은 기기 저장소에 있으므로 새로 고쳐도 남는다.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    reportClientError("boundary", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main>
        <div className="screen" role="alert">
          <h1>문제가 생겼어요</h1>
          <p>화면을 그리다 오류가 났어요. 새로 고치면 대부분 해결돼요. 작성 중인 편성은 이 기기에 그대로 있어요.</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => location.reload()}>
              새로 고침
            </button>
            {/* 같은 주소를 새로 고쳐도 다시 깨지는 경우(그 화면의 오류)를 위해 첫 화면으로 가는 길을 둔다. */}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                location.hash = "#/";
                location.reload();
              }}
            >
              첫 화면으로
            </button>
          </div>
        </div>
      </main>
    );
  }
}
