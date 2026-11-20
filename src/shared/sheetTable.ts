/**
 * 시트에서 가져온 표(또는 붙여 넣은 표)를 사용자가 맞춘 열 설정대로 지난 경기 목록으로 바꾼다.
 *
 * 기존 시트의 실제 열 구성을 모르므로 형식을 고정하지 않는다. 표 모양 세 가지를 받는다.
 * - wide  : 한 줄 = 한 경기. 팀 A 5명·팀 B 5명이 열로 있다.
 * - pair  : 한 경기 = 두 줄(팀당 한 줄). 위 줄이 팀 A다(팀 열이 있으면 그 값을 쓴다).
 * - player: 한 줄 = 선수 한 명. 경기 번호(또는 10줄씩)로 묶는다. 팀 열이 없으면 앞 5명이 팀 A다.
 * - across: 가로로 긴 표(기존 사이트 v1의 "RAW DATA기입" 탭 모양). 경기가 옆으로 늘어서고 한 경기는
 *           이름·승패 두 열, 위 5명이 팀 A, 아래 5명이 팀 B다. 날짜는 위쪽 날짜 줄에서 이어받는다(parseAcross).
 *
 * 어느 열이 무엇인지(역할)는 사용자가 고르고, 처음에는 detectMapping이 머리글과 값의 모양으로 추정한다.
 * 이 파일은 화면·서버 어디에도 기대지 않는 순수 함수만 둔다.
 * 칸 값 읽기는 sheetCells.ts, 열 역할 추정은 sheetMapping.ts, 가로로 긴 표는 sheetAcross.ts,
 * 지문·경기 시각은 sheetFingerprint.ts, 다시 가져오기 비교와 서버로 보낼 모양은 sheetImportPlan.ts에 있다.
 */
import { cleanName, MAX_NAME_LENGTH, nameKey } from "./names";
import { parseAcross } from "./sheetAcross";
import { isoDate, parseDateCell, parseLane, parseResult, parseSide, parseTeamLabel, parseTime, twoDigitYearOf, type DateCell } from "./sheetCells";
import { fingerprinter, futureIndexes, futureMessage } from "./sheetFingerprint";
import { dataRows, headerSideA, LANE_NAMES, mappingProblems, SLOTS, type SheetMapping } from "./sheetMapping";
import { localDate } from "./stats";
import { POSITIONS, type Position, type Team } from "./types";

export interface SheetPlayer {
  name: string;
  position: Position | null;
}

export interface SheetMatch {
  /** 경기가 시작하는 표의 줄 번호(1부터). 가로로 긴 표·기존 사이트 기록은 읽은 순서(1부터). */
  line: number;
  /** 화면에 보일 위치("C~D열 13행"처럼). 없으면 "n번째 줄". */
  where?: string;
  /** 이 경기를 이루는 모든 줄. */
  lines: number[];
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM(모임 시간대). 없으면 null. */
  time: string | null;
  /** 연도를 추정해서 정한 날짜인지. */
  yearGuessed: boolean;
  teamA: SheetPlayer[];
  teamB: SheetPlayer[];
  winner: Team;
  /** 진영 열이 있을 때 팀 A의 진영. */
  sideA: "blue" | "red" | null;
  /** 같은 날 안의 순서(1부터, 표의 순서). */
  orderInDay: number;
  /** 시트 내용 지문. 같은 경기를 다시 가져오면 같은 값이 나온다. */
  fingerprint: string;
  /** 줄 위치 열쇠(날짜#같은 날 순서). 시트에서 고친 줄을 찾는 데 쓴다. */
  rowKey: string;
}

export interface SheetError {
  line: number;
  /** 화면에 보일 위치. 없으면 "n번째 줄". */
  where?: string;
  message: string;
}

export interface YearGuess {
  /** 연도가 없어서 정한 경기 수. */
  count: number;
  from: number;
  to: number;
  /** user: 사용자가 고른 시작 연도, guess: 오늘 날짜와 줄 순서로 추정. */
  basis: "user" | "guess";
}

