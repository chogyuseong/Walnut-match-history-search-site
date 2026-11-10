/**
 * 챔피언 티어(2026-11-10). 운영자가 결과 입력·경기 상세에서 손으로 남긴 챔피언(RosterEntry.champion)만 모아
 * 챔피언별 승률·픽률·티어를 낸다. 게임 API에서 받은 전적이 아니라서 두 가지를 전제로 한다.
 * - 기록된 경기만 센다: 챔피언이 비어 있는 경기는 분모에도 넣지 않는다(입력률은 화면 머리에 따로 보인다).
 * - 표본이 작다: 한 모임의 한 챔피언은 많아야 수십 판이다. 날것의 승률로 줄을 세우면 2판 2승이 맨 위에 온다.
 *   그래서 승률을 50% 쪽으로 당겨(가상 판 수) 매기고, 최소 판 수 미만은 티어 없이 따로 둔다.
 * 밴율·카운터는 기록하지 않는 값이라 없다. 대신 그 챔피언을 주로 쓴 사람을 센다.
 */
import { championName } from "./champions";
import { isCounted, matchesInScope, type Scope } from "./stats";
import { POSITIONS, type MatchView, type Position, type Snapshot } from "./types";

/**
 * 승률을 당기는 가상 판 수. 50% 승률의 가상 경기 12판을 더한 것처럼 계산한다.
 * 12로 둔 근거: 3판 3승(60%)이 20판 13승(59.4%)과 비슷해지고, 픽률 몫이 더해지면 20판 13승이 위로 간다.
 * 줄이면 적게 한 챔피언이 쉽게 1티어가 되고, 늘리면 30판을 넘게 해도 3티어에서 잘 안 벗어난다.
 */
export const TIER_PRIOR_GAMES = 12;
/**
 * 픽률 몫. 점수 = 보정 승률 + 픽률 × 0.1. 픽률 10%가 1%p다. 많이 쓰이면서 이기는 챔피언을 조금 올리는 정도로만 둔다
 * (기록된 경기의 절반에 나온 챔피언도 5%p). 승률보다 세지 않게 해서 많이 쓰고 지는 챔피언이 1티어가 되지는 않는다.
 */
export const TIER_PICK_WEIGHT = 0.1;
/**
 * 티어 경계(점수, 0~1). 위에서부터 1~4티어의 하한이고 나머지는 5티어. 본전(50%)이 3티어 가운데쯤에 오게 했다.
 * 가상 12판 기준 보정 승률: 3판 3승 0.60(→ 판 수가 모자라 2티어, 아래 TIER_TOP_MIN_GAMES)·10판 7승 0.59 → 1티어,
 * 10판 6승 0.55 → 2티어, 3판 2승 0.53 → 2~3티어(픽률 몫에 따라),
 * 10판 5승 0.50 → 3티어, 3판 1승 0.47·10판 4승 0.45 → 4티어, 10판 3승 0.41·3판 0승 0.40 → 5티어. 여기에 픽률 몫이 더해진다.
 */
export const TIER_CUTS = [0.57, 0.535, 0.5, 0.45] as const;
/**
 * 1티어의 최소 판 수(2026-11-10). 가상 12판으로 당겨도 3판 3승(0.60)이 1티어 경계(0.57)를 넘어, 손으로 넣는 작은 표본에서
 * 몇 판 이긴 챔피언이 맨 위 등급을 받았다. 점수가 1티어여도 이 판 수 미만이면 2티어로 둔다(순위·점수는 그대로).
 * 10으로 둔 근거: 위 예시에서 1티어가 되는 가장 적은 기록이 10판 7승이다. 가상 판 수를 늘리는 대신 이렇게 한 까닭은
 * 가상 판 수를 늘리면 모든 점수가 50% 쪽으로 몰려 TIER_CUTS를 다시 잡아야 하고 아래 티어의 뜻까지 바뀌기 때문이다.
 */
export const TIER_TOP_MIN_GAMES = 10;
/** 티어를 매기는 최소 판 수. 이보다 적으면 "기록 부족" 묶음으로 따로 둔다. */
export const TIER_MIN_GAMES = 3;
/** 줄을 펼쳤을 때 보여 줄 최근 경기 수. */
const RECENT_MATCHES = 5;

export type Tier = 1 | 2 | 3 | 4 | 5;
/** 라인 필터. "all"은 라인과 상관없이 센다. */
export type LaneFilter = Position | "all";

export interface ChampionPlayer {
  participantId: string;
  games: number;
  wins: number;
}

