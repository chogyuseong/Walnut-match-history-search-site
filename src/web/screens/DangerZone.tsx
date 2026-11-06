import { useRef, useState } from "react";
import { ApiFailure, call } from "../api";
import { ErrorNote } from "../ui";
import { forgetGroupStorage, go, useAppValue } from "../useApp";
import { downloadJson } from "./Restore";

/** 서버의 확인 문구(src/server/deletion.ts). */
const GROUP_CONFIRM = "삭제";
const ACCOUNT_CONFIRM = "탈퇴";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 삭제가 끝나면 첫 화면을 새로 연다(계정·모임 목록이 바뀌었으므로). */
function reopenHome(): void {
  location.hash = "#/";
  location.reload();
}

/**
 * 모임 삭제·탈퇴(#/delete). 되돌릴 수 없는 동작이라 복원 화면과 같이 확인 문구를 입력해야 실행한다.
 * 모임 삭제는 실행 직전에 백업 파일을 먼저 내려받고, 내려받지 못하면 지우지 않는다.
 */
export function DangerZone() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  // 탈퇴를 막는 것은 대표로 운영하는 모임뿐이다. 공동 운영자로 있는 모임은 탈퇴하면 함께 빠진다(서버가 행을 지운다).
  const groups = (app.me?.groups ?? []).filter((g) => (g.role ?? "owner") === "owner");
  const coGroups = (app.me?.groups ?? []).filter((g) => g.role === "co");
  const isOwner = snapshot !== null && groups.some((g) => g.id === snapshot.group.id);
  const [groupConfirm, setGroupConfirm] = useState("");
  const [accountConfirm, setAccountConfirm] = useState("");
  // 아이디로 가입한 계정은 탈퇴할 때 비밀번호를 한 번 더 확인한다.
  const [accountPassword, setAccountPassword] = useState("");
  const isLocal = app.me?.loginMethod === "local";
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [groupError, setGroupError] = useState<unknown>(null);
  const [accountError, setAccountError] = useState<unknown>(null);
  // 백업을 한 번 내려받았으면 다시 시도할 때 또 받지 않는다.
  const backedUp = useRef(false);

  if (!app.me?.accountId) {
    return (
      <div className="screen">
        <h1>모임 삭제 · 탈퇴</h1>
        <p>로그인한 운영자만 쓸 수 있어요.</p>
        <button type="button" className="primary" onClick={() => go("/")}>
          첫 화면으로
        </button>
      </div>
    );
  }

  async function deleteGroup() {
    if (!snapshot) return;
    const gid = snapshot.group.id;
    setBusy(true);
    setGroupError(null);
    try {
      // 1) 지금 상태를 백업 파일로 먼저 내려받는다. 점검 중(삭제·복원이 중간에 멈춤)이면 불완전해서 받지 않는다.
      if (!backedUp.current && !snapshot.group.maintenance) {
        setStep("백업 파일을 내려받는 중");
        const backup = await call<Record<string, unknown>>("GET", `/api/groups/${gid}/export`);
        downloadJson(backup, `naejeon-before-delete-${today()}.json`);
        backedUp.current = true;
      }
      // 2) 삭제. 응답을 못 받았으면 같은 요청을 다시 보내도 된다(이미 지워졌으면 "찾을 수 없음").
      setStep("모임을 지우는 중");
      try {
        await call("POST", `/api/groups/${gid}/delete`, { confirm: groupConfirm.trim() });
      } catch (e) {
        if (!(e instanceof ApiFailure && e.status === 404 && backedUp.current)) throw e;
      }
      try {
        localStorage.removeItem("naejeon.group");
        localStorage.removeItem("naejeon.draft.v1");
        forgetGroupStorage(gid);
      } catch {
        // 저장소를 못 써도 삭제는 끝났다.
      }
      reopenHome();
    } catch (e) {
      setGroupError(e);
      setStep(null);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    setBusy(true);
    setAccountError(null);
    try {
      await call(
        "POST",
        "/api/account/delete",
        isLocal ? { confirm: accountConfirm.trim(), password: accountPassword } : { confirm: accountConfirm.trim() },
      );
      reopenHome();
    } catch (e) {
      setAccountError(e);
    } finally {
      setBusy(false);
    }
  }

  const groupReady = groupConfirm.trim() === GROUP_CONFIRM;
  const accountReady =
    accountConfirm.trim() === ACCOUNT_CONFIRM && groups.length === 0 && (!isLocal || accountPassword !== "");

  return (
    <div className="screen danger-zone">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/group")}>
          ← 모임
        </button>
        <h1>모임 삭제 · 탈퇴</h1>
      </header>

      {snapshot && !isOwner && (
        <p className="note" role="note">
          모임 삭제는 대표 운영자만 할 수 있어요. 이 계정은 {snapshot.group.name} 모임의 공동 운영자예요.
        </p>
      )}
      {snapshot && isOwner && (
        <section aria-labelledby="dz-group" className="danger-box">
          <h2 id="dz-group">모임 삭제: {snapshot.group.name}</h2>
          <p>
            이 모임의 경기·참가자·변경 내역·설정이 서버에서 <strong>모두 지워지고 되돌릴 수 없습니다.</strong> 조회
            링크는 바로 열리지 않게 됩니다. 운영을 다른 사람에게 맡기려면 지우지 말고 모임 탭의 '운영자 넘기기'를
            써 주세요.
          </p>
          <p className="hint">
            {snapshot.group.maintenance
              ? "점검 중이라 지금 상태는 내려받지 않습니다."
              : "실행하면 먼저 지금 상태를 백업 파일로 내려받습니다. 이 파일로 나중에 새 모임으로 다시 가져올 수 있어요."}
          </p>
          <label>
            확인을 위해 '{GROUP_CONFIRM}'를 입력해 주세요
            <input
              value={groupConfirm}
              onChange={(e) => setGroupConfirm(e.target.value)}
              autoComplete="off"
              maxLength={10}
            />
          </label>
          {step && (
            <p className="hint" role="status">
              {step}…
            </p>
          )}
          <ErrorNote error={groupError} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy || !groupReady}
              onClick={() => void deleteGroup()}
            >
              {snapshot.group.maintenance ? "모임 삭제 다시 실행" : "백업 내려받고 모임 삭제"}
            </button>
          </div>
        </section>
      )}

      <section aria-labelledby="dz-account" className="danger-box">
        <h2 id="dz-account">탈퇴(계정 삭제)</h2>
        <p>
          이 로그인 계정의 기록(로그인 수단과 고유 번호, 아이디로 가입했다면 아이디와 비밀번호·복구 코드의 해시)을
          지우고 모든 기기에서 로그아웃합니다. 같은 카카오·Google 계정이나 같은 아이디로 다시 시작하면 새 계정이
          됩니다.
        </p>
        {coGroups.length > 0 && groups.length === 0 && (
          <p className="hint">
            공동 운영자로 있는 모임({coGroups.map((g) => g.name).join(", ")})에서는 탈퇴하면 함께 빠져요. 모임의 기록은
            그대로 남아요.
          </p>
        )}
        {groups.length > 0 ? (
          <div className="note warn" role="note">
            <p>운영 중인 모임이 있어 지금은 탈퇴할 수 없어요. 먼저 넘기거나 삭제해 주세요.</p>
            <ul className="problem-list">
              {groups.map((g) => (
                <li key={g.id}>{g.name}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <label>
              확인을 위해 '{ACCOUNT_CONFIRM}'를 입력해 주세요
              <input
                value={accountConfirm}
                onChange={(e) => setAccountConfirm(e.target.value)}
                autoComplete="off"
                maxLength={10}
              />
            </label>
            {isLocal && (
              <label>
                지금 비밀번호
                <input
                  type="password"
                  autoComplete="current-password"
                  value={accountPassword}
                  onChange={(e) => setAccountPassword(e.target.value)}
                  maxLength={128}
                />
              </label>
            )}
            <ErrorNote error={accountError} />
            <div className="button-row">
              <button
                type="button"
                className="danger"
                disabled={busy || !accountReady}
                onClick={() => void deleteAccount()}
              >
                탈퇴하기
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
