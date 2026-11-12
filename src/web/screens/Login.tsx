import { useState, type ReactNode } from "react";
import {
  normalizeUsername,
  PASSWORD_RULE,
  passwordProblem,
  USERNAME_RULE,
  usernameProblem,
} from "../../shared/account";
import { call } from "../api";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { LOGIN_RETURN_HASH, rememberLoginReturn } from "../loginReturn";

/**
 * 로그인 시작 주소. 로그인이 끝나면 지금 보던 화면(해시 주소)으로 돌아온다. 작성 중인 편성은 기기에 남아 있다.
 * 돌아갈 주소(조회 토큰이 들어 있을 수 있음)는 쿼리로 보내지 않고 이 탭의 저장소에 둔다(../loginReturn.ts).
 */
function startUrl(provider: "kakao" | "google"): string {
  return `/api/auth/${provider}/start?return=${encodeURIComponent(LOGIN_RETURN_HASH)}`;
}

/** 로그인 버튼을 누르는 순간 지금 화면을 기억한다(화면을 그릴 때가 아니라 누를 때의 주소). */
function rememberHere(): void {
  const hash = location.hash;
  rememberLoginReturn(hash.startsWith("#/") && !hash.startsWith("#/login") ? hash : "#/");
}

/**
 * 카카오 로그인 버튼. 카카오 디자인 가이드: 바탕 #FEE500, 말풍선 심볼 #000000(필수),
 * 글자 #000000 85%, 모서리 12px, 문구 "카카오 로그인".
 * 심볼은 가이드의 모양을 따라 그린 것이다. 공식 리소스(PNG/PSD)로 바꾸는 것이 가장 정확하다.
 */
function KakaoButton() {
  return (
    <a className="login-btn login-kakao" href={startUrl("kakao")} onClick={rememberHere}>
      <svg className="login-symbol" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path
          fill="#000000"
          d="M12 3.5C6.75 3.5 2.5 6.86 2.5 11c0 2.66 1.76 5 4.41 6.33l-.95 3.48c-.1.37.32.66.64.45l4.12-2.73c.42.04.85.07 1.28.07 5.25 0 9.5-3.36 9.5-7.5S17.25 3.5 12 3.5z"
        />
      </svg>
      <span>카카오 로그인</span>
    </a>
  );
}

/**
 * Google 로그인 버튼. Google 브랜드 가이드의 밝은 테마: 바탕 #FFFFFF, 테두리 #747775 1px,
 * 글자 #1F1F1F, 표준 색 G 로고(흰 바탕 위, 색·비율 변경 금지).
 */
function GoogleButton() {
  return (
    <a className="login-btn login-google" href={startUrl("google")} onClick={rememberHere}>
      <svg className="login-symbol" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
      <span>Google 계정으로 로그인</span>
    </a>
  );
}

/** 설정된 로그인 수단의 버튼들. 키가 없는 수단은 보이지 않는다. */
export function LoginButtons() {
  const app = useAppValue();
  const providers = app.me?.providers ?? [];
  if (!providers.includes("kakao") && !providers.includes("google")) return null;
  return (
    <div className="login-buttons">
      {providers.includes("kakao") && <KakaoButton />}
      {providers.includes("google") && <GoogleButton />}
      <p className="hint">
        로그인 수단의 고유 번호만 저장하고 이메일·이름·사진은 받지 않습니다.{" "}
        <a href="#/privacy">개인정보 처리방침</a>
      </p>
    </div>
  );
}

/**
 * 로그인 창. 첫 "이 팀으로 시작"에서 처음 뜬다(docs/P3 1절).
 * 카카오·Google 로그인은 그 회사 화면을 다녀오므로 페이지가 바뀐다. 작성 중인 편성은 기기에 남아 있어
 * 돌아온 뒤 같은 화면에서 이어서 누르면 된다. 개발용 가짜 로그인은 로컬(AUTH_MODE=fake)에서만 보인다.
 */
