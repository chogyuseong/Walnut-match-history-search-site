import { normalizePriority, type Priority } from "./priority";
import { priorityWeightOf } from "./recommend";
import { isCounted, personRecords, PLACEMENT_GAMES_DEFAULT, SMALL_SAMPLE } from "./stats";
import { MAX_SKILL_GROUP, type GroupWeights, type MatchView, type ParticipantView } from "./types";

/**
 * 티어 자동 제안과 티어 점검(배정 화면 #/priority). 서버·저장 형식은 바꾸지 않고 스냅숏에서 매번 계산한다.
 * 집계 기준은 stats.ts와 같다: 결과 확정 경기만(전적 제외·취소·대기·진행 중은 세지 않음), 모임 전체 누적.
 */

/**
 * 승률 보정값 k: (승 + k/2) / (경기 + k). 표본이 적은 사람이 극단(0%·100%)으로 가지 않게 50% 쪽으로 당긴다.
 * 기본 배치 경기 수(10)와 같게 두어, 막 배치를 마친 사람은 실제 승률과 50%의 딱 중간이 되고
 * 경기가 쌓일수록 실제 승률에 가까워진다.
 */
export const SUGGEST_PRIOR_GAMES = 10;

/** 제안에 필요한 최소 인원(5등분이므로 티어마다 한 명은 있게). */
export const SUGGEST_MIN_PEOPLE = MAX_SKILL_GROUP;

export interface SuggestRow {
  participantId: string;
  name: string;
  games: number;
  wins: number;
  /** 지금 티어. */
  current: Priority;
  /** 제안 티어. 기록이 적거나(배치 경기 수 미만) 대상이 5명 미만이면 null. */
  suggested: Priority;
  /** 보정한 승률(0~1). */
  score: number;
  /** few-games: 배치 전(배치 경기 수 미만)이라 제안 없음. */
  status: "ok" | "few-games";
}

export interface SuggestResult {
  /** 대상(배치 완료 활성 참가자)이 5명 이상이라 제안을 냈는지. */
  ready: boolean;
  /** 배치 완료 활성 참가자 수. */
  eligible: number;
  /** 제안 대상은 보정 승률 높은 순, 그 뒤에 기록이 적은 사람(경기 많은 순 → 이름 순). */
  rows: SuggestRow[];
}

export function adjustedRate(wins: number, games: number, k = SUGGEST_PRIOR_GAMES): number {
  return (wins + k / 2) / (games + k);
}

/** 이름 비교는 기기 언어 설정과 무관하게 같은 순서가 되도록 코드 단위로 한다(결정성). */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 티어 제안. 대상: 활성(보관·합쳐짐 제외)이고 모임 전체 누적 확정 경기가 배치 경기 수(모임 설정, 기본 10) 이상인 사람.
 * 보정 승률 높은 순으로 줄 세워 5등분한다: i번째(0부터) 사람은 floor(i × 5 / n) + 1티어(2026-11-06 전에는 4등분).
 * 정렬 순서(동점 처리): 보정 승률 → 경기 수 많은 순 → 참가자 ID 순. 보정 승률이 똑같은 사람들은
 * 그 무리의 첫 사람 티어를 함께 받는다(같은 성적이면 같은 티어). 대상이 5명 미만이면 아무도 제안하지 않는다.
 * 승률만 본 참고값이다(라인·상대·최근 흐름은 보지 않는다).
 */
