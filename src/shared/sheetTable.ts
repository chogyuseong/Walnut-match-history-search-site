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
 */
import { FUTURE_TOLERANCE_MS } from "./backfill";
import { columnCount, isBlankRow } from "./csv";
import { cleanName, MAX_NAME_LENGTH, nameKey } from "./names";
import { localDate, zonedTimeToUtc } from "./stats";
import { POSITIONS, type Position, type RosterEntry, type Side, type Team } from "./types";

export type Layout = "wide" | "pair" | "player" | "across";
export const LAYOUTS: readonly Layout[] = ["wide", "pair", "player", "across"];
export const LAYOUT_LABELS: Record<Layout, string> = {
  wide: "한 줄에 한 경기(10명이 옆으로)",
  pair: "한 경기가 두 줄(팀마다 한 줄)",
  player: "한 줄에 선수 한 명",
  across: "가로로 긴 표(경기마다 이름·승패 두 열, 위 5명·아래 5명)",
};

const SLOTS = [0, 1, 2, 3, 4] as const;
const LANE_NAMES: Record<Position, string> = {
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
/* 값 읽기                                                              */
/* ------------------------------------------------------------------ */

function norm(cell: string): string {
  return cell.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

const LANE_WORDS: Record<string, Position> = {};
for (const [pos, words] of [
  ["top", ["탑", "탑라인", "top", "toplane", "상단"]],
  ["jungle", ["정글", "정글러", "jg", "jug", "jng", "jgl", "jungle", "jungler"]],
  ["mid", ["미드", "미드라인", "mid", "middle", "midlane", "미들"]],
  ["adc", ["원딜", "원거리딜러", "adc", "ad", "adcarry", "bot", "bottom", "바텀", "봇", "원딜러", "carry"]],
  ["support", ["서폿", "서포터", "서포트", "서폿터", "sup", "supp", "support", "suport", "spt", "sp"]],
] as const) {
  for (const word of words) LANE_WORDS[word] = pos as Position;
}

/** 라인 표기를 읽는다. 못 읽으면 null. */
export function parseLane(cell: string): Position | null {
  return LANE_WORDS[norm(cell)] ?? null;
}

/** 팀 표기(A/B, 블루/레드, 1팀/2팀). 뒤에 붙은 "승"·"승리"·"win"은 떼고 읽는다. */
export function parseTeamLabel(cell: string): Team | null {
  const value = norm(cell).replace(/(승리|승|wins?|won)$/, "").replace(/^(팀|team)/, "").replace(/(팀|team)$/, "");
  if (["a", "1", "블루", "blue", "파랑", "청", "블"].includes(value)) return "A";
  if (["b", "2", "레드", "red", "빨강", "홍", "레"].includes(value)) return "B";
  return null;
}

/** 승패 표기. true = 이김. 못 읽으면 null. */
export function parseResult(cell: string): boolean | null {
  const value = norm(cell);
  if (["승", "승리", "w", "win", "won", "o", "○", "◯", "1", "true", "v", "이김", "승!"].includes(value)) return true;
  if (["패", "패배", "l", "lose", "loss", "lost", "x", "×", "✕", "0", "false", "짐"].includes(value)) return false;
  return null;
}

/** 진영 표기. */
export function parseSide(cell: string): "blue" | "red" | null {
  const value = norm(cell).replace(/(진영|팀|side|team)$/, "");
  if (["블루", "blue", "파랑", "청", "블"].includes(value)) return "blue";
  if (["레드", "red", "빨강", "홍", "레"].includes(value)) return "red";
  return null;
}

/** 시각 표기를 HH:MM으로. 20:30, 20:30:00, 오후 8:30, 8:30 PM, 20시 30분, 20시. */
export function parseTime(cell: string): string | null {
  const text = cell.normalize("NFKC").trim().replace(/\s+/g, " ");
  const match =
    /^(오전|오후|am|pm|a\.m\.|p\.m\.)?\s*(\d{1,2})\s*(?::\s*(\d{1,2})(?:\s*:\s*\d{1,2}(?:\.\d+)?)?|시\s*(?:(\d{1,2})\s*분)?)\s*(오전|오후|am|pm|a\.m\.|p\.m\.)?$/i.exec(
      text,
    );
  if (!match) return null;
  const marker = (match[1] ?? match[5] ?? "").toLowerCase().replace(/\./g, "");
  let hour = Number(match[2]);
  const minute = Number(match[3] ?? match[4] ?? 0);
  if (marker !== "") {
    if (hour < 1 || hour > 12) return null;
    const pm = marker === "오후" || marker === "pm";
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export interface DateCell {
  /** 연도가 적혀 있지 않으면 null. */
  year: number | null;
  month: number;
  day: number;
  time: string | null;
}

/**
 * 날짜 표기를 읽는다. 받는 모양:
 * 2026-11-05, 2026.11.5, 2026. 11. 5(구글 시트 한국어 표시), 2026/11/05, 2026년 11월 5일,
 * 11/5/2026(구글 시트 영어 표시), 26.11.05, 26-11-05, 11/5, 11.5, 11월 5일, 뒤의 요일 "(목)",
 * 날짜 뒤의 시각 "2026. 11. 5 오후 8:30:00", "2026-11-05 20:30".
 */
export function parseDateCell(cell: string): DateCell | null {
  let text = cell.normalize("NFKC").trim().replace(/\s+/g, " ");
  // 요일 떼기: (목), (Thu), 목요일
  text = text
    .replace(/\s*\((?:[월화수목금토일]|mon|tue|wed|thu|fri|sat|sun)[a-z]*\)/i, "")
    .replace(/\s*[월화수목금토일]요일/, "")
    .trim();
  const finish = (year: number | null, month: number, day: number, rest: string | undefined): DateCell | null => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let time: string | null = null;
    if (rest !== undefined && rest.trim() !== "") {
      time = parseTime(rest.replace(/^T/, ""));
      if (time === null) return null;
    }
    return { year, month, day, time };
  };
  let m = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?(?:[ T](.+))?$/.exec(text);
  if (m) return finish(Number(m[1]), Number(m[2]), Number(m[3]), m[4]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (.+))?$/.exec(text);
  if (m) return finish(Number(m[3]), Number(m[1]), Number(m[2]), m[4]);
  m = /^(\d{2})\s*[-.]\s*(\d{1,2})\s*[-.]\s*(\d{1,2})\.?(?: (.+))?$/.exec(text);
  if (m) return finish(2000 + Number(m[1]), Number(m[2]), Number(m[3]), m[4]);
  m = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?(?: (.+))?$/.exec(text);
  if (m) return finish(null, Number(m[1]), Number(m[2]), m[3]);
  return null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
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
    const a = orderByHeaderLane(nameCols.slice(0, 5));
    const b = orderByHeaderLane(nameCols.slice(5, 10));
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

/* ------------------------------------------------------------------ */
/* 표 → 경기                                                            */
/* ------------------------------------------------------------------ */

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

interface Draft {
  line: number;
  where?: string;
  lines: number[];
  dateCell: DateCell;
  teamA: SheetPlayer[];
  teamB: SheetPlayer[];
  winner: Team;
  sideA: "blue" | "red" | null;
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

/** 64비트 해시(16진 16자). 지문용이며 보안 목적이 아니다. */
export function hash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * 경기 지문의 바탕 글. 날짜(시각이 있으면 시각까지), 양 팀의 (라인:이름) 목록, 이긴 팀.
 * 팀 안의 순서는 정렬해서 열 순서가 바뀌어도 같은 지문이 나오게 한다. 진영은 넣지 않는다(가져올 때 고르는 값).
 */
export function fingerprintBase(m: Pick<SheetMatch, "date" | "time" | "teamA" | "teamB" | "winner">): string {
  const team = (players: SheetPlayer[]) =>
    players
      .map((p) => `${p.position ?? "-"}:${nameKey(p.name)}`)
      .sort()
      .join(",");
  return `${m.date}${m.time ? `T${m.time}` : ""}|A=${team(m.teamA)}|B=${team(m.teamB)}|W=${m.winner}`;
}

export type FingerprintInput = Pick<SheetMatch, "date" | "time" | "teamA" | "teamB" | "winner">;

/**
 * 지문 매기기. 표 순서대로 부른다. 같은 날 같은 명단·같은 결과의 경기가 또 나오면
 * 몇 번째인지 붙여 서로 다른 지문을 만든다. 시트 가져오기·붙여 넣기·서버(지문 없는 예전 경기)가 함께 쓴다.
 */
export function fingerprinter(): (m: FingerprintInput) => string {
  const seen = new Map<string, number>();
  return (m) => {
    const base = fingerprintBase(m);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return `v1-${hash64(`${base}#${occurrence}`)}`;
  };
}

/**
 * 서버로 보낼 경기 시각(UTC ISO). 시각이 있으면 모임 시간대의 그 시각, 없으면 그날 정오.
 * 같은 칸(날짜+시각)의 경기가 여럿이면 표 순서대로 1초씩 늦춰 순서를 지킨다.
 */
export function playedAtTimes(items: readonly { date: string; time: string | null }[], timeZone: string): string[] {
  const perSlot = new Map<string, number>();
  return items.map((m) => {
    const slot = `${m.date}T${m.time ?? "12:00"}`;
    const order = perSlot.get(slot) ?? 0;
    perSlot.set(slot, order + 1);
    const base = Date.parse(zonedTimeToUtc(m.date, m.time ?? "12:00", timeZone));
    return new Date(base + order * 1000).toISOString();
  });
}

/** 아직 오지 않은 경기 줄의 안내 문구. today는 모임 시간대의 오늘(YYYY-MM-DD). */
export function futureMessage(date: string, time: string | null, today: string, yearGuessed = false): string {
  if (date > today) {
    return yearGuessed
      ? `연도가 없어 ${date.slice(0, 4)}년으로 본 ${date}는 아직 오지 않은 날짜예요. 첫 경기의 연도를 확인해 주세요.`
      : `${date}는 아직 오지 않은 날짜예요. 이미 한 경기만 넣을 수 있어요.`;
  }
  if (time !== null) return `${date} ${time}은 아직 오지 않은 시각이에요. 이미 한 경기만 넣을 수 있어요.`;
  return `${date}는 오늘이고 시각이 없어 낮 12시로 넣는데, 아직 12시가 지나지 않았어요(아직 오지 않은 시각). 시각을 적거나 12시가 지난 뒤에 넣어 주세요.`;
}

/**
 * 경기 시각이 지금(+ 시계 오차 허용 폭)보다 뒤인 경기의 번호(0부터). 서버도 같은 기준으로 거절한다.
 * 시각은 playedAtTimes 규칙(전체 표 기준 순서)으로 매기므로 일부만 보내도 이 검사보다 늦어지지 않는다.
 */
export function futureIndexes(
  items: readonly { date: string; time: string | null }[],
  timeZone: string,
  now: number,
): Set<number> {
  const limit = now + FUTURE_TOLERANCE_MS;
  const out = new Set<number>();
  playedAtTimes(items, timeZone).forEach((t, i) => {
    if (Date.parse(t) > limit) out.add(i);
  });
  return out;
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
  drafts.forEach((d, i) => {
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
      sideA: d.sideA,
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

/* ------------------------------------------------------------------ */
/* 다시 가져오기: 이미 들어간 경기와 비교                                  */
/* ------------------------------------------------------------------ */

export interface ExistingImport {
  fingerprint: string;
  rowKey: string | null;
  sourceKey: string | null;
  state: string;
  matchNo: number;
}

/** 지문으로 견줄 수 있는 경기(시트에서 읽은 경기, 붙여 넣은 줄). 줄 위치 열쇠는 시트만 있다. */
export interface Fingerprinted {
  fingerprint: string;
  rowKey?: string;
}

export interface ImportClassification<T extends Fingerprinted = SheetMatch> {
  /** 새로 넣을 경기. */
  fresh: T[];
  /** 이미 들어가 있어 건너뛸 경기. */
  already: T[];
  /** 같은 자리(날짜·같은 날 순서)의 이전 가져오기와 내용이 달라진 줄. 기본으로 넣지 않는다. */
  changed: { match: T; previous: ExistingImport }[];
  /** fresh 가운데 전에 넣었다가 전적 제외한 경기와 같은 내용인 것. */
  wasExcluded: number;
  /** 이 출처에서 전에 가져왔는데 지금 시트에는 없는 경기 수(지워졌거나 고쳐진 줄). */
  missing: number;
}

/**
 * 지문으로 이미 들어간 경기를 건너뛰고, 같은 시트의 같은 자리에서 내용이 달라진 줄을 따로 모은다.
 * - 이미 들어간 경기: 같은 지문의 경기가 전적 제외가 아닌 상태로 있다(출처와 상관없이).
 * - 바뀐 줄: 같은 출처·같은 자리 열쇠의 이전 경기가 있고, 그 이전 경기의 지문이 지금 표에 없다.
 */
export function classifyImport<T extends Fingerprinted>(
  matches: readonly T[],
  existing: readonly ExistingImport[],
  sourceKey: string | null,
): ImportClassification<T> {
  const active = new Set(existing.filter((e) => e.state !== "excluded").map((e) => e.fingerprint));
  const excluded = new Set(existing.filter((e) => e.state === "excluded").map((e) => e.fingerprint));
  const current = new Set(matches.map((m) => m.fingerprint));
  const orphanByRow = new Map<string, ExistingImport>();
  let missing = 0;
  if (sourceKey !== null) {
    for (const e of existing) {
      if (e.sourceKey !== sourceKey || e.state === "excluded" || current.has(e.fingerprint)) continue;
      missing += 1;
      if (e.rowKey !== null && !orphanByRow.has(e.rowKey)) orphanByRow.set(e.rowKey, e);
    }
  }
  const out: ImportClassification<T> = { fresh: [], already: [], changed: [], wasExcluded: 0, missing: 0 };
  for (const m of matches) {
    if (active.has(m.fingerprint)) {
      out.already.push(m);
      continue;
    }
    const previous = m.rowKey === undefined ? undefined : orphanByRow.get(m.rowKey);
    if (previous && m.rowKey !== undefined) {
      orphanByRow.delete(m.rowKey);
      out.changed.push({ match: m, previous });
      missing -= 1;
      continue;
    }
    if (excluded.has(m.fingerprint)) out.wasExcluded += 1;
    out.fresh.push(m);
  }
  out.missing = missing;
  return out;
}

/* ------------------------------------------------------------------ */
/* 서버로 보낼 경기                                                       */
/* ------------------------------------------------------------------ */

export type SheetSideMode = "unknown" | "a-blue" | "column";

export interface SheetImportPayload {
  playedAt: string;
  roster: RosterEntry[];
  winnerTeam: Team;
  winnerSide: Side;
  fingerprint: string;
  rowKey: string;
}

/**
 * 읽은 경기를 서버로 보낼 경기로 바꾼다.
 * 시각이 있으면 모임 시간대의 그 시각, 없으면 그날 정오에 같은 날 순서만큼 1초씩 더해 표 순서를 지킨다.
 */
export function toSheetPayload(
  matches: readonly SheetMatch[],
  idOfName: (name: string) => string,
  sideMode: SheetSideMode,
  timeZone: string,
): SheetImportPayload[] {
  const times = playedAtTimes(matches, timeZone);
  return matches.map((m, i) => {
    const playedAt = times[i]!;
    const teamASide: "blue" | "red" | null =
      sideMode === "a-blue" ? "blue" : sideMode === "column" ? m.sideA : null;
    const winnerSide: Side =
      teamASide === null ? "unknown" : m.winner === "A" ? teamASide : teamASide === "blue" ? "red" : "blue";
    const entry = (p: SheetPlayer, team: Team): RosterEntry => ({
      participantId: idOfName(p.name),
      team,
      position: p.position,
    });
    return {
      playedAt,
      roster: [...m.teamA.map((p) => entry(p, "A")), ...m.teamB.map((p) => entry(p, "B"))],
      winnerTeam: m.winner,
      winnerSide,
      fingerprint: m.fingerprint,
      rowKey: m.rowKey,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 가로로 긴 표(기존 사이트 v1의 "RAW DATA기입" 탭)                          */
/* ------------------------------------------------------------------ */
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
    .replace(/ /g, " ")
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

function columnName(index: number): string {
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
function parseAcross(
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
