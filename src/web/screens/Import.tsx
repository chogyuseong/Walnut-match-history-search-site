import { useRef, useState } from "react";
import {
  IMPORT_COLUMNS,
  parseMatchTable,
  toImportMatches,
  type ImportMatchPayload,
  type ImportParse,
  type ImportSideMode,
} from "../../shared/importTable";
import { nameKey } from "../../shared/names";
import { parseDelimited } from "../../shared/csv";
import { classifyImport, isLegacyLayout, type ExistingImport } from "../../shared/sheetTable";
import { call, mutate, newRequestId } from "../api";
import { handOffPaste } from "../sheetHandoff";
import { ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { CreateGroupButton } from "../account";

const CHUNK = 50;
const NAME_CHUNK = 30;

interface Plan {
  /** 이번 일괄 입력 전체를 가리키는 ID. 나중에 한 번에 되돌릴 때 쓴다. */
  batchId: string;
  chunks: { requestId: string; matches: ImportMatchPayload[] }[];
  total: number;
}

/**
 * 표 일괄 입력. 시트에 기록해 둔 지난 경기를 붙여 넣어 한꺼번에 넣는다.
 * 전체를 먼저 읽어 검증하고, 틀린 줄이 하나라도 있으면 저장하지 않는다.
 * 진영은 미리 골라 두지 않고 사용자가 직접 고른다.
 */
export function Import() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ImportParse | null>(null);
  // 이 모임에 이미 들어간 경기의 지문. 표를 읽을 때 받아 와서 같은 경기를 건너뛴다.
  const [existing, setExisting] = useState<ExistingImport[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [sideMode, setSideMode] = useState<ImportSideMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [done, setDone] = useState(false);
  // 저장 계획은 한 번 만들면 다시 만들지 않는다. 중간에 끊겨도 같은 요청 ID로 이어서 보내
  // 이미 들어간 묶음이 두 번 들어가지 않게 한다.
  const plan = useRef<Plan | null>(null);

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>표 일괄 입력</h1>
        <p>모임이 있어야 기록을 넣을 수 있어요. 경기를 하지 않아도 모임을 먼저 만들 수 있어요.</p>
        <div className="button-row">
          <CreateGroupButton primary label="모임 만들고 시작" to="/import" />
          <button type="button" className="secondary" onClick={() => go("/")}>
            오늘로 가기
          </button>
        </div>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const timeZone = snapshot.group.timezone;
  const known = new Set(
    snapshot.participants.filter((p) => p.status === "active").map((p) => nameKey(p.name)),
  );
  // 이미 들어간 경기(같은 지문)는 건너뛴다. 시트 가져오기와 같은 기준이다.
  const classification =
    parsed && existing && parsed.errors.length === 0 ? classifyImport(parsed.rows, existing, null) : null;
  const fresh = classification?.fresh ?? [];
  const skipped = classification?.already.length ?? 0;
  // 새로 만들 참가자는 실제로 넣을 경기의 이름만 센다(확인 전에는 표 전체).
  const usedKeys = new Set(fresh.flatMap((r) => [...r.teamA, ...r.teamB].map(nameKey)));
  const usedNames = classification
    ? parsed!.names.filter((name) => usedKeys.has(nameKey(name)))
    : (parsed?.names ?? []);
  const newNames = usedNames.filter((name) => !known.has(nameKey(name)));
  const dates = parsed ? parsed.rows.map((r) => r.date).sort() : [];
  const readable = parsed !== null && parsed.rows.length > 0 && parsed.errors.length === 0 && !done;
  const allSkipped = classification !== null && fresh.length === 0 && saved === 0;
  const ready =
    parsed !== null &&
    parsed.rows.length > 0 &&
    parsed.errors.length === 0 &&
    classification !== null &&
    fresh.length > 0 &&
    sideMode !== null;

  async function read() {
    plan.current = null;
    setSaved(0);
    setDone(false);
    setError(null);
    setExisting(null);
    // 아직 오지 않은 날짜의 줄은 틀린 줄로 알려 준다(서버도 거절한다).
    const result = parseMatchTable(text, { now: Date.now(), timeZone });
    setParsed(result);
    if (result.rows.length === 0 || result.errors.length > 0) return;
    setChecking(true);
    try {
      const res = await call<{ imports: ExistingImport[] }>("GET", `/api/groups/${gid}/imports/fingerprints`);
      setExisting(res.imports);
    } catch (e) {
      setError(e);
    } finally {
      setChecking(false);
    }
  }

  async function run() {
    if (!parsed || !classification || sideMode === null) return;
    setBusy(true);
    setError(null);
    try {
      if (!plan.current) {
        // 이름에 해당하는 참가자를 찾고, 없는 이름은 새로 만든다(같은 이름이면 같은 참가자).
        const idOf = new Map<string, string>();
        for (let i = 0; i < usedNames.length; i += NAME_CHUNK) {
          const names = usedNames.slice(i, i + NAME_CHUNK);
          const ensured = await mutate<{ participants: { id: string }[] }>(`/api/groups/${gid}/participants`, {
            requestId: newRequestId(),
            names,
          });
          names.forEach((name, k) => idOf.set(nameKey(name), ensured.participants[k]!.id));
        }
        const matches = toImportMatches(fresh, (name) => idOf.get(nameKey(name))!, sideMode, timeZone);
        const chunks: Plan["chunks"] = [];
        for (let i = 0; i < matches.length; i += CHUNK) {
          chunks.push({ requestId: newRequestId(), matches: matches.slice(i, i + CHUNK) });
        }
        plan.current = { batchId: newRequestId(), chunks, total: matches.length };
      }
      let count = 0;
      for (const chunk of plan.current.chunks) {
        await mutate(`/api/groups/${gid}/matches/import`, {
          requestId: chunk.requestId,
          batchId: plan.current.batchId,
          source: { kind: "paste" },
          matches: chunk.matches,
        });
        count += chunk.matches.length;
        setSaved(count);
      }
      setDone(true);
      await app.refreshAfterOwnChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/group")}>
          ← 모임
        </button>
        <h1>표 일괄 입력</h1>
      </header>

      <p className="hint">
        시트에 적어 둔 지난 경기를 한꺼번에 넣습니다. 시트에서 범위를 복사해 아래에 붙여 넣으세요.
        한 줄이 한 경기입니다.
      </p>
      <details>
        <summary>열 순서 보기</summary>
        <p className="hint">{IMPORT_COLUMNS.join(" → ")}</p>
        <p className="hint">
          날짜는 2026-10-31, 승리팀은 A 또는 B로 씁니다. 첫 줄이 제목이면 자동으로 건너뜁니다.
        </p>
      </details>

      {!done && (
        <>
          <label>
            붙여 넣을 표
            <textarea
              rows={8}
              value={text}
              disabled={busy || checking || saved > 0}
              onChange={(e) => {
                setText(e.target.value);
                setParsed(null);
                setExisting(null);
              }}
              spellCheck={false}
            />
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || checking || saved > 0 || text.trim() === ""}
            onClick={() => void read()}
          >
            {checking ? "이미 들어간 경기 확인 중…" : "표 읽기"}
          </button>
        </>
      )}

      {parsed && (
        <section className="card" aria-label="미리보기">
          <h2>미리보기</h2>
          {parsed.rows.length === 0 && parsed.errors.length === 0 ? (
            <p>읽은 경기가 없어요. 표를 다시 확인해 주세요.</p>
          ) : (
            <ul className="list">
              <li className="list-row static">
                <span>경기</span>
                <span>{parsed.rows.length}경기</span>
              </li>
              {skipped > 0 && (
                <>
                  <li className="list-row static">
                    <span>이미 들어간 경기(건너뜀)</span>
                    <span>{skipped}경기</span>
                  </li>
                  <li className="list-row static">
                    <span>새로 넣을 경기</span>
                    <span>
                      <strong>{fresh.length}경기</strong>
                    </span>
                  </li>
                </>
              )}
              {dates.length > 0 && (
                <li className="list-row static">
                  <span>기간</span>
                  <span>
                    {dates[0]} ~ {dates[dates.length - 1]}
                  </span>
                </li>
              )}
              <li className="list-row static">
                <span>참가자</span>
                <span>
                  {parsed.names.length}명 (새로 만들 {newNames.length}명)
                </span>
              </li>
            </ul>
          )}
          {newNames.length > 0 && (
            <details>
              <summary>새로 만들 참가자 {newNames.length}명</summary>
              <p className="hint">
                같은 사람이 다른 표기로 들어 있으면 서로 다른 참가자가 됩니다. 넣기 전에 표에서
                이름을 맞춰 주세요.
              </p>
              <p>{newNames.join(", ")}</p>
            </details>
          )}
          {parsed.errors.length > 0 && (
            <div className="note error" role="alert">
              <p>
                <strong>틀린 줄이 {parsed.errors.length}개 있어요.</strong> 모두 고친 뒤에 넣을 수
                있습니다. 일부만 넣지는 않습니다.
              </p>
              <ul>
                {parsed.errors.slice(0, 20).map((e) => (
                  <li key={e.line}>
                    {e.line}번째 줄: {e.message}
                  </li>
                ))}
              </ul>
              {parsed.errors.length > 20 && <p>그 밖에 {parsed.errors.length - 20}줄이 더 있어요.</p>}
            </div>
          )}
          {parsed.errors.length > 0 && !isLegacyLayout(parseDelimited(text)) && (
            <div className="note" role="status">
              <p>열 순서가 기본 형식과 달라 보여요. 열 맞추기 화면에서 어느 열이 무엇인지 고르면 그대로 읽을 수 있어요.</p>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  handOffPaste(text);
                  go("/sheet-import");
                }}
              >
                열 맞추기로 계속
              </button>
            </div>
          )}
        </section>
      )}

      {readable && allSkipped && (
        <p className="note" role="status">
          새로 넣을 경기가 없어요. 이 표의 경기는 이미 모두 들어가 있어요.
        </p>
      )}

      {readable && !allSkipped && (
        <>
          {skipped > 0 && (
            <p className="hint">
              같은 날짜·같은 명단·같은 결과로 이미 들어간 {skipped}경기는 건너뛰고 {fresh.length}경기만 넣어요.
            </p>
          )}
          {classification && classification.wasExcluded > 0 && (
            <p className="hint">
              전에 넣었다가 전적 제외한 경기와 같은 내용 {classification.wasExcluded}경기는 새로 넣어요. 제외한 묶음을
              다시 복구하면 같은 경기가 두 번 들어가니 둘 중 하나만 쓰세요.
            </p>
          )}
          <fieldset disabled={busy || saved > 0}>
            <legend>진영을 어떻게 넣을까요?</legend>
            <label className={sideMode === "unknown" ? "choice chosen" : "choice"}>
              <input
                type="radio"
                name="side-mode"
                checked={sideMode === "unknown"}
                onChange={() => setSideMode("unknown")}
              />
              <span>
                <strong>진영 미상으로 넣기</strong>
                <br />
                <span className="hint">
                  개인 승패와 배치 판수에는 들어가고 진영 통계에서만 빠집니다. 실제 진영을 확신할 수
                  없을 때 고르세요.
                </span>
              </span>
            </label>
            <label className={sideMode === "a-blue" ? "choice chosen" : "choice"}>
              <input
                type="radio"
                name="side-mode"
                checked={sideMode === "a-blue"}
                onChange={() => setSideMode("a-blue")}
              />
              <span>
                <strong>팀 A는 블루, 팀 B는 레드로 넣기</strong>
                <br />
                <span className="hint">
                  표의 A팀이 항상 블루 진영이었을 때 고르세요. 진영 통계에 들어갑니다.
                </span>
              </span>
            </label>
            <p className="hint">어느 쪽이든 나중에 경기마다 진영을 고칠 수 있습니다.</p>
          </fieldset>

          <p className="hint">
            잘못 넣었다면 모임 탭의 표 일괄 입력 기록에서 이번에 넣은 경기를 한 번에 전적 제외할 수
            있습니다.
          </p>
          <ErrorNote error={error} onCheck={() => void run()} />
          {saved > 0 && !busy && (
            <p className="note" role="status">
              {plan.current?.total}경기 중 {saved}경기까지 저장됐습니다. 이어서 넣으면 이미 들어간
              경기는 다시 들어가지 않습니다.
            </p>
          )}
          <button type="button" className="primary wide" disabled={!ready || busy} onClick={() => void run()}>
            {busy
              ? `저장 중 · ${saved}/${plan.current?.total ?? fresh.length}경기`
              : saved > 0
                ? "이어서 넣기"
                : `${classification ? fresh.length : parsed.rows.length}경기 넣기`}
          </button>
        </>
      )}

      {done && (
        <section className="card" aria-label="완료">
          <p className="saved" role="status">
            <strong>
              {saved}경기 저장됨 ·{" "}
              {sideMode === "unknown" ? "진영 미상" : "팀 A → 블루팀, 팀 B → 레드팀"}
            </strong>
          </p>
          {skipped > 0 && <p className="hint">이미 들어간 {skipped}경기는 건너뛰었어요.</p>}
          <div className="button-row">
            <button type="button" className="primary" onClick={() => go("/records")}>
              기록 보기
            </button>
            <button type="button" className="secondary" onClick={() => go("/graphs")}>
              그래프 분석
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
