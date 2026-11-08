import { useCallback, useEffect, useState } from "react";
import { MAX_NAME_LENGTH, nameKey } from "../../shared/names";
import { matchesName } from "../../shared/search";
import { ApiFailure, call } from "../api";
import { ErrorNote } from "../ui";
import { go } from "../useApp";
import { Privacy } from "./Privacy";

/** 공개 응답(src/server/join.ts JoinPublicView). 이름과 신청 여부만 있다. */
interface JoinView {
  groupName: string;
  open: boolean;
  max: number;
  target: number;
  /** verified: 본인 확인된 신청(본인·운영자만 뺄 수 있음). mine: 로그인한 내가 본인 확인한 신청. */
  entries: { key: string; name: string; verified?: true; mine?: true }[];
  people: { id: string; name: string }[];
  /** 로그인한 멤버(이 모임의 참가자와 연결한 계정)면 내 참가자 ID. */
  me?: { participantId: string };
}

/**
 * 참가 신청 화면(#/join/토큰). 로그인이 없다. 자기 이름을 눌러 "오늘 참가"를 신청하고, 명단에 없으면 새 이름을 넣는다.
 * 익명 신청은 본인 확인 수단이 없으므로 링크를 가진 사람은 누구의 신청이든 넣고 뺄 수 있다(화면에 안내한다).
 * 본인과 연결한 참가자(멤버)가 로그인한 채 열면 내 이름이 맨 위에 미리 골라져 있고, 신청하면 '본인 확인됨'으로 들어간다.
 * 본인 확인된 신청은 본인과 운영자만 뺄 수 있어 다른 사람에게는 취소 버튼을 보여주지 않는다(서버도 거절).
 */