export interface SheetParse {
  matches: SheetMatch[];
  errors: SheetError[];
  /** 표에 나온 이름(중복 제거, 처음 나온 표기). 틀린 줄의 이름은 넣지 않는다. */
  names: string[];
  yearGuess: YearGuess | null;
  /** 읽은 자료 줄 수(빈 줄·머리글·건너뛴 줄 제외). */
  dataRowCount: number;
}

interface RawGroup {
  lines: number[];
  rows: (readonly string[])[];
}

export interface Draft {
  line: number;
  where?: string;
  lines: number[];
  dateCell: DateCell;
  teamA: SheetPlayer[];
  teamB: SheetPlayer[];
  winner: Team;
  sideA: "blue" | "red" | null;
  /** 날짜 칸의 연도가 두 자리였으면 그 두 자리("99"). */
  twoDigitYear?: string;
}

class RowError extends Error {}

function cellOf(row: readonly string[], col: number | undefined): string {
  return col === undefined ? "" : (row[col] ?? "").trim();
}

/** 병합된 칸(내보내면 첫 줄에만 값이 있음)을 위해 경기 단위 값은 빈 칸이면 위 칸 값을 이어 쓴다. */
function fillDown(
  rows: { line: number; cells: readonly string[] }[],
  cols: (number | undefined)[],
): { line: number; cells: readonly string[] }[] {
  const last = new Map<number, string>();
  return rows.map((r) => {
    const cells = [...r.cells];
    for (const col of cols) {
      if (col === undefined) continue;
      const value = (cells[col] ?? "").trim();
      if (value === "") cells[col] = last.get(col) ?? "";
      else last.set(col, value);
    }
    return { line: r.line, cells };
  });
}

function group(rows: { line: number; cells: readonly string[] }[], mapping: SheetMapping): RawGroup[] {
  const groups: RawGroup[] = [];
  if (mapping.layout === "wide") {
    return rows.map((r) => ({ lines: [r.line], rows: [r.cells] }));
  }
  const size = mapping.layout === "pair" ? 2 : 10;
  const matchCol = mapping.columns.match;
  const dateCol = mapping.columns.date;
  if (matchCol !== undefined) {
    // 같은 경기 번호(와 날짜)가 이어지는 줄을 한 경기로 묶는다. 경기 번호가 날마다 1부터 시작해도 된다.
    let key: string | null = null;
    for (const r of rows) {
      const k = `${cellOf(r.cells, dateCol)}|${cellOf(r.cells, matchCol)}`;
      if (k !== key || groups[groups.length - 1]!.rows.length >= size) {
        groups.push({ lines: [], rows: [] });
        key = k;
      }
      groups[groups.length - 1]!.lines.push(r.line);
      groups[groups.length - 1]!.rows.push(r.cells);
    }
    return groups;
  }
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    groups.push({ lines: slice.map((r) => r.line), rows: slice.map((r) => r.cells) });
  }
  return groups;
}

function readLane(cell: string, fallback: Position | null): Position | null {
  if (cell === "") return fallback;
  const lane = parseLane(cell);
  if (!lane) throw new RowError(`라인 '${cell}'을 읽지 못했어요. 탑·정글·미드·원딜·서폿(TOP/JG/MID/ADC/SUP)으로 써 주세요.`);
  return lane;
}

function onlyValue(values: string[], what: string): string {
  const filled = [...new Set(values.filter((v) => v !== ""))];
  if (filled.length > 1) throw new RowError(`한 경기 안의 ${what} 값이 서로 달라요(${filled.join(", ")}). 하나로 맞춰 주세요.`);
  return filled[0] ?? "";
}