export interface ChampionTierRow {
  key: string;
  /** 명단 칸 수(같은 경기 양 팀에 같은 챔피언이 기록됐으면 두 판). */
  games: number;
  wins: number;
  /** 이 챔피언이 나온 경기 수 ÷ 기록된 경기 수(0~1). */
  pickRate: number;
  /** 가상 판 수로 50% 쪽으로 당긴 승률(0~1). */
  adjustedRate: number;
  score: number;
  /** 최소 판 수 미만이면 null. */
  tier: Tier | null;
  /** 순위(1부터, 기본 순서 byScore). 기록 부족이면 null. */
  rank: number | null;
  /** 판 수가 많은 사람부터. */
  players: ChampionPlayer[];
  /** 라인별 판 수(라인 필터와 상관없이 범위 안 전체). 포지션 없이 기록된 판은 noLane. */
  lanes: { position: Position; games: number }[];
  noLane: number;
  /** 이 챔피언이 나온 경기, 최근 것부터 RECENT_MATCHES개. */
  recentMatchIds: string[];
  /**
   * recentMatchIds와 같은 순서의 결과. 그 경기에서 이 챔피언을 쓴 칸의 승패로 정한다(경기의 다른 칸이 아니라).
   * 양 팀이 같은 챔피언을 기록한 경기는 한쪽은 이기고 한쪽은 졌으므로 "split"이다.
   */
  recentResults: ("win" | "loss" | "split")[];
}

export interface ChampionTierResult {
  /** 티어가 매겨진 챔피언, 점수 순. */
  rows: ChampionTierRow[];
  /** 최소 판 수 미만, 판 수 많은 순. */
  few: ChampionTierRow[];
  /** 범위 안의 확정 경기 수(라인 필터와 상관없다). 입력률의 분모. */
  countedMatches: number;
  /** 그중 챔피언이 하나라도 기록된 경기 수. 입력률의 분자. */
  recordedMatches: number;
  /** 픽률의 분모: 라인 필터가 있으면 그 라인에 챔피언이 기록된 경기 수, 없으면 recordedMatches. */
  pickBase: number;
}

/** games를 넘기면 1티어에 최소 판 수(TIER_TOP_MIN_GAMES)를 적용한다. 점수 구간만 볼 때는 생략한다. */
export function tierOf(score: number, games = Number.POSITIVE_INFINITY): Tier {
  const index = TIER_CUTS.findIndex((cut) => score >= cut);
  const tier = (index === -1 ? 5 : index + 1) as Tier;
  return tier === 1 && games < TIER_TOP_MIN_GAMES ? 2 : tier;
}

/** 보정 승률과 점수. 화면 설명(도움말)과 테스트가 같은 식을 쓴다. */
export function tierScore(wins: number, games: number, pickRate: number): { adjustedRate: number; score: number } {
  const adjustedRate = (wins + TIER_PRIOR_GAMES / 2) / (games + TIER_PRIOR_GAMES);
  return { adjustedRate, score: adjustedRate + pickRate * TIER_PICK_WEIGHT };
}

/** 최근 경기가 앞에 오는 순서. 경기 번호가 기록 순서라 시각이 같아도 갈린다. */
function newestFirst(a: MatchView, b: MatchView): number {
  return b.playedAt.localeCompare(a.playedAt) || b.matchNo - a.matchNo;
}

interface Tally {
  games: number;
  wins: number;
  matchIds: Set<string>;
  players: Map<string, ChampionPlayer>;
  lanes: Map<Position | null, number>;
  /** 최근 경기마다 이 챔피언 칸의 승·패 수(같은 경기에 두 칸이면 둘 다 센다). */
  recent: { id: string; wins: number; losses: number }[];
}

