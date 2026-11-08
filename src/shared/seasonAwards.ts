/**
 * 시즌 종료 요약과 시상. 서버·저장 없이 스냅숏에서 매번 계산한다(결정적: 같은 입력이면 같은 결과).
 *
 * - 범위: 시즌(끝났거나 진행 중) 또는 연도. 경기 수·승률은 결과 확정이고 전적 제외가 아닌 경기만 센다(isCounted).
 * - 시상 항목마다 근거 숫자를 함께 낸다. 동률이면 공동 수상, 표본 기준에 못 미치면 "해당 없음"(winners가 빈 목록).
 * - 놀리는 상(최저 승률·최다 패 등)은 만들지 않는다.
 * - 티어(skillGroup)·기피 라인·서포터 횟수 보정값은 쓰지 않는다(조회 링크에서도 보는 화면이라).
 *   "헌신상"은 그 범위의 확정 경기에서 서포터 포지션으로 뛴 판 수다(서포터 순환 기록이 아니다).
 */
import { byPlayOrder } from "./series";
import {
  isCounted,
  localDate,
  localYear,
  matchesInScope,
  ratePercent,
  roundRatio,
  scopeLabel,
  sideTotals,
  type Scope,
} from "./stats";
import { POSITIONS, type MatchView, type Position, type Snapshot } from "./types";

/** 최고 승률: 그 범위에서 이만큼 이상 뛴 사람만(랭킹의 "누적 50경기 이상" 묶음과 같게, 2026-11-08). */
export const AWARD_MIN_RATE_GAMES = 50;
/** 가장 많이 성장: 두 범위 모두 이만큼 이상 뛴 사람만(배치 판수와 같게). */
export const AWARD_MIN_GAMES = 10;
/** 라인별 최고 승률: 그 범위 총 경기가 AWARD_MIN_RATE_GAMES 이상인 사람 중, 그 라인으로 이만큼 이상 뛴 사람만. */
export const AWARD_MIN_LINE_GAMES = 5;
/** 최고의 듀오(같은 팀)·천적 관계(상대 팀): 함께·맞붙은 판이 이만큼 이상인 쌍만. */
export const AWARD_MIN_PAIR_GAMES = 5;
/** 최장 연승: 이 이상 이어져야 시상한다(1연승은 연승이 아니다). */
export const AWARD_MIN_STREAK = 2;

export type AwardKey =
  | "bestRate"
  | "mostWins"
  | "mostGames"
  | "longestStreak"
  | "lineBest"
  | "bestDuo"
  | "nemesis"
  | "mostImproved"
  | "mostSupport";

export interface AwardWinner {
  /** 한 사람(대부분) 또는 두 사람(듀오·천적: [이긴 쪽, 진 쪽]). */
  participantIds: string[];
  /** 근거 숫자 한 줄(예: "70% · 14승 6패"). */
  value: string;
}

export interface Award {
  key: AwardKey;
  /** 라인별 최고 승률만: 어느 라인. */
  position?: Position;
  title: string;
  /** 기준 설명(예: "10경기 이상 중 승률 1위"). */
  rule: string;
  /** 비어 있으면 해당 없음. 여럿이면 공동 수상(이름 순). */
  winners: AwardWinner[];
  /** 해당 없음일 때의 까닭. */
  none?: string;
}

export interface SeasonSummary {
  scope: Scope;
  label: string;
  /** 시즌이면 날짜 구간, 연도면 그해 1월 1일~12월 31일. */
  startsOn: string;
  endsOn: string;
  /** 끝나는 날이 오늘(모임 시간대) 이후면 진행 중. */
  ongoing: boolean;
  games: number;
  participants: number;
  /** 진영을 아는 경기만. */
  sides: { known: number; blueWins: number; redWins: number; unknown: number };
  /** 내전을 한 날 수(모임 시간대 날짜). */
  days: number;
  /** 가장 경기가 많았던 날(동률이면 모두, 날짜 순). */
  busiestDays: { date: string; games: number }[];
  awards: Award[];
  /** 가장 많이 성장의 비교 대상(직전 시즌 또는 직전 연도). 없으면 null(항목 생략). */
  previous: { label: string } | null;
}

interface Tally {
  games: number;
  wins: number;
}