function winnerOf(winnerCells: string[], results: { team: Team; cell: string }[], hasWinner: boolean): Team {
  if (hasWinner) {
    const cell = onlyValue(winnerCells, "이긴 팀");
    if (cell === "") throw new RowError("이긴 팀 칸이 비어 있어요. A 또는 B(블루/레드, 1팀/2팀)로 써 주세요.");
    const team = parseTeamLabel(cell);
    if (!team) throw new RowError(`이긴 팀 '${cell}'을 읽지 못했어요. A 또는 B(블루/레드, 1팀/2팀)로 써 주세요.`);
    return team;
  }
  const wins = new Set<Team>();
  const losses = new Set<Team>();
  for (const r of results) {
    if (r.cell === "") continue;
    const won = parseResult(r.cell);
    if (won === null) throw new RowError(`승패 '${r.cell}'을 읽지 못했어요. 승/패(W/L, O/X)로 써 주세요.`);
    (won ? wins : losses).add(r.team);
  }
  for (const team of ["A", "B"] as const) {
    if (wins.has(team) && losses.has(team)) throw new RowError(`팀 ${team} 안에서 승패가 서로 달라요. 한 팀은 승패가 같아야 해요.`);
  }
  if (wins.size === 2) throw new RowError("두 팀이 모두 이긴 것으로 적혀 있어요. 한 팀만 이기게 고쳐 주세요.");
  if (losses.size === 2) throw new RowError("두 팀이 모두 진 것으로 적혀 있어요. 한 팀만 이기게 고쳐 주세요.");
  const winner = wins.size === 1 ? [...wins][0]! : losses.size === 1 ? ([...losses][0] === "A" ? "B" : "A") : null;
  if (!winner) throw new RowError("승패 칸이 비어 있어요. 이긴 팀을 알 수 있게 승/패를 적어 주세요.");
  return winner;
}

function sideAOf(cells: { team: Team; cell: string }[]): "blue" | "red" | null {
  let sideA: "blue" | "red" | null = null;
  for (const c of cells) {
    if (c.cell === "") continue;
    const side = parseSide(c.cell);
    if (!side) throw new RowError(`진영 '${c.cell}'을 읽지 못했어요. 블루 또는 레드로 써 주세요.`);
    const a = c.team === "A" ? side : side === "blue" ? "red" : "blue";
    if (sideA !== null && sideA !== a) throw new RowError("한 경기 안의 진영 값이 서로 맞지 않아요. 두 팀의 진영을 확인해 주세요.");
    sideA = a;
  }
  return sideA;
}

