/**
 * 시리즈 묶음(migrations/0017)의 판정과 점수. 서버(넣을 수 있는지 검사)와 화면(점수 표시)이 같은 규칙을 쓴다.
 *
 * - 시리즈 점수는 "같은 사람들로 이뤄진 팀" 기준이다. 진영은 판마다 바뀔 수 있으므로 블루/레드나 팀 A/B가 아니라
 *   팀 구성(5명의 집합)으로 묶는다. 두 팀의 구성이 판마다 같아야 한 시리즈에 넣을 수 있다(자유 형식도 같다).
 * - 점수에는 결과가 확정된 판만 센다. 전적 제외·미진행 취소된 판은 빼고, 진행 중·결과 대기 판은 "진행 중"으로 둔다.
 * - 형식의 승수를 채운 뒤 더 넣는 것은 막지 않고 표시에 경고를 붙인다(overflow).
 * - 합치기 되돌리기·참가자 교체 정정처럼 넣은 뒤에 구성이 달라진 판은 점수에서 빼고 "구성 다름"으로 알린다.
 * 통계(승률·랭킹)는 지금처럼 판 단위로 센다. 여기의 점수는 보여 주기만 한다.
 */
import { isCounted } from "./stats";
import type { MatchView, RosterEntry, SeriesFormat, SeriesView, Team } from "./types";

export const SERIES_FORMAT_LABEL: Record<SeriesFormat, string> = {
  bo3: "3판 2선승",
  bo5: "5판 3선승",
  free: "자유",
};

/** 이기면 시리즈가 끝나는 승수. 자유 형식은 없다. */
export const SERIES_WINS_NEEDED: Record<SeriesFormat, number | null> = {
  bo3: 2,
  bo5: 3,
  free: null,
};

/** 시리즈 이름 최대 글자 수(migrations/0017 CHECK와 같다). */
export const SERIES_NAME_MAX = 20;

/** 한 팀의 구성 열쇠: 참가자 ID를 정렬해 이은 것. */
export function teamKey(roster: readonly RosterEntry[], team: Team): string {
  return roster
    .filter((r) => r.team === team)
    .map((r) => r.participantId)
    .sort()
    .join(",");
}

/** 두 팀 구성 열쇠(A/B 순서와 무관). 같으면 같은 사람들끼리의 대결이다. */
export function compositionKey(roster: readonly RosterEntry[]): string {
  return [teamKey(roster, "A"), teamKey(roster, "B")].sort().join("|");
}

export function sameComposition(a: readonly RosterEntry[], b: readonly RosterEntry[]): boolean {
  return compositionKey(a) === compositionKey(b);
}

export type SeriesGameStatus = "counted" | "pending" | "dropped" | "mismatch";

export interface SeriesGame {
  match: MatchView;
  status: SeriesGameStatus;
  /** 이긴 쪽(0: 첫 판의 팀 A였던 사람들, 1: 그 상대). 센 판만. */
  winner: 0 | 1 | null;
}

export interface SeriesScore {
  series: SeriesView;
  /** 두 팀의 구성원(0: 첫 판의 팀 A였던 사람들). 판이 없으면 빈 목록. */
  teams: [string[], string[]];
  wins: [number, number];
  games: SeriesGame[];
  /** 형식의 승수를 먼저 채운 쪽. 자유 형식이거나 아직이면 null. */
  winner: 0 | 1 | null;
  /** 승수를 채운 뒤에도 센 판이 있다(형식보다 많이 함). */
  overflow: boolean;
  /** 구성이 달라 점수에서 뺀 판 수. */
  mismatched: number;
}

/** 경기 시각 → 경기 번호 순. 시리즈 안의 판 순서다. */
export function byPlayOrder(a: MatchView, b: MatchView): number {
  return a.playedAt.localeCompare(b.playedAt) || a.matchNo - b.matchNo;
}

