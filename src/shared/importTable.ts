import { cleanName, MAX_NAME_LENGTH, nameKey } from "./names";
import { POSITIONS, type Position, type RosterEntry, type Side, type Team } from "./types";

/**
 * 표 일괄 입력: 시트에서 복사해 붙여 넣은 표를 지난 경기 목록으로 읽는다.
 *
 * 한 줄이 한 경기이고 열은 탭(또는 쉼표)으로 나눈다. 열 순서:
 *   날짜, A탑, A정글, A미드, A원딜, A서폿, B탑, B정글, B미드, B원딜, B서폿, 승리팀(A 또는 B)
 * 첫 줄이 제목 줄이면 건너뛴다.
 *
 * 이 형식은 기존 시트의 실제 열 구성을 확인하기 전에 임시로 정한 것이다.
 * 실제 형식이 다르면 이 파일의 읽는 부분만 바꾸면 된다.
 */
export const IMPORT_COLUMNS = [
  "날짜",
  "A탑",
  "A정글",
  "A미드",
  "A원딜",
  "A서폿",
  "B탑",
  "B정글",
  "B미드",
  "B원딜",
  "B서폿",
  "승리팀",
] as const;

export interface ImportRow {
  /** 붙여 넣은 글의 줄 번호(1부터). 오류 안내에 쓴다. */
  line: number;
  /** YYYY-MM-DD */
  date: string;
  /** 탑·정글·미드·원딜·서폿 순서의 이름 5개. */
  teamA: string[];
  teamB: string[];
  winner: Team;
}

export interface ImportError {
  line: number;
  message: string;
}

export interface ImportParse {
  rows: ImportRow[];
  errors: ImportError[];
  /** 표에 나온 이름(중복 제거, 처음 나온 표기). */
  names: string[];
}

function parseDate(cell: string): string | null {
  const match = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/.exec(cell.trim());
  if (!match) return null;
  const text = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return null;
  return text;
}

function parseWinner(cell: string): Team | null {
  const value = cell.replace(/\s+/g, "").toUpperCase();
  if (value === "A" || value === "A팀" || value === "팀A") return "A";
  if (value === "B" || value === "B팀" || value === "팀B") return "B";
  return null;
}

/** 붙여 넣은 표 전체를 읽는다. 오류가 하나라도 있으면 호출한 쪽이 저장을 막아야 한다. */
export function parseMatchTable(text: string): ImportParse {
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  const names = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let sawContent = false;

  lines.forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    const cells = (raw.includes("\t") ? raw.split("\t") : raw.split(",")).map((c) => c.trim());
    const isFirstContent = !sawContent;
    sawContent = true;
    // 첫 줄이 날짜로 시작하지 않으면 제목 줄로 보고 건너뛴다.
    if (isFirstContent && parseDate(cells[0] ?? "") === null) return;

    if (cells.length !== IMPORT_COLUMNS.length) {
      errors.push({
        line,
        message: `열이 ${cells.length}개예요. ${IMPORT_COLUMNS.length}개(${IMPORT_COLUMNS.join(", ")})여야 합니다.`,
      });
      return;
    }
    const date = parseDate(cells[0]!);
    if (date === null) {
      errors.push({ line, message: `날짜 '${cells[0]}'를 읽지 못했어요. 2026-10-31처럼 써 주세요.` });
      return;
    }
    const players = cells.slice(1, 11).map(cleanName);
    const empty = players.findIndex((name) => name === "");
    if (empty >= 0) {
      errors.push({ line, message: `${IMPORT_COLUMNS[empty + 1]} 칸이 비어 있어요.` });
      return;
    }
    const tooLong = players.find((name) => [...name].length > MAX_NAME_LENGTH);
    if (tooLong) {
      errors.push({ line, message: `'${tooLong}'는 ${MAX_NAME_LENGTH}자를 넘어요.` });
      return;
    }
    const seen = new Set<string>();
    const duplicate = players.find((name) => {
      const key = nameKey(name);
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (duplicate) {
      errors.push({ line, message: `'${duplicate}'가 한 경기에 두 번 있어요.` });
      return;
    }
    const winner = parseWinner(cells[11]!);
    if (winner === null) {
      errors.push({ line, message: `승리팀 '${cells[11]}'를 읽지 못했어요. A 또는 B로 써 주세요.` });
      return;
    }
    for (const name of players) {
      if (!names.has(nameKey(name))) names.set(nameKey(name), name);
    }
    rows.push({ line, date, teamA: players.slice(0, 5), teamB: players.slice(5), winner });
  });

  return { rows, errors, names: [...names.values()] };
}

/** 진영을 어떻게 넣을지. 사용자가 직접 고른다. */
export type ImportSideMode = "unknown" | "a-blue";

export interface ImportMatchPayload {
  playedAt: string;
  roster: RosterEntry[];
  winnerTeam: Team;
  winnerSide: Side;
}

/**
 * 읽은 줄을 서버로 보낼 경기로 바꾼다.
 * - unknown: 모든 경기를 진영 미상으로 넣는다. 개인 승패는 그대로이고 진영 통계에서만 빠진다.
 * - a-blue: 팀 A를 블루, 팀 B를 레드로 넣는다(기존 시트의 자리 기준 그대로).
 * 같은 날의 경기는 표에 적힌 순서를 유지하도록 시각을 1초씩 늦춘다.
 */
export function toImportMatches(
  rows: readonly ImportRow[],
  idOfName: (name: string) => string,
  sideMode: ImportSideMode,
): ImportMatchPayload[] {
  const perDay = new Map<string, number>();
  return rows.map((row) => {
    const order = perDay.get(row.date) ?? 0;
    perDay.set(row.date, order + 1);
    // 날짜만 있으므로 한국 시간 정오로 두고 순서만큼 초를 더한다.
    const playedAt = new Date(Date.parse(`${row.date}T12:00:00+09:00`) + order * 1000).toISOString();
    const entry = (name: string, team: Team, index: number): RosterEntry => ({
      participantId: idOfName(name),
      team,
      position: POSITIONS[index] as Position,
    });
    return {
      playedAt,
      roster: [
        ...row.teamA.map((name, i) => entry(name, "A", i)),
        ...row.teamB.map((name, i) => entry(name, "B", i)),
      ],
      winnerTeam: row.winner,
      winnerSide: sideMode === "unknown" ? "unknown" : row.winner === "A" ? "blue" : "red",
    };
  });
}
