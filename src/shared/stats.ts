import type { MatchView, Snapshot } from "./types";

/**
 * 통계는 저장하지 않고 유효 확정 경기에서 매번 계산한다(docs/P2 P2-11).
 * 유효 확정 경기 = 상태가 결과 확정인 경기. 대기·취소·제외 경기는 세지 않는다.
 */
export const PLACEMENT_GAMES = 10;

export function isCounted(match: MatchView): boolean {
  return match.state === "confirmed" && match.winnerTeam !== null;
}

export interface PersonRecord {
  participantId: string;
  games: number;
  wins: number;
  losses: number;
}

/** 주어진 경기들에서 사람별 승·패를 센다. 진영 미상 경기도 승패에는 들어간다. */
export function personRecords(matches: readonly MatchView[]): Map<string, PersonRecord> {
  const records = new Map<string, PersonRecord>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      let record = records.get(entry.participantId);
      if (!record) {
        record = { participantId: entry.participantId, games: 0, wins: 0, losses: 0 };
        records.set(entry.participantId, record);
      }
      record.games += 1;
      if (entry.team === match.winnerTeam) record.wins += 1;
      else record.losses += 1;
    }
  }
  return records;
}

export interface Placement {
  /** 모임 전체 누적 유효 확정 경기 수. 시즌·오늘 필터로 바뀌지 않는다. */
  games: number;
  done: boolean;
}

/** 배치 상태. 항상 모임 전체 누적 기준이다. */
export function placements(allMatches: readonly MatchView[]): Map<string, Placement> {
  const result = new Map<string, Placement>();
  for (const [id, record] of personRecords(allMatches)) {
    result.set(id, { games: record.games, done: record.games >= PLACEMENT_GAMES });
  }
  return result;
}

/** "오늘"은 가장 최근 세션이다. 열린 세션이 있으면 그것, 없으면 마지막으로 경기한 세션. */
export function latestSessionId(snapshot: Snapshot): string | null {
  if (snapshot.session) return snapshot.session.id;
  let latest: MatchView | null = null;
  for (const match of snapshot.matches) {
    if (match.sessionId === null || match.state === "canceled") continue;
    if (!latest || match.playedAt > latest.playedAt) latest = match;
  }
  return latest?.sessionId ?? null;
}

/** 오늘의 경기: 가장 최근 세션의 경기 중 취소되지 않은 것(확정·대기·진행 중·제외). */
export function todayMatches(snapshot: Snapshot): MatchView[] {
  const sessionId = latestSessionId(snapshot);
  if (!sessionId) return [];
  return snapshot.matches
    .filter((m) => m.sessionId === sessionId && m.state !== "canceled")
    .sort((a, b) => a.matchNo - b.matchNo);
}

/** 주어진 시각의 모임 표시 시간대 날짜(YYYY-MM-DD). */
export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

export type Scope = { kind: "all" } | { kind: "today" } | { kind: "season"; seasonId: string };

/**
 * 범위(전체·시즌·오늘)에 속하는 경기. 취소된 경기는 어느 범위에도 넣지 않는다.
 * 배치와 칭호는 이 필터를 거치지 않고 항상 전체 누적으로 계산한다.
 */
export function matchesInScope(snapshot: Snapshot, scope: Scope): MatchView[] {
  if (scope.kind === "today") return todayMatches(snapshot);
  const visible = snapshot.matches.filter((m) => m.state !== "canceled");
  if (scope.kind === "all") return visible;
  const season = snapshot.seasons.find((s) => s.id === scope.seasonId);
  if (!season) return [];
  return visible.filter((m) => {
    const date = localDate(m.playedAt, snapshot.group.timezone);
    return date >= season.startsOn && date <= season.endsOn;
  });
}

/** 적은 표본 기준. 이보다 적으면 승률 옆에 "자료 적음"을 붙인다. */
export const SMALL_SAMPLE = 5;

export interface Tally {
  games: number;
  wins: number;
}

export interface PairTally extends Tally {
  participantId: string;
}

