import { useEffect, useState } from "react";
import { ApiFailure, call } from "../api";
import { formatDate, formatTime } from "../format";
import { ErrorNote } from "../ui";
import { GROUP_KEY, useAppValue } from "../useApp";
import { RenewLinksChoice, renewShareLinks } from "./CoOperators";
import { LoginDialog } from "./Login";

/** 넘겨받은 모임을 연다. 계정의 모임 목록이 바뀌었으므로 처음부터 다시 불러온다. */
function openGroupTab() {
  location.hash = "/group";
  location.reload();
}

/** 운영자 인수 링크를 연 화면. 로그인한 뒤 수락하면 이 계정이 모임의 운영자가 된다. */
export function Transfer(props: { token: string }) {
  const app = useAppValue();
  const [info, setInfo] = useState<{ groupName: string; expiresAt: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [renewLinks, setRenewLinks] = useState(false);
  // 넘겨받기는 됐는데 링크 바꾸기만 실패했을 때의 오류.
  const [renewFailed, setRenewFailed] = useState<unknown>(null);

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
        localStorage.setItem(GROUP_KEY, result.groupId);
      } catch {
        // 보관하지 못해도 첫 모임으로 열린다.
      }
      if (renewLinks) {
        try {
          await renewShareLinks(result.groupId);
        } catch (e) {
          // 넘겨받기는 끝났다. 링크만 못 바꿨으니 알리고, 모임 탭에서 다시 만들게 한다.
          setRenewFailed(e);
          setBusy(false);
          return;
        }
      }
      openGroupTab();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "TRANSFER_INVALID") setInvalid(true);
      else setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>운영자 넘겨받기</h1>
      {renewFailed ? (
        <>
          <p className="note error" role="alert">
            운영자는 맡았지만 조회 링크·참가 신청 링크는 새로 만들지 못했어요. 모임 탭에서 다시 만들어 주세요.
          </p>
          <ErrorNote error={renewFailed} />
          <button type="button" className="primary wide" onClick={openGroupTab}>
            모임 탭 열기
          </button>
        </>
      ) : invalid ? (
        <p className="note error" role="alert">
          이 링크는 이미 썼거나 만료됐어요. 현재 운영자에게 새 링크를 요청해 주세요.
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
              <strong>{info.groupName}</strong> 모임의 운영자가 돼요.
            </p>
            <p className="hint">
              수락하면 경기 시작·결과 저장·정정·설정을 이 계정으로 하게 되고, 이전 운영자는 수정할
              수 없게 돼요. 기록은 그대로이고, 조회 링크는 아래에서 고를 때만 바뀌어요.
            </p>
            <p className="hint">
              링크 만료: {formatDate(info.expiresAt)} {formatTime(info.expiresAt)}
            </p>
          </section>
          {app.me?.accountId && <RenewLinksChoice checked={renewLinks} onChange={setRenewLinks} who="이전 운영자" />}
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
