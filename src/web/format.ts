import type { Draft } from "../shared/draft";
import { safeTimeZone, SMALL_SAMPLE } from "../shared/stats";
import { standings, titleBandsOf, titleGradeFor, type Standing, type TitleGrade } from "../shared/titles";
import {
  POSITIONS,
  sideOfTeam,
  type MatchView,
  type Position,
  type Side,
  type Snapshot,
  type Team,
} from "../shared/types";

export const POSITION_LABEL: Record<Position, string> = {
  top: "탑",
  jungle: "정글",
  mid: "미드",
  adc: "원딜",
  support: "서폿",
};

export const SIDE_LABEL: Record<Side, string> = {
  blue: "블루",
  red: "레드",
  unknown: "진영 미상",
};

/** 팀은 색이 아니라 기호와 글자로 구분한다. */
export const TEAM_MARK: Record<Team, string> = { A: "●", B: "■" };

/** 팀의 진영이 정해져 있으면 "blue"/"red", 모르면(진영 미정·미상) null. */
export function knownSideOf(team: Team, teamASide: Side | null | undefined): "blue" | "red" | null {
  const side = sideOfTeam(team, teamASide ?? null);
  return side === "blue" || side === "red" ? side : null;
}

/**
 * 팀 이름 규칙(모든 화면 공통). 진영이 정해져 있으면 "블루팀"/"레드팀", 모르면 "팀 A"/"팀 B".
 * 좌우(A가 왼쪽·위)는 바꾸지 않는다: A가 레드인 경기는 왼쪽 팀이 "레드팀"이다.
 */
export function teamName(team: Team, teamASide: Side | null | undefined): string {
  const side = knownSideOf(team, teamASide);
  if (side === "blue") return "블루팀";
  if (side === "red") return "레드팀";
  return `팀 ${team}`;
}

/** 팀 상자 클래스. 진영이 정해져 있으면 그 색의 테두리(styles.css .team.side-blue/red). */
export function teamBoxClass(team: Team, teamASide: Side | null | undefined): string {
  const side = knownSideOf(team, teamASide);
  return side ? `team side-${side}` : "team";
}

/**
 * 받침에 맞춘 조사. pair는 [받침 있을 때, 없을 때]. 예: josa("블루팀", ["은", "는"]) → "은", josa("팀 A", ["은", "는"]) → "는".
 * 끝이 영문이면 읽는 소리로 본다(L·M·N·R은 받침이 있다고 본다).
 */
export function josa(word: string, pair: readonly [string, string]): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? pair[1] : pair[0];
  return /[LMNRlmnr]/.test(last) ? pair[0] : pair[1];
}

export const STATE_LABEL: Record<MatchView["state"], string> = {
  in_progress: "진행 중",
  awaiting_result: "결과 미입력",
  confirmed: "결과 확정",
  canceled: "미진행 취소",
  excluded: "전적 제외",
};

export function formatTime(iso: string | null | undefined, timeZone = "Asia/Seoul"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: safeTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone = "Asia/Seoul"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: safeTimeZone(timeZone),
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
}

/**
 * 모든 사람의 누적 배치·칭호. 검색·랭킹·개인 통계·그래프가 모두 이것 하나를 쓴다.
 * 범위가 적용되지 않은 모임 전체 경기로 계산하므로 범위 필터가 칭호를 바꾸지 않는다.
 */
export function standingsOf(snapshot: Snapshot): Map<string, ShownStanding> {
  const bands = titleBandsOf(snapshot.group.settings);
  const result = new Map<string, ShownStanding>();
  for (const [id, s] of standings(snapshot.matches, bands)) {
    result.set(id, { ...s, grade: s.title ? titleGradeFor(s.wins, s.games, bands) : null });
  }
  return result;
}

/** 화면에 보이는 누적 기준 상태. 칭호의 등급(색·엠블럼)을 함께 둔다(서버 응답 형식은 그대로). */
export interface ShownStanding extends Standing {
  grade: TitleGrade | null;
}

export function nameMap(snapshot: Snapshot | null): (id: string) => string {
  const map = new Map((snapshot?.participants ?? []).map((p) => [p.id, p.name]));
  return (id) => map.get(id) ?? "(알 수 없음)";
}

function positionIndex(position: Position | null): number {
  return position === null ? 99 : POSITIONS.indexOf(position);
}

export function teamRoster(match: MatchView, team: Team): MatchView["roster"] {
  return match.roster
    .filter((r) => r.team === team)
    .sort((a, b) => positionIndex(a.position) - positionIndex(b.position));
}

export function resultLine(match: MatchView): string {
  if (match.state !== "confirmed" || !match.winnerTeam) return STATE_LABEL[match.state];
  return winnerText(match.winnerTeam, match.teamASide);
}

/** "블루팀 승". 진영을 모르면 "팀 A 승 · 진영 미상". */
export function winnerText(winnerTeam: Team, teamASide: Side | null | undefined, verb = "승"): string {
  const name = teamName(winnerTeam, teamASide);
  return knownSideOf(winnerTeam, teamASide) ? `${name} ${verb}` : `${name} ${verb} · ${SIDE_LABEL.unknown}`;
}

/**
 * 경기 줄의 색조. 이긴 팀의 진영을 따른다.
 * 결과가 확정되지 않았거나 진영을 모르면 색을 입히지 않는다.
 */
export function matchTone(match: MatchView): "blue" | "red" | "none" {
  if (match.state !== "confirmed" || !match.winnerTeam) return "none";
  const side = sideOfTeam(match.winnerTeam, match.teamASide);
  return side === "blue" || side === "red" ? side : "none";
}