export function LoginDialog(props: { reason: string; onDone: () => void; onClose: () => void }) {
  const app = useAppValue();
  const providers = app.me?.providers ?? [];
  const local = providers.includes("local");
  const oauth = providers.some((p) => p !== "local");
  const fake = app.me?.authMode === "fake";
  const [mode, setMode] = useState<LocalMode>("login");
  // 가입·복구가 끝나면 복구 코드를 한 번 보여준다. 이 단계가 끝나야 계정 상태를 다시 읽는다
  // (먼저 읽으면 로그인 버튼이 사라지며 이 창도 함께 닫혀 코드를 못 본다).
  const [code, setCode] = useState<string | null>(null);
  const [askSkip, setAskSkip] = useState(false);

  async function finish() {
    await app.reloadMe();
    props.onDone();
  }

  if (code) {
    return (
      <Dialog title="복구 코드" onClose={() => setAskSkip(true)}>
        <RecoveryCodeStep code={code} askSkip={askSkip} setAskSkip={setAskSkip} onDone={() => void finish()} />
      </Dialog>
    );
  }

  return (
    <Dialog title="로그인" onClose={props.onClose}>
      <p>{props.reason}</p>
      <p className="hint">로그인하거나 가입해도 작성하던 편성은 이 기기에 그대로 있어요.</p>
      {local && (
        <LocalAccountForms
          mode={mode}
          setMode={setMode}
          onLoggedIn={() => void finish()}
          onRecoveryCode={setCode}
        />
      )}
      {oauth && (
        <div className={local ? "login-other" : undefined}>
          {local && <p className="login-or">또는</p>}
          <LoginButtons />
        </div>
      )}
      {fake && <FakeLogin onDone={props.onDone} />}
      {!fake && !local && !oauth && (
        <p className="note error">로그인 수단이 아직 설정되지 않았습니다. 서비스 운영자에게 알려 주세요.</p>
      )}
    </Dialog>
  );
}

/** 로컬 개발용 가짜 로그인(AUTH_MODE=fake + 로컬 주소에서만). 자체 계정과 헷갈리지 않게 따로 묶는다. */
function FakeLogin(props: { onDone: () => void }) {
  const app = useAppValue();
  const [subject, setSubject] = useState("운영자");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="dev-login"
      aria-label="개발용 로그인"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await app.login(subject.trim() || "운영자");
          props.onDone();
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="note">
        <strong>개발용 로그인</strong> · 이 컴퓨터에서 띄운 개발 서버에서만 보여요. 비밀번호 없이 이름이 같으면 같은
        계정으로 들어갑니다. 위의 아이디 가입과는 다른 계정이에요.
      </p>
      <label>
        계정 이름
        <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={64} />
      </label>
      <ErrorNote error={error} />
      <button type="submit" className="secondary" disabled={busy}>
        {busy ? "들어가는 중" : "개발용 로그인"}
      </button>
    </form>
  );
}

type LocalMode = "login" | "signup" | "recover";