function buildDraft(g: RawGroup, mapping: SheetMapping): Draft {
  const c = mapping.columns;
  const order = (i: number): Position | null => (mapping.lanesByOrder ? POSITIONS[i]! : null);
  const dateText = onlyValue(g.rows.map((r) => cellOf(r, c.date)), "날짜");
  if (dateText === "") throw new RowError("날짜 칸이 비어 있어요. 2026-11-05처럼 날짜를 적어 주세요.");
  const dateCell = parseDateCell(dateText);
  if (!dateCell) throw new RowError(`날짜 '${dateText}'를 읽지 못했어요. 2026-11-05나 11/5처럼 써 주세요.`);
  if (c.time !== undefined) {
    const timeText = onlyValue(g.rows.map((r) => cellOf(r, c.time)), "시각");
    if (timeText !== "") {
      const time = parseTime(timeText);
      if (!time) throw new RowError(`시각 '${timeText}'를 읽지 못했어요. 20:30이나 오후 8:30처럼 써 주세요.`);
      dateCell.time = time;
    }
  }
  const hasWinner = c.winner !== undefined;
  const winnerCells = g.rows.map((r) => cellOf(r, c.winner));
  let teamA: SheetPlayer[] = [];
  let teamB: SheetPlayer[] = [];
  let winner: Team;
  let sideA: "blue" | "red" | null;

  if (mapping.layout === "wide") {
    const row = g.rows[0]!;
    const players = (prefix: "a" | "b") =>
      SLOTS.map((i) => ({
        name: cellOf(row, c[`${prefix}${i}`]),
        position: readLane(cellOf(row, c[`${prefix}Lane${i}`]), c[`${prefix}Lane${i}`] === undefined ? order(i) : null),
      }));
    teamA = players("a");
    teamB = players("b");
    winner = winnerOf(winnerCells, [{ team: "A", cell: cellOf(row, c.result) }], hasWinner);
    sideA = sideAOf([{ team: "A", cell: cellOf(row, c.side) }]);
  } else if (mapping.layout === "pair") {
    if (g.rows.length !== 2) throw new RowError(`한 경기가 ${g.rows.length}줄이에요. 팀마다 한 줄씩 두 줄이어야 해요.`);
    const teams = teamsOfRows(g.rows, c.team, 1);
    g.rows.forEach((row, k) => {
      const players = SLOTS.map((i) => ({
        name: cellOf(row, c[`p${i}`]),
        position: readLane(cellOf(row, c[`lane${i}`]), c[`lane${i}`] === undefined ? order(i) : null),
      }));
      if (teams[k] === "A") teamA = players;
      else teamB = players;
    });
    winner = winnerOf(winnerCells, g.rows.map((row, k) => ({ team: teams[k]!, cell: cellOf(row, c.result) })), hasWinner);
    sideA = sideAOf(g.rows.map((row, k) => ({ team: teams[k]!, cell: cellOf(row, c.side) })));
  } else {
    if (g.rows.length !== 10) throw new RowError(`한 경기에 ${g.rows.length}명이 있어요. 10명이어야 해요.`);
    const teams = teamsOfRows(g.rows, c.team, 5);
    const slotInTeam: Record<Team, number> = { A: 0, B: 0 };
    g.rows.forEach((row, k) => {
      const team = teams[k]!;
      const slot = slotInTeam[team]++;
      const player = {
        name: cellOf(row, c.name),
        position: readLane(cellOf(row, c.lane), c.lane === undefined ? order(slot) : null),
      };
      (team === "A" ? teamA : teamB).push(player);
    });
    winner = winnerOf(winnerCells, g.rows.map((row, k) => ({ team: teams[k]!, cell: cellOf(row, c.result) })), hasWinner);
    sideA = sideAOf(g.rows.map((row, k) => ({ team: teams[k]!, cell: cellOf(row, c.side) })));
  }

  for (const [label, team] of [["A", teamA], ["B", teamB]] as const) {
    if (team.length !== 5) throw new RowError(`팀 ${label}가 ${team.length}명이에요. 팀마다 5명이어야 해요.`);
    const empty = team.findIndex((p) => cleanName(p.name) === "");
    if (empty >= 0) throw new RowError(`팀 ${label}의 이름 칸이 비어 있어요. 5명을 모두 적어 주세요.`);
    const lanes = team.map((p) => p.position).filter((p): p is Position => p !== null);
    const dup = lanes.find((p, i) => lanes.indexOf(p) !== i);
    if (dup) throw new RowError(`팀 ${label}에 ${LANE_NAMES[dup]} 라인이 두 번 있어요. 라인을 한 번씩만 적어 주세요.`);
  }
  const all = [...teamA, ...teamB].map((p) => ({ ...p, name: cleanName(p.name) }));
  const tooLong = all.find((p) => [...p.name].length > MAX_NAME_LENGTH);
  if (tooLong) throw new RowError(`'${tooLong.name}'는 ${MAX_NAME_LENGTH}자를 넘어요. 이름을 줄여 주세요.`);
  const seen = new Set<string>();
  for (const p of all) {
    const key = nameKey(p.name);
    if (seen.has(key)) throw new RowError(`'${p.name}'가 한 경기에 두 번 있어요. 같은 사람은 한 번만 적어 주세요.`);
    seen.add(key);
  }
  return {
    line: g.lines[0]!,
    lines: g.lines,
    dateCell,
    teamA: all.slice(0, 5),
    teamB: all.slice(5),
    winner,
    sideA,
    ...(twoDigitYearOf(dateText) !== undefined ? { twoDigitYear: twoDigitYearOf(dateText) } : {}),
  };
}

/** 팀 열이 있으면 그 값으로, 없으면 앞쪽 줄(perTeam개)을 팀 A로 본다. */
function teamsOfRows(rows: (readonly string[])[], teamCol: number | undefined, perTeam: number): Team[] {
  if (teamCol === undefined) return rows.map((_, k) => (k < perTeam ? "A" : "B"));
  return rows.map((row) => {
    const cell = cellOf(row, teamCol);
    const team = parseTeamLabel(cell) ?? (parseSide(cell) === "blue" ? "A" : parseSide(cell) === "red" ? "B" : null);
    if (!team) throw new RowError(`팀 '${cell}'을 읽지 못했어요. A 또는 B(블루/레드, 1팀/2팀)로 써 주세요.`);
    return team;
  });
}

