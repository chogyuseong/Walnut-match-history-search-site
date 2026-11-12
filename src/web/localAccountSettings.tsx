import { useState } from "react";
import { PASSWORD_RULE, passwordProblem } from "../shared/account";
import { call } from "./api";
import { PasswordField, RecoveryCodeStep } from "./screens/Login";
import { ErrorNote } from "./ui";
import { useAppValue } from "./useApp";

// 모임 탭에서만 쓰는 계정 관리. 예전에는 account.tsx(상단 바 로그인 상태)에 있어 비밀번호 칸·복구 코드 단계까지
// 첫 화면 묶음에 실렸다. 로그인 창과 같은 부품을 쓰므로 screens/Login.tsx를 바로 부른다.

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
            doneLabel="닫기"
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
