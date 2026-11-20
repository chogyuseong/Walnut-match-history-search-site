import { useEffect, useMemo, useRef, useState } from "react";
import { parseDelimited } from "../../shared/csv";
import { linkNames, type NameLink } from "../../shared/importLink";
import {
  classifyImport,
  namesToLink,
  promoteAgain,
  toSheetPayload,
  type ExistingImport,
  type ImportClassification,
  type SheetImportPayload,
  type SheetSideMode,
} from "../../shared/sheetImportPlan";
import { detectMapping, type SheetMapping } from "../../shared/sheetMapping";
import { parseSheet, type SheetMatch } from "../../shared/sheetTable";
import { looksLikeLegacyUrl } from "../../shared/legacy";
import { parseSheetUrl, type SheetTab } from "../../shared/sheetUrl";
import { localDate } from "../../shared/stats";
import { ApiFailure, call } from "../api";
import { takePastedText } from "../sheetHandoff";
import { ImportProgress, prepareImport, sendImport, splitNameLinks, type ImportPlan } from "../importSave";
import { go, useAppValue } from "../useApp";
import { CreateGroupButton } from "../account";
import { ConfirmStep } from "./sheetImport/ConfirmStep";
import { MappingStep } from "./sheetImport/MappingStep";
import { parseRowList, rememberMapping, storedMapping, type Loaded } from "./sheetImport/mappingMemory";
import { SourceStep, type SourceMode } from "./sheetImport/SourceStep";

type Step = 1 | 2 | 3 | 4;

const STEP_NAMES = ["링크", "열 맞추기", "확인", "가져오기"] as const;

/**
 * 구글 시트에서 가져오기(붙여 넣은 표도 같은 화면). 1 링크 → 2 열 맞추기 → 3 확인 → 4 가져오기.
 * 전체를 읽고 검증한 뒤에만 저장한다. 저장은 기존 일괄 입력 경로(50경기 묶음, 이어서 넣기)로 한다.
 * 단계 화면(sheetImport/ 아래)은 그리기만 하고, 상태·서버 호출·저장 계획은 모두 여기에 둔다.
 */
export function SheetImport() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [step, setStep] = useState<Step>(1);
  const [mode, setMode] = useState<SourceMode>("sheet");
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
  const plan = useRef<ImportPlan<SheetImportPayload> | null>(null);

  // 표 일괄 입력에서 넘어온 붙여 넣기.
  useEffect(() => {
    const pasted = takePastedText();
    if (pasted !== null) {
      setMode("paste");
      setText(pasted);
      openTable({ rows: parseDelimited(pasted), kind: "paste", sourceKey: null, title: null });
    }
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
  const promoted: SheetMatch[] = useMemo(
    () => (classification && existing ? promoteAgain(classification, existing, asNew) : []),
    [classification, existing, asNew],
  );
  const links: NameLink[] = useMemo(
    () =>
      parsed && snapshot && classification
        ? linkNames(namesToLink(parsed.names, classification, promoted), snapshot.participants)
        : [],
    [parsed, snapshot, classification, promoted],
  );

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

  function pickTab(name: string) {
    setTabName(name);
    void readSheet(name);
  }

  function readPasted() {
    setError(null);
    openTable({ rows: parseDelimited(text), kind: "paste", sourceKey: null, title: null });
  }

  // 저장 계획에는 진영이 박혀 있어, 첫 시도가 실패한 뒤 진영을 바꾸면 계획을 버려야 새 값으로 저장된다.
  // 한 묶음이라도 저장되면 고르는 칸을 잠근다. 응답만 잃은 묶음은 서버가 같은 지문을 거절해 두 번 들어가지 않는다.
  function chooseSide(mode: SheetSideMode) {
    setSideMode(mode);
    plan.current = null;
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

  async function run() {
    if (!classification || sideMode === null) return;
    setStep(4);
    setBusy(true);
    setError(null);
    try {
      plan.current ??= await prepareImport(gid, splitNameLinks(links, choices), (idOf) =>
        toSheetPayload(toSend, idOf, sideMode, timeZone),
      );
      const source =
        loaded?.kind === "sheet"
          ? { kind: "sheet", sourceKey: loaded.sourceKey, ...(loaded.title ? { label: loaded.title } : {}) }
          : { kind: "paste" };
      await sendImport(gid, plan.current, source, setSaved);
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
        <SourceStep
          mode={mode}
          url={url}
          urlCheck={urlCheck}
          isLegacyUrl={isLegacyUrl}
          tabName={tabName}
          tabChoices={tabChoices}
          text={text}
          busy={busy}
          error={error}
          onMode={setMode}
          onUrl={(value) => {
            setUrl(value);
            setError(null);
          }}
          onTabName={(value) => {
            setTabName(value);
            setTabChoices(null);
            setError(null);
          }}
          onPickTab={pickTab}
          onText={setText}
          onReadSheet={() => void readSheet()}
          onReadPasted={readPasted}
        />
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
          onPickTab={pickTab}
          onBack={() => setStep(1)}
          onNext={() => void goConfirm()}
          busy={busy}
          error={error}
        />
      )}

      {step === 3 && parsed && classification && (
        <ConfirmStep
          parsed={parsed}
          classification={classification}
          promoted={promoted}
          toSend={toSend}
          links={links}
          choices={choices}
          asNew={asNew}
          skipErrors={skipErrors}
          includeChanged={includeChanged}
          sideMode={sideMode}
          hasSideColumn={mapping?.columns.side !== undefined}
          busy={busy}
          done={done}
          saved={saved}
          onChoose={(name, value) => setChoices({ ...choices, [name]: value })}
          onAsNew={(next) => {
            setAsNew(next);
            plan.current = null;
          }}
          onSkipErrors={setSkipErrors}
          onIncludeChanged={setIncludeChanged}
          onSide={chooseSide}
          onFix={() => setStep(1)}
          onBack={() => setStep(2)}
          onRun={() => void run()}
        />
      )}

      {step === 4 && (
        <ImportProgress
          busy={busy}
          done={done}
          saved={saved}
          total={plan.current?.total ?? toSend.length}
          error={error}
          onRun={() => void run()}
          sideText={sideMode === "unknown" ? "진영 미상" : sideMode === "a-blue" ? "팀 A → 블루팀, 팀 B → 레드팀" : "표의 진영 열"}
          undoHint="잘못 넣었다면 모임 탭의 표 일괄 입력 기록에서 이번에 넣은 경기를 한 번에 전적 제외할 수 있어요."
        />
      )}
    </div>
  );
}
