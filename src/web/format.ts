import type { Draft } from "../shared/draft";
import { dateTimeFormat, placementGamesOf, ratePercent, safeTimeZone, SMALL_SAMPLE } from "../shared/stats";
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

/** 순위 숫자를 색으로 강조하는 마지막 순위(그 아래는 흐린 글자). */
const RANK_EMPHASIS_PLACES = 10;

/**
 * 순위 숫자 클래스(2026-11-09 2단계: 색 띠 대신 숫자 색으로만 강조). 1위 포인트 색 · 2위 은 · 3위 동 ·
 * 4~10위 본문 · 11위부터 흐린 글자. quiet이면(배치 진행 중 등) 순위와 관계없이 흐린 글자다.
 */
export function rankClass(rank: number, quiet = false): string {
  if (quiet || rank > RANK_EMPHASIS_PLACES) return "rank rank-rest";
  if (rank <= 3) return `rank rank-${rank}`;
  return "rank rank-mid";
}

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
 * 팀 머리 글자에 칠할 진영 색. 진영을 아는 경기는 그 진영, 모르는 경기는 팀 A를 블루·B를 레드 색으로 칠한다
 * (사용자 요청 2026-11-12: 요약 화면의 "●A"/"■B"에도 진영 색). 이름은 teamName 규칙 그대로 "●A"/"■B"라 진영을 지어내지는 않는다.
 * 표의 블루 칸에 A, 레드 칸에 B를 놓는 규칙(Dashboard teamInColumn)과 같은 짝이다.
 */
