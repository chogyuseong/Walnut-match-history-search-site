import { MAX_NAME_LENGTH, cleanName, nameKey } from "./names";
import { zonedTimeToUtc } from "./stats";
import { TEAMS, type Position, type RosterEntry, type Side, type Team } from "./types";

/**
 * 지난 경기 한 건 입력 폼(docs/P2 "지난 경기 입력").
 * 저장은 서버의 backfill 경로가 하며 세션·순환·진행 상태를 건드리지 않는다.
 * 이 파일은 폼 값 검사와 요청 만들기만 한다.
 */

/**
 * 아직 오지 않은 시각을 막을 때 봐주는 시계 오차(밀리초). 지난 경기 한 건 입력·표 일괄 입력·시트 가져오기가
 * 같은 값을 쓰고, 서버의 일괄 입력도 이 값으로 거절한다.
 */
export const FUTURE_TOLERANCE_MS = 60_000;

/** 진영 고르기: 미상 / 팀 A가 블루 / 팀 A가 레드. 미리 골라 두지 않는다. */
export type BackfillSide = "unknown" | "a-blue" | "a-red";

export interface BackfillSlot {
  name: string;
  /** 빈 문자열이면 포지션 없음. 지난 경기는 포지션이 선택 사항이다. */
  position: Position | "";
}

export interface BackfillForm {
  /** 모임 시간대 기준 YYYY-MM-DD. */
  date: string;
  /** 모임 시간대 기준 HH:mm. */
  time: string;
  teams: Record<Team, BackfillSlot[]>;
  winner: Team | null;
  side: BackfillSide | null;
}

export function emptyBackfillForm(date: string, time: string): BackfillForm {
  const five = () => Array.from({ length: 5 }, () => ({ name: "", position: "" as const }));
  return { date, time, teams: { A: five(), B: five() }, winner: null, side: null };
}

/** 승리 팀과 "팀 A의 진영"에서 서버가 받는 "승리 팀의 진영"을 구한다. */
export function winnerSideOf(winner: Team, side: BackfillSide): Side {
  if (side === "unknown") return "unknown";
  const teamA: Side = side === "a-blue" ? "blue" : "red";
  if (winner === "A") return teamA;
  return teamA === "blue" ? "red" : "blue";
}

/** 폼에 남은 문제. 비어 있으면 저장할 수 있다. */
export function backfillProblems(form: BackfillForm, timeZone: string, now: Date): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date) || !/^\d{2}:\d{2}$/.test(form.time)) {
    problems.push("날짜와 시각을 넣어 주세요.");
  } else if (Date.parse(zonedTimeToUtc(form.date, form.time, timeZone)) > now.getTime() + FUTURE_TOLERANCE_MS) {
    problems.push("아직 오지 않은 시각이에요. 이미 한 경기만 넣을 수 있어요.");
  }
  const all = TEAMS.flatMap((team) => form.teams[team].map((slot) => cleanName(slot.name)));
  const empty = all.filter((name) => name === "").length;
  if (empty > 0) problems.push(`이름이 빈 칸이 ${empty}개 있어요.`);
  const tooLong = all.filter((name) => [...name].length > MAX_NAME_LENGTH);
  if (tooLong.length > 0) problems.push(`이름은 ${MAX_NAME_LENGTH}자까지예요: ${tooLong.join(", ")}`);
  // 같은 이름(대소문자·공백 차이 무시)을 두 번 넣었는지. 이름마다 처음 적은 표기로 한 번씩 알린다.
  const firstByKey = new Map<string, string>();
  const repeated = new Set<string>();
  for (const name of all) {
    if (name === "") continue;
    const key = nameKey(name);
    if (firstByKey.has(key)) repeated.add(firstByKey.get(key)!);
    else firstByKey.set(key, name);
  }
  if (repeated.size > 0) problems.push(`같은 사람이 두 번 들어 있어요: ${[...repeated].join(", ")}`);
  for (const team of TEAMS) {
    const positions = form.teams[team].map((s) => s.position).filter((p) => p !== "");
    if (new Set(positions).size !== positions.length) {
      problems.push(`팀 ${team}에 같은 포지션이 두 번 있어요.`);
    }
  }
  if (form.winner === null) problems.push("이긴 팀을 골라 주세요.");
  if (form.side === null) problems.push("진영을 골라 주세요.");
  return problems;
}

/** 폼에 적힌 이름(정리한 것). 참가자 확인·생성 요청에 쓴다. */
export function backfillNames(form: BackfillForm): string[] {
  return TEAMS.flatMap((team) => form.teams[team].map((slot) => cleanName(slot.name)));
}

export interface BackfillRequest {
  playedAt: string;
  roster: RosterEntry[];
  winnerTeam: Team;
  winnerSide: Side;
}

/** 검사를 통과한 폼을 서버 요청으로 바꾼다. idOfName은 이름 → 참가자 ID다. */
export function backfillRequest(
  form: BackfillForm,
  timeZone: string,
  idOfName: (name: string) => string,
): BackfillRequest {
  if (form.winner === null || form.side === null) throw new Error("승리 팀과 진영이 필요합니다.");
  return {
    playedAt: zonedTimeToUtc(form.date, form.time, timeZone),
    roster: TEAMS.flatMap((team) =>
      form.teams[team].map((slot) => ({
        participantId: idOfName(cleanName(slot.name)),
        team,
        position: slot.position === "" ? null : slot.position,
      })),
    ),
    winnerTeam: form.winner,
    winnerSide: winnerSideOf(form.winner, form.side),
  };
}