export function Join(props: { token: string; rest: string[] }) {
  const { token } = props;
  const [view, setView] = useState<JoinView | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await call<JoinView>("GET", `/api/join/${token}`));
      setError(null);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setInvalid(true);
      else setError(e);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  if (props.rest[0] === "privacy") {
    return <Privacy back={() => go(`/join/${token}`)} backLabel="← 참가 신청" />;
  }

  async function send(path: string, body: Record<string, unknown>, message: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setView(await call<JoinView>("POST", path, body));
      setDone(message);
      return true;
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "JOIN_INVALID") setInvalid(true);
      else setError(e);
      // 닫혔거나 꽉 찼으면 지금 상태를 다시 보여준다.
      void load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <div className="screen">
        <h1>참가 신청</h1>
        <p className="note warn" role="alert">
          이 신청 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요.
        </p>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="screen">
        <h1>참가 신청</h1>
        {error ? (
          <>
            <ErrorNote error={error} />
            <button type="button" className="secondary" onClick={() => void load()}>
              다시 불러오기
            </button>
          </>
        ) : (
          <p>불러오는 중…</p>
        )}
      </div>
    );
  }

  const joined = new Set(view.entries.map((e) => e.key));
  const myPerson = view.me ? (view.people.find((p) => p.id === view.me!.participantId) ?? null) : null;
  const myEntry = myPerson ? (view.entries.find((e) => e.key === `p:${myPerson.id}`) ?? null) : null;
  const count = view.entries.length;
  // 공백·대소문자를 무시하고 초성("ㄱㅅ")으로도 찾는다(전적 검색과 같은 규칙).
  const listed = view.people
    .filter((p) => matchesName(p.name, query))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const typed = newName.trim();
  const sameInList = typed !== "" ? view.people.find((p) => nameKey(p.name) === nameKey(typed)) : undefined;

  return (
    <div className="screen join-screen">
      <header className="screen-head">
        <h1>{view.groupName} 참가 신청</h1>
        <strong className="count" aria-label={`신청 ${count}명, 한 판 ${view.target}명`}>
          {count} / {view.target}명
        </strong>
      </header>
      {view.open ? (
        <p className="note" role="status">
          신청 받는 중이에요. 자기 이름을 눌러 "오늘 참가"를 신청해 주세요.
          {count >= view.target ? ` 이미 ${view.target}명이 넘어 지금 신청하면 대기예요.` : ""}
        </p>
      ) : (
        <p className="note warn" role="status">
          지금은 신청을 받지 않아요. 신청·취소는 운영자가 다시 열면 할 수 있어요.
        </p>
      )}
      <p className="hint">
        로그인 없이 쓰는 화면이라 본인 확인을 하지 않아요. 다른 사람의 이름은 누르지 말아 주세요. 팀 편성은 운영자가
        정해요. 운영자에게 받은 연결 링크로 내 이름을 계정에 연결해 두면, 로그인한 채 신청할 때 '본인 확인됨'으로 들어가요.
      </p>
      <ErrorNote error={error} />
      {done && (
        <p className="note" role="status">
          {done}
        </p>
      )}

      {myPerson && (
        <section className="card" aria-label="내 이름으로 신청">
          <p>
            로그인한 계정과 연결된 이름: <strong>{myPerson.name}</strong>
          </p>
          {myEntry?.mine ? (
            <p className="hint">본인 확인된 신청이에요. 본인과 운영자만 뺄 수 있어요.</p>
          ) : view.open ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void send(`/api/join/${token}`, { participantId: myPerson.id }, `${myPerson.name} 님, 본인 확인으로 신청했어요.`)
              }
            >
              {myEntry ? "내 신청을 본인 확인으로 바꾸기" : `${myPerson.name}(으)로 오늘 참가`}
            </button>
          ) : null}
        </section>
      )}

      <section aria-label="신청한 사람">
        <h2>신청한 사람 {count}명</h2>
        {count === 0 ? (
          <p className="hint">아직 신청한 사람이 없어요.</p>
        ) : (
          <ol className="list join-list">
            {view.entries.map((e, i) => (
              <li key={e.key} className="list-row static">
                <span className="name">
                  {i + 1}. {e.name}
                  {i >= view.target && <span className="tag">대기</span>}
                  {e.verified && <span className="tag">본인 확인됨</span>}
                </span>
                {view.open && (!e.verified || e.mine) && (
                  <button
                    type="button"
                    className="link"
                    disabled={busy}
                    aria-label={`${e.name} 신청 취소`}
                    onClick={() =>
                      void send(`/api/join/${token}/cancel`, { key: e.key }, `${e.name} 신청을 취소했어요.`)
                    }
                  >
                    취소
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {view.open && (
        <>
          <section aria-label="명단에서 신청">
            <h2>명단에서 내 이름 찾기</h2>
            <input
              type="search"
              aria-label="이름 검색"
              placeholder="이름 검색"
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <ul className="list">
              {listed.map((p) => {
                const isJoined = joined.has(`p:${p.id}`);
                return (
                  <li key={p.id} className="list-row static">
                    <span className="name">
                      {p.name}
                      {isJoined && <span className="tag">신청함</span>}
                    </span>
                    {!isJoined && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        aria-label={`${p.name} 오늘 참가`}
                        onClick={() =>
                          void send(`/api/join/${token}`, { participantId: p.id }, `${p.name} 님, 신청했어요.`).then(
                            (ok) => ok && setQuery(""),
                          )
                        }
                      >
                        오늘 참가
                      </button>
                    )}
                  </li>
                );
              })}
              {listed.length === 0 && <li className="hint">명단에 일치하는 이름이 없어요. 아래에 새 이름을 넣어 주세요.</li>}
            </ul>
          </section>

          <section aria-label="새 이름으로 신청">
            <h2>명단에 없으면</h2>
            <form
              className="input-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (typed === "") return;
                void send(`/api/join/${token}`, { name: typed }, `${typed} 님, 신청했어요.`).then(
                  (ok) => ok && setNewName(""),
                );
              }}
            >
              <input
                aria-label="새 이름"
                placeholder="새 이름"
                maxLength={MAX_NAME_LENGTH}
                autoComplete="off"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button type="submit" className="secondary" disabled={busy || typed === ""}>
                신청
              </button>
            </form>
            {sameInList && (
              <p className="hint">명단에 '{sameInList.name}'이(가) 있어요. 신청하면 그 사람으로 들어가요.</p>
            )}
          </section>
        </>
      )}

      <p className="hint">
        <button type="button" className="link" onClick={() => void load()}>
          새로 고침
        </button>
      </p>
    </div>
  );
}