export function sideColorOf(team: Team, teamASide: Side | null | undefined): "blue" | "red" {
  return knownSideOf(team, teamASide) ?? (team === "A" ? "blue" : "red");
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
  return dateTimeFormat("ko-KR", {
    timeZone: safeTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/**
 * 날짜 조각(연·월·일). 날짜만 있는 값("2026-07-01", 시즌 기간·입력칸)은 시간대 변환 없이 그대로 읽고,
 * 시각이 있는 값은 모임 시간대로 바꿔 읽는다.
 */
function dateParts(iso: string, timeZone: string): { y: number; m: number; d: number } {
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (plain) return { y: Number(plain[1]), m: Number(plain[2]), d: Number(plain[3]) };
  const parts = dateTimeFormat("en-US", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(iso));
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: pick("year"), m: pick("month"), d: pick("day") };
}

function thisYear(timeZone: string): number {
  return dateParts(new Date().toISOString(), timeZone).y;
}

/**
 * 날짜 표기(모든 화면 공통, 2026-11-08 통일): 올해는 "11월 7일", 올해가 아니면 "2025년 11월 7일".
 * 입력칸 값·파일 이름·CSV는 ISO("2026-07-01")를 그대로 쓴다.
 */
export function formatDate(iso: string | null | undefined, timeZone = "Asia/Seoul"): string {
  if (!iso) return "";
  const { y, m, d } = dateParts(iso, timeZone);
  return y === thisYear(timeZone) ? `${m}월 ${d}일` : `${y}년 ${m}월 ${d}일`;
}

/**
 * 기간 표기: "7월 1일 ~ 8월 31일". 두 날짜의 연도가 다르면 양쪽에 연도를 쓰고,
 * 같은 해지만 올해가 아니면 앞에만 연도를 쓴다("2025년 7월 1일 ~ 8월 31일"). 끝이 없으면 "7월 1일 ~".
 */
export function formatRange(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  timeZone = "Asia/Seoul",
): string {
  if (!startIso) return endIso ? `~ ${formatDate(endIso, timeZone)}` : "";
  if (!endIso) return `${formatDate(startIso, timeZone)} ~`;
  const a = dateParts(startIso, timeZone);
  const b = dateParts(endIso, timeZone);
  if (a.y !== b.y) return `${a.y}년 ${a.m}월 ${a.d}일 ~ ${b.y}년 ${b.m}월 ${b.d}일`;
  const head = a.y === thisYear(timeZone) ? "" : `${a.y}년 `;
  return `${head}${a.m}월 ${a.d}일 ~ ${b.m}월 ${b.d}일`;
}

/**
 * 모든 사람의 누적 배치·칭호. 검색·랭킹·개인 통계·그래프가 모두 이것 하나를 쓴다.
 * 범위가 적용되지 않은 모임 전체 경기로 계산하므로 범위 필터가 칭호를 바꾸지 않는다.
 */
export function standingsOf(snapshot: Snapshot): Map<string, ShownStanding> {
  const bands = titleBandsOf(snapshot.group.settings);
  const result = new Map<string, ShownStanding>();
  for (const [id, s] of standings(snapshot.matches, bands, placementGamesOf(snapshot.group.settings))) {
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
 * 승률 색 단계의 경계(%). 45~54%는 기준 구간(기본 색)이다.
 * - 높은 쪽: 55 이상 → 1단계, 60 이상 → 2, 65 이상 → 3, 70 이상 → 4.
 * - 낮은 쪽: 45 미만 → -1단계, 40 이하 → -2, 35 이하 → -3, 30 이하 → -4.
 * 정확히 55%는 높음(2026-11-12 사용자 결정: "55% 이상"), 정확히 45%는 기준 구간이다. 화면 색은 세 단뿐이라(styles.css .heat-*: 높음 강조색 · 기준 주요 글자 ·
 * 낮음 보조 글자) 1~4단계는 같은 색이다. 단계 수를 남긴 것은 시험·정렬 없는 비교(rate-colors e2e)가 단계 이름을 쓰기 때문이다.
 */
export const RATE_HEAT_HOT = [55, 60, 65, 70] as const;
export const RATE_HEAT_COLD = [45, 40, 35, 30] as const;

/** 승률 색 단계: -4(가장 낮음)~0(기준)~4(가장 높음). 경기가 적으면 null(색 없음). */
export type RateHeat = -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4;

/**
 * 승률 → 색 단계. 막대·고리·표 칸·숫자 글자가 모두 이 함수 하나를 쓴다.
 * 화면에 보이는 정수 승률(ratePercent)로 비교한다: 69.6%는 "70%"로 보이므로 4단계, 44.9%는 "45%"로 보이므로 기준 구간.
 * (예전에는 정확한 분수로 비교해 "70%"인데 3단계 색, "55%"인데 1단계 색처럼 숫자와 색이 어긋났다.)
 */
export function rateHeat(wins: number, games: number): RateHeat | null {
  if (games < RATE_HEAT_MIN_GAMES) return null;
  const pct = ratePercent(wins, games);
  const [h1, h2, h3, h4] = RATE_HEAT_HOT;
  const [c1, c2, c3, c4] = RATE_HEAT_COLD;
  if (pct >= h4) return 4;
  if (pct >= h3) return 3;
  if (pct >= h2) return 2;
  if (pct >= h1) return 1;
  if (pct <= c4) return -4;
  if (pct <= c3) return -3;
  if (pct <= c2) return -2;
  if (pct < c1) return -1;
  return 0;
}

/** 화면에 쓰는 승률 글("57%"). 경기가 없으면 "기록 없음". */
export function rateText(wins: number, games: number): string {
  return games === 0 ? "기록 없음" : `${ratePercent(wins, games)}%`;
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
 * 승률 여섯 칸 경계(사용자 요청 예외, CLAUDE.md 5절). rateHueClass(여섯 색)·peopleBarStep(골드 명도)이 같이 쓴다.
 * 40% 미만 · 40~44 · 45~49 · 50~54 · 55~59 · 60% 이상. 사람이 몰리는 40~60%를 5%씩 나눠 막대끼리 구별되게 했다.
 */
export const PEOPLE_BAR_STEPS = [40, 45, 50, 55, 60] as const;

/** 승률 여섯 칸 번호(1이 가장 낮음 ~ 6이 가장 높음). 경기가 적으면 null(색 없음). */
function rateStepOf(wins: number, games: number): number | null {
  if (games < RATE_HEAT_MIN_GAMES) return null;
  const pct = ratePercent(wins, games);
  return 1 + PEOPLE_BAR_STEPS.filter((edge) => pct >= edge).length;
}

/** 승률 고리·MMR 랭킹 막대의 골드 명도 칸(win-step-1~6). 경기가 적으면 색 없음. */
export function peopleBarStep(wins: number, games: number): string {
  const step = rateStepOf(wins, games);
  return step === null ? "" : `win-step-${step}`;
}

/**
 * 개인별·라인별 승률 막대와 숫자, 플레이어 × 라인 칸 숫자의 여섯 색(rate-hue-1~6, 2026-11-12 사용자 요청). 경계는 위와 같고, 칸마다 색 자체가
 * 다르다(분홍·주황·노랑·연두·초록·청록, 진영 뜻인 파랑·빨강은 쓰지 않는다). 경기가 적으면 색 없음.
 */
export function rateHueClass(wins: number, games: number): string {
  const step = rateStepOf(wins, games);
  return step === null ? "" : `rate-hue-${step}`;
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
