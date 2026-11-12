import { useEffect, useMemo, useRef, useState } from "react";
import { columnCount, parseDelimited } from "../../shared/csv";
import { linkNames, similarWithinTable, type NameLink } from "../../shared/importLink";
import { nameKey } from "../../shared/names";
import {
  classifyImport,
  detectMapping,
  hash64,
  nextFreeFingerprint,
  LAYOUT_LABELS,
  LAYOUTS,
  mappingProblems,
  parseSheet,
  roleLabel,
  rolesOf,
  toSheetPayload,
  type ExistingImport,
  type ImportClassification,
  type Layout,
  type SheetImportPayload,
  type SheetMapping,
  type SheetMatch,
  type SheetSideMode,
} from "../../shared/sheetTable";
import { looksLikeLegacyUrl } from "../../shared/legacy";
import { parseSheetUrl, SHEET_URL_MESSAGES, type SheetTab } from "../../shared/sheetUrl";
import { localDate } from "../../shared/stats";
import { ApiFailure, call, mutate, newRequestId } from "../api";
import { handOffLegacyUrl, takePastedText } from "../sheetHandoff";
import { ImportDateWarnings } from "../importDateWarnings";
import { ImportAgainPicker } from "../importAgain";
import { ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { CreateGroupButton } from "../account";

const CHUNK = 50;
const NAME_CHUNK = 30;
const PREVIEW_ROWS = 20;
const LIST_LIMIT = 20;
const MAPPING_KEY = "naejeon.sheetMapping.v1:";
/** 열이 이보다 많으면 열 고르기를 접고 미리보기 표도 앞쪽 열만 보여 준다. */
const MANY_COLUMNS = 40;
const PREVIEW_COLUMNS = 30;
const ACROSS_SAMPLE = 5;

type Step = 1 | 2 | 3 | 4;

interface Loaded {
  rows: string[][];
  kind: "sheet" | "paste";
  /** 시트 출처 열쇠(sheet:문서:gid). 붙여 넣기는 null. */
  sourceKey: string | null;
  title: string | null;
  /** 시트 문서의 탭 목록(주소에 탭 번호가 없었거나 탭 이름으로 읽었을 때). */
  tabs?: SheetTab[];
  /** 읽은 탭. */
  tab?: SheetTab;
}

interface Plan {
  batchId: string;
  chunks: { requestId: string; matches: SheetImportPayload[] }[];
  total: number;
}

const STEP_NAMES = ["링크", "열 맞추기", "확인", "가져오기"] as const;

function columnLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function parseRowList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/)) {
    const range = /^(\d{1,6})(?:\s*[-~]\s*(\d{1,6}))?$/.exec(part.trim());
    if (!range) continue;
    const from = Number(range[1]);
    const to = Math.min(Number(range[2] ?? range[1]), from + 5000);
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function mappingKey(loaded: Loaded): string {
  if (loaded.sourceKey) return MAPPING_KEY + loaded.sourceKey;
  const first = loaded.rows.find((r) => r.some((c) => c.trim() !== "")) ?? [];
  return `${MAPPING_KEY}paste:${hash64(first.join("\u0001"))}`;
}

/** 이 기기에 기억한 열 맞춤. 표의 열 수와 맞지 않으면 버린다. */
function storedMapping(loaded: Loaded): SheetMapping | null {
  try {
    const raw = localStorage.getItem(mappingKey(loaded));
    if (!raw) return null;
    const value = JSON.parse(raw) as SheetMapping;
    const cols = columnCount(loaded.rows);
    if (!LAYOUTS.includes(value.layout) || typeof value.columns !== "object") return null;
    if (Object.values(value.columns).some((c) => typeof c !== "number" || c < 0 || c >= cols)) return null;
    if (!Number.isInteger(value.headerRow) || !Array.isArray(value.skip)) return null;
    return {
      layout: value.layout,
      headerRow: value.headerRow,
      skip: value.skip.filter((n) => Number.isInteger(n)),
      columns: value.columns,
      lanesByOrder: value.lanesByOrder !== false,
      year: typeof value.year === "number" ? value.year : null,
    };
  } catch {
    return null;
  }
}

function rememberMapping(loaded: Loaded, mapping: SheetMapping): void {
  try {
    localStorage.setItem(mappingKey(loaded), JSON.stringify(mapping));
  } catch {
    // 기기 저장소를 못 쓰면 기억하지 않는다(다음에 다시 맞추면 된다).
  }
}

/**
 * 구글 시트에서 가져오기(붙여 넣은 표도 같은 화면). 1 링크 → 2 열 맞추기 → 3 확인 → 4 가져오기.
 * 전체를 읽고 검증한 뒤에만 저장한다. 저장은 기존 일괄 입력 경로(50경기 묶음, 이어서 넣기)로 한다.
 */
export function SheetImport() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<"sheet" | "paste">("sheet");
  const [url, setUrl] = useState("");
  const [tabName, setTabName] = useState("");
  const [tabChoices, setTabChoices] = useState<string[] | null>(null);
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<SheetMapping | null>(null);
  const [mappingFromMemory, setMappingFromMemory] = useState(false);
  const [skipText, setSkipText] = useState("");
  const [existing, setExisting] = useState<ExistingImport[] | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [sideMode, setSideMode] = useState<SheetSideMode | null>(null);
  const [skipErrors, setSkipErrors] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [done, setDone] = useState(false);
  // "이미 들어간 경기"로 분류됐지만 한 번 더 한 경기라고 고른 줄(줄 번호). importAgain.tsx 설명.
  const [asNew, setAsNew] = useState<ReadonlySet<number>>(new Set());
  const plan = useRef<Plan | null>(null);

  // 표 일괄 입력에서 넘어온 붙여 넣기.
  useEffect(() => {
    const pasted = takePastedText();
    if (pasted !== null) {
      setMode("paste");
      setText(pasted);
      openTable({ rows: parseDelimited(pasted), kind: "paste", sourceKey: null, title: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timeZone = snapshot?.group.timezone ?? "Asia/Seoul";
  const today = localDate(new Date().toISOString(), timeZone);
  // 아직 오지 않은 경기는 지금 시각 기준으로 틀린 줄이 된다(서버도 같은 기준으로 거절한다).
  const parsed = useMemo(
    () => (loaded && mapping ? parseSheet(loaded.rows, mapping, { today, now: Date.now(), timeZone }) : null),
    [loaded, mapping, today, timeZone],
  );
  const classification: ImportClassification | null = useMemo(
    () => (parsed && existing ? classifyImport(parsed.matches, existing, loaded?.sourceKey ?? null) : null),
    [parsed, existing, loaded],
  );
  // 고른 줄은 이미 쓰인 지문(모임에 있는 것 + 이번에 넣을 것)을 피한 다음 순번 지문으로 바꿔 새 경기로 보낸다.
  const promoted: SheetMatch[] = useMemo(() => {
    if (!classification || !existing) return [];
    const taken = new Set([
      ...existing.map((e) => e.fingerprint),
      ...classification.fresh.map((m) => m.fingerprint),
      ...classification.changed.map((c) => c.match.fingerprint),
    ]);
    return classification.already
      .filter((m) => asNew.has(m.line))
      .map((m) => {
        const fingerprint = nextFreeFingerprint(m, taken);
        taken.add(fingerprint);
        return { ...m, fingerprint };
      });
  }, [classification, existing, asNew]);
  const links: NameLink[] = useMemo(() => {
    if (!parsed || !snapshot || !classification) return [];
    const used = new Set<string>();
    for (const m of [...classification.fresh, ...classification.changed.map((c) => c.match), ...promoted]) {
      for (const p of [...m.teamA, ...m.teamB]) used.add(nameKey(p.name));
    }
    return linkNames(
      parsed.names.filter((n) => used.has(nameKey(n))),
      snapshot.participants,
    );
  }, [parsed, snapshot, classification, promoted]);

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>구글 시트에서 가져오기</h1>
        <p>모임이 있어야 기록을 넣을 수 있어요. 경기를 하지 않아도 모임을 먼저 만들 수 있어요.</p>
        <div className="button-row">
          <CreateGroupButton primary label="모임 만들고 시작" to="/sheet-import" />
          <button type="button" className="secondary" onClick={() => go("/")}>
            오늘로 가기
          </button>
        </div>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const isLegacyUrl = url.trim() !== "" && looksLikeLegacyUrl(url);
  const urlCheck = url.trim() === "" || isLegacyUrl ? null : parseSheetUrl(url);

  function openTable(next: Loaded) {
    const remembered = storedMapping(next);
    const m = remembered ?? detectMapping(next.rows);
    setLoaded(next);
    setMapping(m);
    setMappingFromMemory(remembered !== null);
    setSkipText(m.skip.join(", "));
    setExisting(null);
    setAsNew(new Set());
    setChoices({});
    setSideMode(null);
    setSkipErrors(false);
    setIncludeChanged(false);
    plan.current = null;
    setSaved(0);
    setDone(false);
    setStep(2);
  }

  async function readSheet(tab: string = tabName) {
    if (!urlCheck?.ok) return;
    setBusy(true);
    setError(null);
    setTabChoices(null);
    try {
      const res = await call<{ csv: string; title: string | null; sourceKey: string; tabs?: SheetTab[]; tab?: SheetTab }>(
        "POST",
        `/api/groups/${gid}/sheets/read`,
        { url: url.trim(), ...(tab.trim() !== "" ? { tab: tab.trim() } : {}) },
      );
      const rows = parseDelimited(res.csv, ",");
      if (rows.every((r) => r.every((c) => c.trim() === ""))) {
        setError(new Error("empty"));
        return;
      }
      openTable({
        rows,
        kind: "sheet",
        sourceKey: res.sourceKey,
        title: res.title,
        ...(res.tabs ? { tabs: res.tabs } : {}),
        ...(res.tab ? { tab: res.tab } : {}),
      });
    } catch (e) {
      // 탭 이름을 못 찾으면 이 시트의 탭 목록을 골라 쓰게 한다.
      if (e instanceof ApiFailure && e.code === "SHEET_TAB_NOT_FOUND" && Array.isArray(e.details?.tabs)) {
        setTabChoices((e.details!.tabs as unknown[]).filter((t): t is string => typeof t === "string"));
      }
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  function readPasted() {
    setError(null);
    openTable({ rows: parseDelimited(text), kind: "paste", sourceKey: null, title: null });
  }

  async function goConfirm() {
    if (!loaded || !mapping) return;
    rememberMapping(loaded, mapping);
    // 아직 아무것도 저장하지 않았으면 설정이 바뀌었을 수 있으니 저장 계획을 새로 만든다.
    if (saved === 0) plan.current = null;
    setBusy(true);
    setError(null);
    try {
      const res = await call<{ imports: ExistingImport[] }>("GET", `/api/groups/${gid}/imports/fingerprints`);
      setExisting(res.imports);
      setStep(3);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const toSend = classification
    ? [...classification.fresh, ...promoted, ...(includeChanged ? classification.changed.map((c) => c.match) : [])].sort(
        (x, y) => x.line - y.line,
      )
    : [];
  const undecided = links.filter((l) => l.kind === "similar" && !choices[l.name]);
  const errorCount = parsed?.errors.length ?? 0;
  const ready =
    toSend.length > 0 && sideMode !== null && undecided.length === 0 && (errorCount === 0 || skipErrors);

  async function run() {
    if (!classification || sideMode === null) return;
    setStep(4);
    setBusy(true);
    setError(null);
    try {
      if (!plan.current) {
        const idOf = new Map<string, string>();
        const create: string[] = [];
        for (const link of links) {
          const choice = link.kind === "similar" ? choices[link.name] : undefined;
          if (link.participantId) idOf.set(nameKey(link.name), link.participantId);
          else if (choice && choice !== "new") idOf.set(nameKey(link.name), choice);
          else create.push(link.name);
        }
        for (let i = 0; i < create.length; i += NAME_CHUNK) {
          const names = create.slice(i, i + NAME_CHUNK);
          const ensured = await mutate<{ participants: { id: string }[] }>(`/api/groups/${gid}/participants`, {
            requestId: newRequestId(),
            names,
          });
          names.forEach((name, k) => idOf.set(nameKey(name), ensured.participants[k]!.id));
        }
        const matches = toSheetPayload(toSend, (name) => idOf.get(nameKey(name))!, sideMode, timeZone);
        const chunks: Plan["chunks"] = [];
        for (let i = 0; i < matches.length; i += CHUNK) {
          chunks.push({ requestId: newRequestId(), matches: matches.slice(i, i + CHUNK) });
        }
        plan.current = { batchId: newRequestId(), chunks, total: matches.length };
      }
      const source =
        loaded?.kind === "sheet"
          ? { kind: "sheet", sourceKey: loaded.sourceKey, ...(loaded.title ? { label: loaded.title } : {}) }
          : { kind: "paste" };
      let count = 0;
      for (const chunk of plan.current.chunks) {
        await mutate(`/api/groups/${gid}/matches/import`, {
          requestId: chunk.requestId,
          batchId: plan.current.batchId,
          source,
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
        <h1>구글 시트에서 가져오기</h1>
      </header>

      <ol className="sheet-steps" aria-label="단계">
        {STEP_NAMES.map((name, i) => (
          <li key={name} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "current" : ""}>
            <span className="sheet-step-no">{i + 1}</span> {name}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <section className="card" aria-label="링크">
          <fieldset>
            <legend>어디서 읽을까요?</legend>
            <div className="choice-row">
              <label className={mode === "sheet" ? "choice chosen" : "choice"}>
                <input type="radio" name="sheet-mode" checked={mode === "sheet"} onChange={() => setMode("sheet")} />
                <span>시트 주소로 읽기</span>
              </label>
              <label className={mode === "paste" ? "choice chosen" : "choice"}>
                <input type="radio" name="sheet-mode" checked={mode === "paste"} onChange={() => setMode("paste")} />
                <span>표 붙여 넣기</span>
              </label>
            </div>
          </fieldset>
          {mode === "sheet" ? (
            <>
              <label>
                구글 시트 주소
                <input
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://docs.google.com/spreadsheets/d/…"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setError(null);
                  }}
                />
              </label>
              {/* 주소 오류는 칸 바로 아래(설명 문단보다 위)에 둔다. */}
              {urlCheck && !urlCheck.ok && (
                <p className="note error" role="alert">
                  {SHEET_URL_MESSAGES[urlCheck.problem]}
                </p>
              )}
              <p className="hint">
                가져올 탭을 연 상태에서 브라우저 주소창의 주소를 복사해 붙여 넣으세요. 시트의 공유 설정이
                '링크가 있는 모든 사용자(보기)'여야 읽을 수 있어요. 다른 탭을 가져오려면 그 탭을 열고 주소를
                다시 복사하세요.
              </p>
              {isLegacyUrl && (
                <div className="note" role="status">
                  <p>
                    <strong>기존 사이트의 연결 주소로 보여요.</strong> script.google.com/macros/s/…/exec 주소는 시트가
                    아니라 기존 사이트가 기록을 읽던 주소예요. 기존 사이트 기록 가져오기로 읽을 수 있어요.
                  </p>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      handOffLegacyUrl(url.trim());
                      go("/legacy-import");
                    }}
                  >
                    기존 사이트 기록 가져오기로
                  </button>
                </div>
              )}
              {urlCheck?.ok && urlCheck.ref.gid === null && (
                <>
                  <p className="hint">
                    주소에 탭 번호(gid)가 없어요. 비워 두면 첫 번째 탭을 읽어요. 다른 탭이면 시트 맨 아래에 보이는 탭
                    이름을 적어 주세요.
                  </p>
                  {urlCheck.ref.kind === "doc" && (
                    <label>
                      탭 이름(선택)
                      <input
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="예: RAW DATA기입"
                        value={tabName}
                        onChange={(e) => {
                          setTabName(e.target.value);
                          setTabChoices(null);
                          setError(null);
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              {!isLegacyUrl && (
                <button
                  type="button"
                  className="primary wide"
                  disabled={busy || !urlCheck?.ok}
                  onClick={() => void readSheet()}
                >
                  {busy ? "시트 읽는 중…" : "시트 읽기"}
                </button>
              )}
              {tabChoices && tabChoices.length > 0 && (
                <label>
                  이 시트의 탭
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value === "") return;
                      setTabName(e.target.value);
                      void readSheet(e.target.value);
                    }}
                  >
                    <option value="">탭을 골라 주세요</option>
                    {tabChoices.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="hint">시트 내용은 서버에 저장하지 않아요. 확인을 마치고 가져올 때 경기만 저장합니다.</p>
              <p className="hint">
                기존 사이트(구글 시트 + Apps Script)에서 옮겨 오나요?{" "}
                <button type="button" className="link" onClick={() => go("/legacy-import")}>
                  기존 사이트 기록 가져오기
                </button>
                가 더 정확해요(라인·날짜를 그대로 가져와요).
              </p>
            </>
          ) : (
            <>
              <label>
                붙여 넣을 표
                <textarea rows={8} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
              </label>
              <p className="hint">시트에서 머리글까지 범위를 복사해 붙여 넣으세요. 다음 단계에서 열을 맞춥니다.</p>
              <button type="button" className="primary wide" disabled={text.trim() === ""} onClick={readPasted}>
                표 읽기
              </button>
            </>
          )}
          {error instanceof Error && error.message === "empty" ? (
            <p className="note error" role="alert">
              읽은 표가 비어 있어요. 가져올 탭의 주소가 맞는지 확인해 주세요.
            </p>
          ) : (
            <ErrorNote error={error} />
          )}
        </section>
      )}

      {step === 2 && loaded && mapping && parsed && (
        <MappingStep
          loaded={loaded}
          mapping={mapping}
          fromMemory={mappingFromMemory}
          skipText={skipText}
          parsed={parsed}
          onSkipText={(value) => {
            setSkipText(value);
            setMapping({ ...mapping, skip: parseRowList(value) });
          }}
          onChange={setMapping}
          onPickTab={(name) => {
            setTabName(name);
            void readSheet(name);
          }}
          onBack={() => setStep(1)}
          onNext={() => void goConfirm()}
          busy={busy}
          error={error}
        />
      )}

      {step === 3 && parsed && classification && (
        <section className="card" aria-label="확인">
          <h2>가져올 내용 확인</h2>
          <ImportDateWarnings matches={parsed.matches} />
          <ul className="list">
            <li className="list-row static">
              <span>읽은 경기</span>
              <span>{parsed.matches.length}경기</span>
            </li>
            <li className="list-row static">
              <span>이미 들어간 경기(건너뜀)</span>
              <span>{classification.already.length - promoted.length}경기</span>
            </li>
            {classification.already.length > 0 && (
              <li className="list-row static">
                <ImportAgainPicker
                  rows={classification.already.map((m) => ({
                    line: m.line,
                    where: m.where,
                    date: m.date,
                    winner: m.winner,
                    firstName: m.teamA[0]?.name ?? "",
                  }))}
                  picked={asNew}
                  disabled={busy || done}
                  onChange={(next) => {
                    setAsNew(next);
                    plan.current = null;
                  }}
                />
              </li>
            )}
            <li className="list-row static">
              <span>새로 넣을 경기</span>
              <span>
                <strong>{toSend.length}경기</strong>
              </span>
            </li>
            {classification.changed.length > 0 && (
              <li className="list-row static">
                <span>바뀐 줄</span>
                <span>{classification.changed.length}개</span>
              </li>
            )}
            {errorCount > 0 && (
              <li className="list-row static">
                <span>틀린 줄</span>
                <span>{errorCount}개</span>
              </li>
            )}
          </ul>
          {toSend.length > 0 && (
            <p className="hint">
              기간: {toSend.reduce((a, m) => (m.date < a ? m.date : a), toSend[0]!.date)} ~{" "}
              {toSend.reduce((a, m) => (m.date > a ? m.date : a), toSend[0]!.date)}
            </p>
          )}
          {classification.wasExcluded > 0 && (
            <p className="hint">
              전에 넣었다가 전적 제외한 경기와 같은 내용 {classification.wasExcluded}경기는 새로 넣어요. 제외한 묶음을
              다시 복구하면 같은 경기가 두 번 들어가니 둘 중 하나만 쓰세요.
            </p>
          )}
          {classification.missing > 0 && (
            <p className="hint">
              전에 이 시트에서 가져왔는데 지금 시트에 없는 경기가 {classification.missing}개 있어요. 이미 들어간 기록은
              그대로 두니 필요하면 기록 화면에서 전적 제외하세요.
            </p>
          )}

          {errorCount > 0 && (
            <div className="note warn" role="alert">
              <p>
                <strong>틀린 줄이 {errorCount}개 있어요.</strong> 시트를 고친 뒤 다시 읽거나, 틀린 줄만 빼고 넣을 수
                있어요.
              </p>
              <ul>
                {parsed.errors.slice(0, LIST_LIMIT).map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    {e.where ?? `${e.line}번째 줄`}: {e.message}
                  </li>
                ))}
              </ul>
              {errorCount > LIST_LIMIT && <p>그 밖에 {errorCount - LIST_LIMIT}줄이 더 있어요.</p>}
              <label className="check-line">
                <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
                <span>틀린 줄 {errorCount}개는 빼고 넣기</span>
              </label>
              <button type="button" className="secondary" onClick={() => setStep(1)}>
                고친 뒤 다시 읽기
              </button>
            </div>
          )}

          {classification.changed.length > 0 && (
            <details>
              <summary>바뀐 줄 {classification.changed.length}개</summary>
              <p className="hint">
                전에 가져온 같은 자리(같은 날짜·순서)의 경기와 내용이 달라요. 시트에서 고친 줄이면 기록 화면에서 그
                경기를 직접 고치세요.
              </p>
              <ul>
                {classification.changed.slice(0, LIST_LIMIT).map((c) => (
                  <li key={c.match.line}>
                    {c.match.where ?? `${c.match.line}번째 줄`} ({c.match.date}) — 전에 넣은 {c.previous.matchNo}번 경기와 달라요
                  </li>
                ))}
              </ul>
              <label className="check-line">
                <input type="checkbox" checked={includeChanged} onChange={(e) => setIncludeChanged(e.target.checked)} />
                <span>바뀐 줄도 새 경기로 넣기(전에 넣은 경기는 그대로 남아요)</span>
              </label>
            </details>
          )}

          <NameLinks links={links} choices={choices} onChoose={(name, value) => setChoices({ ...choices, [name]: value })} names={parsed.names} />

          {toSend.length === 0 ? (
            <p className="note" role="status">
              새로 넣을 경기가 없어요. 이 시트의 경기는 이미 모두 들어가 있어요.
            </p>
          ) : (
            <fieldset>
              <legend>진영을 어떻게 넣을까요?</legend>
              <label className={sideMode === "unknown" ? "choice chosen" : "choice"}>
                <input type="radio" name="sheet-side" checked={sideMode === "unknown"} onChange={() => setSideMode("unknown")} />
                <span>
                  <strong>진영 미상으로 넣기</strong>
                  <br />
                  <span className="hint">개인 승패와 배치 판수에는 들어가고 진영 통계에서만 빠집니다.</span>
                </span>
              </label>
              <label className={sideMode === "a-blue" ? "choice chosen" : "choice"}>
                <input type="radio" name="sheet-side" checked={sideMode === "a-blue"} onChange={() => setSideMode("a-blue")} />
                <span>
                  <strong>팀 A는 블루, 팀 B는 레드로 넣기</strong>
                  <br />
                  <span className="hint">표의 팀 A(위 5명·앞 5명)가 항상 블루였을 때 고르세요.</span>
                </span>
              </label>
              {mapping?.columns.side !== undefined && (
                <label className={sideMode === "column" ? "choice chosen" : "choice"}>
                  <input type="radio" name="sheet-side" checked={sideMode === "column"} onChange={() => setSideMode("column")} />
                  <span>
                    <strong>표의 진영 열대로 넣기</strong>
                    <br />
                    <span className="hint">
                      진영 열이 실제 진영이 아니라 자리 기준(위 5명=블루)일 수 있어요. 실제 진영이 확실할 때만 고르세요.
                      비어 있는 칸은 진영 미상이 됩니다.
                    </span>
                  </span>
                </label>
              )}
              <p className="hint">어느 쪽이든 나중에 경기마다 진영을 고칠 수 있습니다.</p>
            </fieldset>
          )}

          <div className="button-row">
            <button type="button" className="secondary" onClick={() => setStep(2)}>
              ← 열 맞추기
            </button>
            {toSend.length > 0 && (
              <button type="button" className="primary" disabled={!ready} onClick={() => void run()}>
                {toSend.length}경기 가져오기
              </button>
            )}
          </div>
          {toSend.length > 0 && !ready && (
            <p className="hint">
              {sideMode === null
                ? "진영을 어떻게 넣을지 골라 주세요."
                : undecided.length > 0
                  ? `비슷한 이름 ${undecided.length}개를 어떻게 이을지 골라 주세요.`
                  : "틀린 줄을 빼고 넣을지 골라 주세요."}
            </p>
          )}
        </section>
      )}

      {step === 4 && (
        <section className="card" aria-label="가져오기">
          {!done && (
            <p role="status">
              {busy
                ? `저장 중 · ${saved}/${plan.current?.total ?? toSend.length}경기`
                : `${plan.current?.total ?? toSend.length}경기 중 ${saved}경기까지 저장됐습니다.`}
            </p>
          )}
          <ErrorNote error={error} onCheck={() => void run()} />
          {!done && !busy && (
            <>
              <p className="hint">이어서 넣으면 이미 들어간 묶음은 다시 들어가지 않습니다.</p>
              <button type="button" className="primary wide" onClick={() => void run()}>
                이어서 넣기
              </button>
            </>
          )}
          {done && (
            <>
              <p className="saved" role="status">
                <strong>
                  {saved}경기 저장됨 ·{" "}
                  {sideMode === "unknown" ? "진영 미상" : sideMode === "a-blue" ? "팀 A → 블루팀, 팀 B → 레드팀" : "표의 진영 열"}
                </strong>
              </p>
              <p className="hint">
                잘못 넣었다면 모임 탭의 표 일괄 입력 기록에서 이번에 넣은 경기를 한 번에 전적 제외할 수 있습니다.
              </p>
              <div className="button-row">
                <button type="button" className="primary" onClick={() => go("/records")}>
                  기록 보기
                </button>
                <button type="button" className="secondary" onClick={() => go("/group")}>
                  모임으로
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MappingStep(props: {
  loaded: Loaded;
  mapping: SheetMapping;
  fromMemory: boolean;
  skipText: string;
  parsed: ReturnType<typeof parseSheet>;
  onSkipText: (value: string) => void;
  onChange: (mapping: SheetMapping) => void;
  onPickTab: (name: string) => void;
  onBack: () => void;
  onNext: () => void;
  busy: boolean;
  error: unknown;
}) {
  const { loaded, mapping, parsed } = props;
  const across = mapping.layout === "across";
  const rows = loaded.rows;
  const cols = columnCount(rows);
  const roles = rolesOf(mapping.layout);
  const roleOfColumn = new Map(Object.entries(mapping.columns).map(([role, col]) => [col, role]));
  const problems = mappingProblems(mapping);
  const header = mapping.headerRow > 0 ? (rows[mapping.headerRow - 1] ?? []) : [];
  const skip = new Set(mapping.skip);
  const errorLines = new Set(parsed.errors.map((e) => e.line));
  const sampleRows = rows
    .map((cells, i) => ({ cells, line: i + 1 }))
    .filter((r) => r.line > mapping.headerRow && !skip.has(r.line) && r.cells.some((c) => c.trim() !== ""))
    .slice(0, 3);
  const hasLaneColumn = roles.some((r) => /lane/i.test(r) && mapping.columns[r] !== undefined);
  const manyColumns = cols > MANY_COLUMNS;
  const previewCols = Math.min(cols, PREVIEW_COLUMNS);
  const thisYear = Number(localDate(new Date().toISOString(), "Asia/Seoul").slice(0, 4));

  function setRole(col: number, role: string) {
    const columns: Record<string, number> = {};
    for (const [r, c] of Object.entries(mapping.columns)) {
      if (c === col || r === role) continue;
      columns[r] = c;
    }
    if (role !== "") columns[role] = col;
    props.onChange({ ...mapping, columns });
  }

  return (
    <section className="card" aria-label="열 맞추기">
      <h2>열 맞추기</h2>
      <p className="hint">
        {loaded.title ? `${loaded.title} · ` : ""}
        {rows.length}줄 · {cols}열.{" "}
        {across ? "" : "어느 열이 무엇인지 맞춰 주세요. "}
        {props.fromMemory ? "이 기기에 기억한 설정을 적용했어요." : across ? "" : "머리글과 값을 보고 먼저 맞춰 두었어요."}
      </p>
      {loaded.tabs && loaded.tabs.length > 1 && (
        <label>
          읽은 탭
          <select value={loaded.tab?.name ?? ""} onChange={(e) => props.onPickTab(e.target.value)} disabled={props.busy}>
            {!loaded.tab && <option value="">(알 수 없음)</option>}
            {loaded.tabs.map((t) => (
              <option key={t.gid} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {across && (
        <p className="note" role="status">
          <strong>가로로 긴 표로 보여요.</strong> 경기마다 이름·승패 두 열이 옆으로 늘어선 표(기존 사이트의 RAW DATA
          모양)로 읽어요. 위 5명이 팀 A, 아래 5명이 팀 B이고, 날짜는 위쪽 날짜 줄에서 이어받아요.
        </p>
      )}

      <fieldset>
        <legend>표 모양</legend>
        {LAYOUTS.map((layout: Layout) => (
          <label key={layout} className={mapping.layout === layout ? "choice chosen" : "choice"}>
            <input
              type="radio"
              name="sheet-layout"
              checked={mapping.layout === layout}
              onChange={() =>
                props.onChange({
                  ...detectMapping(rows, layout),
                  headerRow: mapping.headerRow,
                  skip: mapping.skip,
                  year: mapping.year,
                })
              }
            />
            <span>{LAYOUT_LABELS[layout]}</span>
          </label>
        ))}
        {mapping.layout === "pair" && (
          <p className="hint">팀 열이 없으면 두 줄 중 위 줄을 팀 A로 봅니다.</p>
        )}
        {mapping.layout === "player" && (
          <p className="hint">경기 번호 열이 없으면 10줄씩 한 경기로 묶고, 팀 열이 없으면 앞 5명을 팀 A로 봅니다.</p>
        )}
      </fieldset>

      {!across && (
      <div className="sheet-options">
        <label>
          머리글 줄
          <select
            value={mapping.headerRow}
            onChange={(e) => props.onChange({ ...mapping, headerRow: Number(e.target.value) })}
          >
            <option value={0}>머리글 없음</option>
            {rows.slice(0, 10).map((_, i) => (
              <option key={i} value={i + 1}>
                {i + 1}번째 줄
              </option>
            ))}
          </select>
        </label>
        <label>
          건너뛸 줄
          <input
            type="text"
            inputMode="numeric"
            placeholder="예: 2, 30-32"
            value={props.skipText}
            onChange={(e) => props.onSkipText(e.target.value)}
          />
        </label>
      </div>
      )}

      {!across && (
      <details className="sheet-col-picker" open={!manyColumns}>
      <summary>
        <h3 className="inline-heading">열마다 역할 고르기</h3>
        {manyColumns ? ` · 열이 ${cols}개라 접어 두었어요` : ""}
      </summary>
      <ul className="sheet-cols">
        {Array.from({ length: cols }, (_, col) => {
          const samples = sampleRows.map((r) => (r.cells[col] ?? "").trim()).filter((v) => v !== "");
          return (
            <li key={col} className="sheet-col">
              <label>
                <span className="sheet-col-name">
                  열 {columnLetter(col)}
                  {header[col]?.trim() ? ` · ${header[col]!.trim()}` : ""}
                </span>
                <span className="hint sheet-col-sample">{samples.length > 0 ? `예: ${samples.join(", ")}` : "예: (빈 칸)"}</span>
                <select value={roleOfColumn.get(col) ?? ""} onChange={(e) => setRole(col, e.target.value)}>
                  <option value="">안 씀</option>
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(mapping.layout, role)}
                      {mapping.columns[role] !== undefined && mapping.columns[role] !== col
                        ? ` (지금 열 ${columnLetter(mapping.columns[role]!)})`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          );
        })}
      </ul>
      </details>
      )}

      {!hasLaneColumn && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={mapping.lanesByOrder}
            onChange={(e) => props.onChange({ ...mapping, lanesByOrder: e.target.checked })}
          />
          <span>
            {across
              ? "팀마다 위에서부터 탑→정글→미드→원딜→서폿 순서로 라인 정하기"
              : "라인 열이 없으니 이름 칸 순서(탑→정글→미드→원딜→서폿)로 라인 정하기"}
          </span>
        </label>
      )}

      {parsed.yearGuess && (
        <div className="note" role="status">
          <p>
            연도가 없는 날짜가 {parsed.yearGuess.count}경기 있어요.{" "}
            {parsed.yearGuess.basis === "guess"
              ? `${parsed.yearGuess.from === parsed.yearGuess.to ? parsed.yearGuess.from : `${parsed.yearGuess.from}~${parsed.yearGuess.to}`}년으로 추정했어요(마지막 경기를 오늘 이전으로 보고, 줄 순서대로 12월→1월이면 해를 넘김). 다르면 첫 경기의 연도를 골라 주세요.`
              : `${parsed.yearGuess.from}년부터 줄 순서대로 셌어요.`}
          </p>
          <label>
            첫 경기의 연도
            <select
              value={mapping.year ?? ""}
              onChange={(e) => props.onChange({ ...mapping, year: e.target.value === "" ? null : Number(e.target.value) })}
            >
              <option value="">추정에 맡기기</option>
              {Array.from({ length: 11 }, (_, i) => thisYear - i).map((y) => (
                <option key={y} value={y}>
                  {y}년
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <h3>미리보기</h3>
      {across ? (
        <AcrossPreview matches={parsed.matches.slice(0, ACROSS_SAMPLE)} />
      ) : (
      <>
      <div className="sheet-scroll" tabIndex={0} role="region" aria-label="표 미리보기">
        <table className="sheet-table">
          <thead>
            <tr>
              <th scope="col">줄</th>
              {Array.from({ length: previewCols }, (_, col) => (
                <th key={col} scope="col">
                  {columnLetter(col)}
                  <br />
                  <span className="sheet-role">
                    {roleOfColumn.has(col) ? roleLabel(mapping.layout, roleOfColumn.get(col)!).replace(/\(.*\)$/, "") : "—"}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, PREVIEW_ROWS).map((cells, i) => {
              const line = i + 1;
              const kind =
                line === mapping.headerRow ? "header" : line < mapping.headerRow || skip.has(line) ? "skipped" : errorLines.has(line) ? "error" : "";
              return (
                <tr key={line} className={kind ? `sheet-row-${kind}` : undefined}>
                  <th scope="row">
                    {line}
                    {kind === "error" ? " ⚠" : kind === "skipped" ? " ⤼" : ""}
                  </th>
                  {Array.from({ length: previewCols }, (_, col) => (
                    <td key={col}>{cells[col] ?? ""}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_ROWS && <p className="hint">처음 {PREVIEW_ROWS}줄만 보여요. 그 밖에 {rows.length - PREVIEW_ROWS}줄이 더 있어요.</p>}
      {cols > previewCols && <p className="hint">앞쪽 {previewCols}열만 보여요. 그 밖에 {cols - previewCols}열이 더 있어요.</p>}
      </>
      )}

      {problems.length > 0 ? (
        <div className="note error" role="alert">
          {problems.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : (
        <p className="note" role="status">
          지금 설정으로 {parsed.matches.length}경기를 읽었어요
          {parsed.errors.length > 0 ? ` · 틀린 줄 ${parsed.errors.length}개(다음 단계에서 보여요)` : ""}.
        </p>
      )}
      <ErrorNote error={props.error} />
      <div className="button-row">
        <button type="button" className="secondary" onClick={props.onBack}>
          ← 다시 읽기
        </button>
        <button
          type="button"
          className="primary"
          disabled={props.busy || problems.length > 0 || parsed.matches.length === 0}
          onClick={props.onNext}
        >
          다음: 확인
        </button>
      </div>
    </section>
  );
}

/** 가로로 긴 표의 미리보기: 1,000열이 넘는 표를 그대로 그리지 않고 읽은 경기 몇 개를 보여 준다. */
function AcrossPreview(props: { matches: SheetMatch[] }) {
  const lane = (p: SheetMatch["teamA"][number]) => (p.position ? `${POSITION_SHORT[p.position]} ` : "");
  if (props.matches.length === 0) return <p className="hint">읽은 경기가 없어요.</p>;
  return (
    <>
      <p className="hint">읽은 경기 중 앞쪽 {props.matches.length}경기예요.</p>
      <ul className="list">
        {props.matches.map((m) => (
          <li key={m.line} className="list-row static across-row">
            <span>
              <strong>
                {m.date} · {m.where}
              </strong>
              <br />
              팀 A{m.winner === "A" ? "(승)" : ""}: {m.teamA.map((p) => lane(p) + p.name).join(", ")}
              <br />
              팀 B{m.winner === "B" ? "(승)" : ""}: {m.teamB.map((p) => lane(p) + p.name).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

const POSITION_SHORT: Record<string, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

export function NameLinks(props: {
  links: NameLink[];
  names: string[];
  choices: Record<string, string>;
  onChoose: (name: string, value: string) => void;
}) {
  const exact = props.links.filter((l) => l.kind === "exact");
  const merged = props.links.filter((l) => l.kind === "merged");
  const similar = props.links.filter((l) => l.kind === "similar");
  const fresh = props.links.filter((l) => l.kind === "new");
  const within = similarWithinTable(props.names);
  if (props.links.length === 0) return null;
  return (
    <div className="sheet-names">
      <h3>참가자 연결</h3>
      <p className="hint">
        {exact.length + merged.length > 0 ? `이름이 같은 기존 참가자 ${exact.length + merged.length}명은 자동으로 이어요. ` : ""}
        새로 만들 참가자 {fresh.length}명.
      </p>
      {merged.length > 0 && (
        <details>
          <summary>합쳐진 참가자 {merged.length}명은 남은 사람으로 이어요</summary>
          <ul>
            {merged.map((l) => (
              <li key={l.name}>
                {l.name} → 합친 뒤 남은 참가자
              </li>
            ))}
          </ul>
        </details>
      )}
      {similar.length > 0 && (
        <div className="note warn">
          <p>
            <strong>비슷한 이름 {similar.length}개</strong> — 띄어쓰기·대소문자·전각 문자만 다른 기존 참가자가 있어요. 같은
            사람인지 골라 주세요.
          </p>
          <ul className="sheet-links">
            {similar.map((l) => (
              <li key={l.name}>
                <label>
                  <span>표의 '{l.name}'</span>
                  <select value={props.choices[l.name] ?? ""} onChange={(e) => props.onChoose(l.name, e.target.value)}>
                    <option value="">골라 주세요</option>
                    {l.candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        기존 '{c.name}'와 같은 사람
                      </option>
                    ))}
                    <option value="new">다른 사람(새로 만들기)</option>
                  </select>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {fresh.length > 0 && (
        <details>
          <summary>새로 만들 참가자 {fresh.length}명</summary>
          <p>{fresh.map((l) => l.name + (l.archivedSameName ? "(같은 이름의 보관된 참가자 있음)" : "")).join(", ")}</p>
        </details>
      )}
      {within.length > 0 && (
        <p className="hint">
          표 안에 같은 사람일 수 있는 이름이 있어요: {within.map((g) => g.join(" / ")).join(", ")}. 다른 사람이 맞으면
          그대로 두고, 같은 사람이면 시트에서 이름을 맞추거나 가져온 뒤 참가자 합치기를 쓰세요.
        </p>
      )}
    </div>
  );
}
