import { useState } from "react";
import { dropHandoff, handoffOf, sendHandoff, takeHandoff, type HandoffState } from "../../draftHandoff";
import { formatTime } from "../../format";
import { Dialog, ErrorNote } from "../../ui";
import { go, type AppValue } from "../../useApp";

/**
 * 편성 넘기기 안내 줄(src/web/draftHandoff.ts). 오늘 화면(Today.tsx)과 준비 화면(Prep.tsx)이 함께 쓴다.
 * - 다른 기기가 넘긴 것: "○시 ○분에 다른 기기에서 넘긴 편성(12명)" + 이어받기 · 넘긴 편성 버리기(작성 중인 편성의 "버리기"와 헷갈리지 않게 이름을 길게 둔다). 이 기기에도 작성하던 편성이 있으면
 *   바꿀지 한 번 묻는다(덮어쓰면 되돌릴 수 없다).
 * - 이 기기가 넘긴 것: 넘겨 두었다는 안내 + (준비 화면) 다시 넘기기 · 넘기기 취소. 넘긴 뒤 여기서 고친 것은 넘긴 편성에
 *   들어가지 않아서 "다시 넘기기"를 둔다.
 * - 준비 화면에서 넘긴 것이 없으면: "이 기기에만 있어요" + 다른 기기로 넘기기.
 * 버튼은 모두 보조 버튼·글 링크다. 화면의 주 버튼(시작·다음 경기 준비)과 다투지 않게 한다(CLAUDE.md 2절).
 */
export function HandoffNote(props: { app: AppValue; where: "today" | "prep" }) {
  const { app, where } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [asking, setAsking] = useState(false);
  const state = handoffOf(app.snapshot);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };
  const take = () =>
    run(async () => {
      setAsking(false);
      await takeHandoff(app);
      if (where === "today") go("/prep");
      else app.setNotice("넘겨받은 편성으로 바꿨어요.");
    });
  const send = () => run(() => sendHandoff(app, app.draft!));
  const timeOf = (s: HandoffState) => formatTime(s.view.createdAt, app.snapshot?.group.timezone);

  let body;
  if (state && !state.mine) {
    body = (
      <p className="note handoff-note" role="status">
        <span>
          {timeOf(state)}에 다른 기기에서 넘긴 편성이 있어요({state.view.people}명).
          {state.stale && " 넘긴 뒤 경기 상태가 바뀌어 이어받은 다음 명단을 확인해야 해요."}
        </span>
        <span className="button-row">
          <button type="button" className="secondary" disabled={busy} onClick={() => (app.draft ? setAsking(true) : take())}>
            이어받기
          </button>
          <button type="button" className="link" disabled={busy} onClick={() => run(() => dropHandoff(app, state.view))}>
            넘긴 편성 버리기
          </button>
        </span>
      </p>
    );
  } else if (state?.mine) {
    body = (
      <p className="note handoff-note" role="status">
        <span>
          {timeOf(state)}에 다른 기기로 넘겨 두었어요. 그 기기에서 오늘 화면을 열면 이어받을 수 있어요.
          {where === "prep" && " 넘긴 뒤 여기서 고친 것은 다시 넘겨야 들어가요."}
        </span>
        <span className="button-row">
          {where === "prep" && (
            <button type="button" className="secondary" disabled={busy} onClick={send}>
              다시 넘기기
            </button>
          )}
          <button type="button" className="link" disabled={busy} onClick={() => run(() => dropHandoff(app, state.view))}>
            넘기기 취소
          </button>
        </span>
      </p>
    );
  } else if (where === "prep") {
    body = (
      <p className="handoff-line">
        <span className="hint">이 편성은 이 기기에만 있어요.</span>
        <button type="button" className="link" disabled={busy} onClick={send}>
          다른 기기로 넘기기
        </button>
      </p>
    );
  } else {
    return null;
  }

  return (
    <>
      {body}
      <ErrorNote error={error} />
      {asking && (
        <Dialog title="작성하던 편성을 바꿀까요?" onClose={() => setAsking(false)}>
          <p>이 기기에서 작성하던 편성은 지워지고, 다른 기기에서 넘긴 편성({state?.view.people}명)으로 바뀌어요.</p>
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={take}>
              넘겨받은 편성으로 바꾸기
            </button>
            <button type="button" className="secondary" onClick={() => setAsking(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