export function suggestPriorities(
  participants: readonly ParticipantView[],
  matches: readonly MatchView[],
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): SuggestResult {
  const records = personRecords(matches);
  const active = participants.filter((p) => p.status === "active" && !p.mergedInto);
  const rows: SuggestRow[] = active.map((p) => {
    const r = records.get(p.id);
    const games = r?.games ?? 0;
    const wins = r?.wins ?? 0;
    return {
      participantId: p.id,
      name: p.name,
      games,
      wins,
      current: normalizePriority(p.skillGroup),
      suggested: null,
      score: adjustedRate(wins, games),
      status: games >= placementGames ? "ok" : "few-games",
    };
  });
  const eligible = rows
    .filter((r) => r.status === "ok")
    .sort((a, b) => b.score - a.score || b.games - a.games || byText(a.participantId, b.participantId));
  const few = rows
    .filter((r) => r.status === "few-games")
    .sort((a, b) => b.games - a.games || byText(a.name, b.name) || byText(a.participantId, b.participantId));
  const ready = eligible.length >= SUGGEST_MIN_PEOPLE;
  if (ready) {
    const n = eligible.length;
    let tier: Priority = null;
    eligible.forEach((row, i) => {
      const prev = eligible[i - 1];
      const same = prev !== undefined && Math.abs(prev.score - row.score) < 1e-12;
      if (!same) tier = (Math.floor((i * MAX_SKILL_GROUP) / n) + 1) as Priority;
      row.suggested = tier;
    });
  }
  return { ready, eligible: eligible.length, rows: [...eligible, ...few] };
}

/** 제안을 적용하면 바뀌는 사람(제안이 있고 지금 티어와 다른 사람). */
export function changedSuggestions(result: SuggestResult): SuggestRow[] {
  return result.rows.filter((r) => r.suggested !== null && r.suggested !== r.current);
}

export interface BalanceCheck {
  /** 두 팀의 가중치 합이 달랐던 확정 경기 수. */
  uneven: number;
  /** 그중 합이 높은 팀이 이긴 경기 수. */
  higherWon: number;
  /** 합이 같았던 확정 경기 수(아무도 티어를 정하지 않은 경기 포함). */
  even: number;
  /** uneven이 5경기 미만이면 true(화면은 숫자 대신 "자료 적음"). */
  small: boolean;
}

/**
 * 편성 균형 사후 점검. 경기 당시의 티어는 저장하지 않으므로 **지금 티어**를 지난 확정 경기에 적용해 계산한다.
 * 가중치는 팀 추천과 같다(priorityWeightOf: 미지정은 그 경기 10명 중 지정된 사람 가중치의 중앙값).
 * 합 차는 팀 추천과 같이 소수 셋째 자리에서 반올림해 비교한다.
 */
export function balanceCheck(
  participants: readonly ParticipantView[],
  matches: readonly MatchView[],
  groupWeights: Readonly<GroupWeights>,
): BalanceCheck {
  const priorityOf = new Map(participants.map((p) => [p.id, normalizePriority(p.skillGroup)]));
  let uneven = 0;
  let higherWon = 0;
  let even = 0;
  for (const match of matches) {
    if (!isCounted(match)) continue;
    const people = match.roster.map((r) => ({ key: r.participantId, skillGroup: priorityOf.get(r.participantId) ?? null }));
    const weightOf = priorityWeightOf(people, groupWeights);
    const sum = (team: "A" | "B") =>
      match.roster
        .filter((r) => r.team === team)
        .reduce((s, r) => s + weightOf({ key: r.participantId, skillGroup: priorityOf.get(r.participantId) ?? null }), 0);
    const diff = Math.round((sum("A") - sum("B")) * 1000) / 1000;
    if (diff === 0) {
      even += 1;
      continue;
    }
    uneven += 1;
    const higher = diff > 0 ? "A" : "B";
    if (match.winnerTeam === higher) higherWon += 1;
  }
  return { uneven, higherWon, even, small: uneven < SMALL_SAMPLE };
}

export interface PriorityMismatch {
  /** far: 지금 티어와 제안 티어가 2단계 이상 다름. unset: 배치 완료인데 아직 티어를 안 정함. */
  kind: "far" | "unset";
  row: SuggestRow;
}

/** 티어와 성적이 어긋나는 사람. 제안 결과(suggestPriorities)에서 뽑는다. 제안 순서(성적 좋은 순)를 따른다. */
export function priorityMismatches(result: SuggestResult): PriorityMismatch[] {
  const list: PriorityMismatch[] = [];
  for (const row of result.rows) {
    if (row.suggested === null) continue;
    if (row.current === null) list.push({ kind: "unset", row });
    else if (Math.abs(row.current - row.suggested) >= 2) list.push({ kind: "far", row });
  }
  return list;
}
