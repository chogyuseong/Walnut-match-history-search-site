import { useId, useState } from "react";
import { FEEDBACK_MAX_CHARS, FEEDBACK_MIN_CHARS } from "../../shared/feedback";
import { APP_VERSION } from "../../shared/version";
import { call } from "../api";
import { BackLink, ScreenHead } from "../screenKit";
import { ErrorNote, LineIcon } from "../ui";
import { go } from "../useApp";

/**
 * 피드백(#/feedback, 시험 운영 기간). 누구나 로그인 없이 불편한 점을 적어 보낸다(POST /api/feedback, src/server/feedback.ts).
 * 글은 사이트 운영자만 사이트 관리 화면(SiteAdmin.tsx)에서 읽는다. 연락처를 받지 않으므로 답장할 수 없다는 것을 적어 둔다.
 * 들어오는 곳: PC는 주 메뉴 "피드백" 탭, 휴대폰과 조회 링크·참가 신청·예시 모임은 상단 바의 "피드백" 링크(App.tsx).
 *
 * 보내기는 mutate가 아니라 call로 한 번만 보낸다. 요청 ID가 없는 경로라 응답을 놓쳐 다시 보내면 같은 글이 두 번 쌓인다.
 */
export function Feedback() {
  const fieldId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const length = text.trim().length;
  const over = length > FEEDBACK_MAX_CHARS;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await call("POST", "/api/feedback", { body: text, appVersion: APP_VERSION });
      setText("");
      setSent(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen feedback-screen">
      <ScreenHead
        back={<BackLink label="← 오늘" fallback={() => go("/")} />}
        title="피드백"
        desc="시험 운영 중이에요. 쓰다가 불편했던 점이나 바라는 점을 적어 주시면 사이트 운영자가 읽고 고칩니다."
      />
      {sent ? (
        <div className="feedback-sent" role="status">
          <p className="feedback-sent-line">
            <LineIcon name="check" />
            보냈어요. 적어 주셔서 고마워요.
          </p>
          <button type="button" className="secondary" onClick={() => setSent(false)}>
            하나 더 적기
          </button>
        </div>
      ) : (
        <form
          className="feedback-form"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor={fieldId}>불편한 점</label>
          <textarea
            id={fieldId}
            value={text}
            rows={6}
            maxLength={FEEDBACK_MAX_CHARS}
            aria-describedby={`${fieldId}-hint`}
            onChange={(event) => setText(event.target.value)}
          />
          <p id={`${fieldId}-hint`} className="hint">
            어느 화면에서 무엇을 하다가 그랬는지 적어 주시면 고치기 쉬워요. 이름·연락처 같은 개인정보는 적지 말아 주세요.
            답장은 드리지 못해요.{" "}
            <span className={over ? "memo-count over" : "memo-count"}>
              {length}/{FEEDBACK_MAX_CHARS}자
            </span>
          </p>
          <ErrorNote error={error} />
          <button type="submit" className="primary" disabled={busy || length < FEEDBACK_MIN_CHARS || over}>
            {busy ? "보내는 중…" : "의견 보내기"}
          </button>
        </form>
      )}
    </div>
  );
}