export interface PersonDetail {
  participantId: string;
  summary: PersonRecord;
  /** 범위 안에서 가장 최근 경기부터. 실제 집계한 경기 수는 games에 있다. */
  recent10: Tally;
  recent20: Tally;
  /** 포지션 기록이 있는 경기만. 기록이 없는 라인은 키가 없다(0%가 아니라 "기록 없음"). */
  byPosition: Partial<Record<string, Tally>>;
  positionUnknown: number;
  /** 진영을 아는 경기만. */
  bySide: { blue: Tally; red: Tally };
  sideUnknown: number;
  /** 현재 이어지고 있는 연승(양수) 또는 연패(음수). */
  currentStreak: number;
  longestWinStreak: number;
  longestLoseStreak: number;
  /** 같은 팀이었던 사람별 성적. 함께한 경기 수 많은 순. */
  synergy: PairTally[];
  /** 상대 팀이었던 사람별 성적(이 사람 기준 승). 만난 경기 수 많은 순. */
  versus: PairTally[];
  /** 참여한 유효 확정 경기. 최근 것부터. */
  matches: MatchView[];
}

function sortPairs(pairs: Map<string, Tally>, nameOf: (id: string) => string): PairTally[] {
  return [...pairs.entries()]
    .map(([participantId, tally]) => ({ participantId, ...tally }))
    .sort(
      (a, b) =>
        b.games - a.games ||
        nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
        a.participantId.localeCompare(b.participantId),
    );
}

/** 한 사람의 상세 통계. 넘겨받은 경기(범위가 이미 적용된 것) 안에서만 계산한다. */
export function personDetail(
  scoped: readonly MatchView[],
  participantId: string,
  nameOf: (id: string) => string,
): PersonDetail {
  const mine = scoped
    .filter((m) => isCounted(m) && m.roster.some((r) => r.participantId === participantId))
    .sort((a, b) => a.playedAt.localeCompare(b.playedAt) || a.matchNo - b.matchNo);

  const summary: PersonRecord = { participantId, games: 0, wins: 0, losses: 0 };
  const byPosition: Partial<Record<string, Tally>> = {};
  const bySide = { blue: { games: 0, wins: 0 }, red: { games: 0, wins: 0 } };
  const synergy = new Map<string, Tally>();
  const versus = new Map<string, Tally>();
  let positionUnknown = 0;
  let sideUnknown = 0;
  let run = 0;
  let longestWinStreak = 0;
  let longestLoseStreak = 0;
  const results: boolean[] = [];

  for (const match of mine) {
    const me = match.roster.find((r) => r.participantId === participantId)!;
    const won = me.team === match.winnerTeam;
    results.push(won);
    summary.games += 1;
    if (won) summary.wins += 1;
    else summary.losses += 1;

    if (me.position === null) {
      positionUnknown += 1;
    } else {
      const tally = (byPosition[me.position] ??= { games: 0, wins: 0 });
      tally.games += 1;
      if (won) tally.wins += 1;
    }

    const teamASide = match.teamASide;
    if (teamASide === "blue" || teamASide === "red") {
      const mySide = me.team === "A" ? teamASide : teamASide === "blue" ? "red" : "blue";
      bySide[mySide].games += 1;
      if (won) bySide[mySide].wins += 1;
    } else {
      sideUnknown += 1;
    }

    run = won ? (run > 0 ? run + 1 : 1) : run < 0 ? run - 1 : -1;
    longestWinStreak = Math.max(longestWinStreak, run);
    longestLoseStreak = Math.max(longestLoseStreak, -run);

    for (const other of match.roster) {
      if (other.participantId === participantId) continue;
      const target = other.team === me.team ? synergy : versus;
      let tally = target.get(other.participantId);
      if (!tally) {
        tally = { games: 0, wins: 0 };
        target.set(other.participantId, tally);
      }
      tally.games += 1;
      if (won) tally.wins += 1;
    }
  }

  const recent = (count: number): Tally => {
    const slice = results.slice(-count);
    return { games: slice.length, wins: slice.filter(Boolean).length };
  };

  return {
    participantId,
    summary,
    recent10: recent(10),
    recent20: recent(20),
    byPosition,
    positionUnknown,
    bySide,
    sideUnknown,
    currentStreak: run,
    longestWinStreak,
    longestLoseStreak,
    synergy: sortPairs(synergy, nameOf),
    versus: sortPairs(versus, nameOf),
    matches: [...mine].reverse(),
  };
}

