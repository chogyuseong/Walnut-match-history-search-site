import { useId, useState } from "react";
import { MEMO_MAX, memoLength, normalizeMemo } from "../shared/memo";
import type { MatchView } from "../shared/types";
import { mutate, newRequestId } from "./api";
import { ErrorNote } from "./ui";
import type { AppValue } from "./useApp";

/** 정리한 뒤의 글자 수가 한도를 넘는지. */
export function memoTooLong(raw: string): boolean {
  const memo = normalizeMemo(raw);
  return memo !== null && memoLength(memo) > MEMO_MAX;
}

/**
 * 경기 메모 입력 칸(결과 입력 창·경기 상세가 함께 쓴다). 최대 200자, 줄바꿈 허용, 비우면 삭제.
 * 메모는 공개 정보라 조회 링크에서도 보인다는 안내를 칸 옆에 둔다.
 */
export function MemoField(props: { value: string; onChange: (value: string) => void; label?: string }) {
  const id = useId();
  const memo = normalizeMemo(props.value);
  const count = memo === null ? 0 : memoLength(memo);
  const over = count > MEMO_MAX;
  return (
    <div className="memo-edit">
      <label htmlFor={id}>{props.label ?? "메모 (선택)"}</label>
      <textarea
        id={id}
        value={props.value}
        rows={3}
        placeholder="예: 바론 스틸로 역전"
        aria-describedby={`${id}-hint`}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <p id={`${id}-hint`} className="hint">
        조회 링크에서도 보여요. 비우면 메모가 지워져요.{" "}
        <span className={over ? "memo-count over" : "memo-count"}>
          {count}/{MEMO_MAX}자
        </span>
        {over ? " · 글자 수를 줄여 주세요." : ""}
      </p>
    </div>
  );
}

const MEMO_STATES: readonly MatchView["state"][] = ["in_progress", "awaiting_result", "confirmed"];

/**
 * 경기 상세의 메모 구역. 메모는 글자 그대로(줄바꿈 유지) 보여 준다.
 * 운영자는 진행 중·결과 대기·확정 경기에서 쓰고 고칠 수 있다. 조회자에게는 메모가 있을 때만 보인다.
 */
export function MatchMemoSection(props: { match: MatchView; app: AppValue | null }) {
  const { match, app } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editable = app !== null && MEMO_STATES.includes(match.state);
  if (!match.memo && !editable) return null;

  async function save() {
    if (!app?.snapshot || memoTooLong(text)) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${app.snapshot.group.id}/matches/${match.id}/memo`, {
        requestId: newRequestId(),
        memo: text,
        baseMemo: match.memo ?? null,
      });
      await app.refreshAfterOwnChange();
      setEditing(false);
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="메모">
      <h2>메모</h2>
      {editing ? (
        <>
          <MemoField value={text} onChange={setText} label="메모" />
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="primary" disabled={busy || memoTooLong(text)} onClick={() => void save()}>
              {busy ? "저장 중" : "메모 저장"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>
              취소
            </button>
          </div>
        </>
      ) : (
        <>
          {match.memo ? <p className="memo-text">{match.memo}</p> : <p className="hint">메모가 없어요.</p>}
          {editable && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setText(match.memo ?? "");
                setError(null);
                setEditing(true);
              }}
            >
              {match.memo ? "메모 고치기" : "메모 쓰기"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
