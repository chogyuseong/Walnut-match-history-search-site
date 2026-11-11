import { useState } from "react";
import { ROLE_LABEL } from "./account";
import { ErrorNote } from "./ui";
import { go, useAppValue } from "./useApp";

/** 계정당 모임 수(대표 + 공동 운영 합계). 서버의 MAX_GROUPS_PER_ACCOUNT와 같다(src/server/groups.ts). */
export const MAX_GROUPS = 5;

/**
 * 모임 탭 맨 위의 "모임 고르기". 내 모임(대표·공동 운영)을 보여 주고 고르면 그 모임으로 바뀐다(기기에 기억).
 * 모임이 하나면 눈에 띄지 않게 접어 두고 "새 모임 만들기"만 둔다.
 */
export function GroupSwitcher() {
  const app = useAppValue();
  const groups = app.me?.groups ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  if (groups.length === 0) return null;
  const full = groups.length >= MAX_GROUPS;
  // 이름을 바꾼 직후에는 계정 목록이 옛 이름일 수 있어 지금 모임은 기록의 이름을 쓴다.
  const nameOf = (g: { id: string; name: string }) =>
    g.id === app.snapshot?.group.id ? app.snapshot.group.name : g.name;

  function switchTo(id: string, label: string) {
    setError(null);
    void app.switchGroup(id).then(() => app.setNotice(`'${label}' 모임으로 바꿨어요.`));
  }

  // 이름 칸의 보이는 라벨(placeholder는 비웠을 때의 기본값 안내만 한다). 모임 탭에 GroupSwitcher는 하나라 고정 id를 쓴다.
  const createForm = (
    <>
      <label htmlFor="new-group-name">새 모임 이름</label>
      <form
        className="input-row"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          void app
            .createGroup(name.trim() === "" ? undefined : name.trim())
            .then(() => {
              setName("");
              app.setNotice("새 모임을 만들고 그 모임으로 바꿨어요.");
            })
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        <input
          id="new-group-name"
          placeholder="비우면 '내 내전 모임'"
          maxLength={20}
          value={name}
          disabled={full}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={busy || full}>
          새 모임 만들기
        </button>
      </form>
    </>
  );
  const limitHint = (
    <p className="hint">
      한 계정은 대표·공동 운영을 합쳐 모임 {MAX_GROUPS}개까지 맡을 수 있어요
      {full ? ". 더 만들려면 쓰지 않는 모임을 넘기거나 삭제해 주세요." : "."}
    </p>
  );

  if (groups.length === 1) {
    return (
      <details className="group-switch-compact">
        <summary>
          내 모임 {groups.length}/{MAX_GROUPS} · 새 모임 만들기
        </summary>
        {limitHint}
        {createForm}
        <ErrorNote error={error} />
      </details>
    );
  }

  return (
    <section className="card" aria-label="모임 고르기">
      <h2>
        내 모임 {groups.length}/{MAX_GROUPS}
      </h2>
      <ul className="list" aria-label="내 모임 목록">
        {groups.map((g) => {
          const current = g.id === app.groupId;
          const role = ROLE_LABEL[g.role ?? "owner"];
          return (
            <li key={g.id} className={current ? "list-row static selected" : "list-row static"}>
              <span className="name">
                {nameOf(g)} <span className="tag">{role}</span>
              </span>
              {current ? (
                <span className="tag" aria-current="true">
                  지금 모임
                </span>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  aria-label={`${nameOf(g)}(${role}) 열기`}
                  disabled={app.switching}
                  onClick={() => switchTo(g.id, nameOf(g))}
                >
                  열기
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="hint">
        모임을 바꾸면 작성 중인 편성과 고른 참가자는 모임마다 따로 남아 있다가 다시 돌아오면 이어서 쓸 수 있어요.
      </p>
      {limitHint}
      {createForm}
      <ErrorNote error={error} />
    </section>
  );
}

/**
 * 참가 중인 모임(참가자로 연결한 모임, migrations/0019). 운영하는 모임과 따로 보여 준다.
 * 고르면 조회 링크와 같은 읽기 전용 화면(#/mine/모임ID)이 토큰 없이 열린다. 없으면 그리지 않는다.
 */
export function MembershipList() {
  const app = useAppValue();
  const list = app.me?.memberships ?? [];
  if (list.length === 0) return null;
  return (
    <section className="card" aria-label="참가 중인 모임">
      <h2>참가 중인 모임 {list.length}</h2>
      <ul className="list" aria-label="참가 중인 모임 목록">
        {list.map((m) => (
          <li key={m.id} className="list-row static">
            <span className="name">
              {m.name} <span className="tag">참가자 · {m.participantName}</span>
            </span>
            <button
              type="button"
              className="secondary"
              aria-label={`${m.name}(참가 중) 열기`}
              onClick={() => go(`/mine/${m.id}`)}
            >
              열기
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">참가자로 연결한 모임은 기록을 보고, 내 기피 라인을 정하고, 정정을 요청할 수 있어요. 기록은 운영자만 고쳐요.</p>
    </section>
  );
}