/** 승률 색 단계를 적용하기 시작하는 경기 수(SMALL_SAMPLE). 이보다 적으면 우연일 수 있어 색을 입히지 않는다. */
export const RATE_HEAT_MIN_GAMES = SMALL_SAMPLE;

/**
 * 승률 색 단계의 경계(%). 45~55%는 기준 구간(기본 색)이다.
 * - 높은 쪽: 55 초과 → 1단계, 60 이상 → 2, 65 이상 → 3, 70 이상 → 4(가장 붉다).
 * - 낮은 쪽: 45 미만 → -1단계, 40 이하 → -2, 35 이하 → -3, 30 이하 → -4(가장 가라앉는다).
 * 경계값 자체(정확히 45%·55%)는 기준 구간에 든다.
 */
export const RATE_HEAT_HOT = [55, 60, 65, 70] as const;
export const RATE_HEAT_COLD = [45, 40, 35, 30] as const;

/** 승률 색 단계: -4(가장 낮음)~0(기준)~4(가장 높음). 경기가 적으면 null(색 없음). */
export type RateHeat = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;

/**
 * 승률 → 색 단계. 막대·고리·표 칸·숫자 글자가 모두 이 함수 하나를 쓴다.
 * 소수 오차를 피하려고 승률을 나누지 않고 곱해서 비교한다.
 */
export function rateHeat(wins: number, games: number): RateHeat | null {
  if (games < RATE_HEAT_MIN_GAMES) return null;
  const pct = wins * 100;
  const [h1, h2, h3, h4] = RATE_HEAT_HOT;
  const [c1, c2, c3, c4] = RATE_HEAT_COLD;
  if (pct >= h4 * games) return 4;
  if (pct >= h3 * games) return 3;
  if (pct >= h2 * games) return 2;
  if (pct > h1 * games) return 1;
  if (pct <= c4 * games) return -4;
  if (pct <= c3 * games) return -3;
  if (pct <= c2 * games) return -2;
  if (pct < c1 * games) return -1;
  return 0;
}

/** 색 단계의 클래스 이름: heat-h1~h4(높음), heat-0(기준), heat-l1~l4(낮음). 경기가 적으면 빈 문자열. */
export function heatClass(wins: number, games: number): string {
  const heat = rateHeat(wins, games);
  if (heat === null) return "";
  return heat > 0 ? `heat-h${heat}` : heat < 0 ? `heat-l${-heat}` : "heat-0";
}

/**
 * 승률 숫자 글자의 클래스 이름. 막대와 같은 색 단계(heatClass)를 쓴다.
 * 기준 구간은 기본 글자 색, 경기가 적으면 색 없이 굵기만.
 */
export function rateTier(wins: number, games: number): string {
  const heat = heatClass(wins, games);
  return heat ? `rate ${heat}` : "rate";
}

/**
 * 명단 텍스트(docs/P1 후보 C). 복사한 시점의 내용이며 끝에 기준 시각을 붙인다.
 * 팀 이름은 teamName 규칙(진영이 정해졌으면 블루팀·레드팀, 아니면 팀 A·B). 실력 그룹은 넣지 않는다.
 */
export function matchRosterText(snapshot: Snapshot, match: MatchView, link: string | null): string {
  const nameOf = nameMap(snapshot);
  const lines = [`${snapshot.group.name} · ${match.matchNo}경기 · ${STATE_LABEL[match.state]}`];
  for (const team of ["A", "B"] as const) {
    lines.push("", `${TEAM_MARK[team]} ${teamName(team, match.teamASide)}`);
    for (const entry of teamRoster(match, team)) {
      const position = entry.position ? POSITION_LABEL[entry.position] : "-";
      lines.push(`${position} ${nameOf(entry.participantId)}`);
    }
  }
  lines.push("", `${formatTime(snapshot.serverTime, snapshot.group.timezone)} 기준`);
  if (link) lines.push(`최신 상태: ${link}`);
  return lines.join("\n");
}

/** 아직 시작하지 않은 편성의 명단 텍스트. 링크가 없다. 준비 화면은 팀 A가 항상 블루팀이다(실력 그룹은 넣지 않는다). */
export function draftRosterText(draft: Draft): string {
  const nameOf = new Map(draft.people.map((p) => [p.key, p.name]));
  const lines = ["내전 편성 (아직 시작 전)"];
  for (const team of ["A", "B"] as const) {
    lines.push("", `${TEAM_MARK[team]} ${teamName(team, draft.teamASide ?? "blue")}`);
    const members = draft.slots
      .filter((s) => s.team === team)
      .sort((a, b) => positionIndex(a.position) - positionIndex(b.position));
    for (const slot of members) {
      lines.push(`${POSITION_LABEL[slot.position]} ${nameOf.get(slot.key) ?? ""}`);
    }
  }
  lines.push("", `${formatTime(new Date().toISOString())} 기준`);
  return lines.join("\n");
}

/** 클립보드에 복사한다. 실패하면 false를 돌려주고 호출한 쪽이 글 상자를 보여준다. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function viewLink(token: string, suffix = "now"): string {
  return `${location.origin}/#/v/${token}/${suffix}`;
}

/**
 * 받침에 맞춘 목적격 조사("을"/"를"). 이름 끝이 한글이 아니면(영문·숫자) "을(를)"로 둔다.
 * 예: "용호" → "용호를", "김민" → "김민을".
 */
export function objectParticle(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? "를" : "을";
  if (/[0-9]/.test(last)) return "013678".includes(last) ? "을" : "를";
  return "을(를)";
}
