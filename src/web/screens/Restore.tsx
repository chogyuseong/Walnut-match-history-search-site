import { useRef, useState } from "react";
import { ApiFailure, call, mutate, newRequestId } from "../api";
import { formatDate, formatTime } from "../format";
import { ErrorNote } from "../ui";
import { useAppValue } from "../useApp";

/** 서버의 복원 미리보기 응답(src/server/restore.ts의 RestorePreview). */
interface Counts {
  matches: number;
  confirmed: number;
  participants: number;
}
interface Preview {
  ok: boolean;
  problems: string[];
  sameGroup: boolean;
  file?: Counts & { groupName: string; createdAt: string; formatVersion: number };
  current: Counts;
  generation: number;
  confirmText: string;
}

/** JSON을 파일로 내려받는다. */
export function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 모임 탭의 "백업에서 복원" 구역(검증 시나리오 36·37·38).
 * 파일 고르기 → 서버가 파일 전체를 검사하고 바뀌는 내용을 요약 → 확인 문구 입력 → 실행.
 * 같은 모임 파일이면 이 모임을 되돌리고(실행 직전 지금 상태를 자동으로 내려받음),
 * 다른 모임 파일이면 이 모임은 그대로 두고 새 모임으로 가져온다.
 */
export function RestoreSection() {
  const app = useAppValue();
  const snapshot = app.snapshot!;
  const gid = snapshot.group.id;
  const tz = snapshot.group.timezone;
  const maintenance = snapshot.group.maintenance === true;
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [backup, setBackup] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  // 아이디로 가입한 계정은 이 모임을 되돌릴 때 비밀번호를 한 번 더 확인한다(서버가 확인한다). 새 모임으로 가져오기는 묻지 않는다.
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState<string | null>(null);
  // 요청 ID는 파일을 확인할 때 한 번 만들고, 다시 누를 때(응답을 못 받았을 때)는 같은 값을 쓴다.
  const requestId = useRef<string>(newRequestId());

  function reset() {
    setFileName(null);
    setBackup(null);
    setPreview(null);
    setReadError(null);
    setConfirm("");
    setPassword("");
    setError(null);
    setStep(null);
    requestId.current = newRequestId();
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    reset();
    if (!file) return;
    setFileName(file.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setReadError("이 파일은 백업 파일(JSON)로 읽을 수 없어요. '백업 내려받기'로 받은 파일을 골라 주세요.");
      return;
    }
    setBackup(parsed);
    setBusy(true);
    try {
      setPreview(await call<Preview>("POST", `/api/groups/${gid}/restore/preview`, { backup: parsed }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = app.me?.loginMethod === "local" && preview?.sameGroup === true;

  async function runRestore() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      if (preview.sameGroup) {
        // 1) 복원 직전 상태를 먼저 내려받는다. 실패하면 복원하지 않는다.
        //    점검 상태(복원이 중간에 멈춤)에서는 지금 상태가 불완전하므로 내려받지 않는다.
        if (!maintenance) {
          setStep("지금 상태를 백업 파일로 내려받는 중");
          const current = await call<Record<string, unknown>>("GET", `/api/groups/${gid}/export`);
          downloadJson(current, `naejeon-before-restore-${today()}.json`);
        }
        setStep("복원하는 중");
        const result = await mutate<Counts>(`/api/groups/${gid}/restore`, {
          requestId: requestId.current,
          confirm,
          baseGeneration: preview.generation,
          backup,
          ...(needsPassword ? { password } : {}),
        });
        await app.refreshAfterOwnChange();
        app.setNotice(`복원했어요. 경기 ${result.matches}개, 참가자 ${result.participants}명입니다.`);
        reset();
      } else {
        setStep("새 모임으로 가져오는 중");
        const result = await mutate<{ groupId: string }>(`/api/restore/new-group`, {
          requestId: requestId.current,
          confirm,
          backup,
        });
        // 가져온 모임을 열어 둔다.
        try {
          localStorage.setItem("naejeon.group", result.groupId);
        } catch {
          // 저장소를 못 쓰면 첫 모임이 열린다.
        }
        location.hash = "#/group";
        location.reload();
      }
    } catch (e) {
      setError(e);
      setStep(null);
      if (e instanceof ApiFailure && e.code === "RESTORE_INCOMPLETE") void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  const file = preview?.file;
  const ready =
    preview?.ok === true && confirm.trim() === preview.confirmText && (!needsPassword || password !== "");

  return (
    <section aria-label="백업에서 복원" className="restore">
      <h2>백업에서 복원</h2>
      {maintenance && (
        <p className="note warn" role="alert">
          복원이 중간에 멈춰 이 모임은 점검 중이에요. 다른 저장은 막혀 있습니다. 같은 백업 파일로 복원을
          다시 실행하면 끝납니다.
        </p>
      )}
      <p className="hint">
        '백업 내려받기'로 받은 파일로 이 모임을 그 시점으로 되돌립니다. 백업 이후의 기록은 사라지고,
        운영자와 조회 링크는 바뀌지 않습니다. 다른 모임의 백업은 이 모임을 바꾸지 않고 새 모임으로
        가져옵니다.
      </p>
      <label className="file-pick">
        백업 파일 고르기
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </label>
      {fileName && busy && !preview && <p className="hint">파일을 검사하는 중…</p>}
      {readError && (
        <p className="note warn" role="alert">
          {readError}
        </p>
      )}

      {preview && !preview.ok && (
        <div className="note warn" role="alert">
          <p>
            <strong>이 파일로는 복원할 수 없어요.</strong> 아무것도 바꾸지 않았습니다.
          </p>
          <ul className="problem-list">
            {preview.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      {preview?.ok && file && (
        <div className="restore-preview">
          <p>
            {preview.sameGroup ? (
              <>
                이 모임의 백업입니다 · {formatDate(file.createdAt, tz)} {formatTime(file.createdAt, tz)}에
                만든 파일
              </>
            ) : (
              <>
                다른 모임(<strong>{file.groupName}</strong>)의 백업입니다. 이 모임은 그대로 두고{" "}
                <strong>새 모임</strong>으로 가져옵니다.
              </>
            )}
          </p>
          <table className="restore-diff">
            <caption className="restore-caption">복원으로 바뀌는 내용</caption>
            <thead>
              <tr>
                <th scope="col">항목</th>
                {preview.sameGroup && <th scope="col">지금</th>}
                <th scope="col">{preview.sameGroup ? "복원 뒤" : "가져올 내용"}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">경기</th>
                {preview.sameGroup && <td>{preview.current.matches}경기</td>}
                <td>{file.matches}경기</td>
              </tr>
              <tr>
                <th scope="row">그중 결과 확정</th>
                {preview.sameGroup && <td>{preview.current.confirmed}경기</td>}
                <td>{file.confirmed}경기</td>
              </tr>
              <tr>
                <th scope="row">참가자</th>
                {preview.sameGroup && <td>{preview.current.participants}명</td>}
                <td>{file.participants}명</td>
              </tr>
            </tbody>
          </table>
          {preview.sameGroup && (
            <p className="hint">
              {maintenance
                ? "점검 중이라 지금 상태는 내려받지 않습니다."
                : "실행하면 먼저 지금 상태를 백업 파일로 내려받은 뒤 복원합니다. 잘못 복원했으면 그 파일로 다시 복원하면 됩니다."}
            </p>
          )}
          <label>
            확인을 위해 '{preview.confirmText}'을 입력해 주세요
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="off"
              maxLength={10}
            />
          </label>
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
          {step && (
            <p className="hint" role="status">
              {step}…
            </p>
          )}
          <ErrorNote error={error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy || !ready}
              onClick={() => void runRestore()}
            >
              {preview.sameGroup
                ? maintenance
                  ? "복원 다시 실행"
                  : "지금 상태 내려받고 복원하기"
                : "새 모임으로 가져오기"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={reset}>
              그만두기
            </button>
          </div>
        </div>
      )}
      {!preview && <ErrorNote error={error} />}
    </section>
  );
}

/** 백업 파일에서 화면에 보여줄 요약만 읽는다. 파일 전체 검사는 서버가 가져올 때 한다. */
function backupSummary(raw: unknown): { groupName: string; matches: number; participants: number } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as { formatVersion?: unknown; group?: { name?: unknown }; matches?: unknown; participants?: unknown };
  if (typeof data.formatVersion !== "number" || typeof data.group?.name !== "string") return null;
  return {
    groupName: data.group.name,
    matches: Array.isArray(data.matches) ? data.matches.length : 0,
    participants: Array.isArray(data.participants) ? data.participants.length : 0,
  };
}

/**
 * 모임이 아직 없는 계정의 "백업 파일로 시작". 빈 모임을 먼저 만들지 않고 파일을 바로 새 모임으로 가져온다
 * (서버 /api/restore/new-group 은 모임 없이도 받는다). 미리보기 API는 모임이 있어야 하므로 여기서는 파일의
 * 요약만 보여주고, 파일 전체 검사는 가져올 때 서버가 한다. 문제가 있으면 아무것도 만들지 않는다.
 */
export function NewGroupFromBackup() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [backup, setBackup] = useState<unknown>(null);
  const [summary, setSummary] = useState<ReturnType<typeof backupSummary>>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestId = useRef<string>(newRequestId());

  function reset() {
    setBackup(null);
    setSummary(null);
    setReadError(null);
    setConfirm("");
    setError(null);
    requestId.current = newRequestId();
    if (inputRef.current) inputRef.current.value = "";
  }

  async function onFile(file: File | undefined) {
    reset();
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      parsed = undefined;
    }
    const next = backupSummary(parsed);
    if (!next) {
      setReadError("이 파일은 백업 파일로 읽을 수 없어요. 모임 탭의 '백업 내려받기'로 받은 파일을 골라 주세요.");
      return;
    }
    setBackup(parsed);
    setSummary(next);
  }

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<{ groupId: string }>(`/api/restore/new-group`, {
        requestId: requestId.current,
        confirm: confirm.trim(),
        backup,
      });
      try {
        localStorage.setItem("naejeon.group", result.groupId);
      } catch {
        // 저장소를 못 쓰면 첫 모임이 열린다.
      }
      location.hash = "#/group";
      location.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const problems =
    error instanceof ApiFailure && Array.isArray(error.details?.problems) ? (error.details.problems as string[]) : [];

  return (
    <section className="card start-card" aria-label="백업 파일로 시작">
      <h2>백업 파일이 있다면</h2>
      <p className="hint">'백업 내려받기'로 받아 둔 파일을 고르면 그 기록 그대로 새 모임을 만들어요.</p>
      <label className="file-pick">
        백업 파일 고르기
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </label>
      {readError && (
        <p className="note warn" role="alert">
          {readError}
        </p>
      )}
      {summary && (
        <div className="restore-preview">
          <p>
            <strong>{summary.groupName}</strong>의 백업 · 경기 {summary.matches}개 · 참가자 {summary.participants}명.
            새 모임으로 가져옵니다.
          </p>
          <p className="hint">파일 전체는 가져올 때 검사해요. 문제가 있으면 아무것도 만들지 않아요.</p>
          <label>
            확인을 위해 '복원'을 입력해 주세요
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" maxLength={10} />
          </label>
          {problems.length > 0 ? (
            <div className="note warn" role="alert">
              <p>
                <strong>이 파일로는 가져올 수 없어요.</strong> 아무것도 만들지 않았습니다.
              </p>
              <ul className="problem-list">
                {problems.map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : (
            <ErrorNote error={error} />
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || confirm.trim() !== "복원"}
              onClick={() => void run()}
            >
              {busy ? "가져오는 중…" : "새 모임으로 가져오기"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={reset}>
              그만두기
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
