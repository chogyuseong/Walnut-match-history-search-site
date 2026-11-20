/**
 * 가로로 긴 표(기존 사이트 v1의 "RAW DATA기입" 탭)를 판별하고 경기 초안으로 읽는다.
 * 표 읽기(sheetTable.ts parseSheet)와 열 자동 추정(sheetMapping.ts detectMapping)이 부른다.
 * 초안 모양(Draft)은 sheetTable.ts에 있어 그쪽 규칙(연도 추정·지문)을 다른 표 모양과 똑같이 탄다.
 */
import { cleanName, MAX_NAME_LENGTH, nameKey } from "./names";
import { isoDate, parseLane, type DateCell } from "./sheetCells";
import type { SheetMapping } from "./sheetMapping";
import type { Draft, SheetError } from "./sheetTable";
import { POSITIONS, type Position } from "./types";

/*
 * v1 app.js parseSheet를 그대로 옮겼다. v1 화면 안내: "위 5명은 블루, 아래 5명은 레드", "날짜를 포함하고 이름·승패가
 * 있는 두 칸씩", "오른쪽에 이름·승패 두 열을 더 붙이거나, 아래에 다음 날짜와 10명을 이어 붙이면 된다".
 * 실제 탭(2026-11-05 확인): 12행 = 날짜 줄(경기 묶음의 첫 이름 칸에만 "5월 1일"처럼 적힘),
 * 13~22행 = 10명(이름 칸·승/패 칸), A열 = 팀 표시, B열 = Top/Jungle/Mid/AD/Suport. 경기 522개 × 2열.
 *
 * 읽는 규칙(v1과 같다):
 * - 왼쪽부터 열 c를 보며, 오른쪽 열(c+1)에 승/패가 하나라도 있으면 (c, c+1)을 이름·승패 두 열로 읽고 c+1은 건너뛴다.
 * - 위에서 아래로 내려가며 승/패가 있는 줄을 모아 10명이 차면 한 경기. 위 5명이 팀 A, 아래 5명이 팀 B.
 * - 날짜: 날짜 칸은 같은 줄의 오른쪽 칸들이 이어받는다(병합 칸·묶음의 첫 칸에만 적은 날짜). 승패가 없는 줄에서
 *   (이어받은) 날짜를 만나면 그때까지 모은 줄을 끊고 그 날짜를 쓴다. 같은 열의 다음 경기도 그 날짜를 이어 쓴다.
 * - 빈 줄, "." 줄, 이름/승패 머리글 줄은 끊는 줄이다. 그 밖에 읽을 수 없는 줄은 틀린 줄로 알린다.
 * - 5명씩 같은 결과(한쪽 승·한쪽 패)여야 한다. 10명이 안 되면 틀린 경기.
 * v1과 다른 점: 연도 없는 날짜에 v1은 고른 연도 하나를 모두 붙였고, 여기서는 다른 표 모양과 같이 줄 순서대로
 * 12월 → 1월이면 해를 넘긴다(resolveYears). 이름은 v2 규칙(20자, 띄어쓰기 정리)으로 확인한다.
 */

const ACROSS_WIN = /^(승|승리|win|w)$/i;
const ACROSS_LOSS = /^(패|패배|lose|loss|l)$/i;

