import { PLACEMENT_GAMES_DEFAULT } from "./stats";
import { standings, type Standing } from "./titles";
import type { MatchView, TitleBand } from "./types";

/** 중복 참가자 합치기 미리보기의 칭호·누적 승패 비교(서버 src/server/merge.ts가 쓴다). 합치기 계산 자체는 merge.ts. */

/** 합친 뒤의 경기 목록(계산용). 합칠 대상의 명단 행을 남길 대상으로 바꾼다. */
export function mergedMatches(
  matches: readonly MatchView[],
  sourceId: string,
  targetId: string,
): MatchView[] {
  return matches.map((m) =>
    m.roster.some((r) => r.participantId === sourceId)
      ? {
          ...m,
          roster: m.roster.map((r) =>
            r.participantId === sourceId ? { ...r, participantId: targetId } : r,
          ),
        }
      : m,
  );
}

export interface MergeStandings {
  /** 합치기 전 합칠 대상. 확정 경기가 없으면 null. */
  source: Standing | null;
  /** 합치기 전 남길 대상. */
  target: Standing | null;
  /** 합친 뒤 남길 대상. */
  merged: Standing | null;
}

/** 합치기 전후의 누적 승패·배치·칭호(docs/P2 P2-11, 누적 기준). */
export function mergeStandings(
  matches: readonly MatchView[],
  sourceId: string,
  targetId: string,
  bands: readonly TitleBand[],
  placementGames: number = PLACEMENT_GAMES_DEFAULT,
): MergeStandings {
  const before = standings(matches, bands, placementGames);
  const after = standings(mergedMatches(matches, sourceId, targetId), bands, placementGames);
  return {
    source: before.get(sourceId) ?? null,
    target: before.get(targetId) ?? null,
    merged: after.get(targetId) ?? null,
  };
}