/**
 * 연도 없는 날짜에 연도를 붙인다.
 * - 사용자가 시작 연도를 고르면: 표 순서대로 그 해에서 시작하고, 달이 6개월 넘게 줄면(예: 12월 → 1월) 해를 넘긴다.
 * - 고르지 않으면: 마지막 경기를 "오늘 이전의 가장 가까운 그 날짜"로 보고 거꾸로 같은 규칙을 적용한다.
 * 연도가 적힌 줄을 만나면 그 해를 기준으로 다시 이어 간다.
 */
function resolveYears(
  cells: DateCell[],
  year: number | null,
  today: string,
): { years: (number | null)[]; guess: YearGuess | null } {
  const years: (number | null)[] = cells.map((c) => c.year);
  const missing = cells.filter((c) => c.year === null).length;
  if (missing === 0) return { years, guess: null };
  /** from부터 끝까지 앞으로: 달이 6개월 넘게 줄면 해를 넘긴다. */
  const forward = (from: number, startYear: number) => {
    let cur = startYear;
    let prevMonth: number | null = null;
    for (let i = from; i < cells.length; i++) {
      const c = cells[i]!;
      if (c.year !== null) cur = c.year;
      else {
        if (prevMonth !== null && c.month < prevMonth - 6) cur += 1;
        years[i] = cur;
      }
      prevMonth = c.month;
    }
  };
  /** from부터 처음까지 거꾸로: 달이 6개월 넘게 늘면 해를 되돌린다. */
  const backward = (from: number, startYear: number, nextMonthStart: number | null) => {
    let cur = startYear;
    let nextMonth = nextMonthStart;
    for (let i = from; i >= 0; i--) {
      const c = cells[i]!;
      if (c.year !== null) cur = c.year;
      else {
        if (nextMonth !== null && c.month > nextMonth + 6) cur -= 1;
        years[i] = cur;
      }
      nextMonth = c.month;
    }
  };
  const firstExplicit = cells.findIndex((c) => c.year !== null);
  if (year !== null) {
    forward(0, year);
  } else if (firstExplicit >= 0) {
    // 연도가 적힌 줄이 있으면 그 줄을 기준으로 뒤는 앞으로, 앞은 거꾸로 센다.
    const anchor = cells[firstExplicit]!;
    forward(firstExplicit, anchor.year!);
    if (firstExplicit > 0) backward(firstExplicit - 1, anchor.year!, anchor.month);
  } else {
    // 마지막 경기를 오늘 이전의 가장 가까운 그 날짜로 본다.
    const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
    const last = cells[cells.length - 1]!;
    const lastYear = last.month < tm || (last.month === tm && last.day <= td) ? ty : ty - 1;
    backward(cells.length - 1, lastYear, null);
  }
  const guessed = years.filter((_, i) => cells[i]!.year === null) as number[];
  return {
    years,
    guess: {
      count: missing,
      from: Math.min(...guessed),
      to: Math.max(...guessed),
      basis: year === null ? "guess" : "user",
    },
  };
}

export interface ParseOptions {
  /** 모임 시간대의 오늘(YYYY-MM-DD). 연도 추정에 쓴다. */
  today: string;
  /** 지금(밀리초). timeZone과 함께 주면 아직 오지 않은 경기를 틀린 줄로 돌려준다. */
  now?: number;
  /** 모임 시간대. 시각이 없는 경기는 이 시간대의 정오로 본다. */
  timeZone?: string;
}