/** 자체 계정: [로그인 | 회원가입] 전환과 "비밀번호를 잊었어요"(복구 코드). */
function LocalAccountForms(props: {
  mode: LocalMode;
  setMode: (mode: LocalMode) => void;
  onLoggedIn: () => void;
  onRecoveryCode: (code: string) => void;
}) {
  const { mode, setMode } = props;
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const name = normalizeUsername(username.trim());
  const checksRules = mode !== "login";
  const nameProblem = checksRules ? usernameProblem(name) : username.trim() === "" ? "아이디를 입력해 주세요." : null;
  const passProblem = checksRules
    ? passwordProblem(password, name)
    : password === ""
      ? "비밀번호를 입력해 주세요."
      : null;
  const codeProblem = mode === "recover" && recoveryCode.trim() === "" ? "복구 코드를 입력해 주세요." : null;

  function switchTo(next: LocalMode) {
    setMode(next);
    setTried(false);
    setError(null);
    setPassword("");
  }

  async function submit() {
    setTried(true);
    if (nameProblem || passProblem || codeProblem) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await call("POST", "/api/auth/login", { username: name, password });
        props.onLoggedIn();
      } else if (mode === "signup") {
        const result = await call<{ recoveryCode: string }>("POST", "/api/auth/signup", { username: name, password });
        props.onRecoveryCode(result.recoveryCode);
      } else {
        const result = await call<{ recoveryCode: string }>("POST", "/api/auth/recover", {
          username: name,
          recoveryCode,
          newPassword: password,
        });
        props.onRecoveryCode(result.recoveryCode);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="local-login">
      {mode !== "recover" ? (
        <div className="segmented" role="tablist" aria-label="로그인 또는 회원가입">
          {(["login", "signup"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "selected" : undefined}
              onClick={() => switchTo(m)}
            >
              {m === "login" ? "로그인" : "회원가입"}
            </button>
          ))}
        </div>
      ) : (
        <h3 className="local-title">복구 코드로 비밀번호 다시 정하기</h3>
      )}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "signup" && <p className="hint">아이디와 비밀번호만 정하면 돼요. 이메일·전화번호는 받지 않아요.</p>}
        {mode === "recover" && (
          <p className="hint">가입할 때 받은 복구 코드를 넣고 새 비밀번호를 정해요. 다른 기기의 로그인은 모두 끝나요.</p>
        )}
        <Field
          id="local-username"
          label="아이디"
          rule={checksRules ? USERNAME_RULE : null}
          problem={tried ? nameProblem : null}
        >
          <input
            id="local-username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={
              [checksRules ? "local-username-rule" : "", tried && nameProblem ? "local-username-problem" : ""]
                .filter(Boolean)
                .join(" ") || undefined
            }
            aria-invalid={tried && nameProblem ? true : undefined}
            value={username}
            maxLength={40}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        {mode === "recover" && (
          <Field id="local-recovery" label="복구 코드" rule="XXXX-XXXX-… 32글자. 띄어쓰기·대소문자는 상관없어요." problem={tried ? codeProblem : null}>
            <input
              id="local-recovery"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={recoveryCode}
              maxLength={80}
              onChange={(e) => setRecoveryCode(e.target.value)}
            />
          </Field>
        )}
        <PasswordField
          id="local-password"
          label={mode === "recover" ? "새 비밀번호" : "비밀번호"}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          value={password}
          onChange={setPassword}
          rule={checksRules ? PASSWORD_RULE : null}
          problem={tried ? passProblem : null}
        />
        <ErrorNote error={error} />
        <button type="submit" className="primary wide" disabled={busy}>
          {busy
            ? "확인하는 중…"
            : mode === "login"
              ? "아이디로 로그인"
              : mode === "signup"
                ? "가입하고 시작하기"
                : "비밀번호 다시 정하기"}
        </button>
      </form>
      {mode === "login" && (
        <button type="button" className="link" onClick={() => switchTo("recover")}>
          비밀번호를 잊었어요
        </button>
      )}
      {mode === "recover" && (
        <button type="button" className="link" onClick={() => switchTo("login")}>
          ← 로그인으로 돌아가기
        </button>
      )}
    </div>
  );
}

/** 이름표 + 칸 + 조건 한 줄 + 틀린 이유. 조건과 이유는 칸의 설명으로 읽힌다. */
function Field(props: {
  id: string;
  label: string;
  rule: string | null;
  problem: string | null;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children}
      {props.rule && (
        <p className="hint field-rule" id={`${props.id}-rule`}>
          {props.rule}
        </p>
      )}
      {props.problem && (
        <p className="field-problem" id={`${props.id}-problem`} role="alert">
          {props.problem}
        </p>
      )}
    </div>
  );
}

/** 비밀번호 칸. [보기]로 입력한 글자를 확인할 수 있다. */
export function PasswordField(props: {
  id: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
  rule?: string | null;
  problem?: string | null;
}) {
  const [shown, setShown] = useState(false);
  const described = [props.rule ? `${props.id}-rule` : "", props.problem ? `${props.id}-problem` : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <Field id={props.id} label={props.label} rule={props.rule ?? null} problem={props.problem ?? null}>
      <div className="password-row">
        <input
          id={props.id}
          type={shown ? "text" : "password"}
          autoComplete={props.autoComplete}
          autoCapitalize="none"
          spellCheck={false}
          value={props.value}
          maxLength={256}
          aria-describedby={described || undefined}
          aria-invalid={props.problem ? true : undefined}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <button
          type="button"
          className="secondary"
          aria-pressed={shown}
          aria-label={`${props.label} ${shown ? "숨기기" : "보기"}`}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? "숨기기" : "보기"}
        </button>
      </div>
    </Field>
  );
}