/** 보이는 정수 승률(공용 ratePercent: 0.5%는 올림, 소수 오차 없음). */
const pct = (t: Tally) => ratePercent(t.wins, t.games);
const record = (t: Tally) => `${pct(t)}% · ${t.wins}승 ${t.games - t.wins}패`;
/**
 * 가장 많이 성장의 상승 폭 글("+3%p", after가 더 높을 때만 부른다).
 * 보이는 두 정수 승률의 차가 0 이상이면 그 차(화살표 양쪽 숫자와 맞게). 반올림 때문에 두 숫자가 같아
 * "+0%p"가 되면 실제 차를 소수 한 자리로("+0.5%p"), 그래도 0.0이면 "0.1 미만"으로 쓴다.
 */
function gainText(before: Tally, after: Tally): string {
  const shown = pct(after) - pct(before);
  if (shown > 0) return `+${shown}%p`;
  // 실제 차(%p) × 10 = 1000 × (aw·bg − bw·ag) / (ag·bg)
  const tenths = roundRatio(after.wins * before.games - before.wins * after.games, after.games * before.games, 1000);
  return tenths > 0 ? `+${(tenths / 10).toFixed(1)}%p` : "+0.1%p 미만";
}

/** 승률 a가 b보다 높으면 양수(분수끼리 정확히 비교). */
const compareRate = (a: Tally, b: Tally) => a.wins * b.games - b.wins * a.games;

/** 범위의 시작·끝 날짜. */
function rangeOf(snapshot: Snapshot, scope: Scope): { startsOn: string; endsOn: string } | null {
  if (scope.kind === "season") {
    const season = snapshot.seasons.find((s) => s.id === scope.seasonId);
    return season ? { startsOn: season.startsOn, endsOn: season.endsOn } : null;
  }
  if (scope.kind === "year") return { startsOn: `${scope.year}-01-01`, endsOn: `${scope.year}-12-31` };
  return null;
}

/** 직전 범위: 시즌이면 시작일이 바로 앞인 시즌, 연도면 앞 해(그해 경기가 있을 때만). */
function previousScope(snapshot: Snapshot, scope: Scope): Scope | null {
  if (scope.kind === "season") {
    const season = snapshot.seasons.find((s) => s.id === scope.seasonId);
    if (!season) return null;
    const before = snapshot.seasons
      .filter((s) => s.startsOn < season.startsOn)
      .sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
    return before ? { kind: "season", seasonId: before.id } : null;
  }
  if (scope.kind === "year") {
    const prev = scope.year - 1;
    const has = snapshot.matches.some(
      (m) => m.state !== "canceled" && localYear(m.playedAt, snapshot.group.timezone) === prev,
    );
    return has ? { kind: "year", year: prev } : null;
  }
  return null;
}

function bump(map: Map<string, Tally>, key: string, won: boolean): void {
  let t = map.get(key);
  if (!t) {
    t = { games: 0, wins: 0 };
    map.set(key, t);
  }
  t.games += 1;
  if (won) t.wins += 1;
}

function people(matches: readonly MatchView[]): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const m of matches) for (const r of m.roster) bump(out, r.participantId, r.team === m.winnerTeam);
  return out;
}

/**
 * 최대값을 가진 항목들(공동 수상). better(a, b) > 0이면 a가 낫다. 결과는 tieOrder 순.
 * 후보가 없으면 빈 목록.
 */
function top<T>(items: readonly T[], better: (a: T, b: T) => number, tieOrder: (a: T, b: T) => number): T[] {
  let best: T[] = [];
  for (const item of items) {
    if (best.length === 0) best = [item];
    else {
      const c = better(item, best[0]!);
      if (c > 0) best = [item];
      else if (c === 0) best.push(item);
    }
  }
  return best.sort(tieOrder);
}

