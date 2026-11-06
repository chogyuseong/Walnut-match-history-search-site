import { useCallback, useEffect, useState } from "react";
import { call, mutate, newRequestId } from "./api";
import { CopyButton, Dialog, ErrorNote } from "./ui";

/** 운영자용 신청 한 사람(src/server/join.ts JoinEntry). */
export interface JoinEntryView {
  key: string;
  name: string;
  participantId: string | null;
  createdAt: string;
  /** 본인 확인된 신청(연결한 참가자가 로그인해 직접 신청, migrations/0019). 본인과 운영자만 뺄 수 있다. */
  verified?: true;
}

interface AdminView {
  /** token: 링크 원문(서버 저장, migrations/0015). 그 전에 만든 링크는 null이라 다시 만들어야 복사할 수 있다. */
  link: { open: boolean; createdAt: string; token: string | null } | null;
  entries: JoinEntryView[];
  max: number;
  target: number;
}

export function joinLink(token: string): string {
  return `${location.origin}/#/join/${token}`;
}

/** 참가자 고르기 화면 위쪽의 "참가 신청" 구역(대표·공동 운영자). */
export function JoinPanel(props: {
  groupId: string;
  selectedKeys: ReadonlySet<string>;
  onLoad: (entries: readonly JoinEntryView[]) => void;
}) {
  const { groupId } = props;
  const [view, setView] = useState<AdminView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState<null | "regenerate" | "clear">(null);

  const load = useCallback(async () => {
    try {
      setView(await call<AdminView>("GET", `/api/groups/${groupId}/join`));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [groupId]);

  useEffect(() => {
    void load();
    // 예전에는 링크 주소를 기기에 기억했다. 이제 서버가 주므로 남은 값을 지운다.
    try {
      localStorage.removeItem(`naejeon.joinToken.${groupId}`);
    } catch {
      // 저장소를 못 써도 동작에는 영향이 없다.
    }
  }, [groupId, load]);

  async function run(work: () => Promise<AdminView | void>) {
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (next) setView(next);
      else await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const createLink = () =>
    run(async () => {
      await call<{ token: string }>("POST", `/api/groups/${groupId}/join/link`);
      setConfirm(null);
    });

  const entries = view?.entries ?? [];
  const target = view?.target ?? 10;
  const link = view?.link ?? null;
  const token = link?.token ?? null;
  // 불러오는 동안에도 같은 모양(버튼은 꺼 둠)으로 그려 아래 화면이 밀리지 않게 한다.
  const loading = !view && !error;
  const off = busy || loading;

  return (
    <section className="card join-panel" aria-label="참가 신청">
      <div className="section-head">
        <h2>참가 신청 {entries.length > 0 ? `${entries.length}명` : ""}</h2>
        <span className="tag">{loading ? "확인 중" : !link ? "링크 없음" : link.open ? "받는 중" : "닫힘"}</span>
      </div>
      <p className="hint">
        링크를 보내면 참가자가 로그인 없이 "오늘 참가"를 눌러요. 본인 확인이 없어 링크를 가진 사람은 누구의 신청이든
        넣고 뺄 수 있어요. 본인과 연결한 참가자가 로그인한 채 신청하면 '본인 확인됨'으로 들어가고, 그 신청은 본인과
        운영자만 뺄 수 있어요.
      </p>
      <ErrorNote error={error} />
      {(view || loading) && (
        <>
          <div className="button-row">
            {!link ? (
              <button type="button" className="secondary" disabled={off} onClick={() => void createLink()}>
                신청 링크 만들기
              </button>
            ) : (
              <>
                {token ? (
                  <CopyButton label="신청 링크 복사" text={() => joinLink(token)} />
                ) : (
                  <span className="hint">예전에 만든 링크라 주소를 보여줄 수 없어요. 다시 만들면 복사할 수 있어요.</span>
                )}
                <button type="button" className="link" disabled={busy} onClick={() => setConfirm("regenerate")}>
                  링크 다시 만들기
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      mutate<AdminView>(`/api/groups/${groupId}/join/open`, {
                        requestId: newRequestId(),
                        open: !link.open,
                      }),
                    )
                  }
                >
                  {link.open ? "신청 닫기" : "신청 다시 받기"}
                </button>
              </>
            )}
            <button type="button" className="link" disabled={off} onClick={() => void load()}>
              새로 고침
            </button>
          </div>

          {entries.length === 0 ? (
            <p className="hint">{loading ? "불러오는 중…" : "아직 신청한 사람이 없어요."}</p>
          ) : (
            <ol className="list join-list" aria-label="신청자 목록">
              {entries.map((e, i) => {
                const key = e.participantId ? `p:${e.participantId}` : null;
                return (
                  <li key={e.key} className="list-row static">
                    <span className="name">
                      {i + 1}. {e.name}
                      {!e.participantId && <span className="tag">새 이름</span>}
                      {e.verified && <span className="tag">본인 확인됨</span>}
                      {i >= target && <span className="tag">대기</span>}
                      {key && props.selectedKeys.has(key) && <span className="tag">선택됨</span>}
                    </span>
                    <button
                      type="button"
                      className="link"
                      disabled={busy}
                      aria-label={`${e.name} 신청 지우기`}
                      onClick={() =>
                        void run(() =>
                          mutate<AdminView>(`/api/groups/${groupId}/join/remove`, {
                            requestId: newRequestId(),
                            key: e.key,
                          }),
                        )
                      }
                    >
                      지우기
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={entries.length === 0}
              onClick={() => props.onLoad(entries)}
            >
              신청자 {entries.length}명 불러오기
            </button>
            {entries.length > 0 && (
              <button type="button" className="link" disabled={busy} onClick={() => setConfirm("clear")}>
                신청 비우기
              </button>
            )}
          </div>
          {entries.length > target && (
            <p className="hint">
              앞 {target}명을 고르고 {entries.length - target}명은 대기로 둬요. 신청 목록은 경기를 시작해도 남아요.
            </p>
          )}
        </>
      )}

      {confirm === "regenerate" && (
        <Dialog title="신청 링크 다시 만들기" onClose={() => setConfirm(null)}>
          <p>새 링크를 만들면 지금까지 보낸 신청 링크는 더 이상 열리지 않아요. 신청 목록은 그대로예요.</p>
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void createLink()}>
              새 링크 만들기
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
      {confirm === "clear" && (
        <Dialog title="신청 비우기" onClose={() => setConfirm(null)}>
          <p>신청자 {entries.length}명을 모두 지워요. 링크는 그대로라 새로 신청을 받을 수 있어요.</p>
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const next = await mutate<AdminView>(`/api/groups/${groupId}/join/clear`, {
                    requestId: newRequestId(),
                  });
                  setConfirm(null);
                  return next;
                })
              }
            >
              신청 비우기
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
