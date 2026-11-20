// 시트 가져오기 2단계 "열 맞추기" 화면: 표 모양·머리글 줄·건너뛸 줄·열마다 역할을 고르고 미리보기로 확인한다.
// 상태는 부르는 쪽(screens/SheetImport.tsx)이 갖고, 이 화면은 바꾼 값을 onChange로 올려 보내기만 한다.
import { columnCount } from "../../../shared/csv";
import { columnName } from "../../../shared/sheetAcross";
import {
  detectMapping,
  LAYOUT_LABELS,
  LAYOUTS,
  mappingProblems,
  roleLabel,
  rolesOf,
  type Layout,
  type SheetMapping,
} from "../../../shared/sheetMapping";
import type { parseSheet, SheetMatch } from "../../../shared/sheetTable";
import { localDate } from "../../../shared/stats";
import { ErrorNote } from "../../ui";
import type { Loaded } from "./mappingMemory";

const PREVIEW_ROWS = 20;
/** 열이 이보다 많으면 열 고르기를 접고 미리보기 표도 앞쪽 열만 보여 준다. */
const MANY_COLUMNS = 40;
const PREVIEW_COLUMNS = 30;
const ACROSS_SAMPLE = 5;

export function MappingStep(props: {
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
          <p className="hint">팀 열이 없으면 두 줄 중 위 줄을 팀 A로 봐요.</p>
        )}
        {mapping.layout === "player" && (
          <p className="hint">경기 번호 열이 없으면 10줄씩 한 경기로 묶고, 팀 열이 없으면 앞 5명을 팀 A로 봐요.</p>
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
                  열 {columnName(col)}
                  {header[col]?.trim() ? ` · ${header[col]!.trim()}` : ""}
                </span>
                <span className="hint sheet-col-sample">{samples.length > 0 ? `예: ${samples.join(", ")}` : "예: (빈 칸)"}</span>
                <select value={roleOfColumn.get(col) ?? ""} onChange={(e) => setRole(col, e.target.value)}>
                  <option value="">안 씀</option>
                  {roles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(mapping.layout, role)}
                      {mapping.columns[role] !== undefined && mapping.columns[role] !== col
                        ? ` (지금 열 ${columnName(mapping.columns[role]!)})`
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
                  {columnName(col)}
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
