import { useEffect, useState } from "react";
import { ApiFailure, call } from "../api";
import { formatDate, formatTime } from "../format";
import { ErrorNote } from "../ui";
import { useAppValue } from "../useApp";
import { LoginDialog } from "./Login";

/** 운영자 인수 링크를 연 화면. 로그인한 뒤 수락하면 이 계정이 모임의 운영자가 된다. */
export function Transfer(props: { token: string }) {
  const app = useAppValue();
  const [info, setInfo] = useState<{ groupName: string; expiresAt: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    call<{ groupName: string; expiresAt: string }>("GET", `/api/transfer/${props.token}`)
      .then(setInfo)
      .catch((e) => {
        if (e instanceof ApiFailure && e.status === 404) setInvalid(true);
        else setError(e);
      });
  }, [props.token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ groupId: string }>("POST", `/api/transfer/${props.token}/accept`);
      try {
        localStorage.setItem("naejeon.group", result.groupId);
      } catch {
        // 보관하지 못해도 첫 모임으로 열린다.
      }
      // 계정의 모임 목록이 바뀌었으므로 처음부터 다시 불러온다.
      location.hash = "/group";
      location.reload();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "TRANSFER_INVALID") setInvalid(true);
      else setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>운영자 넘겨받기</h1>
      {invalid ? (
        <p className="note error" role="alert">
          이 링크는 이미 썼거나 만료됐습니다. 현재 운영자에게 새 링크를 요청해 주세요.
        </p>
      ) : !info ? (
        <>
          {!error && <p>불러오는 중…</p>}
          <ErrorNote error={error} />
        </>
      ) : (
        <>
          <section className="card">
            <p>
              <strong>{info.groupName}</strong> 모임의 운영자가 됩니다.
            </p>
            <p className="hint">
              수락하면 경기 시작·결과 저장·정정·설정을 이 계정으로 하게 되고, 이전 운영자는 수정할
              수 없게 됩니다. 기록과 조회 링크는 바뀌지 않습니다.
            </p>
            <p className="hint">
              링크 만료: {formatDate(info.expiresAt)} {formatTime(info.expiresAt)}
            </p>
          </section>
          <ErrorNote error={error} />
          {app.me?.accountId ? (
            <button type="button" className="primary wide" disabled={busy} onClick={() => void accept()}>
              {busy ? "처리 중" : "운영자 맡기"}
            </button>
          ) : (
            <button type="button" className="primary wide" onClick={() => setLoginOpen(true)}>
              로그인하고 계속
            </button>
          )}
        </>
      )}
      {loginOpen && (
        <LoginDialog
          reason="운영자를 넘겨받을 계정으로 로그인해 주세요."
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      )}
    </div>
  );
}
