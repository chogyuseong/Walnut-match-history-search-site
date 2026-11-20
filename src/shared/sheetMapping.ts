/**
 * 표 모양(wide·pair·player·across)과 열 역할, 그리고 머리글·값의 모양으로 열 역할을 처음 추정하는 부분.
 * 시트 가져오기 화면(SheetImport.tsx)의 열 맞추기 칸과 기존 표 판별(Import.tsx)이 쓴다.
 * 가로로 긴 표는 열마다 역할을 고르지 않으므로 판별·설정만 sheetAcross.ts에 맡긴다.
 */
import { columnCount, isBlankRow } from "./csv";
import { acrossMapping, isAcrossLayout } from "./sheetAcross";
import { LANE_WORDS, norm, parseDateCell, parseLane, parseResult, parseSide, parseTeamLabel, parseTime } from "./sheetCells";
import { POSITIONS, type Position } from "./types";

export type Layout = "wide" | "pair" | "player" | "across";
export const LAYOUTS: readonly Layout[] = ["wide", "pair", "player", "across"];
export const LAYOUT_LABELS: Record<Layout, string> = {
  wide: "한 줄에 한 경기(10명이 옆으로)",
  pair: "한 경기가 두 줄(팀마다 한 줄)",
  player: "한 줄에 선수 한 명",
  across: "가로로 긴 표(경기마다 이름·승패 두 열, 위 5명·아래 5명)",
};

export const SLOTS = [0, 1, 2, 3, 4] as const;
export const LANE_NAMES: Record<Position, string> = {
  top: "탑",
  jungle: "정글",
  mid: "미드",
  adc: "원딜",
  support: "서폿",
};

/** 표 모양마다 고를 수 있는 열의 역할. */
export function rolesOf(layout: Layout): string[] {
  // 가로로 긴 표는 열마다 역할을 고르지 않는다(이름·승패 두 열씩 반복을 그대로 읽는다).
  if (layout === "across") return [];
  const common = ["date", "time"];
  if (layout === "wide") {
    return [
      ...common,
      ...SLOTS.map((i) => `a${i}`),
      ...SLOTS.map((i) => `b${i}`),
      "winner",
      "result",
      "side",
      ...SLOTS.map((i) => `aLane${i}`),
      ...SLOTS.map((i) => `bLane${i}`),
    ];
  }
  if (layout === "pair") {
    return [
      ...common,
      "match",
      ...SLOTS.map((i) => `p${i}`),
      "team",
      "winner",
      "result",
      "side",
      ...SLOTS.map((i) => `lane${i}`),
    ];
  }
  return [...common, "match", "name", "team", "lane", "winner", "result", "side"];
}

export function roleLabel(layout: Layout, role: string): string {
  const slot = /\d$/.test(role) ? Number(role.slice(-1)) : -1;
  const lane = slot >= 0 ? LANE_NAMES[POSITIONS[slot]!] : "";
  if (role === "date") return "날짜";
  if (role === "time") return "시각";
  if (role === "match") return "경기 번호";
  if (role === "winner") return "이긴 팀(A/B, 블루/레드, 1팀/2팀)";
  if (role === "result")
    return layout === "wide" ? "팀 A의 승패(승/패)" : layout === "pair" ? "이 줄 팀의 승패" : "이 선수의 승패";
  if (role === "team") return "팀(A/B, 블루/레드, 1팀/2팀)";
  if (role === "side") return layout === "wide" ? "팀 A의 진영" : "진영";
  if (role === "name") return "이름";
  if (role === "lane") return "라인";
  if (/^a\d$/.test(role)) return `팀 A 이름 ${slot + 1}(${lane})`;
  if (/^b\d$/.test(role)) return `팀 B 이름 ${slot + 1}(${lane})`;
  if (/^p\d$/.test(role)) return `이름 ${slot + 1}(${lane})`;
  if (/^aLane\d$/.test(role)) return `팀 A 라인 ${slot + 1}`;
  if (/^bLane\d$/.test(role)) return `팀 B 라인 ${slot + 1}`;
  if (/^lane\d$/.test(role)) return `라인 ${slot + 1}`;
  return role;
}

