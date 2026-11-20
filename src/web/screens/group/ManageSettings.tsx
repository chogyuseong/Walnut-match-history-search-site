// 모임 탭 '모임 관리'의 구역들: 모임 이름, 백업 내려받기, 운영자 넘기기(대표 운영자만). 공동 운영자는 ../CoOperators.tsx.
import { useState } from "react";
import { call, mutate, newRequestId } from "../../api";
import { todayIn } from "../../../shared/stats";
import { isReauthError, RecentLoginNote, useRecentLogin } from "../../recentLogin";
import { CopyButton, Dialog, ErrorNote } from "../../ui";
import type { GroupKit } from "./kit";

export function GroupNameSection({ kit }: { kit: GroupKit }) {
  // null이면 고치지 않은 상태라 칸에 지금 이름을 보여준다. 저장에 성공하면 다시 null.
  const [name, setName] = useState<string | null>(null);
  return (
    <section aria-label="모임 이름">
      <h2>모임 이름</h2>
      <form
        className="input-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (name === null || name.trim() === "") return;
          void kit
            .run(() => mutate(`/api/groups/${kit.gid}`, { requestId: newRequestId(), name }, "PATCH"), "모임 이름을 바꿨어요.", "name")
            .then((ok) => ok && setName(null));
        }}
      >
        <input
          aria-label="모임 이름"
          value={name ?? kit.snapshot.group.name}
          maxLength={20}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={kit.busy || name === null || name.trim() === ""}>
          저장
        </button>
      </form>
      {name !== null && name.trim() === "" && <p className="hint">모임 이름을 한 글자 이상 적어 주세요.</p>}
      {kit.placeError("name")}
    </section>
  );
}

export function BackupSection({ kit }: { kit: GroupKit }) {
  return (
    <section aria-label="백업">
      <h2>백업</h2>
      <p className="hint">
        경기·참가자·설정·변경 이력이 들어가요. 계정과 모임 링크는 들어가지 않아요.
      </p>
      <button
        type="button"
        className="secondary"
        disabled={kit.busy}
        onClick={() =>
          void kit.run(async () => {
            const backup = await call<Record<string, unknown>>("GET", `/api/groups/${kit.gid}/export`);
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `naejeon-backup-${todayIn(kit.snapshot.group.timezone)}.json`;
            anchor.click();
            URL.revokeObjectURL(url);
          }, "백업 파일을 내려받았어요.", "backup")
        }
      >
        백업 내려받기
      </button>
      {kit.placeError("backup")}
    </section>
  );
}

/**
 * 운영자 넘기기: 1회용·24시간 인수 링크를 만든다. 받는 사람이 수락하면 이 계정은 모임을 고칠 수 없다.
 * 아이디로 가입한 계정은 비밀번호를 한 번 더, 카카오·Google 계정은 최근 로그인을 서버가 확인한다(src/web/recentLogin.tsx).
 */
export function TransferSection({ kit }: { kit: GroupKit }) {
  const { app, busy, error } = kit;
  const [open, setOpen] = useState(false);
  const [transferLink, setTransferLink] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const needsPassword = app.me?.loginMethod === "local";
  const recentLogin = useRecentLogin(app.me, error);
  const close = () => {
    setOpen(false);
    setTransferLink(null);
    setPassword("");
  };
  return (
    <section aria-label="운영자 넘기기">
      <h2>운영자 넘기기</h2>
      <p className="hint">
        모임 운영을 다른 사람에게 넘겨요. 받는 사람이 링크를 열어 수락하면 그 사람이 운영자가
        되고, 이 계정은 더 이상 이 모임을 수정할 수 없어요. 기록과 모임 링크는 그대로예요.
      </p>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        인수 링크 만들기
      </button>

      {open && (
        <Dialog title="운영자 넘기기" onClose={close}>
          {transferLink === null ? (
            <>
              <p>
                인수 링크는 한 번만 쓸 수 있고 24시간 뒤 만료돼요. 링크를 받은 사람이 수락하는
                순간 이 계정은 이 모임을 수정할 수 없게 돼요.
              </p>
              {needsPassword && (
                <label>
                  지금 비밀번호
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={128}
                  />
                </label>
              )}
              <RecentLoginNote me={app.me} blocked={recentLogin.blocked} />
              <ErrorNote error={isReauthError(error) ? null : error} />
              <div className="button-row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy || (needsPassword && password === "") || recentLogin.blocked}
                  onClick={() =>
                    void kit.track(async () => {
                      const created = await call<{ token: string }>(
                        "POST",
                        `/api/groups/${kit.gid}/transfer`,
                        needsPassword ? { password } : undefined,
                      );
                      setPassword("");
                      setTransferLink(`${location.origin}/#/transfer/${created.token}`);
                    })
                  }
                >
                  인수 링크 만들기
                </button>
                <button type="button" className="secondary" onClick={() => setOpen(false)}>
                  그만두기
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                링크를 만들었어요. 넘겨받을 사람에게만 보내세요. 새 링크를 만들면 이 링크는
                무효가 돼요.
              </p>
              <CopyButton label="인수 링크 복사" text={() => transferLink} />
            </>
          )}
        </Dialog>
      )}
    </section>
  );
}
