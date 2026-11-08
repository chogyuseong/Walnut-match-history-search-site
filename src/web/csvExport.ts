import { toCsv, type CsvValue } from "../shared/csv";
import { localDate, safeTimeZone, type PersonRecord } from "../shared/stats";
import { POSITIONS, type MatchView, type Snapshot, type Team } from "../shared/types";
import { knownSideOf, nameMap, POSITION_LABEL, STATE_LABEL, teamName, type ShownStanding } from "./format";

/**
 * 기록·랭킹·개인 참여 경기를 CSV로 내려받는다. 운영자와 조회 링크가 같은 함수를 쓴다.
 * 화면에 받은 스냅숏(공개 응답이면 공개 정보)만 쓰며, 티어(실력 그룹)·계정·참가자 ID는 넣지 않는다.
 *
 * 경기 열은 늘 같다: "팀1_탑"…"팀1_서폿", "팀2_탑"…"팀2_서폿".
 * 진영이 정해진 경기는 팀1이 블루팀, 팀2가 레드팀이다. 진영을 모르면 팀1이 팀 A, 팀2가 팀 B이고 비고에 "진영 미상"을 적는다.
 */

const TEAM_COLUMNS = ["팀1", "팀2"] as const;

/** 경기 CSV의 머리 줄(본인 열 없는 기본). */
export const MATCH_CSV_HEADER: readonly string[] = [
  "경기 번호",
  "날짜·시각",
  "상태",
  ...TEAM_COLUMNS.flatMap((t) => POSITIONS.map((p) => `${t}_${POSITION_LABEL[p]}`)),
  "승리 팀",
  "비고",
  "메모",
];

/** 사람이 읽는 모임 시간대 날짜·시각: "2026-11-07 21:30". */
export function csvDateTime(iso: string, timeZone: string): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return `${localDate(iso, timeZone)} ${time}`;
}

/** 팀1(블루 또는 팀 A)·팀2(레드 또는 팀 B)가 각각 어느 팀인지. */
function teamOrder(match: MatchView): [Team, Team] {
  return knownSideOf("A", match.teamASide) === "red" ? ["B", "A"] : ["A", "B"];
}

/** 한 팀의 다섯 칸(탑~서폿). 포지션이 없는 사람은 빈 칸에 명단 순서대로 넣는다. */
function teamCells(match: MatchView, team: Team, nameOf: (id: string) => string): { cells: string[]; missing: boolean } {
  const cells: string[] = POSITIONS.map(() => "");
  const loose: string[] = [];
  for (const entry of match.roster.filter((r) => r.team === team)) {
    const index = entry.position ? POSITIONS.indexOf(entry.position) : -1;
    if (index >= 0 && cells[index] === "") cells[index] = nameOf(entry.participantId);
    else loose.push(nameOf(entry.participantId));
  }
  for (const name of loose) {
    const empty = cells.indexOf("");
    if (empty >= 0) cells[empty] = name;
  }
  return { cells, missing: loose.length > 0 };
}

function matchRow(match: MatchView, nameOf: (id: string) => string, timeZone: string): CsvValue[] {
  const [first, second] = teamOrder(match);
  const one = teamCells(match, first, nameOf);
  const two = teamCells(match, second, nameOf);
  const notes: string[] = [];
  if (!knownSideOf("A", match.teamASide)) notes.push("진영 미상");
  if (one.missing || two.missing) notes.push("포지션 기록 없음");
  const winner = match.state === "confirmed" && match.winnerTeam ? teamName(match.winnerTeam, match.teamASide) : "";
  return [
    match.matchNo,
    csvDateTime(match.playedAt, timeZone),
    STATE_LABEL[match.state],
    ...one.cells,
    ...two.cells,
    winner,
    notes.join(" · "),
    match.memo ?? "",
  ];
}

/** 경기 목록 CSV(기록 화면의 지금 범위·조건). 순서는 받은 그대로. */
export function matchesCsv(snapshot: Snapshot, matches: readonly MatchView[]): string {
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  return toCsv([MATCH_CSV_HEADER, ...matches.map((m) => matchRow(m, nameOf, tz))]);
}

/** 한 사람의 참여 경기 CSV. 경기 열 앞에 그 사람의 팀·라인·결과를 둔다. */
export function personMatchesCsv(snapshot: Snapshot, participantId: string, matches: readonly MatchView[]): string {
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const header = [...MATCH_CSV_HEADER.slice(0, 3), "본인 팀", "본인 라인", "본인 결과", ...MATCH_CSV_HEADER.slice(3)];
  const rows = matches.map((m) => {
    const base = matchRow(m, nameOf, tz);
    const me = m.roster.find((r) => r.participantId === participantId);
    const result =
      me && m.state === "confirmed" && m.winnerTeam ? (me.team === m.winnerTeam ? "승" : "패") : "";
    const mine: CsvValue[] = [
      me ? teamName(me.team, m.teamASide) : "",
      me?.position ? POSITION_LABEL[me.position] : "",
      result,
    ];
    return [...base.slice(0, 3), ...mine, ...base.slice(3)];
  });
  return toCsv([header, ...rows]);
}

/** 랭킹 CSV의 한 줄에 필요한 값. */
export interface RankingCsvRow extends PersonRecord {
  rank: number;
  name: string;
}

export const RANKING_CSV_HEADER: readonly string[] = [
  "순위",
  "이름",
  "경기",
  "승",
  "패",
  "승률(%)",
  "배치",
  "칭호",
  "MMR",
];

/**
 * 랭킹 CSV(지금 범위·라인·검색이 적용된 표). 배치·칭호·MMR은 화면과 같이 누적 기준.
 * ratings: 사람별 MMR(rating.ts, 소수). 반올림한 정수로 적고, 없는 사람은 빈 칸.
 */
export function rankingCsv(
  rows: readonly RankingCsvRow[],
  standing: ReadonlyMap<string, ShownStanding>,
  ratings: ReadonlyMap<string, number> = new Map(),
): string {
  return toCsv([
    RANKING_CSV_HEADER,
    ...rows.map((r) => {
      const s = standing.get(r.participantId);
      return [
        r.rank,
        r.name,
        r.games,
        r.wins,
        r.losses,
        r.games === 0 ? "" : Math.round((r.wins / r.games) * 100),
        s?.done ? "배치 완료" : "배치 중",
        s?.title ?? "",
        ratings.has(r.participantId) ? Math.round(ratings.get(r.participantId)!) : "",
      ];
    }),
  ]);
}

/** 파일 이름에 쓸 수 없는 글자(윈도우 기준)와 제어 문자를 지운다. */
function safeFilePart(text: string): string {
  // eslint-disable-next-line no-control-regex -- 파일 이름에 쓸 수 없는 제어 문자를 일부러 지운다.
  return text.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

/** "내전기록-모임이름-20261108.csv". parts는 모임 이름 뒤에 붙일 것(예: 사람 이름). 날짜는 모임 시간대의 오늘. */
export function csvFileName(
  prefix: string,
  snapshot: Snapshot,
  parts: readonly string[] = [],
  now: Date = new Date(),
): string {
  const date = localDate(now.toISOString(), snapshot.group.timezone).replace(/-/g, "");
  const pieces = [prefix, snapshot.group.name, ...parts].map(safeFilePart).filter((p) => p !== "");
  return `${[...pieces, date].join("-")}.csv`;
}

/** 글을 파일로 내려받는다(blob 주소 + a[download]. 모임 화면의 백업 내려받기와 같은 방식). */
export function downloadText(fileName: string, text: string, type = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // 내려받기가 시작될 시간을 준 뒤 주소를 풀어 준다.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