/**
 * 사람별 승·패를 한 라인으로 좁혀 센다. 그 라인을 맡은 경기만 들어간다.
 * position이 null이면 라인 구분 없이 전체다.
 */
export function personRecordsByLine(
  matches: readonly MatchView[],
  position: string | null,
): Map<string, PersonRecord> {
  if (position === null) return personRecords(matches);
  const records = new Map<string, PersonRecord>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      if (entry.position !== position) continue;
      let record = records.get(entry.participantId);
      if (!record) {
        record = { participantId: entry.participantId, games: 0, wins: 0, losses: 0 };
        records.set(entry.participantId, record);
      }
      record.games += 1;
      if (entry.team === match.winnerTeam) record.wins += 1;
      else record.losses += 1;
    }
  }
  return records;
}

export interface SideTotals {
  /** 진영을 아는 경기 수. 블루와 레드의 경기 수는 같다. */
  known: number;
  blueWins: number;
  redWins: number;
  /** 진영 미상이라 뺀 경기 수. */
  unknown: number;
}

/** 진영별 누적 승패. 진영 미상 경기는 빼고 그 수를 함께 돌려준다. */
export function sideTotals(matches: readonly MatchView[]): SideTotals {
  const totals: SideTotals = { known: 0, blueWins: 0, redWins: 0, unknown: 0 };
  for (const match of matches) {
    if (!isCounted(match)) continue;
    if (match.teamASide !== "blue" && match.teamASide !== "red") {
      totals.unknown += 1;
      continue;
    }
    totals.known += 1;
    const blueTeam = match.teamASide === "blue" ? "A" : "B";
    if (match.winnerTeam === blueTeam) totals.blueWins += 1;
    else totals.redWins += 1;
  }
  return totals;
}

/** 플레이어 × 라인 표. 기록이 없는 칸은 키가 없다. */
export function playerLineMatrix(
  matches: readonly MatchView[],
): Map<string, Partial<Record<string, Tally>>> {
  const matrix = new Map<string, Partial<Record<string, Tally>>>();
  for (const match of matches) {
    if (!isCounted(match)) continue;
    for (const entry of match.roster) {
      if (entry.position === null) continue;
      let row = matrix.get(entry.participantId);
      if (!row) {
        row = {};
        matrix.set(entry.participantId, row);
      }
      const tally = (row[entry.position] ??= { games: 0, wins: 0 });
      tally.games += 1;
      if (entry.team === match.winnerTeam) tally.wins += 1;
    }
  }
  return matrix;
}

/**
 * 순위형 목록의 정렬: 배치 완료자를 먼저 두고 그 안에서 승률순.
 * 배치 여부는 범위와 무관하게 전체 누적 기준(placement)이다.
 * 범위 안에 경기가 없는 사람은 records에 없으므로 순위에 들어가지 않는다.
 */
export function sortRanking(
  records: PersonRecord[],
  placement: ReadonlyMap<string, Placement>,
  nameOf: (id: string) => string,
): PersonRecord[] {
  const sorted = sortByWinRate(records, nameOf);
  const done = (r: PersonRecord) => (placement.get(r.participantId)?.done ? 0 : 1);
  // sort는 안정 정렬이라 같은 묶음 안의 승률 순서가 유지된다.
  return sorted.sort((a, b) => done(a) - done(b));
}

/** 이름 검색: 완전 일치 → 앞부분 일치 → 포함 순. 배치 여부로 순서를 바꾸지 않는다. */
export function searchByName<T extends { name: string }>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  const rank = (name: string) => {
    const n = name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  return items
    .filter((item) => rank(item.name) < 3)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ko"));
}

/** 승률순 정렬. 동률은 경기 수 많은 순 → 이름 → 참가자 ID. */
export function sortByWinRate(
  records: PersonRecord[],
  nameOf: (id: string) => string,
): PersonRecord[] {
  const rate = (r: PersonRecord) => (r.games === 0 ? 0 : r.wins / r.games);
  return [...records].sort(
    (a, b) =>
      rate(b) - rate(a) ||
      b.games - a.games ||
      nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
      a.participantId.localeCompare(b.participantId),
  );
}
