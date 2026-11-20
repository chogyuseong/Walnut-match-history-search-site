// 시트 가져오기 3단계 "확인" 화면: 읽은 경기를 이미 들어간 것·새것·바뀐 것·틀린 줄로 나눠 보여 주고,
// 이름 잇기와 진영 넣는 방식을 고르게 한다. 상태와 저장 계획은 부르는 쪽(screens/SheetImport.tsx)이 갖는다.
// 진영·"한 번 더 한 경기" 선택을 바꾸면 본체가 저장 계획을 버려야 하므로, 그 둘은 꼭 onSide·onAsNew로 올려 보낸다.
import type { NameLink } from "../../../shared/importLink";
import { crowdedDays, type ImportClassification, type SheetSideMode } from "../../../shared/sheetImportPlan";
import type { parseSheet, SheetMatch } from "../../../shared/sheetTable";
import { ImportAgainPicker } from "../../importAgain";
import { ImportDateWarnings } from "../../importDateWarnings";
import { NameLinks } from "../../importSave";

/** 틀린 줄·바뀐 줄 목록에 한 번에 보여 주는 줄 수. 나머지는 개수만 적는다. */
const LIST_LIMIT = 20;

export function ConfirmStep(props: {
  parsed: ReturnType<typeof parseSheet>;
  classification: ImportClassification;
  /** "이미 들어간 경기" 중 한 번 더 한 경기로 골라 새 지문을 붙인 경기. */
  promoted: SheetMatch[];
  /** 이번에 실제로 보낼 경기(새것 + 고른 것 + 고르면 바뀐 줄), 줄 번호 순. */
  toSend: SheetMatch[];
  links: NameLink[];
  choices: Record<string, string>;
  asNew: ReadonlySet<number>;
  skipErrors: boolean;
  includeChanged: boolean;
  sideMode: SheetSideMode | null;
  /** 열 맞추기에서 진영 열을 골랐을 때만 "표의 진영 열대로"를 보여 준다. */
  hasSideColumn: boolean;
  busy: boolean;
  done: boolean;
  /** 이미 저장된 경기 수. 하나라도 저장됐으면 진영을 바꾸지 못하게 잠근다. */
  saved: number;
  onChoose: (name: string, value: string) => void;
  onAsNew: (next: ReadonlySet<number>) => void;
  onSkipErrors: (value: boolean) => void;
  onIncludeChanged: (value: boolean) => void;
  onSide: (mode: SheetSideMode) => void;
  onFix: () => void;
  onBack: () => void;
  onRun: () => void;
}) {
  const { parsed, classification, promoted, toSend, links, sideMode } = props;
  // 날짜가 몰린 날 경고는 이번에 실제로 넣을 경기가 그 날짜에 있을 때만 띄운다. 이미 다 들어간 시트를 다시 열 때마다 뜨면 소음이다.
  const sendDates = new Set(toSend.map((m) => m.date));
  const crowded = crowdedDays(parsed.matches).filter((d) => sendDates.has(d.date));
  const undecided = links.filter((l) => l.kind === "similar" && !props.choices[l.name]);
  const errorCount = parsed.errors.length;
  const ready = toSend.length > 0 && sideMode !== null && undecided.length === 0 && (errorCount === 0 || props.skipErrors);

  return (
    <section className="card" aria-label="확인">
      <h2>가져올 내용 확인</h2>
      <ImportDateWarnings matches={parsed.matches} crowded={crowded} />
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
              picked={props.asNew}
              disabled={props.busy || props.done}
              onChange={props.onAsNew}
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
            <input type="checkbox" checked={props.skipErrors} onChange={(e) => props.onSkipErrors(e.target.checked)} />
            <span>틀린 줄 {errorCount}개는 빼고 넣기</span>
          </label>
          <button type="button" className="secondary" onClick={props.onFix}>
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
            <input
              type="checkbox"
              checked={props.includeChanged}
              onChange={(e) => props.onIncludeChanged(e.target.checked)}
            />
            <span>바뀐 줄도 새 경기로 넣기(전에 넣은 경기는 그대로 남아요)</span>
          </label>
        </details>
      )}

      <NameLinks links={links} choices={props.choices} onChoose={props.onChoose} names={parsed.names} />

      {toSend.length === 0 ? (
        <p className="note" role="status">
          새로 넣을 경기가 없어요. 이 시트의 경기는 이미 모두 들어가 있어요.
        </p>
      ) : (
        <fieldset disabled={props.busy || props.saved > 0}>
          <legend>진영을 어떻게 넣을까요?</legend>
          <label className={sideMode === "unknown" ? "choice chosen" : "choice"}>
            <input type="radio" name="sheet-side" checked={sideMode === "unknown"} onChange={() => props.onSide("unknown")} />
            <span>
              <strong>진영 미상으로 넣기</strong>
              <br />
              <span className="hint">개인 승패와 배치 판수에는 들어가고 진영 통계에서만 빠져요.</span>
            </span>
          </label>
          <label className={sideMode === "a-blue" ? "choice chosen" : "choice"}>
            <input type="radio" name="sheet-side" checked={sideMode === "a-blue"} onChange={() => props.onSide("a-blue")} />
            <span>
              <strong>팀 A는 블루, 팀 B는 레드로 넣기</strong>
              <br />
              <span className="hint">표의 팀 A(위 5명·앞 5명)가 항상 블루였을 때 고르세요.</span>
            </span>
          </label>
          {props.hasSideColumn && (
            <label className={sideMode === "column" ? "choice chosen" : "choice"}>
              <input type="radio" name="sheet-side" checked={sideMode === "column"} onChange={() => props.onSide("column")} />
              <span>
                <strong>표의 진영 열대로 넣기</strong>
                <br />
                <span className="hint">
                  진영 열이 실제 진영이 아니라 자리 기준(위 5명=블루)일 수 있어요. 실제 진영이 확실할 때만 고르세요.
                  비어 있는 칸은 진영 미상이 돼요.
                </span>
              </span>
            </label>
          )}
          <p className="hint">어느 쪽이든 나중에 경기마다 진영을 고칠 수 있어요.</p>
        </fieldset>
      )}

      <div className="button-row">
        <button type="button" className="secondary" onClick={props.onBack}>
          ← 열 맞추기
        </button>
        {toSend.length > 0 && (
          <button type="button" className="primary" disabled={!ready} onClick={props.onRun}>
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
  );
}
