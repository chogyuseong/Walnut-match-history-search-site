import { useEffect, useMemo, useRef, useState } from "react";
import { linkNames, type NameLink } from "../../shared/importLink";
import {
  convertLegacy,
  LEGACY_URL_MESSAGES,
  legacySkippedText,
  parseLegacyUrl,
  type LegacyChoice,
  type LegacyConverted,
  type LegacyFutureMode,
  type LegacyMatch,
  type LegacySummary,
} from "../../shared/legacy";
import { nameKey } from "../../shared/names";
import {
  classifyImport,
  toSheetPayload,
  type ExistingImport,
  type ImportClassification,
  type SheetImportPayload,
} from "../../shared/sheetTable";
import { looksLikeSheetUrl } from "../../shared/sheetUrl";
import { CreateGroupButton } from "../account";
import { call, mutate, newRequestId } from "../api";
import { takeLegacyUrl } from "../sheetHandoff";
import { ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { NameLinks } from "./SheetImport";

const CHUNK = 50;
const NAME_CHUNK = 30;
const LIST_LIMIT = 20;
const TIMELINE_LIMIT = 40;

type Step = 1 | 2 | 3;
const STEP_NAMES = ["주소", "확인", "가져오기"] as const;

interface Read {
  sourceKey: string;
  matches: LegacyMatch[];
  summary: LegacySummary;
  remembered: LegacyChoice | null;
  /** 읽은 시각. 아직 오지 않은 경기의 기준이다(화면을 다시 그려도 바뀌지 않게). */
  readAt: number;
}

interface Plan {
  batchId: string;
  chunks: { requestId: string; matches: SheetImportPayload[] }[];
  total: number;
}

type SideMode = "unknown" | "column";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * 기존 사이트(v1, 천안호두.GG) 기록 가져오기. 1 주소 → 2 확인 → 3 가져오기.
 * 서버가 Apps Script 웹 앱에서 공용 기록을 읽어(읽기만) 형식을 검증해 돌려주면, 여기서 날짜·진영·이름을 확인하고
 * 시트 가져오기와 같은 일괄 입력 경로(50경기 묶음, 이어서 넣기, 지문으로 다시 가져오기)로 저장한다.
 */
export function LegacyImport() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [step, setStep] = useState<Step>(1);
  const [url, setUrl] = useState("");
  const [read, setRead] = useState<Read | null>(null);
  const [existing, setExisting] = useState<ExistingImport[] | null>(null);
  const [futureMode, setFutureMode] = useState<LegacyFutureMode>("shift");
  const [from, setFrom] = useState<string>("");
  const [sideMode, setSideMode] = useState<SideMode | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [skipErrors, setSkipErrors] = useState(false);
  const [includeChanged, setIncludeChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(0);
  const [done, setDone] = useState(false);
  const plan = useRef<Plan | null>(null);

  // 시트 가져오기 화면의 주소 칸에서 넘어온 주소.
  useEffect(() => {
    const handed = takeLegacyUrl();
    if (handed !== null) setUrl(handed);
  }, []);

  const timeZone = snapshot?.group.timezone ?? "Asia/Seoul";

  // 기준 날짜 없이(아직 오지 않은 경기만) 한 번 바꿔 아직 오지 않은 경기의 범위를 안다.
  const base = useMemo(
    () => (read ? convertLegacy(read.matches, { timeZone, now: read.readAt, futureMode: "drop", from: null }) : null),
    [read, timeZone],
  );
  const fromDate = from !== "" ? from : null;
  const conv = useMemo(
    () => (read ? convertLegacy(read.matches, { timeZone, now: read.readAt, futureMode, from: fromDate }) : null),
    [read, timeZone, futureMode, fromDate],
  );
  const classification: ImportClassification<LegacyConverted> | null = useMemo(
    () => (conv && existing && read ? classifyImport(conv.matches, existing, read.sourceKey) : null),
    [conv, existing, read],
  );
  const links: NameLink[] = useMemo(() => {
    if (!conv || !snapshot || !classification) return [];
    const used = new Set<string>();
    for (const m of [...classification.fresh, ...classification.changed.map((c) => c.match)]) {
      for (const p of [...m.teamA, ...m.teamB]) used.add(nameKey(p.name));
    }
    return linkNames(
      conv.names.filter((n) => used.has(nameKey(n))),
      snapshot.participants,
    );
  }, [conv, snapshot, classification]);

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>기존 사이트 기록 가져오기</h1>
        <p>모임이 있어야 기록을 넣을 수 있어요. 경기를 하지 않아도 모임을 먼저 만들 수 있어요.</p>
        <div className="button-row">
          <CreateGroupButton primary label="모임 만들고 시작" to="/legacy-import" />
          <button type="button" className="secondary" onClick={() => go("/")}>
            오늘로 가기
          </button>
        </div>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const urlCheck = url.trim() === "" ? null : parseLegacyUrl(url);
  const isSheetUrl = url.trim() !== "" && looksLikeSheetUrl(url);

  async function readLegacy() {
    if (!urlCheck?.ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await call<Omit<Read, "readAt">>("POST", `/api/groups/${gid}/legacy/read`, { url: url.trim() });
      const fingerprints = await call<{ imports: ExistingImport[] }>("GET", `/api/groups/${gid}/imports/fingerprints`);
      setRead({ ...res, readAt: Date.now() });
      setExisting(fingerprints.imports);
      // 같은 주소로 전에 가져올 때 고른 날짜 처리를 기본으로 쓴다(다시 고를 수 있다).
      setFutureMode(res.remembered?.futureMode ?? "shift");
      setFrom(res.remembered?.from ?? "");
      setSideMode(null);
      setChoices({});
      setSkipErrors(false);
      setIncludeChanged(false);
      plan.current = null;
      setSaved(0);
      setDone(false);
      setStep(2);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // 기준 날짜 기본값: 아직 오지 않은 경기의 첫 날짜(= 아직 오지 않은 경기만).
  const firstFuture = base?.future.first ?? null;
  const effectiveFrom = fromDate ?? firstFuture;
  const showDates = !!conv && (conv.affected.count > 0 || (base?.future.count ?? 0) > 0 || read?.remembered?.from != null);

  const toSend = classification
    ? [...classification.fresh, ...(includeChanged ? classification.changed.map((c) => c.match) : [])].sort(
        (x, y) => x.line - y.line,
      )
    : [];
  const undecided = links.filter((l) => l.kind === "similar" && !choices[l.name]);
  const errorCount = conv?.errors.length ?? 0;
  const ready =
    toSend.length > 0 && sideMode !== null && undecided.length === 0 && (errorCount === 0 || skipErrors);

  async function run() {
    if (!classification || sideMode === null || !read || !conv) return;
    setStep(3);
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
      // 고른 날짜 처리를 묶음에 남긴다. 기준은 실제로 쓴 날짜(기본이면 아직 오지 않은 첫 날짜)로 고정해,
      // 시간이 지나 그 경기들이 "지난 날짜"가 돼도 다시 가져올 때 같은 경기를 옮긴다.
      const options = conv.affected.count > 0 ? { futureMode, from: effectiveFrom } : null;
      const source = { kind: "legacy", sourceKey: read.sourceKey, label: "기존 사이트", ...(options ? { options } : {}) };
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

  // 옮긴 뒤 순서 확인: 옮긴 날짜 범위 앞뒤 2주의 날마다 경기 수(옮긴 경기·원래 경기).
  const timeline = (() => {
    if (!conv || futureMode !== "shift" || conv.shiftedRange.first === null) return [];
    const lo = addDays(conv.shiftedRange.first, -14);
    const hi = addDays(conv.shiftedRange.last!, 14);
    const days = new Map<string, { moved: number; kept: number }>();
    for (const m of conv.matches) {
      if (m.date < lo || m.date > hi) continue;
      const d = days.get(m.date) ?? { moved: 0, kept: 0 };
      if (m.shifted) d.moved += 1;
      else d.kept += 1;
      days.set(m.date, d);
    }
    return [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  })();

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/group")}>
          ← 모임
        </button>
        <h1>기존 사이트 기록 가져오기</h1>
      </header>

      <ol className="sheet-steps" aria-label="단계">
        {STEP_NAMES.map((name, i) => (
          <li key={name} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "current" : ""}>
            <span className="sheet-step-no">{i + 1}</span> {name}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <section className="card" aria-label="주소">
          <label>
            기존 사이트 연결 주소
            <input
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://script.google.com/macros/s/…/exec"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="hint">
            기존 사이트의 '공용 저장 연결'에 넣어 쓰던 주소예요. script.google.com/macros/s/…/exec 모양이고, 구글 시트
            주소(docs.google.com)와는 달라요. 모임 암호는 필요 없고, 기존 사이트의 기록은 읽기만 하고 바꾸지 않아요.
          </p>
          {isSheetUrl ? (
            <div className="note warn" role="alert">
              <p>구글 시트 주소예요. 시트의 표를 가져오려면 시트에서 가져오기를 쓰세요.</p>
              <button type="button" className="secondary" onClick={() => go("/sheet-import")}>
                구글 시트에서 가져오기로
              </button>
            </div>
          ) : (
            urlCheck &&
            !urlCheck.ok && (
              <p className="note warn" role="alert">
                {LEGACY_URL_MESSAGES[urlCheck.problem]}
              </p>
            )
          )}
          <button type="button" className="primary wide" disabled={busy || !urlCheck?.ok} onClick={() => void readLegacy()}>
            {busy ? "기존 기록 읽는 중…" : "기존 기록 읽기"}
          </button>
          <p className="hint">읽은 내용은 서버에 저장하지 않아요. 확인을 마치고 가져올 때 경기만 저장합니다.</p>
          <ErrorNote error={error} />
        </section>
      )}

      {step === 2 && read && conv && classification && (
        <section className="card" aria-label="확인">
          <h2>가져올 내용 확인</h2>
          <ul className="list">
            <li className="list-row static">
              <span>기존 사이트의 경기</span>
              <span>{read.summary.matches}경기</span>
            </li>
            <li className="list-row static">
              <span>참가자</span>
              <span>{conv.names.length}명</span>
            </li>
            <li className="list-row static">
              <span>이미 들어간 경기(건너뜀)</span>
              <span>{classification.already.length}경기</span>
            </li>
            <li className="list-row static">
              <span>새로 넣을 경기</span>
              <span>
                <strong>{toSend.length}경기</strong>
              </span>
            </li>
            {conv.dropped > 0 && (
              <li className="list-row static">
                <span>빼고 넣는 경기</span>
                <span>{conv.dropped}경기</span>
              </li>
            )}
            {classification.changed.length > 0 && (
              <li className="list-row static">
                <span>바뀐 경기</span>
                <span>{classification.changed.length}개</span>
              </li>
            )}
            {errorCount > 0 && (
              <li className="list-row static">
                <span>틀린 경기</span>
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
          <p className="hint">{legacySkippedText(read.summary)}</p>

          {showDates && (
            <fieldset>
              <legend>
                {(base?.future.count ?? 0) > 0
                  ? `오늘 이후 날짜의 경기가 ${base!.future.count}경기 있어요(${base!.future.first} ~ ${base!.future.last})`
                  : "날짜를 옮기거나 뺄 경기"}
              </legend>
              <p className="hint">
                아직 오지 않은 날짜는 넣을 수 없어요. 연도가 없는 날짜가 한 해 늦게 들어간 경기일 수 있어요.
              </p>
              <label className={futureMode === "shift" ? "choice chosen" : "choice"}>
                <input type="radio" name="legacy-future" checked={futureMode === "shift"} onChange={() => setFutureMode("shift")} />
                <span>
                  <strong>한 해 앞으로 옮겨 넣기(권장)</strong>
                  <br />
                  <span className="hint">
                    1년을 빼서 넣어요.
                    {futureMode === "shift" && conv.affected.count > 0
                      ? ` ${conv.affected.count}경기 · ${conv.affected.first} ~ ${conv.affected.last} → ${conv.shiftedRange.first ?? "-"} ~ ${conv.shiftedRange.last ?? "-"}`
                      : ""}
                  </span>
                </span>
              </label>
              <label className={futureMode === "drop" ? "choice chosen" : "choice"}>
                <input type="radio" name="legacy-future" checked={futureMode === "drop"} onChange={() => setFutureMode("drop")} />
                <span>
                  <strong>빼고 넣기</strong>
                  <br />
                  <span className="hint">
                    이 경기들은 넣지 않아요.{futureMode === "drop" && conv.dropped > 0 ? ` ${conv.dropped}경기를 빼요.` : ""}
                  </span>
                </span>
              </label>
              <label>
                이 날짜부터의 경기를 {futureMode === "shift" ? "한 해 앞으로 옮기기" : "빼기"}
                <input
                  type="date"
                  value={effectiveFrom ?? ""}
                  max={firstFuture ?? undefined}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <p className="hint">
                기본은 오늘 이후 날짜의 경기만이에요({firstFuture ?? "-"}부터). 그보다 이른 날짜의 경기도 같은 오류라면
                날짜를 앞당겨 주세요. 지금 기준: {conv.affected.count}경기({conv.affected.first ?? "-"} ~{" "}
                {conv.affected.last ?? "-"}).
              </p>
              {from !== "" && firstFuture !== null && from !== firstFuture && (
                <button type="button" className="secondary" onClick={() => setFrom(firstFuture)}>
                  오늘 이후 경기만으로 되돌리기
                </button>
              )}
              {timeline.length > 0 && (
                <details>
                  <summary>옮긴 뒤 날짜 순서 확인({timeline.length}일)</summary>
                  <p className="hint">옮긴 경기와 원래 그 무렵의 경기가 날짜순으로 어떻게 이어지는지 보여요.</p>
                  <div className="sheet-scroll" tabIndex={0} role="region" aria-label="옮긴 뒤 날짜 순서">
                    <table className="sheet-table">
                      <thead>
                        <tr>
                          <th scope="col">날짜</th>
                          <th scope="col">옮긴 경기</th>
                          <th scope="col">원래 경기</th>
                        </tr>
                      </thead>
                      <tbody>
                        {timeline.slice(0, TIMELINE_LIMIT).map(([date, d]) => (
                          <tr key={date}>
                            <th scope="row">{date}</th>
                            <td>{d.moved > 0 ? `${d.moved}경기` : ""}</td>
                            <td>{d.kept > 0 ? `${d.kept}경기` : ""}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {timeline.length > TIMELINE_LIMIT && <p className="hint">처음 {TIMELINE_LIMIT}일만 보여요.</p>}
                </details>
              )}
            </fieldset>
          )}

          {classification.wasExcluded > 0 && (
            <p className="hint">
              전에 넣었다가 전적 제외한 경기와 같은 내용 {classification.wasExcluded}경기는 새로 넣어요. 제외한 묶음을
              다시 복구하면 같은 경기가 두 번 들어가니 둘 중 하나만 쓰세요.
            </p>
          )}
          {classification.missing > 0 && (
            <p className="hint">
              전에 이 주소에서 가져왔는데 지금 기존 사이트에 없는 경기가 {classification.missing}개 있어요. 이미 들어간
              기록은 그대로 두니 필요하면 기록 화면에서 전적 제외하세요.
            </p>
          )}

          {errorCount > 0 && (
            <div className="note warn" role="alert">
              <p>
                <strong>틀린 경기가 {errorCount}개 있어요.</strong> 기존 사이트에서 고친 뒤 다시 읽거나, 틀린 경기만 빼고
                넣을 수 있어요.
              </p>
              <ul>
                {conv.errors.slice(0, LIST_LIMIT).map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    {e.where ?? `${e.line}번째 경기`}: {e.message}
                  </li>
                ))}
              </ul>
              {errorCount > LIST_LIMIT && <p>그 밖에 {errorCount - LIST_LIMIT}개가 더 있어요.</p>}
              <label className="check-line">
                <input type="checkbox" checked={skipErrors} onChange={(e) => setSkipErrors(e.target.checked)} />
                <span>틀린 경기 {errorCount}개는 빼고 넣기</span>
              </label>
            </div>
          )}

          {classification.changed.length > 0 && (
            <details>
              <summary>바뀐 경기 {classification.changed.length}개</summary>
              <p className="hint">
                전에 가져온 같은 경기(기존 사이트의 같은 경기 번호)와 내용이 달라요. 기존 사이트에서 고친 경기면 기록
                화면에서 그 경기를 직접 고치세요.
              </p>
              <ul>
                {classification.changed.slice(0, LIST_LIMIT).map((c) => (
                  <li key={c.match.rowKey}>
                    {c.match.where ?? `${c.match.line}번째 경기`} ({c.match.date}) — 전에 넣은 {c.previous.matchNo}번 경기와
                    달라요
                  </li>
                ))}
              </ul>
              <label className="check-line">
                <input type="checkbox" checked={includeChanged} onChange={(e) => setIncludeChanged(e.target.checked)} />
                <span>바뀐 경기도 새 경기로 넣기(전에 넣은 경기는 그대로 남아요)</span>
              </label>
            </details>
          )}

          <NameLinks
            links={links}
            choices={choices}
            onChoose={(name, value) => setChoices({ ...choices, [name]: value })}
            names={conv.names}
          />

          {toSend.length === 0 ? (
            <p className="note" role="status">
              새로 넣을 경기가 없어요. 기존 사이트의 경기는 이미 모두 들어가 있어요.
            </p>
          ) : (
            <fieldset>
              <legend>진영을 어떻게 넣을까요?</legend>
              <label className={sideMode === "unknown" ? "choice chosen" : "choice"}>
                <input type="radio" name="legacy-side" checked={sideMode === "unknown"} onChange={() => setSideMode("unknown")} />
                <span>
                  <strong>진영 미상으로 넣기</strong>
                  <br />
                  <span className="hint">
                    블루는 팀 A, 레드는 팀 B로 넣고 진영은 비워요. 개인 승패와 배치 판수에는 들어가고 진영 통계에서만
                    빠집니다.
                  </span>
                </span>
              </label>
              <label className={sideMode === "column" ? "choice chosen" : "choice"}>
                <input type="radio" name="legacy-side" checked={sideMode === "column"} onChange={() => setSideMode("column")} />
                <span>
                  <strong>기존 사이트의 블루·레드를 그대로 넣기</strong>
                  <br />
                  <span className="hint">
                    기존 사이트의 블루·레드는 실제 진영이 아니라 표의 자리(위 5명 = 블루)일 수 있어요. 실제 진영이
                    확실할 때만 고르세요.
                  </span>
                </span>
              </label>
              <p className="hint">어느 쪽이든 나중에 경기마다 진영을 고칠 수 있습니다.</p>
            </fieldset>
          )}

          <div className="button-row">
            <button type="button" className="secondary" onClick={() => setStep(1)}>
              ← 다시 읽기
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
                  : "틀린 경기를 빼고 넣을지 골라 주세요."}
            </p>
          )}
        </section>
      )}

      {step === 3 && (
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
                  {saved}경기 저장됨 · {sideMode === "unknown" ? "진영 미상" : "기존 사이트의 블루·레드"}
                </strong>
              </p>
              <p className="hint">
                잘못 넣었다면 모임 탭의 표 일괄 입력 기록(기존 사이트)에서 이번에 넣은 경기를 한 번에 전적 제외할 수
                있습니다.
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
