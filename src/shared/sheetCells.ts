/**
 * 시트·붙여 넣은 표의 칸 하나를 값으로 읽는다(라인·팀·승패·진영·시각·날짜). 못 읽으면 null.
 * 열 자동 추정(sheetMapping.ts)은 이 함수들로 칸의 모양을 보고, 표 읽기(sheetTable.ts parseSheet)는 실제 값을 읽는다.
 * 받는 표기를 늘릴 때는 shapeOf(sheetMapping.ts)가 그 칸을 다른 모양으로 오인하지 않는지 test/sheet-import.test.ts로 본다.
 */
import type { Position, Team } from "./types";

export function norm(cell: string): string {
  return cell.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}

export const LANE_WORDS: Record<string, Position> = {};
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

/** 26.11.05, 26-11-05처럼 연도가 두 자리인 날짜. */
const TWO_DIGIT_YEAR = /^(\d{2})\s*[-.]\s*(\d{1,2})\s*[-.]\s*(\d{1,2})\.?(?: (.+))?$/;

/** 날짜 칸 글 정리: 공백을 하나로, 요일((목), (Thu), 목요일)을 뗀다. */
function cleanDateText(cell: string): string {
  return cell
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\((?:[월화수목금토일]|mon|tue|wed|thu|fri|sat|sun)[a-z]*\)/i, "")
    .replace(/\s*[월화수목금토일]요일/, "")
    .trim();
}

/** 날짜 칸의 연도가 두 자리면 그 두 자리. 아니면 undefined. */
export function twoDigitYearOf(cell: string): string | undefined {
  return TWO_DIGIT_YEAR.exec(cleanDateText(cell))?.[1];
}

/**
 * 날짜 표기를 읽는다. 받는 모양:
 * 2026-11-05, 2026.11.5, 2026. 11. 5(구글 시트 한국어 표시), 2026/11/05, 2026년 11월 5일,
 * 11/5/2026(구글 시트 영어 표시), 26.11.05, 26-11-05, 11/5, 11.5, 11월 5일, 뒤의 요일 "(목)",
 * 날짜 뒤의 시각 "2026. 11. 5 오후 8:30:00", "2026-11-05 20:30".
 */
export function parseDateCell(cell: string): DateCell | null {
  const text = cleanDateText(cell);
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
  m = TWO_DIGIT_YEAR.exec(text);
  // 두 자리 연도는 20xx로 읽는다. 그 해가 내년보다 뒤면(예: "99.1.1" → 2099) 표 읽기(parseSheet)가 틀린 줄로 알린다.
  if (m) return finish(2000 + Number(m[1]), Number(m[2]), Number(m[3]), m[4]);
  m = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?(?: (.+))?$/.exec(text);
  if (m) return finish(null, Number(m[1]), Number(m[2]), m[3]);
  return null;
}

export function isoDate(year: number, month: number, day: number): string | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
}
