/**
 * 다시 가져와도 같은 경기를 알아보는 지문과, 서버로 보낼 경기 시각·아직 오지 않은 경기 검사.
 * 시트 가져오기·붙여 넣기(importTable.ts)·기존 사이트 가져오기(legacy.ts)·서버(server/sheets.ts)가 함께 쓴다.
 * 지문 규칙을 바꾸면 이미 들어간 경기와 지문이 달라져 다시 가져올 때 중복이 생긴다. migrations/0007 설명 참고.
 */
import { FUTURE_TOLERANCE_MS } from "./backfill";
import { nameKey } from "./names";
import type { SheetMatch, SheetPlayer } from "./sheetTable";
import { zonedTimeToUtc } from "./stats";

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
 * 같은 내용(날짜·명단·결과)의 경기가 이미 들어가 있을 때, 이 경기를 "따로 한 경기"로 넣을 지문.
 * taken(이미 있는 지문들, 예: imports/fingerprints 응답)에 없는 가장 작은 순번(#1, #2, …)의 지문을 돌려준다.
 *
 * 지문은 내용만으로 만들어서 "같은 경기를 다시 붙여 넣음"과 "같은 날 같은 10명·같은 결과의 두 번째 경기만 따로
 * 붙여 넣음"을 구별할 수 없다. 그래서 fingerprinter가 자동으로 이 순번을 쓰지는 않는다(다시 붙여 넣을 때마다
 * 중복 경기가 생긴다). 화면이 "이미 들어간 경기"로 분류된 줄에 대해 사용자가 다른 경기라고 고를 때만 쓴다.
 */
export function nextFreeFingerprint(m: FingerprintInput, taken: ReadonlySet<string>): string {
  const base = fingerprintBase(m);
  for (let occurrence = 1; ; occurrence++) {
    const fp = `v1-${hash64(`${base}#${occurrence}`)}`;
    if (!taken.has(fp)) return fp;
  }
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