/**
 * 복구 코드를 한 번 보여주는 단계. 적었다고 확인하면 [계속], 적지 않고 넘어가려면 한 번 더 확인받는다.
 * 가입·복구 뒤(로그인 창)와 모임 탭의 "복구 코드 새로 받기"가 같이 쓴다.
 */
export function RecoveryCodeStep(props: {
  code: string;
  askSkip: boolean;
  setAskSkip: (ask: boolean) => void;
  onDone: () => void;
  /** 마침 버튼 이름(결과를 적는다). 가입은 "가입 마치기", 설정에서 새로 받을 때는 "닫기". */
  doneLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="recovery-step">
      <p className="note">
        <strong>이 코드를 적어 두세요.</strong> 비밀번호를 잊으면 이 코드로만 다시 정할 수 있어요. 이메일이 없어서
        다른 방법으로는 되찾을 수 없고, 코드는 지금 한 번만 보여 드려요.
      </p>
      <p className="recovery-code" aria-label="복구 코드">
        <code>{props.code}</code>
      </p>
      <CopyButton label="코드 복사" text={() => props.code} />
      <label className="toggle">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> 코드를 안전한 곳에 적어
        뒀어요
      </label>
      <button type="button" className="primary wide" disabled={!saved} onClick={props.onDone}>
        {props.doneLabel ?? "가입 마치기"}
      </button>
      {!props.askSkip ? (
        <button type="button" className="link" onClick={() => props.setAskSkip(true)}>
          적지 않고 넘어가기
        </button>
      ) : (
        <div className="note warn" role="alert">
          <p>코드를 적지 않으면 비밀번호를 잊었을 때 이 계정을 되찾을 수 없어요. 그래도 넘어갈까요?</p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={() => props.setAskSkip(false)}>
              돌아가서 적기
            </button>
            <button type="button" className="danger" onClick={props.onDone}>
              그래도 넘어가기
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const FAILURE_TEXT: Record<string, { title: string; next: string }> = {
  state_mismatch: {
    title: "로그인 요청이 만료됐거나 다른 창에서 시작됐어요.",
    next: "이 창에서 처음부터 다시 로그인해 주세요.",
  },
  denied: {
    title: "로그인을 취소했어요.",
    next: "이어서 하려면 다시 로그인해 주세요. 작성하던 편성은 그대로 있어요.",
  },
  provider_error: {
    title: "카카오·Google에서 로그인 확인을 받지 못했어요.",
    next: "잠시 뒤 다시 시도하거나 다른 로그인 수단을 써 주세요.",
  },
  not_configured: {
    title: "이 로그인 수단은 아직 쓸 수 없어요.",
    next: "다른 로그인 수단을 써 주세요.",
  },
  rate_limited: {
    title: "로그인 시도가 너무 잦아요.",
    next: "1분쯤 뒤에 다시 시도해 주세요.",
  },
};

/** 로그인 실패 안내(#/login-failed/이유). 서버의 콜백이 실패하면 여기로 보낸다. */
export function LoginFailed(props: { reason: string }) {
  const [open, setOpen] = useState(false);
  const text = FAILURE_TEXT[props.reason] ?? FAILURE_TEXT.provider_error!;
  return (
    <div className="screen">
      <h1>로그인하지 못했어요</h1>
      <p className="note error" role="alert">
        {text.title}
      </p>
      <p>{text.next}</p>
      <div className="button-row">
        <button type="button" className="primary" onClick={() => setOpen(true)}>
          다시 로그인
        </button>
        <button type="button" className="secondary" onClick={() => go("/")}>
          첫 화면으로
        </button>
      </div>
      {open && (
        <LoginDialog
          reason="운영 기능을 쓰려면 로그인이 필요해요."
          onDone={() => go("/")}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
