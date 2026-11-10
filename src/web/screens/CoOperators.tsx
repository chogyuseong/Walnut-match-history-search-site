import { useEffect, useState } from "react";
import { ApiFailure, call } from "../api";
import { formatDate, formatTime } from "../format";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { LoginDialog } from "./Login";

/** 서버의 공동 운영자 목록 한 줄(src/server/coOperators.ts CoOperatorView). */
interface CoOperatorRow {
  accountId: string;
  provider: string;
  loginId: string | null;
  accountCreatedAt: string;
  joinedAt: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  local: "아이디 계정",
  kakao: "카카오 계정",
  google: "Google 계정",
  fake: "개발용 계정",
};

/** 목록에 보여줄 계정 이름. 계정에 이미 저장된 것만 쓴다(자체 계정 아이디, 또는 로그인 수단 + 등록일). */
function accountLabel(row: CoOperatorRow): string {
  if (row.loginId) return `${row.loginId} (${PROVIDER_LABEL.local})`;
  return `${PROVIDER_LABEL[row.provider] ?? "다른 계정"} · ${formatDate(row.accountCreatedAt)} 가입`;
}

/** 모임 탭의 조회 링크 칸(Group.tsx). 접혀 있는 "자주 쓰는 것" 묶음을 펼친 뒤 그 칸으로 내려간다. */
function showViewLinkSection() {
  const block = document.getElementById("group-block-often") as HTMLDetailsElement | null;
  if (block && !block.open) block.open = true;
  document.getElementById("group-view-link")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 모임 탭(대표 운영자): 공동 운영자 목록, 초대 링크 만들기, 내보내기. */
export function CoOperatorsSection(props: { gid: string }) {
  const app = useAppValue();
  const [rows, setRows] = useState<CoOperatorRow[] | null>(null);
  const [max, setMax] = useState(5);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CoOperatorRow | null>(null);
  // 내보낸 뒤 링크를 다시 만들라는 안내. 닫거나 화면을 떠날 때까지 둔다(잠깐 뜨는 알림으로는 놓치기 쉽다).
  const [removedHint, setRemovedHint] = useState(false);

  async function load() {
    try {
      const res = await call<{ coOperators: CoOperatorRow[]; max: number }>("GET", `/api/groups/${props.gid}/co-operators`);
      setRows(res.coOperators);
      setMax(res.max);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void load();
    // 모임이 바뀌면 다시 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.gid]);

  const full = rows !== null && rows.length >= max;

  return (
    <section aria-label="공동 운영자">
      <h2>공동 운영자</h2>
      <p className="hint">
        내가 없는 날에도 다른 사람이 경기를 기록할 수 있게 공동 운영자를 둘 수 있어요(최대 {max}명). 공동
        운영자는 경기·참가자·설정을 똑같이 다루지만 운영자 넘기기, 모임 삭제, 백업에서 복원, 공동 운영자 초대·내보내기는
        대표 운영자(이 계정)만 할 수 있어요.
      </p>
      {rows === null ? (
        !error && <p className="hint">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="hint">아직 공동 운영자가 없어요.</p>
      ) : (
        <ul className="list" aria-label="공동 운영자 목록">
          {rows.map((row) => (
            <li key={row.accountId} className="list-row static">
              <span className="name">
                {accountLabel(row)}
                <br />
                <span className="hint">{formatDate(row.joinedAt)}부터 공동 운영</span>
              </span>
              <button type="button" className="danger" disabled={busy} onClick={() => setRemoving(row)}>
                내보내기
              </button>
            </li>
          ))}
        </ul>
      )}
      {removedHint && (
        // 내보낸 사람도 조회 링크·참가 신청 링크 주소는 그대로 알고 있다(링크에는 계정 확인이 없다).
        // 자동으로 바꾸면 참가자들이 가진 링크까지 끊기므로, 바꿀지는 운영자가 정하게 길만 알려 준다(2026-11-10 보안 감사).
        <div role="status" aria-label="링크 다시 만들기 안내" className="card">
          <p>
            내보낸 사람도 조회 링크와 참가 신청 링크는 그대로 열 수 있어요. 막으려면 두 링크를 다시 만들어 참가자에게 새로
            보내 주세요.
          </p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={showViewLinkSection}>
              조회 링크 다시 만들기
            </button>
            <button type="button" className="secondary" onClick={() => go("/pick")}>
              참가 신청 링크 다시 만들기
            </button>
            <button type="button" className="link" onClick={() => setRemovedHint(false)}>
              닫기
            </button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
      <button
        type="button"
        className="secondary"
        disabled={full}
        onClick={() => {
          setLink(null);
          setError(null);
          setInviteOpen(true);
        }}
      >
        초대 링크 만들기
      </button>
      {full && <p className="hint">공동 운영자가 {max}명이라 더 초대할 수 없어요.</p>}

      {inviteOpen && (
        <Dialog title="공동 운영자 초대" onClose={() => setInviteOpen(false)}>
          {link === null ? (
            <>
              <p>
                초대 링크는 한 번만 쓸 수 있고 24시간 뒤 만료됩니다. 링크를 받은 사람이 로그인해 수락하면 공동 운영자가
                됩니다. 새 링크를 만들면 쓰지 않은 이전 링크는 무효가 됩니다.
              </p>
              <ErrorNote error={error} />
              <div className="button-row">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const created = await call<{ token: string }>("POST", `/api/groups/${props.gid}/co-operators/invite`);
                      setLink(`${location.origin}/#/co-invite/${created.token}`);
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  초대 링크 만들기
                </button>
                <button type="button" className="secondary" onClick={() => setInviteOpen(false)}>
                  그만두기
                </button>
              </div>
            </>
          ) : (
            <>
              <p>링크를 만들었어요. 공동 운영자로 들일 사람에게만 보내세요.</p>
              <CopyButton label="초대 링크 복사" text={() => link} />
            </>
          )}
        </Dialog>
      )}

      {removing && (
        <Dialog title="공동 운영자 내보내기" onClose={() => setRemoving(null)}>
          <p>
            <strong>{accountLabel(removing)}</strong>을(를) 내보내면 그 계정은 바로 이 모임을 보거나 고칠 수 없게 됩니다.
            그동안 저장한 기록은 그대로 남아요.
          </p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await call("DELETE", `/api/groups/${props.gid}/co-operators/${removing.accountId}`);
                  setRemoving(null);
                  app.setNotice("공동 운영자를 내보냈어요.");
                  setRemovedHint(true);
                  await load();
                } catch (e) {
                  setError(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              내보내기
            </button>
            <button type="button" className="secondary" onClick={() => setRemoving(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** 모임 탭(공동 운영자): 내 역할 안내와 나가기. */
export function CoOperatorSelfSection(props: { gid: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section aria-label="공동 운영자">
      <h2>공동 운영자</h2>
      <p className="hint">
        이 계정은 이 모임의 공동 운영자예요. 경기·참가자·설정은 대표 운영자와 똑같이 다룰 수 있고, 운영자 넘기기, 모임
        삭제, 백업에서 복원, 공동 운영자 초대·내보내기는 대표 운영자만 할 수 있어요.
      </p>
      <button type="button" className="danger" onClick={() => setConfirm(true)}>
        공동 운영자에서 나가기
      </button>
      {confirm && (
        <Dialog title="공동 운영자에서 나가기" onClose={() => setConfirm(false)}>
          <p>나가면 이 계정으로 이 모임을 보거나 고칠 수 없어요. 다시 들어오려면 대표 운영자에게 새 초대 링크를 받아야 해요.</p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await call("POST", `/api/groups/${props.gid}/co-operators/leave`);
                  // 계정의 모임 목록이 바뀌었으므로 처음부터 다시 불러온다.
                  location.hash = "/";
                  location.reload();
                } catch (e) {
                  setError(e);
                  setBusy(false);
                }
              }}
            >
              나가기
            </button>
            <button type="button" className="secondary" onClick={() => setConfirm(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/** 공동 운영자 초대 링크를 연 화면(#/co-invite/토큰). 로그인한 뒤 수락하면 공동 운영자가 된다. */
export function CoInvite(props: { token: string }) {
  const app = useAppValue();
  const [info, setInfo] = useState<{ groupName: string; expiresAt: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    call<{ groupName: string; expiresAt: string }>("GET", `/api/co-invite/${props.token}`)
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
      const result = await call<{ groupId: string }>("POST", `/api/co-invite/${props.token}/accept`);
      try {
        localStorage.setItem("naejeon.group", result.groupId);
      } catch {
        // 보관하지 못하면 첫 모임이 열린다. 모임 탭의 "내 모임"에서 바꿀 수 있다.
      }
      location.hash = "/";
      location.reload();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "INVITE_INVALID") setInvalid(true);
      else setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>공동 운영자 초대</h1>
      {invalid ? (
        <p className="note warn" role="alert">
          이 초대 링크는 이미 썼거나 만료됐어요. 대표 운영자에게 새 링크를 요청해 주세요.
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
              <strong>{info.groupName}</strong> 모임의 공동 운영자가 됩니다.
            </p>
            <p className="hint">
              수락하면 이 계정으로 경기 시작·결과 저장·정정·설정을 할 수 있어요. 운영자 넘기기, 모임 삭제, 백업에서 복원,
              공동 운영자 초대는 대표 운영자만 할 수 있어요. 이미 다른 모임이 있어도 수락할 수 있고, 모임 탭의 "내 모임"에서
              바꿔 열어요(한 계정은 대표·공동 운영을 합쳐 모임 5개까지).
            </p>
            <p className="hint">
              링크 만료: {formatDate(info.expiresAt)} {formatTime(info.expiresAt)}
            </p>
          </section>
          <ErrorNote error={error} />
          {app.me?.accountId ? (
            <button type="button" className="primary wide" disabled={busy} onClick={() => void accept()}>
              {busy ? "처리 중" : "공동 운영자 되기"}
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
          reason="공동 운영자로 참여할 계정으로 로그인해 주세요."
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      )}
    </div>
  );
}