export function championTiers(
  snapshot: Snapshot,
  options: { scope: Scope; lane: LaneFilter; minGames?: number },
): ChampionTierResult {
  const minGames = options.minGames ?? TIER_MIN_GAMES;
  const counted = matchesInScope(snapshot, options.scope).filter(isCounted).sort(newestFirst);
  const tallies = new Map<string, Tally>();
  let recordedMatches = 0;
  let pickBase = 0;

  for (const match of counted) {
    const recorded = match.roster.filter((r) => r.champion);
    if (recorded.length === 0) continue;
    recordedMatches += 1;
    const inLane = options.lane === "all" ? recorded : recorded.filter((r) => r.position === options.lane);
    if (inLane.length > 0) pickBase += 1;
    for (const entry of recorded) {
      const key = entry.champion!;
      let tally = tallies.get(key);
      if (!tally) {
        tally = { games: 0, wins: 0, matchIds: new Set(), players: new Map(), lanes: new Map(), recent: [] };
        tallies.set(key, tally);
      }
      // 라인 분포는 라인 필터를 거치지 않는다: 미드로 보고 있어도 "이 챔피언은 탑에서도 쓰였다"를 보여 준다.
      tally.lanes.set(entry.position, (tally.lanes.get(entry.position) ?? 0) + 1);
    }
    for (const entry of inLane) {
      const tally = tallies.get(entry.champion!)!;
      const won = entry.team === match.winnerTeam;
      tally.games += 1;
      if (won) tally.wins += 1;
      if (!tally.matchIds.has(match.id)) {
        tally.matchIds.add(match.id);
        if (tally.recent.length < RECENT_MATCHES) tally.recent.push({ id: match.id, wins: 0, losses: 0 });
      }
      // 경기는 최신순으로 한 번씩만 돌므로, 이 경기가 목록에 들어갔다면 마지막 항목이다.
      const last = tally.recent[tally.recent.length - 1];
      if (last?.id === match.id) {
        if (won) last.wins += 1;
        else last.losses += 1;
      }
      const player = tally.players.get(entry.participantId) ?? { participantId: entry.participantId, games: 0, wins: 0 };
      player.games += 1;
      if (won) player.wins += 1;
      tally.players.set(entry.participantId, player);
    }
  }

  const all: ChampionTierRow[] = [];
  for (const [key, tally] of tallies) {
    // 라인 필터로 보면 그 라인에서 한 번도 안 쓰인 챔피언은 빠진다.
    if (tally.games === 0) continue;
    const pickRate = pickBase === 0 ? 0 : tally.matchIds.size / pickBase;
    const { adjustedRate, score } = tierScore(tally.wins, tally.games, pickRate);
    all.push({
      key,
      games: tally.games,
      wins: tally.wins,
      pickRate,
      adjustedRate,
      score,
      tier: tally.games >= minGames ? tierOf(score, tally.games) : null,
      rank: null,
      players: [...tally.players.values()].sort(
        (a, b) => b.games - a.games || b.wins - a.wins || a.participantId.localeCompare(b.participantId),
      ),
      lanes: POSITIONS.flatMap((position) => {
        const games = tally.lanes.get(position) ?? 0;
        return games > 0 ? [{ position, games }] : [];
      }),
      noLane: tally.lanes.get(null) ?? 0,
      recentMatchIds: tally.recent.map((m) => m.id),
      recentResults: tally.recent.map((m) => (m.wins > 0 && m.losses > 0 ? "split" : m.wins > 0 ? "win" : "loss")),
    });
  }

  const rows = all.filter((row) => row.tier !== null).sort(byScore);
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  const few = all
    .filter((row) => row.tier === null)
    .sort((a, b) => b.games - a.games || b.wins - a.wins || byName(a, b));
  return { rows, few, countedMatches: counted.length, recordedMatches, pickBase };
}

function byName(a: ChampionTierRow, b: ChampionTierRow): number {
  return championName(a.key).localeCompare(championName(b.key), "ko") || a.key.localeCompare(b.key);
}

/**
 * 기본 순서: 티어 → 점수 → 판 수 → 이름. 같은 기록이면 언제나 같은 순서다.
 * 티어를 먼저 보는 까닭: 판 수가 모자라 2티어로 내린 챔피언(TIER_TOP_MIN_GAMES)이 점수만으로는 1티어 사이에 끼어
 * 순위와 티어가 어긋나 보인다.
 */
export function byScore(a: ChampionTierRow, b: ChampionTierRow): number {
  return tierRank(a) - tierRank(b) || b.score - a.score || b.games - a.games || byName(a, b);
}

/** 기록 부족(티어 없음)은 5티어 뒤. */
function tierRank(row: ChampionTierRow): number {
  return row.tier ?? 6;
}

export type ChampionSortKey = "tier" | "rate" | "pick" | "games";

/** 표 정렬. 값이 같으면 기본 순서를 따른다. 티어 정렬은 기본 순서 그대로(내림) 또는 뒤집은 것(오름)이다. */
export function sortChampionRows(
  rows: readonly ChampionTierRow[],
  key: ChampionSortKey,
  dir: "asc" | "desc",
): ChampionTierRow[] {
  const sign = dir === "desc" ? 1 : -1;
  if (key === "tier") return [...rows].sort((a, b) => sign * byScore(a, b));
  const value = (row: ChampionTierRow): number =>
    key === "rate" ? row.wins / row.games : key === "pick" ? row.pickRate : row.games;
  return [...rows].sort((a, b) => sign * (value(b) - value(a)) || byScore(a, b));
}

/**
 * 챔피언이 하나도 기록되지 않은 가장 최근 확정 경기. 운영자에게 "빠진 경기 채우기"로 보여 준다.
 * 범위와 상관없이 모임 전체에서 찾는다(지난 시즌을 보고 있어도 채울 곳은 최근 경기다).
 */
export function latestMatchWithoutChampions(matches: readonly MatchView[]): MatchView | null {
  return [...matches].filter((m) => isCounted(m) && !m.roster.some((r) => r.champion)).sort(newestFirst)[0] ?? null;
}
