import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PASSWORD_RULE, passwordProblem } from "../shared/account";
import { call } from "./api";
import { LoginDialog, PasswordField, RecoveryCodeStep } from "./screens/Login";
import { ROLE_LABEL } from "./groupSwitcher";
import { ErrorNote } from "./ui";
import { go, useAppValue } from "./useApp";

/** 로그인한 운영자만 쓰는 화면(주소의 첫 칸). 로그인하지 않았으면 로그인 안내를 대신 보여준다. */
export const LOGIN_ONLY: Record<string, string> = {
  group: "모임",
  import: "표 일괄 입력",
  "sheet-import": "구글 시트에서 가져오기",
  "legacy-import": "기존 사이트 기록 가져오기",
  backfill: "지난 경기 입력",
  merge: "중복 참가자 합치기",
  priority: "티어 배정",
  delete: "모임 삭제 · 탈퇴",
};

/**
 * 로그인 창. 상단 바 안(넓은 화면에서 흐림 효과가 걸린 고정 바)에 그리면 창이 바 안에 갇히므로
 * 문서 맨 끝에 그린다.
 */
function LoginDialogOnBody(props: { reason: string; onClose: () => void }) {
  return createPortal(
    <LoginDialog reason={props.reason} onDone={props.onClose} onClose={props.onClose} />,
    document.body,
  );
}

/**
 * 상단 바의 로그인 상태. 로그인 전에는 [로그인], 로그인 뒤에는 [로그인됨]을 누르면 로그아웃이 나온다.
 * 계정 식별자·이름은 그리지 않는다(서버도 로그인 수단의 고유 번호만 저장한다).
 */
