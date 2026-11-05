import { useState } from "react";
import { Dialog, ErrorNote } from "../ui";
import { useAppValue } from "../useApp";

/**
 * 로그인 창. 첫 "이 팀으로 시작"에서 처음 뜬다(docs/P3 1절).
 * 지금은 로컬·테스트용 가짜 로그인만 있다. 실제 로그인 수단은 아직 연결하지 않았다.
 */
export function LoginDialog(props: { reason: string; onDone: () => void; onClose: () => void }) {
  const app = useAppValue();
  const [subject, setSubject] = useState("운영자");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fake = app.me?.authMode === "fake";

  return (
    <Dialog title="로그인" onClose={props.onClose}>
      <p>{props.reason}</p>
      {fake ? (
        <form
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
          <p className="note">개발용 로그인입니다. 이름이 같으면 같은 계정으로 들어갑니다.</p>
          <label>
            계정 이름
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={64} />
          </label>
          <ErrorNote error={error} />
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "로그인 중" : "로그인"}
          </button>
        </form>
      ) : (
        <p className="note warn">로그인 수단이 아직 설정되지 않았습니다.</p>
      )}
    </Dialog>
  );
}
