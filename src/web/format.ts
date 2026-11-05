import type { Draft } from "../shared/draft";
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
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDate(iso: string | null | undefined, timeZone = "Asia/Seoul"): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    month: "long",
    day: "numeric",
  }).format(new Date(iso));
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
  const side = sideOfTeam(match.winnerTeam, match.teamASide);
  return `팀 ${match.winnerTeam} 승 · ${SIDE_LABEL[side ?? "unknown"]}`;
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

/** 승률 색 구간을 적용하기 시작하는 경기 수. 이보다 적으면 우연일 수 있어 색을 입히지 않는다. */
const RATE_TIER_MIN_GAMES = 5;

/**
 * 승률 구간의 클래스 이름. 디자인 키트의 평점 4단계 색을 승률에 옮긴 것이다:
 * 50% 미만 회색, 50% 이상 초록, 55% 이상 파랑, 65% 이상 금색.
 */
export function rateTier(wins: number, games: number): string {
  if (games < RATE_TIER_MIN_GAMES) return "rate";
  const rate = (wins / games) * 100;
  if (rate >= 65) return "rate rate-god";
  if (rate >= 55) return "rate rate-great";
  if (rate >= 50) return "rate rate-good";
  return "rate rate-normal";
}

/**
 * 명단 텍스트(docs/P1 후보 C). 복사한 시점의 내용이며 끝에 기준 시각을 붙인다.
 * 진영이 확인되지 않았으면 팀 A·B로만 쓴다. 실력 그룹은 넣지 않는다.
 */
export function matchRosterText(snapshot: Snapshot, match: MatchView, link: string | null): string {
  const nameOf = nameMap(snapshot);
  const lines = [`${snapshot.group.name} · ${match.matchNo}경기 · ${STATE_LABEL[match.state]}`];
  for (const team of ["A", "B"] as const) {
    const side = sideOfTeam(team, match.teamASide);
    const sideText = side && side !== "unknown" ? ` (${SIDE_LABEL[side]})` : "";
    lines.push("", `${TEAM_MARK[team]} 팀 ${team}${sideText}`);
    for (const entry of teamRoster(match, team)) {
      const position = entry.position ? POSITION_LABEL[entry.position] : "-";
      lines.push(`${position} ${nameOf(entry.participantId)}`);
    }
  }
  lines.push("", `${formatTime(snapshot.serverTime, snapshot.group.timezone)} 기준`);
  if (link) lines.push(`최신 상태: ${link}`);
  return lines.join("\n");
}

/** 아직 시작하지 않은 편성의 명단 텍스트. 링크가 없다. */
export function draftRosterText(draft: Draft): string {
  const nameOf = new Map(draft.people.map((p) => [p.key, p.name]));
  const lines = ["내전 편성 (아직 시작 전)"];
  for (const team of ["A", "B"] as const) {
    lines.push("", `${TEAM_MARK[team]} 팀 ${team}`);
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