export function AccountControl() {
  const app = useAppValue();
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const loggedIn = Boolean(app.me?.accountId);

  // 메뉴 밖을 누르거나 Esc를 누르면 닫는다. Esc로 닫으면 초점을 [로그인됨]으로 돌려준다.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // 로그아웃·로그인 만료로 상태가 바뀌면 메뉴를 닫는다.
  useEffect(() => {
    if (!loggedIn) setMenuOpen(false);
  }, [loggedIn]);

  // 계정 상태를 아직 모르면(첫 불러오기 중) 아무것도 그리지 않는다. 잠깐 [로그인]이 보였다 사라지지 않게.
  if (!app.ready) return null;

  if (!loggedIn) {
    return (
      <>
        <button type="button" className="primary topbar-login" onClick={() => setLoginOpen(true)}>
          로그인
        </button>
        {loginOpen && (
          <LoginDialogOnBody
            reason="로그인하면 저장된 모임과 기록을 불러오고, 모임 탭에서 시트 가져오기·백업 같은 운영 기능을 쓸 수 있어요."
            onClose={() => setLoginOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="topbar-account" ref={wrap}>
      <button
        ref={toggle}
        type="button"
        className="secondary topbar-account-button"
        aria-expanded={menuOpen}
        aria-controls="account-menu"
        onClick={() => {
          setError(null);
          setMenuOpen((open) => !open);
        }}
      >
        <span className="account-dot" aria-hidden="true" />
        로그인됨
      </button>
      {menuOpen && (
        <div id="account-menu" className="account-menu" role="group" aria-label="로그인 상태">
          <p>이 기기에서 운영자로 로그인돼 있어요.</p>
          {(app.me?.groups.length ?? 0) > 1 && (
            <div className="account-groups" role="group" aria-label="모임 바꾸기">
              {app.me!.groups.map((g) => {
                const label =
                  g.id === app.snapshot?.group.id ? app.snapshot.group.name : g.name;
                return (
                  <button
                    key={g.id}
                    type="button"
                    className="secondary wide"
                    aria-pressed={g.id === app.groupId}
                    disabled={app.switching}
                    onClick={() => {
                      setMenuOpen(false);
                      if (g.id === app.groupId) return;
                      void app.switchGroup(g.id).then(() => app.setNotice(`'${label}' 모임으로 바꿨어요.`));
                    }}
                  >
                    {label} · {ROLE_LABEL[g.role ?? "owner"]}
                  </button>
                );
              })}
            </div>
          )}
          <ErrorNote error={error} />
          <button
            type="button"
            className="secondary wide"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              const page = location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
              void app
                .logout()
                .then(() => {
                  setMenuOpen(false);
                  app.setNotice("로그아웃했어요. 작성 중인 편성은 이 기기에 남아 있어요.");
                  // 로그인해야 쓰는 화면에 있었다면 첫 화면으로 간다.
                  if (page in LOGIN_ONLY) go("/");
                })
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "로그아웃 중" : "로그아웃"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 로그인해야 쓰는 화면에 로그인하지 않고 들어왔을 때. 로그인하면 같은 주소이므로 그 화면이 그대로 열린다
 * (카카오·Google 로그인도 누른 순간의 주소로 돌아온다).
 */
export function LoginRequired(props: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="screen">
      <h1>{props.title}</h1>
      <p className="note">이 화면은 로그인이 필요해요. 로그인하면 이 화면이 바로 열려요.</p>
      <p className="hint">팀 짜기와 명단 복사는 로그인 없이 됩니다.</p>
      <div className="button-row">
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          로그인하고 계속
        </button>
        <button type="button" className="secondary" onClick={() => go("/")}>
          오늘로 가기
        </button>
      </div>
      {open && (
        <LoginDialog
          reason={`'${props.title}' 화면은 모임을 운영하는 계정으로 로그인해야 열려요.`}
          onDone={() => setOpen(false)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 아이디로 가입한 계정의 관리: 비밀번호 바꾸기, 복구 코드 새로 받기. 다른 로그인 수단이면 그리지 않는다.
 * 둘 다 지금 비밀번호를 확인한다(세션 쿠키만 가진 사람이 계정을 가로채지 못하게).
 */
export function LocalAccountSettings() {
  const app = useAppValue();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [codePassword, setCodePassword] = useState("");
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState<unknown>(null);
  const [code, setCode] = useState<string | null>(null);
  const [askSkip, setAskSkip] = useState(false);
  if (app.me?.loginMethod !== "local") return null;

  // 새 비밀번호 조건(아이디와 같은지는 서버가 본다: 화면은 아이디를 모른다).
  const nextProblem = passwordProblem(next, "");

  return (
    <>
      <section aria-label="비밀번호 바꾸기">
        <h2>비밀번호 바꾸기</h2>
        <p className="hint">바꾸면 다른 기기에서는 다시 로그인해야 해요. 이 기기는 그대로예요.</p>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setTried(true);
            if (current === "" || nextProblem) return;
            setBusy(true);
            setError(null);
            void call("POST", "/api/account/password", { currentPassword: current, newPassword: next })
              .then(() => {
                setCurrent("");
                setNext("");
                setTried(false);
                app.setNotice("비밀번호를 바꿨어요. 다른 기기에서는 다시 로그인해야 해요.");
              })
              .catch(setError)
              .finally(() => setBusy(false));
          }}
        >
          <PasswordField
            id="change-current"
            label="지금 비밀번호"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
            problem={tried && current === "" ? "지금 비밀번호를 입력해 주세요." : null}
          />
          <PasswordField
            id="change-next"
            label="새 비밀번호"
            autoComplete="new-password"
            value={next}
            onChange={setNext}
            rule={PASSWORD_RULE}
            problem={tried ? nextProblem : null}
          />
          <ErrorNote error={error} />
          <button type="submit" className="secondary" disabled={busy}>
            {busy ? "바꾸는 중…" : "비밀번호 바꾸기"}
          </button>
        </form>
      </section>
      <section aria-label="복구 코드">
        <h2>복구 코드</h2>
        <p className="hint">
          비밀번호를 잊었을 때 쓰는 코드예요. 잃어버렸다면 새로 받으세요. 새로 받으면 이전 코드는 바로 못 써요.
        </p>
        {code ? (
          <RecoveryCodeStep
            code={code}
            askSkip={askSkip}
            setAskSkip={setAskSkip}
            onDone={() => {
              setCode(null);
              setAskSkip(false);
            }}
          />
        ) : (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (codePassword === "") return;
              setCodeBusy(true);
              setCodeError(null);
              void call<{ recoveryCode: string }>("POST", "/api/account/recovery-code", { password: codePassword })
                .then((result) => {
                  setCodePassword("");
                  setCode(result.recoveryCode);
                })
                .catch(setCodeError)
                .finally(() => setCodeBusy(false));
            }}
          >
            <PasswordField
              id="code-password"
              label="지금 비밀번호"
              autoComplete="current-password"
              value={codePassword}
              onChange={setCodePassword}
            />
            <ErrorNote error={codeError} />
            <button type="submit" className="secondary" disabled={codeBusy || codePassword === ""}>
              {codeBusy ? "만드는 중…" : "복구 코드 새로 받기"}
            </button>
          </form>
        )}
      </section>
    </>
  );
}

/**
 * 모임이 아직 없는 계정에게 모임을 먼저 만들고 그 화면으로 가게 하는 버튼.
 * 경기를 한 번도 하지 않고 지난 기록부터 넣고 싶은 사람을 위한 길이다. 모임 만들기는 app.ensureGroup을 쓴다.
 */
export function CreateGroupButton(props: { label: string; to: string; primary?: boolean }) {
  const app = useAppValue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <button
        type="button"
        className={props.primary ? "primary" : "secondary"}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void app
            .ensureGroup()
            .then(() => {
              app.setNotice("모임을 만들었어요. 모임 이름은 모임 탭에서 바꿀 수 있어요.");
              go(props.to);
            })
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "모임 만드는 중…" : props.label}
      </button>
      <ErrorNote error={error} />
    </>
  );
}
