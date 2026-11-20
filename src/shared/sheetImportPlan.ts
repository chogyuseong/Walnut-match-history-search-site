/**
 * 읽은 경기 가운데 무엇을 넣을지 정하고(이미 들어간 경기·바뀐 줄·날짜가 몰린 날), 서버로 보낼 모양으로 바꾼다.
 * 시트 가져오기(SheetImport.tsx)·기존 사이트 가져오기(LegacyImport.tsx)·가져오기 입구(Import.tsx)가 쓴다.
 */
import { nameKey } from "./names";
import { nextFreeFingerprint, playedAtTimes } from "./sheetFingerprint";
import type { SheetMatch, SheetPlayer } from "./sheetTable";
import type { RosterEntry, Side, Team } from "./types";

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

/**
 * "이미 들어간 경기"로 분류됐지만 사용자가 한 번 더 한 경기라고 고른 줄(picked, 줄 번호)을 새 지문으로 바꿔 돌려준다.
 * 모임에 이미 있는 지문과 이번에 넣을 지문을 모두 피한 다음 순번을 쓴다(같은 내용의 줄을 둘 골라도 서로 다른 지문).
 * 시트 가져오기·기존 사이트 가져오기가 쓴다(src/web/importAgain.tsx 설명).
 */
export function promoteAgain<T extends SheetMatch>(
  classification: ImportClassification<T>,
  existing: readonly ExistingImport[],
  picked: ReadonlySet<number>,
): T[] {
  const taken = new Set([
    ...existing.map((e) => e.fingerprint),
    ...classification.fresh.map((m) => m.fingerprint),
    ...classification.changed.map((c) => c.match.fingerprint),
  ]);
  return classification.already
    .filter((m) => picked.has(m.line))
    .map((m) => {
      const fingerprint = nextFreeFingerprint(m, taken);
      taken.add(fingerprint);
      return { ...m, fingerprint };
    });
}

/**
 * 넣을 수 있는 경기(새 경기·바뀐 줄·다시 넣기로 고른 줄)에 나오는 이름만 남긴다. 건너뛸 경기에만 있는 이름은
 * 참가자 연결 칸에 띄우지도, 새로 만들지도 않는다.
 */
export function namesToLink<T extends SheetMatch>(
  names: readonly string[],
  classification: ImportClassification<T>,
  promoted: readonly T[],
): string[] {
  const used = new Set<string>();
  for (const m of [...classification.fresh, ...classification.changed.map((c) => c.match), ...promoted]) {
    for (const p of [...m.teamA, ...m.teamB]) used.add(nameKey(p.name));
  }
  return names.filter((n) => used.has(nameKey(n)));
}

/**
 * 하루에 이만큼 이상이면 날짜가 잘못 들어갔다고 의심한다. 실제 기록의 하루 최대는 11경기였고,
 * 날짜 칸이 빠져 앞 날짜를 이어받은 경우는 수십~백 경기 단위라 그 사이로 잡았다.
 */
export const CROWDED_DAY_MIN = 20;

export interface CrowdedDay {
  date: string;
  /** 그 날짜로 읽힌 경기 수(읽은 경기 전체 기준). */
  count: number;
  /** 그 날짜의 첫 경기(표 순서). 확인할 위치를 알려 주는 데 쓴다. */
  first: Pick<SheetMatch, "line" | "where">;
}

/**
 * 한 날짜에 경기가 몰린 날(날짜순). 가로로 긴 표는 빈 날짜 칸이 왼쪽 날짜를 이어받으므로(parseAcross, 의도된 동작)
 * 날짜 칸이 비면 경기 수십 개가 하루에 몰린다. 읽기를 막지 않고 미리보기에서 알리기만 한다. 표 모양과 무관하게 센다.
 */
export function crowdedDays(
  matches: readonly Pick<SheetMatch, "date" | "line" | "where">[],
  min = CROWDED_DAY_MIN,
): CrowdedDay[] {
  const byDate = new Map<string, CrowdedDay>();
  for (const m of matches) {
    const day = byDate.get(m.date);
    if (!day) byDate.set(m.date, { date: m.date, count: 1, first: m });
    else {
      day.count += 1;
      if (m.line < day.first.line) day.first = m;
    }
  }
  return [...byDate.values()].filter((d) => d.count >= min).sort((x, y) => x.date.localeCompare(y.date));
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