export function seasonSummary(
  snapshot: Snapshot,
  scope: Scope,
  nameOf: (id: string) => string,
  now: Date = new Date(),
): SeasonSummary {
  const tz = snapshot.group.timezone;
  const range = rangeOf(snapshot, scope) ?? { startsOn: "", endsOn: "" };
  const today = localDate(now.toISOString(), tz);
  const counted = matchesInScope(snapshot, scope).filter(isCounted).sort(byPlayOrder);
  const byName = (a: string, b: string) => nameOf(a).localeCompare(nameOf(b), "ko") || a.localeCompare(b);
  const idsOrder = (a: { ids: string[] }, b: { ids: string[] }) => {
    for (let i = 0; i < Math.max(a.ids.length, b.ids.length); i++) {
      const c = byName(a.ids[i] ?? "", b.ids[i] ?? "");
      if (c !== 0) return c;
    }
    return 0;
  };

  // 요약
  const sides = sideTotals(counted);
  const perDay = new Map<string, number>();
  for (const m of counted) {
    const d = localDate(m.playedAt, tz);
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const maxDay = Math.max(0, ...perDay.values());
  const busiestDays = [...perDay.entries()]
    .filter(([, n]) => n === maxDay && n > 0)
    .map(([date, games]) => ({ date, games }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const tallies = people(counted);

  const awards: Award[] = [];
  type Row = { ids: string[]; t: Tally; n?: number };
  const rows: Row[] = [...tallies.entries()].map(([id, t]) => ({ ids: [id], t }));

  // 최고 승률
  {
    const eligible = rows.filter((r) => r.t.games >= AWARD_MIN_RATE_GAMES);
    const winners = top(eligible, (a, b) => compareRate(a.t, b.t), idsOrder);
    awards.push({
      key: "bestRate",
      title: "최고 승률",
      rule: `${AWARD_MIN_RATE_GAMES}경기 이상 뛴 사람 중 승률 1위`,
      winners: winners.map((r) => ({ participantIds: r.ids, value: `${record(r.t)} (${r.t.games}경기)` })),
      none: eligible.length === 0 ? `${AWARD_MIN_RATE_GAMES}경기 이상 뛴 사람이 없어요.` : undefined,
    });
  }
  // 최다 승
  {
    const eligible = rows.filter((r) => r.t.wins > 0);
    const winners = top(eligible, (a, b) => a.t.wins - b.t.wins, idsOrder);
    awards.push({
      key: "mostWins",
      title: "최다 승",
      rule: "가장 많이 이긴 사람",
      winners: winners.map((r) => ({ participantIds: r.ids, value: `${r.t.wins}승 (${r.t.games}경기)` })),
      none: eligible.length === 0 ? "이긴 경기가 없어요." : undefined,
    });
  }
  // 개근상(최다 참가)
  {
    const winners = top(rows, (a, b) => a.t.games - b.t.games, idsOrder);
    awards.push({
      key: "mostGames",
      title: "개근상",
      rule: "가장 많이 참가한 사람",
      winners: winners.map((r) => ({ participantIds: r.ids, value: `${r.t.games}경기 참가` })),
      none: rows.length === 0 ? "확정된 경기가 없어요." : undefined,
    });
  }
  // 최장 연승(범위 안의 경기 순서대로)
  {
    const run = new Map<string, number>();
    const longest = new Map<string, number>();
    for (const m of counted) {
      for (const r of m.roster) {
        const next = r.team === m.winnerTeam ? (run.get(r.participantId) ?? 0) + 1 : 0;
        run.set(r.participantId, next);
        longest.set(r.participantId, Math.max(longest.get(r.participantId) ?? 0, next));
      }
    }
    const eligible = [...longest.entries()]
      .filter(([, n]) => n >= AWARD_MIN_STREAK)
      .map(([id, n]) => ({ ids: [id], t: { games: 0, wins: 0 }, n }));
    const winners = top(eligible, (a, b) => a.n! - b.n!, idsOrder);
    awards.push({
      key: "longestStreak",
      title: "최장 연승",
      rule: `가장 길게 이어 이긴 사람(${AWARD_MIN_STREAK}연승 이상)`,
      winners: winners.map((r) => ({ participantIds: r.ids, value: `${r.n}연승` })),
      none: eligible.length === 0 ? `${AWARD_MIN_STREAK}연승 이상인 사람이 없어요.` : undefined,
    });
  }
  // 라인별 최고 승률
  for (const position of POSITIONS) {
    const line = new Map<string, Tally>();
    for (const m of counted) {
      for (const r of m.roster) if (r.position === position) bump(line, r.participantId, r.team === m.winnerTeam);
    }
    // 총 경기 기준은 최고 승률과 같다(2026-11-08). 라인 경기 기준은 표본이 너무 적은 라인을 거르는 용도.
    const eligible = [...line.entries()]
      .filter(([id, t]) => (tallies.get(id)?.games ?? 0) >= AWARD_MIN_RATE_GAMES && t.games >= AWARD_MIN_LINE_GAMES)
      .map(([id, t]) => ({ ids: [id], t }));
    const winners = top(eligible, (a, b) => compareRate(a.t, b.t), idsOrder);
    awards.push({
      key: "lineBest",
      position,
      title: "라인별 최고 승률",
      rule: `총 ${AWARD_MIN_RATE_GAMES}경기 이상 뛴 사람 중 그 라인 ${AWARD_MIN_LINE_GAMES}경기 이상인 사람의 승률 1위`,
      winners: winners.map((r) => ({ participantIds: r.ids, value: `${record(r.t)} (${r.t.games}경기)` })),
      none:
        eligible.length === 0
          ? `총 ${AWARD_MIN_RATE_GAMES}경기 이상이면서 이 라인으로 ${AWARD_MIN_LINE_GAMES}경기 이상 뛴 사람이 없어요.`
          : undefined,
    });
  }
  // 최고의 듀오(같은 팀)와 천적 관계(상대 팀)
  {
    const duo = new Map<string, Tally>();
    const versus = new Map<string, Tally>();
    for (const m of counted) {
      for (const a of m.roster) {
        for (const b of m.roster) {
          if (a.participantId === b.participantId) continue;
          const won = a.team === m.winnerTeam;
          if (a.team === b.team) {
            // 같은 쌍은 한 번만 센다(ID 순서가 앞인 쪽 기준).
            if (a.participantId < b.participantId) bump(duo, `${a.participantId}|${b.participantId}`, won);
          } else {
            bump(versus, `${a.participantId}|${b.participantId}`, won);
          }
        }
      }
    }
    const duoRows = [...duo.entries()]
      .filter(([, t]) => t.games >= AWARD_MIN_PAIR_GAMES)
      .map(([key, t]) => ({ ids: key.split("|").sort(byName), t }));
    const duoWinners = top(duoRows, (a, b) => compareRate(a.t, b.t), idsOrder);
    awards.push({
      key: "bestDuo",
      title: "최고의 듀오",
      rule: `같은 팀으로 ${AWARD_MIN_PAIR_GAMES}경기 이상 함께한 두 사람 중 승률 1위`,
      winners: duoWinners.map((r) => ({ participantIds: r.ids, value: `함께 ${record(r.t)} (${r.t.games}경기)` })),
      none: duoRows.length === 0 ? `같은 팀으로 ${AWARD_MIN_PAIR_GAMES}경기 이상 함께한 두 사람이 없어요.` : undefined,
    });
    // 천적: A가 B를 상대로 이긴 비율이 가장 높은 쌍(50% 초과만. 반반이면 천적이 아니다).
    const enough = [...versus.entries()].filter(([, t]) => t.games >= AWARD_MIN_PAIR_GAMES);
    const vsRows = enough
      .filter(([, t]) => t.wins * 2 > t.games)
      .map(([key, t]) => ({ ids: key.split("|"), t }));
    const vsWinners = top(vsRows, (a, b) => compareRate(a.t, b.t), idsOrder);
    awards.push({
      key: "nemesis",
      title: "천적 관계",
      rule: `상대 팀으로 ${AWARD_MIN_PAIR_GAMES}경기 이상 만난 두 사람 중 한쪽 승률이 가장 높은 쌍`,
      winners: vsWinners.map((r) => ({ participantIds: r.ids, value: `상대 전적 ${record(r.t)} (${r.t.games}경기)` })),
      none:
        enough.length === 0
          ? `상대 팀으로 ${AWARD_MIN_PAIR_GAMES}경기 이상 만난 두 사람이 없어요.`
          : vsRows.length === 0
            ? "한쪽이 더 많이 이긴 쌍이 없어요(모두 반반)."
            : undefined,
    });
  }
  // 가장 많이 성장(직전 범위가 있을 때만)
  const prevScope = previousScope(snapshot, scope);
  if (prevScope) {
    const prev = people(matchesInScope(snapshot, prevScope).filter(isCounted));
    const eligible = rows
      .filter((r) => r.t.games >= AWARD_MIN_GAMES)
      .map((r) => ({ ...r, before: prev.get(r.ids[0]!) }))
      .filter((r): r is Row & { before: Tally } => r.before !== undefined && r.before.games >= AWARD_MIN_GAMES);
    // 상승 폭 = 이번 승률 - 직전 승률(분수로 정확히). 오른 사람만.
    const gain = (r: Row & { before: Tally }) => r.t.wins * r.before.games - r.before.wins * r.t.games;
    const rising = eligible.filter((r) => gain(r) > 0);
    const winners = top(
      rising,
      (a, b) => gain(a) * (b.t.games * b.before.games) - gain(b) * (a.t.games * a.before.games),
      idsOrder,
    );
    const prevLabel = scopeLabel(snapshot, prevScope);
    awards.push({
      key: "mostImproved",
      title: "가장 많이 성장",
      rule: `${prevLabel} 대비 승률이 가장 많이 오른 사람(두 범위 모두 ${AWARD_MIN_GAMES}경기 이상)`,
      winners: winners.map((r) => ({
        participantIds: r.ids,
        value: `${pct(r.before)}% → ${pct(r.t)}% (${gainText(r.before, r.t)})`,
      })),
      none:
        eligible.length === 0
          ? `두 범위 모두 ${AWARD_MIN_GAMES}경기 이상 뛴 사람이 없어요.`
          : rising.length === 0
            ? `${prevLabel}보다 승률이 오른 사람이 없어요.`
            : undefined,
    });
  }
  // 헌신상(서포터 최다)
  {
    const support = new Map<string, number>();
    for (const m of counted) {
      for (const r of m.roster) {
        if (r.position === "support") support.set(r.participantId, (support.get(r.participantId) ?? 0) + 1);
      }
    }
    const eligible = [...support.entries()].map(([id, n]) => ({ ids: [id], t: { games: 0, wins: 0 }, n }));
    const winners = top(eligible, (a, b) => a.n - b.n, idsOrder);
    awards.push({
      key: "mostSupport",
      title: "헌신상",
      rule: "서포터로 가장 많이 뛴 사람",
      winners: winners.map((r) => ({ participantIds: r.ids, value: `서포터 ${r.n}경기` })),
      none: eligible.length === 0 ? "서포터 포지션 기록이 없어요." : undefined,
    });
  }

  for (const award of awards) if (award.none === undefined) delete award.none;

  return {
    scope,
    label: scopeLabel(snapshot, scope),
    startsOn: range.startsOn,
    endsOn: range.endsOn,
    ongoing: range.endsOn !== "" && range.endsOn >= today,
    games: counted.length,
    participants: tallies.size,
    sides,
    days: perDay.size,
    busiestDays,
    awards,
    previous: prevScope ? { label: scopeLabel(snapshot, prevScope) } : null,
  };
}

/** 공유용 글(텍스트 복사). 이름은 nameOf로 바꾼다. */
export function seasonSummaryText(summary: SeasonSummary, groupName: string, nameOf: (id: string) => string): string {
  const lines: string[] = [];
  lines.push(`[${groupName}] ${summary.label} 요약${summary.ongoing ? " (진행 중)" : ""}`);
  if (summary.startsOn) lines.push(`${summary.startsOn} ~ ${summary.endsOn}`);
  lines.push(`경기 ${summary.games} · 참가 ${summary.participants}명 · 내전 ${summary.days}일`);
  if (summary.sides.known > 0) {
    const blue = ratePercent(summary.sides.blueWins, summary.sides.known);
    lines.push(`블루 : 레드 승률 ${blue}% : ${100 - blue}% (진영 아는 ${summary.sides.known}경기)`);
  }
  if (summary.busiestDays.length > 0) {
    lines.push(
      `가장 많이 한 날: ${summary.busiestDays
        .slice(0, 5)
        .map((d) => d.date)
        .join(", ")}${summary.busiestDays.length > 5 ? ` 외 ${summary.busiestDays.length - 5}일` : ""} (${summary.busiestDays[0]!.games}경기)`,
    );
  }
  lines.push("");
  for (const award of summary.awards) {
    lines.push(`${awardTitle(award)}: ${awardWinnersText(award, nameOf)}`);
  }
  return lines.join("\n");
}

const LINE_NAME: Record<Position, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

/** 항목 제목. 라인별 최고 승률은 "탑 최고 승률"처럼 쓴다. */
export function awardTitle(award: Award): string {
  return award.position ? `${LINE_NAME[award.position]} 최고 승률` : award.title;
}

/** 수상자 이름 + 근거 숫자(공동 수상은 " / "로 잇는다). 해당 없음이면 "해당 없음". */
export function awardWinnersText(award: Award, nameOf: (id: string) => string): string {
  if (award.winners.length === 0) return "해당 없음";
  const joiner = award.key === "nemesis" ? " → " : " · ";
  return award.winners
    .map((w) => `${w.participantIds.map(nameOf).join(joiner)} ${w.value}`)
    .join(" / ") + (award.winners.length > 1 ? " (공동)" : "");
}
