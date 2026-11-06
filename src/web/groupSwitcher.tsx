import { useState } from "react";
import { ErrorNote } from "./ui";
import { useAppValue } from "./useApp";

/** 계정당 모임 수(대표 + 공동 운영 합계). 서버의 MAX_GROUPS_PER_ACCOUNT와 같다(src/server/groups.ts). */
export const MAX_GROUPS = 5;

export const ROLE_LABEL = { owner: "대표", co: "공동 운영자" } as const;

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

  const createForm = (
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
        aria-label="새 모임 이름"
        placeholder="새 모임 이름(비우면 '내 내전 모임')"
        maxLength={20}
        value={name}
        disabled={full}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="secondary" disabled={busy || full}>
        새 모임 만들기
      </button>
    </form>
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
