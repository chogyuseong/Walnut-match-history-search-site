import { useCallback, useEffect, useState } from "react";
import { ApiFailure, call, mutate, newRequestId } from "./api";
import { CopyButton, Dialog, ErrorNote } from "./ui";

/** 운영자용 신청 한 사람(src/server/join.ts JoinEntry). */
export interface JoinEntryView {
  key: string;
  name: string;
  participantId: string | null;
  createdAt: string;
}

interface AdminView {
  link: { open: boolean; createdAt: string } | null;
  entries: JoinEntryView[];
  max: number;
  target: number;
}

/**
 * 신청 링크 토큰은 서버에 해시만 있어 만들 때 한 번만 받는다. 이 기기에서 다시 복사할 수 있게 모임마다 기억한다.
 * 다른 기기(다른 공동 운영자)에서 다시 만들면 여기 기억한 토큰은 무효가 되므로 열 때 확인해 지운다.
 */
function tokenKey(groupId: string): string {
  return `naejeon.joinToken.${groupId}`;
}

function readToken(groupId: string): string | null {
  try {
    return localStorage.getItem(tokenKey(groupId));
  } catch {
    return null;
  }
}

function writeToken(groupId: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(tokenKey(groupId), token);
    else localStorage.removeItem(tokenKey(groupId));
  } catch {
    // 기억하지 못하면 이번 화면에서만 복사할 수 있다.
  }
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
  const [token, setToken] = useState<string | null>(() => readToken(groupId));
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
    // 기억한 토큰이 아직 유효한지 확인한다(다른 기기에서 다시 만들었으면 지운다).
    const stored = readToken(groupId);
    if (stored) {
      call("GET", `/api/join/${stored}`).catch((e) => {
        if (e instanceof ApiFailure && e.status === 404) {
          writeToken(groupId, null);
          setToken(null);
        }
      });
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
      const created = await call<{ token: string }>("POST", `/api/groups/${groupId}/join/link`);
      writeToken(groupId, created.token);
      setToken(created.token);
      setConfirm(null);
    });

  const entries = view?.entries ?? [];
  const target = view?.target ?? 10;
  const link = view?.link ?? null;

  return (
    <section className="card join-panel" aria-label="참가 신청">
      <div className="section-head">
        <h2>참가 신청 {entries.length > 0 ? `${entries.length}명` : ""}</h2>
        <span className="tag">{!link ? "링크 없음" : link.open ? "받는 중" : "닫힘"}</span>
      </div>
      <p className="hint">
        링크를 보내면 참가자가 로그인 없이 "오늘 참가"를 눌러요. 본인 확인이 없어 링크를 가진 사람은 누구의 신청이든
        넣고 뺄 수 있어요.
      </p>
      <ErrorNote error={error} />
      {!view ? (
        !error && <p className="hint">불러오는 중…</p>
      ) : (
        <>
          <div className="button-row">
            {!link ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => void createLink()}>
                신청 링크 만들기
              </button>
            ) : (
              <>
                {token ? (
                  <CopyButton label="신청 링크 복사" text={() => joinLink(token)} />
                ) : (
                  <span className="hint">이 기기에는 링크 주소가 없어요. 다시 만들면 복사할 수 있어요.</span>
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
            <button type="button" className="link" disabled={busy} onClick={() => void load()}>
              새로 고침
            </button>
          </div>

          {entries.length === 0 ? (
            <p className="hint">아직 신청한 사람이 없어요.</p>
          ) : (
            <ol className="list join-list" aria-label="신청자 목록">
              {entries.map((e, i) => {
                const key = e.participantId ? `p:${e.participantId}` : null;
                return (
                  <li key={e.key} className="list-row static">
                    <span className="name">
                      {i + 1}. {e.name}
                      {!e.participantId && <span className="tag">새 이름</span>}
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