/** v1 pastedSheetRows의 칸 정리. */
function acrossClean(cell: string): string {
  return cell
    .replace(/&nbsp;|&#(?:160|x[aA]0);|&#(?:32|x20);/g, " ")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
    .replace(/^__([\s\S]*)__$/, "$1")
    .trim()
    .normalize("NFC");
}

function acrossResult(cell: string | undefined): "win" | "loss" | null {
  const v = cell ?? "";
  return ACROSS_WIN.test(v) ? "win" : ACROSS_LOSS.test(v) ? "loss" : null;
}

/** v1 sheetDate: "5월 1일", "3/23", "9월30일", "25년 12월 28일", "2026-11-05". 날짜 모양이 아니면 null. */
export function acrossDate(value: string): DateCell | "invalid" | null {
  const m = /^(?:(\d{2}|\d{4})\s*[년./-]\s*)?(\d{1,2})\s*[월./-]\s*(\d{1,2})\s*일?\s*\.?$/.exec(value.trim());
  if (!m) return null;
  const year = m[1] ? (Number(m[1]) < 100 ? 2000 + Number(m[1]) : Number(m[1])) : null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if ((year !== null && (year < 1900 || year > 2100)) || month < 1 || month > 12 || day < 1 || day > 31) return "invalid";
  if (year !== null && isoDate(year, month, day) === null) return "invalid";
  return { year, month, day, time: null };
}

/** 0부터 센 열 번호 → 시트 열 이름(0 → A, 25 → Z, 26 → AA). */
export function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** 승/패가 5칸 이상 있는 열 번호. */
function resultColumns(rows: readonly (readonly string[])[]): number[] {
  const counts = new Map<number, number>();
  for (const row of rows) {
    row.forEach((cell, c) => {
      if (acrossResult(acrossClean(cell))) counts.set(c, (counts.get(c) ?? 0) + 1);
    });
  }
  return [...counts.entries()].filter(([, n]) => n >= 5).map(([c]) => c).sort((a, b) => a - b);
}

/**
 * 가로로 긴 표인지: 승/패 열이 2개 이상이고, 그 열들이 두 열 간격으로 반복된다(80% 이상).
 * 한 줄 = 한 경기·한 경기 = 두 줄·한 줄 = 선수 한 명 모양은 승패 열이 하나라서 걸리지 않는다.
 */
export function isAcrossLayout(rows: readonly (readonly string[])[]): boolean {
  const cols = resultColumns(rows);
  if (cols.length < 2) return false;
  let pairs = 0;
  for (let i = 1; i < cols.length; i++) if (cols[i]! - cols[i - 1]! === 2) pairs += 1;
  if (pairs / (cols.length - 1) < 0.8) return false;
  // 승률 표처럼 승/패 글자가 섞인 다른 표를 거르기 위해 실제로 읽어 본다:
  // 10명씩(5승·5패) 묶인 경기가 2개 이상이고, 읽은 경기가 틀린 묶음보다 많아야 한다.
  const { drafts, errors } = parseAcross(rows, { ...acrossMapping(rows), lanesByOrder: false });
  return drafts.length >= 2 && drafts.length > errors.length;
}

export function acrossMapping(rows: readonly (readonly string[])[]): SheetMapping {
  // v1과 같이 표에 Top·Jungle·Support 같은 라인 이름이 있으면 줄 순서를 라인으로 본다.
  const lanes = new Set<Position>();
  for (const row of rows) {
    for (const cell of row.slice(0, 4)) {
      const lane = parseLane(cell);
      if (lane) lanes.add(lane);
    }
  }
  return {
    layout: "across",
    headerRow: 0,
    skip: [],
    columns: {},
    lanesByOrder: lanes.has("top") && lanes.has("jungle") && lanes.has("support"),
    year: null,
  };
}

/** 가로로 긴 표를 경기 초안으로 읽는다. 초안·틀린 줄의 line은 읽은 순서(1부터)다. */
export function parseAcross(
  rows: readonly (readonly string[])[],
  mapping: SheetMapping,
): { drafts: Draft[]; errors: SheetError[] } {
  const skip = new Set(mapping.skip);
  const grid = rows.map((row, i) => (skip.has(i + 1) ? [] : row.map(acrossClean)));
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const drafts: Draft[] = [];
  const errors: SheetError[] = [];
  let seq = 0;
  const fail = (where: string, message: string) => {
    errors.push({ line: ++seq, where, message });
  };
  // 줄마다 왼쪽 날짜를 오른쪽 칸이 이어받는다.
  const dates: (DateCell | "invalid" | null)[][] = grid.map((row) => {
    let inherited: DateCell | "invalid" | null = null;
    return Array.from({ length: width }, (_, c) => {
      const d = acrossDate(row[c] ?? "");
      if (d !== null) inherited = d;
      return inherited;
    });
  });
  type Cell = { name: string; result: "win" | "loss"; row: number };
  for (let c = 0; c < width - 1; c++) {
    if (!grid.some((row) => acrossResult(row[c + 1]))) continue;
    const cols = `${columnName(c)}~${columnName(c + 1)}열`;
    let date: DateCell | "invalid" | null = null;
    let block: Cell[] = [];
    let start = 0;
    let poison = false;
    let started = false;
    const flush = (): void => {
      if (block.length === 0) return;
      const where = `${cols} ${start + 1}행`;
      const b = block;
      block = [];
      if (poison) {
        poison = false;
        return fail(where, "읽을 수 없는 줄이 섞여 있어 이 경기를 뺐어요.");
      }
      if (b.length !== 10) return fail(where, `${b.length}명이에요. 한 경기에 10명이 있어야 해요.`);
      if (date === null || date === "invalid") {
        return fail(where, "날짜가 없어요. 이 경기 위쪽 날짜 줄에 날짜를 적어 주세요.");
      }
      const names = b.map((x) => cleanName(x.name));
      if (names.some((n) => n === "")) return fail(where, "이름 칸이 비어 있어요. 10명을 모두 적어 주세요.");
      const tooLong = names.find((n) => [...n].length > MAX_NAME_LENGTH);
      if (tooLong) return fail(where, `'${tooLong}'는 ${MAX_NAME_LENGTH}자를 넘어요. 이름을 줄여 주세요.`);
      const keys = names.map(nameKey);
      const dup = names.find((_, i) => keys.indexOf(keys[i]!) !== i);
      if (dup) return fail(where, `'${dup}'가 한 경기에 두 번 있어요. 같은 사람은 한 번만 적어 주세요.`);
      const a = b.slice(0, 5);
      const z = b.slice(5);
      if (
        !a.every((x) => x.result === a[0]!.result) ||
        !z.every((x) => x.result === z[0]!.result) ||
        a[0]!.result === z[0]!.result
      ) {
        return fail(where, "위 5명과 아래 5명이 각각 같은 결과여야 해요(한쪽 5명 승, 다른 쪽 5명 패).");
      }
      const players = (from: number) =>
        names.slice(from, from + 5).map((name, i) => ({ name, position: mapping.lanesByOrder ? POSITIONS[i]! : null }));
      drafts.push({
        line: ++seq,
        where,
        lines: b.map((x) => x.row + 1),
        dateCell: { ...date },
        teamA: players(0),
        teamB: players(5),
        winner: a[0]!.result === "win" ? "A" : "B",
        sideA: null,
      });
    };
    for (let r = 0; r < grid.length; r++) {
      const n = grid[r]![c] ?? "";
      const value = grid[r]![c + 1] ?? "";
      const outcome = acrossResult(value);
      const d = dates[r]![c] ?? dates[r]![c + 1] ?? null;
      if (outcome) {
        started = true;
        if (block.length === 0) start = r;
        block.push({ name: n, result: outcome, row: r });
        if (block.length === 10) flush();
      } else if (d !== null) {
        flush();
        date = d;
        if (d === "invalid") fail(`${cols} ${r + 1}행`, "없는 날짜예요. 날짜를 고쳐 주세요.");
      } else if ((!n && !value) || (block.length === 0 && /^[.\s]*$/.test(n) && /^[.\s]*$/.test(value))) {
        flush();
      } else if (/^(이름|성명|플레이어|소환사|선수)$/i.test(n) && /^(승패|결과|승\/패)$/i.test(value)) {
        flush();
      } else if (started || date !== null) {
        if (block.length > 0) poison = true;
        fail(`${cols} ${r + 1}행`, `'${n} / ${value}'의 승패를 읽지 못했어요. 승 또는 패로 적어 주세요.`);
      }
    }
    flush();
    c++;
  }
  return { drafts, errors };
}
