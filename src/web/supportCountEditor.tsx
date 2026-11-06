import { useEffect, useState } from "react";
import { mutate, newRequestId } from "./api";
import { ErrorNote } from "./ui";

const MAX_COUNT = 99;

/**
 * 서포터 횟수 직접 입력(준비 화면과 모임 탭이 같이 쓴다).
 * 사람마다 −/＋와 숫자 칸을 두고, 바꾼 사람만 모아 "저장" 한 번에 보낸다(연타해도 요청이 쏟아지지 않게).
 * 저장한 값은 "N회"로 정한 것이고, 그 뒤 실제로 시작한 경기의 서포터는 계속 더해진다.
 * 저장이 끝나거나 실패하면 최신 상태를 다시 받는다(다른 운영자가 먼저 고쳤으면 그 값이 보인다).
 */
export function SupportCountEditor(props: {
  groupId: string;
  people: readonly { id: string; name: string }[];
  /** 지금 서포터 횟수(사건 수 + 보정값). 없으면 0회. */
  counts: ReadonlyMap<string, number>;
  /** 저장 뒤(성공·실패 모두) 최신 상태를 다시 받는다. */
  refresh: () => Promise<unknown>;
  onSaved?: () => void;
  label: string;
}) {
  const { people, counts } = props;
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valueOf = (id: string) => edits[id] ?? counts.get(id) ?? 0;
  const changed = people.filter((p) => valueOf(p.id) !== (counts.get(p.id) ?? 0));

  // 서버 값이 바뀌어 편집한 값과 같아지면 편집 표시를 지운다.
  useEffect(() => {
    setEdits((current) => {
      const next = Object.fromEntries(
        Object.entries(current).filter(([id, n]) => n !== (counts.get(id) ?? 0)),
      );
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [counts]);

  const set = (id: string, n: number) => {
    if (!Number.isFinite(n)) return;
    setEdits({ ...edits, [id]: Math.max(0, Math.min(MAX_COUNT, Math.round(n))) });
  };

  async function save() {
    if (changed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${props.groupId}/rotation/counts`, {
        requestId: newRequestId(),
        counts: changed.map((p) => ({ participantId: p.id, count: valueOf(p.id) })),
      });
      await props.refresh();
      setEdits({});
      props.onSaved?.();
    } catch (e) {
      setError(e);
      void props.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="count-editor">
      <ul className="list" aria-label={props.label}>
        {people.map((p) => {
          const value = valueOf(p.id);
          const dirty = value !== (counts.get(p.id) ?? 0);
          return (
            <li key={p.id} className={dirty ? "list-row static count-row dirty" : "list-row static count-row"}>
              <span className="name">{p.name}</span>
              <span className="count-stepper">
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${p.name} 서포터 횟수 줄이기`}
                  disabled={busy || value <= 0}
                  onClick={() => set(p.id, value - 1)}
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_COUNT}
                  aria-label={`${p.name} 서포터 횟수`}
                  value={value}
                  disabled={busy}
                  onChange={(e) => set(p.id, e.target.value === "" ? 0 : Number(e.target.value))}
                />
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${p.name} 서포터 횟수 늘리기`}
                  disabled={busy || value >= MAX_COUNT}
                  onClick={() => set(p.id, value + 1)}
                >
                  ＋
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="button-row">
        <button type="button" className="primary" disabled={busy || changed.length === 0} onClick={() => void save()}>
          {busy ? "저장 중" : changed.length > 0 ? `서포터 횟수 저장 (${changed.length}명)` : "서포터 횟수 저장"}
        </button>
        {changed.length > 0 && (
          <button type="button" className="link" disabled={busy} onClick={() => setEdits({})}>
            고친 값 되돌리기
          </button>
        )}
      </div>
      <p className="hint">
        0~{MAX_COUNT}회로 정할 수 있어요. 저장한 뒤 실제로 시작한 경기의 서포터는 이어서 더해져요.
      </p>
      <ErrorNote error={error} />
    </div>
  );
}