/** 시리즈의 점수를 계산한다. matches는 모임의 경기 전체(또는 이 시리즈의 경기를 포함한 목록)다. */
export function seriesScore(series: SeriesView, matches: readonly MatchView[]): SeriesScore {
  const byId = new Map(matches.map((m) => [m.id, m]));
  const members = series.matchIds
    .map((id) => byId.get(id))
    .filter((m): m is MatchView => m !== undefined)
    .sort(byPlayOrder);
  const first = members[0];
  const teams: [string[], string[]] = first
    ? [teamKey(first.roster, "A").split(","), teamKey(first.roster, "B").split(",")]
    : [[], []];
  const refKey = first ? compositionKey(first.roster) : "";
  const sideZero = first ? teamKey(first.roster, "A") : "";
  const need = SERIES_WINS_NEEDED[series.format];
  const wins: [number, number] = [0, 0];
  let winner: 0 | 1 | null = null;
  let overflow = false;
  let mismatched = 0;
  const games: SeriesGame[] = members.map((match) => {
    if (match.state === "excluded" || match.state === "canceled") {
      return { match, status: "dropped", winner: null };
    }
    if (compositionKey(match.roster) !== refKey) {
      mismatched += 1;
      return { match, status: "mismatch", winner: null };
    }
    if (!isCounted(match)) return { match, status: "pending", winner: null };
    const winnerKey = teamKey(match.roster, match.winnerTeam!);
    const side: 0 | 1 = winnerKey === sideZero ? 0 : 1;
    if (winner !== null) overflow = true;
    wins[side] += 1;
    if (need !== null && winner === null && wins[side] >= need) winner = side;
    return { match, status: "counted", winner: side };
  });
  return { series, teams, wins, games, winner, overflow, mismatched };
}

/** 시리즈 이름(없으면 "시리즈"). */
export function seriesTitle(series: SeriesView): string {
  return series.name ?? "시리즈";
}

/**
 * 시리즈 한 줄 요약: "결승 · 3판 2선승 · 2:1". 점수는 첫 판의 팀 A였던 사람들 쪽이 앞이다.
 */
export function seriesLine(score: SeriesScore): string {
  return `${seriesTitle(score.series)} · ${SERIES_FORMAT_LABEL[score.series.format]} · ${score.wins[0]}:${score.wins[1]}`;
}

/**
 * 시리즈의 팀 이름: 구성원 중 이름 순으로 맨 앞 사람 + "팀"(예: "가람팀").
 * 두 팀의 이름이 같아지면(같은 이름의 보관된 사람 등) "팀 1"/"팀 2"로 쓴다.
 */
export function seriesTeamNames(
  teams: readonly [readonly string[], readonly string[]],
  nameOf: (id: string) => string,
): [string, string] {
  const lead = (ids: readonly string[]) =>
    [...ids].map(nameOf).sort((a, b) => a.localeCompare(b, "ko"))[0] ?? "";
  const a = lead(teams[0]);
  const b = lead(teams[1]);
  if (a === "" || b === "" || a === b) return ["팀 1", "팀 2"];
  return [`${a}팀`, `${b}팀`];
}

/** 경기 ID → 그 경기가 속한 시리즈. */
export function seriesIndex(series: readonly SeriesView[] | undefined): Map<string, SeriesView> {
  const index = new Map<string, SeriesView>();
  for (const s of series ?? []) for (const id of s.matchIds) index.set(id, s);
  return index;
}

/** 시리즈의 기준 판(첫 판). 새 판은 이 판과 구성이 같아야 넣을 수 있다. */
export function seriesReference(series: SeriesView, matches: readonly MatchView[]): MatchView | null {
  const byId = new Map(matches.map((m) => [m.id, m]));
  return (
    series.matchIds
      .map((id) => byId.get(id))
      .filter((m): m is MatchView => m !== undefined)
      .sort(byPlayOrder)[0] ?? null
  );
}

/** 구성이 달라 넣을 수 없을 때의 안내(서버 오류 문구와 같다). */
export const SERIES_TEAMS_DIFFER_TEXT =
  "두 팀의 5명 구성이 시리즈의 다른 판과 달라서 같은 시리즈에 넣을 수 없어요. 진영은 달라도 되지만 같은 사람들로 이뤄진 팀이어야 해요.";