export interface SheetMapping {
  layout: Layout;
  /** 머리글 줄 번호(1부터). 0이면 머리글 없음. 머리글과 그 위의 줄은 읽지 않는다. */
  headerRow: number;
  /** 읽지 않을 줄 번호(1부터). */
  skip: number[];
  /** 역할 → 열 번호(0부터). */
  columns: Record<string, number>;
  /** 라인 열이 없을 때 이름 칸의 순서(탑→정글→미드→원딜→서폿)로 라인을 정할지. */
  lanesByOrder: boolean;
  /** 연도 없는 날짜의 첫 연도. null이면 추정한다(추정은 화면에 드러낸다). */
  year: number | null;
}

/* ------------------------------------------------------------------ */
/* 열 자동 추정                                                          */
/* ------------------------------------------------------------------ */

const HEADER_HINTS: [RegExp, string][] = [
  [/날짜|일자|date|일시|day/, "date"],
  [/시간|시각|time/, "time"],
  [/승리|승팀|이긴|winner|승자|win팀/, "winner"],
  [/결과|승패|result|w\/l|승\/패/, "result"],
  [/진영|side/, "side"],
  [/경기|번호|match|game|^no\.?$|^#$|판/, "match"],
  [/라인|포지션|lane|position|^pos$|역할/, "lane"],
  [/^팀$|^team$|소속|팀구분|^편$/, "team"],
  [/이름|닉네임|닉|선수|player|name|소환사|참가자/, "name"],
];

function headerHint(cell: string): string | null {
  const value = norm(cell);
  if (value === "") return null;
  for (const [pattern, role] of HEADER_HINTS) if (pattern.test(value)) return role;
  if (parseLane(cell) !== null) return "laneHeader";
  return null;
}

type Shape = "date" | "time" | "lane" | "team" | "result" | "side" | "number" | "name" | "empty";

function shapeOf(cell: string): Shape {
  const text = cell.trim();
  if (text === "") return "empty";
  if (parseDateCell(text)) return "date";
  if (parseTime(text)) return "time";
  if (parseLane(text)) return "lane";
  if (parseSide(text)) return "side";
  if (/^\d+$/.test(text)) return "number";
  if (parseResult(text) !== null) return "result";
  if (parseTeamLabel(text)) return "team";
  return "name";
}

function columnShapes(rows: readonly (readonly string[])[], col: number): Record<Shape, number> {
  const counts: Record<Shape, number> = {
    date: 0, time: 0, lane: 0, team: 0, result: 0, side: 0, number: 0, name: 0, empty: 0,
  };
  for (const row of rows) counts[shapeOf(row[col] ?? "")] += 1;
  return counts;
}

/** 머리글 줄 추정: 앞 10줄 중 머리글 단어가 가장 많은 줄. 두 개 미만이면 머리글 없음. */
export function detectHeaderRow(rows: readonly (readonly string[])[]): number {
  let best = 0;
  let bestScore = 1;
  rows.slice(0, 10).forEach((row, index) => {
    const score = row.filter((cell) => headerHint(cell) !== null).length;
    const dates = row.filter((cell) => parseDateCell(cell) !== null).length;
    if (score > bestScore && dates === 0) {
      best = index + 1;
      bestScore = score;
    }
  });
  return best;
}

/** 머리글 다음부터, 건너뛸 줄과 빈 줄을 뺀 자료 줄(줄 번호와 함께). */
export function dataRows(
  rows: readonly (readonly string[])[],
  mapping: Pick<SheetMapping, "headerRow" | "skip">,
): { line: number; cells: readonly string[] }[] {
  const skip = new Set(mapping.skip);
  const out: { line: number; cells: readonly string[] }[] = [];
  rows.forEach((cells, index) => {
    const line = index + 1;
    if (line <= mapping.headerRow || skip.has(line) || isBlankRow(cells)) return;
    out.push({ line, cells });
  });
  return out;
}

/** 표 모양을 추정한다. */
export function detectLayout(rows: readonly (readonly string[])[], headerRow: number): Layout {
  const data = dataRows(rows, { headerRow, skip: [] }).slice(0, 60).map((r) => r.cells);
  const cols = columnCount(rows);
  let nameCols = 0;
  let laneCols = 0;
  for (let c = 0; c < cols; c++) {
    const s = columnShapes(data, c);
    const filled = data.length - s.empty;
    if (filled === 0) continue;
    if (s.name / filled >= 0.6) nameCols += 1;
    if (s.lane / filled >= 0.6) laneCols += 1;
  }
  if (nameCols >= 10) return "wide";
  if (nameCols >= 5) return "pair";
  if (nameCols >= 1 && nameCols <= 3) return "player";
  return laneCols >= 1 && laneCols < 5 ? "player" : "wide";
}

/** 기존 표 일괄 입력 형식(날짜, A탑~A서폿, B탑~B서폿, 승리팀)인지. */
export function isLegacyLayout(rows: readonly (readonly string[])[]): boolean {
  const first = rows.find((r) => !isBlankRow(r));
  if (!first) return false;
  const legacyHeader = ["날짜", "a탑", "a정글", "a미드", "a원딜", "a서폿", "b탑", "b정글", "b미드", "b원딜", "b서폿", "승리팀"];
  if (first.length === 12 && first.every((c, i) => norm(c) === legacyHeader[i])) return true;
  return first.length === 12 && parseDateCell(first[0] ?? "")?.year != null && parseTeamLabel(first[11] ?? "") !== null;
}

export function legacyMapping(rows: readonly (readonly string[])[]): SheetMapping {
  const first = rows.findIndex((r) => !isBlankRow(r));
  const header = first >= 0 && parseDateCell(rows[first]![0] ?? "") === null ? first + 1 : 0;
  const columns: Record<string, number> = { date: 0, winner: 11 };
  for (const i of SLOTS) {
    columns[`a${i}`] = 1 + i;
    columns[`b${i}`] = 6 + i;
  }
  return { layout: "wide", headerRow: header, skip: [], columns, lanesByOrder: true, year: null };
}

/**
 * 열 역할을 추정한다. layout을 주면 그 모양으로, 안 주면 모양도 추정한다.
 * 머리글 이름을 먼저 보고, 머리글이 없거나 모르는 이름이면 값의 모양을 본다.
 */
export function detectMapping(rows: readonly (readonly string[])[], layout?: Layout): SheetMapping {
  if (!layout && isLegacyLayout(rows)) return legacyMapping(rows);
  if (layout === "across" || (!layout && isAcrossLayout(rows))) return acrossMapping(rows);
  const headerRow = detectHeaderRow(rows);
  const chosen = layout ?? detectLayout(rows, headerRow);
  const header = headerRow > 0 ? rows[headerRow - 1]! : [];
  const data = dataRows(rows, { headerRow, skip: [] }).slice(0, 60).map((r) => r.cells);
  const cols = columnCount(rows);
  const columns: Record<string, number> = {};
  const used = new Set<number>();
  const take = (role: string, col: number) => {
    if (columns[role] !== undefined || used.has(col)) return;
    columns[role] = col;
    used.add(col);
  };

  const hints = Array.from({ length: cols }, (_, c) => headerHint(header[c] ?? ""));
  const shapes = Array.from({ length: cols }, (_, c) => columnShapes(data, c));
  const ratio = (c: number, shape: Shape) => {
    const s = shapes[c]!;
    const filled = data.length - s.empty;
    return filled === 0 ? 0 : s[shape] / filled;
  };

  // 1) 머리글로 정해지는 단일 역할.
  for (let c = 0; c < cols; c++) {
    const hint = hints[c];
    if (hint === "date" && ratio(c, "date") >= 0.5) take("date", c);
    else if (hint === "time") take("time", c);
    else if (hint === "winner") take("winner", c);
    else if (hint === "result") take("result", c);
    else if (hint === "side" && chosen !== "wide") take("side", c);
    else if (hint === "side" && chosen === "wide") take("side", c);
    else if (hint === "match" && chosen !== "wide") take("match", c);
    else if (hint === "team" && chosen !== "wide") take("team", c);
  }
  // 2) 값의 모양으로 정해지는 단일 역할.
  for (let c = 0; c < cols; c++) {
    if (used.has(c)) continue;
    if (ratio(c, "date") >= 0.7) take("date", c);
    else if (ratio(c, "time") >= 0.7) take("time", c);
    else if (ratio(c, "result") >= 0.7) take("result", c);
    else if (ratio(c, "side") >= 0.7) take("side", c);
    else if (ratio(c, "team") >= 0.7) take(chosen === "wide" ? "winner" : "team", c);
  }
  // 3) 이름·라인 열.
  const isLaneCol = (c: number) => !used.has(c) && (hints[c] === "lane" || ratio(c, "lane") >= 0.7);
  const isNameCol = (c: number) =>
    !used.has(c) &&
    !isLaneCol(c) &&
    (hints[c] === "name" || hints[c] === "laneHeader" || (ratio(c, "name") >= 0.6 && hints[c] === null));
  const nameCols: number[] = [];
  const laneAfter = new Map<number, number>();
  for (let c = 0; c < cols; c++) {
    if (isNameCol(c)) {
      nameCols.push(c);
      if (c + 1 < cols && isLaneCol(c + 1)) laneAfter.set(c, c + 1);
    }
  }
  const laneCols: number[] = [];
  for (let c = 0; c < cols; c++) if (isLaneCol(c)) laneCols.push(c);
  // 경기 번호: 숫자 열(머리글로 못 정했을 때). 선수 한 줄 모양에서만.
  if (chosen !== "wide" && columns.match === undefined) {
    for (let c = 0; c < cols; c++) {
      if (!used.has(c) && ratio(c, "number") >= 0.9 && !nameCols.includes(c)) {
        take("match", c);
        break;
      }
    }
  }

  /** 머리글의 라인 단어로 이름 칸의 순서를 맞춘다(예: "블루 정글" 열이 탑보다 앞에 있어도). */
  const orderByHeaderLane = (group: number[]): number[] => {
    const lanes = group.map((c) => parseLaneInHeader(header[c] ?? ""));
    if (lanes.some((l) => l === null) || new Set(lanes).size !== lanes.length) return group;
    return [...group].sort(
      (x, y) => POSITIONS.indexOf(lanes[group.indexOf(x)]!) - POSITIONS.indexOf(lanes[group.indexOf(y)]!),
    );
  };

  if (chosen === "wide") {
    let a = orderByHeaderLane(nameCols.slice(0, 5));
    let b = orderByHeaderLane(nameCols.slice(5, 10));
    // 앞 5개 열 머리글이 레드, 뒤 5개가 블루면 맞바꾼다. 이긴 팀 칸의 "블루"는 늘 팀 A로 읽으므로(parseTeamLabel)
    // 팀 A가 블루 열이어야 승패가 뒤바뀌지 않는다.
    if (groupSide(header, a) === "red" && groupSide(header, b) === "blue") [a, b] = [b, a];
    a.forEach((c, i) => {
      take(`a${i}`, c);
      const lane = laneAfter.get(c);
      if (lane !== undefined) take(`aLane${i}`, lane);
    });
    b.forEach((c, i) => {
      take(`b${i}`, c);
      const lane = laneAfter.get(c);
      if (lane !== undefined) take(`bLane${i}`, lane);
    });
  } else if (chosen === "pair") {
    orderByHeaderLane(nameCols.slice(0, 5)).forEach((c, i) => {
      take(`p${i}`, c);
      const lane = laneAfter.get(c);
      if (lane !== undefined) take(`lane${i}`, lane);
    });
  } else {
    if (nameCols[0] !== undefined) take("name", nameCols[0]);
    if (laneCols[0] !== undefined) take("lane", laneCols[0]);
  }
  return { layout: chosen, headerRow, skip: [], columns, lanesByOrder: true, year: null };
}

/** 머리글 칸의 진영 단어("레드 탑", "Blue Mid", "블루팀 서폿"). 라인 단어를 떼고 남은 앞부분으로 읽는다. */
function headerSide(cell: string): "blue" | "red" | null {
  const value = norm(cell);
  if (value === "") return null;
  const lane = parseLaneInHeader(cell);
  let rest = value;
  if (lane !== null) {
    for (const word of Object.keys(LANE_WORDS).sort((x, y) => y.length - x.length)) {
      if (LANE_WORDS[word] === lane && rest.endsWith(word)) {
        rest = rest.slice(0, -word.length);
        break;
      }
    }
  }
  rest = rest.replace(/[-_:./()[\]]+/g, "");
  if (/블루|blue|파랑/.test(rest)) return /레드|red|빨강/.test(rest) ? null : "blue";
  if (/레드|red|빨강/.test(rest)) return "red";
  return parseSide(rest);
}

/** 열 묶음의 머리글이 모두 같은 진영이면 그 진영. 아니면 null. */
function groupSide(header: readonly string[], cols: readonly number[]): "blue" | "red" | null {
  if (cols.length === 0) return null;
  const sides = cols.map((c) => headerSide(header[c] ?? ""));
  return sides.every((s) => s === sides[0]) ? sides[0]! : null;
}

/**
 * 한 줄 한 경기 표에서 이름 열 머리글로 알 수 있는 팀 A의 진영(팀 A 열이 모두 블루, 팀 B 열이 모두 레드면 "blue",
 * 반대면 "red"). 머리글이 없거나 섞여 있으면 null. 진영 열이 없을 때 경기의 sideA로 쓴다.
 */
export function headerSideA(rows: readonly (readonly string[])[], mapping: SheetMapping): "blue" | "red" | null {
  if (mapping.layout !== "wide" || mapping.headerRow <= 0) return null;
  const header = rows[mapping.headerRow - 1] ?? [];
  const cols = (prefix: "a" | "b") =>
    SLOTS.map((i) => mapping.columns[`${prefix}${i}`]).filter((c): c is number => c !== undefined);
  const a = groupSide(header, cols("a"));
  const b = groupSide(header, cols("b"));
  if (a === null || b === null || a === b) return null;
  return a;
}

function parseLaneInHeader(cell: string): Position | null {
  const value = norm(cell);
  for (const word of Object.keys(LANE_WORDS).sort((x, y) => y.length - x.length)) {
    // 영문 한 글자 표기는 없다. 한글은 "탑"처럼 한 글자도 받는다.
    if ((word.length >= 2 || /[가-힣]/.test(word)) && value.endsWith(word)) return LANE_WORDS[word]!;
  }
  return null;
}

/** 설정이 모자라 읽을 수 없는 이유(한 문장씩). 비어 있으면 읽을 수 있다. */
export function mappingProblems(mapping: SheetMapping): string[] {
  if (mapping.layout === "across") return [];
  const has = (role: string) => mapping.columns[role] !== undefined;
  const problems: string[] = [];
  if (!has("date")) problems.push("날짜 열을 골라 주세요.");
  if (mapping.layout === "wide") {
    const missing = [...SLOTS.map((i) => `a${i}`), ...SLOTS.map((i) => `b${i}`)].filter((r) => !has(r));
    if (missing.length > 0) problems.push(`이름 열 10개(팀 A 5개, 팀 B 5개)를 모두 골라 주세요. ${missing.length}개가 비었어요.`);
  } else if (mapping.layout === "pair") {
    const missing = SLOTS.filter((i) => !has(`p${i}`));
    if (missing.length > 0) problems.push(`이름 열 5개를 모두 골라 주세요. ${missing.length}개가 비었어요.`);
  } else if (!has("name")) {
    problems.push("이름 열을 골라 주세요.");
  }
  if (!has("winner") && !has("result")) problems.push("이긴 팀 열이나 승패 열 중 하나를 골라 주세요.");
  const cols = Object.values(mapping.columns);
  if (new Set(cols).size !== cols.length) problems.push("한 열에 두 가지 역할을 줄 수 없어요.");
  return problems;
}