/** 표 전체를 설정대로 읽는다. 틀린 줄은 errors에 모으고 나머지는 matches로 돌려준다. */
export function parseSheet(rows: readonly (readonly string[])[], mapping: SheetMapping, options: ParseOptions): SheetParse {
  const errors: SheetError[] = [];
  const problems = mappingProblems(mapping);
  const raw = dataRows(rows, mapping);
  if (problems.length > 0) {
    return { matches: [], errors: [], names: [], yearGuess: null, dataRowCount: raw.length };
  }
  const c = mapping.columns;
  const drafts: Draft[] = [];
  if (mapping.layout === "across") {
    const across = parseAcross(rows, mapping);
    drafts.push(...across.drafts);
    errors.push(...across.errors);
  } else {
    const filled =
      mapping.layout === "wide" ? raw : fillDown(raw, [c.date, c.time, c.match, c.winner]);
    for (const g of group(filled, mapping)) {
      try {
        drafts.push(buildDraft(g, mapping));
      } catch (error) {
        if (!(error instanceof RowError)) throw error;
        errors.push({ line: g.lines[0]!, message: error.message });
      }
    }
  }

  const { years, guess } = resolveYears(
    drafts.map((d) => d.dateCell),
    mapping.year,
    options.today,
  );
  let matches: SheetMatch[] = [];
  const perDay = new Map<string, number>();
  const fingerprintOf = fingerprinter();
  // 진영 열이 없으면 이름 열 머리글(레드 탑·블루 탑…)로 팀 A의 진영을 안다.
  const sideFromHeader = c.side === undefined ? headerSideA(rows, mapping) : null;
  const thisYear = Number(options.today.slice(0, 4));
  drafts.forEach((d, i) => {
    if (d.twoDigitYear !== undefined && years[i]! > thisYear + 1) {
      // "99.1.1"을 2099년으로 읽으면 미래, 1999년이면 이 사이트가 생기기 훨씬 전이라 어느 쪽인지 정하지 않는다.
      const yy = d.twoDigitYear;
      errors.push({
        line: d.line,
        ...(d.where ? { where: d.where } : {}),
        message: `연도가 두 자리(${yy})라 20${yy}년인지 19${yy}년인지 확실하지 않아요. 네 자리 연도(예: ${thisYear}-${String(d.dateCell.month).padStart(2, "0")}-${String(d.dateCell.day).padStart(2, "0")})로 적어 주세요.`,
      });
      return;
    }
    const date = isoDate(years[i]!, d.dateCell.month, d.dateCell.day);
    if (date === null) {
      errors.push({
        line: d.line,
        ...(d.where ? { where: d.where } : {}),
        message: `${years[i]}년 ${d.dateCell.month}월 ${d.dateCell.day}일은 없는 날짜예요. 날짜를 고쳐 주세요.`,
      });
      return;
    }
    const orderInDay = (perDay.get(date) ?? 0) + 1;
    perDay.set(date, orderInDay);
    matches.push({
      line: d.line,
      ...(d.where ? { where: d.where } : {}),
      lines: d.lines,
      date,
      time: d.dateCell.time,
      yearGuessed: d.dateCell.year === null,
      teamA: d.teamA,
      teamB: d.teamB,
      winner: d.winner,
      sideA: d.sideA ?? sideFromHeader,
      orderInDay,
      fingerprint: fingerprintOf({ date, time: d.dateCell.time, teamA: d.teamA, teamB: d.teamB, winner: d.winner }),
      rowKey: `${date}#${orderInDay}`,
    });
  });
  // 아직 오지 않은 경기는 틀린 줄로 돌린다. 지문은 그 전에 매겨서 시간이 지나도 다른 줄의 지문이 바뀌지 않게 한다.
  if (options.now !== undefined && options.timeZone !== undefined) {
    const today = localDate(new Date(options.now).toISOString(), options.timeZone);
    const future = futureIndexes(matches, options.timeZone, options.now);
    for (const i of future) {
      const m = matches[i]!;
      errors.push({
        line: m.line,
        ...(m.where ? { where: m.where } : {}),
        message: futureMessage(m.date, m.time, today, m.yearGuessed),
      });
    }
    matches = matches.filter((_, i) => !future.has(i));
  }
  errors.sort((x, y) => x.line - y.line);
  const names = new Map<string, string>();
  for (const m of matches) {
    for (const p of [...m.teamA, ...m.teamB]) if (!names.has(nameKey(p.name))) names.set(nameKey(p.name), p.name);
  }
  return { matches, errors, names: [...names.values()], yearGuess: guess, dataRowCount: raw.length };
}
