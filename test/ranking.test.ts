import { describe, expect, it } from "vitest";
import { rankingGroup } from "../src/shared/insights";
import {
  divergingBar,
  mmrRanking,
  mmrScale,
  podiumOf,
  rankEmphasis,
  rankingGroupSizes,
  rankingHighlights,
} from "../src/shared/ranking";
import { computeRatings } from "../src/shared/rating";
import { placements } from "../src/shared/stats";
import type { MatchView, Team } from "../src/shared/types";

// MMR 랭킹 화면의 계산(src/shared/ranking.ts): 기록 화면 MMR 순과 같은 순서, 요약 타일 세 칸, 묶음 인원.

function match(no: number, teamA: number[], teamB: number[], winner: Team): MatchView {
  const playedAt = new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: "s1",
    state: "confirmed",
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: playedAt,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((i) => ({ participantId: `id${i}`, team: "A" as const, position: null })),
      ...teamB.map((i) => ({ participantId: `id${i}`, team: "B" as const, position: null })),
    ],
  } as MatchView;
}

const nameOf = (id: string) => `선수${id.slice(2)}`;

/**
 * id0~9: 50경기 이상(id4·id9는 딱 50) · id10·11: 12경기(배치 완료, 50 미만) · id12·13: 8경기(배치 진행 중).
 * id12는 여덟 판 다 이겨 K=40으로 크게 오른다(요약 타일에서 빠지는지 본다).
 */
function season(): MatchView[] {
  const matches: MatchView[] = [];
  let no = 0;
  for (let i = 0; i < 50; i++) matches.push(match(++no, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], i % 5 === 0 ? "B" : "A"));
  for (let i = 0; i < 12; i++) matches.push(match(++no, [0, 1, 2, 3, 10], [5, 6, 7, 8, 11], i % 2 === 0 ? "A" : "B"));
  for (let i = 0; i < 8; i++) matches.push(match(++no, [0, 1, 2, 3, 12], [5, 6, 7, 8, 13], "A"));
  return matches;
}

describe("MMR 랭킹", () => {
  it("경기가 없으면 빈 순위표, 요약 타일은 모두 비고 묶음 인원은 0", () => {
    const table = computeRatings([]);
    const placement = placements([]);
    const ranking = mmrRanking([], table, placement, nameOf, "");
    expect(ranking.ranked).toEqual([]);
    expect(rankingHighlights(ranking.ranked, table, placement)).toEqual({ leader: null, riser: null, peak: null });
    expect(rankingGroupSizes(ranking.ranked, placement)).toEqual({ 0: 0, 1: 0, 2: 0 });
  });

  it("묶음(50경기 이상 → 배치 완료 → 배치 진행 중) 안에서 MMR 내림차순, 묶음 인원", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
    expect(rankingGroupSizes(ranked, placement)).toEqual({ 0: 10, 1: 2, 2: 2 });
    for (let i = 1; i < ranked.length; i++) {
      const prev = ranked[i - 1]!;
      const cur = ranked[i]!;
      const groupPrev = rankingGroup(placement, prev.participantId);
      const groupCur = rankingGroup(placement, cur.participantId);
      expect(groupCur).toBeGreaterThanOrEqual(groupPrev);
      if (groupCur === groupPrev) {
        expect(table.get(cur.participantId)!.rating).toBeLessThanOrEqual(table.get(prev.participantId)!.rating);
      }
    }
    // 배치 진행 중인 두 사람은 MMR과 상관없이 맨 아래다.
    expect(ranked.slice(-2).map((r) => r.participantId).sort()).toEqual(["id12", "id13"]);
  });

  it("검색해도 순위 숫자는 검색 전 그대로", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const all = mmrRanking(matches, table, placement, nameOf, "");
    const found = mmrRanking(matches, table, placement, nameOf, "선수12");
    expect(found.shown).toHaveLength(1);
    expect(found.shown[0]!.rank).toBe(all.ranked.find((r) => r.participantId === "id12")!.rank);
  });

  it("요약 타일: 1위는 순위표 맨 위, 최고 상승·최고 MMR은 배치 완료자 중에서 고른다", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    const highlights = rankingHighlights(ranked, table, placement);
    expect(highlights.leader?.row.participantId).toBe(ranked[0]!.participantId);

    const placed = [...table.values()].filter((p) => placement.get(p.participantId)!.done);
    const topRise = Math.max(...placed.map((p) => p.delta10));
    const topPeak = Math.max(...placed.map((p) => p.peak));
    expect(highlights.riser?.rating.delta10).toBe(topRise);
    expect(highlights.peak?.rating.peak).toBe(topPeak);
    // id12는 배치 중 K=40으로 여덟 판에 크게 올라 누구보다 상승 폭이 크지만 후보가 아니다.
    expect(table.get("id12")!.delta10).toBeGreaterThan(topRise);
    expect(highlights.riser?.row.participantId).not.toBe("id12");
  });

  it("배치 완료자가 없으면 요약 타일은 모두 빈다", () => {
    const matches = [match(1, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "A")];
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    expect(ranked).toHaveLength(10);
    expect(rankingHighlights(ranked, table, placement)).toEqual({ leader: null, riser: null, peak: null });
  });

  it("최근 10경기 변화가 반올림해 +1 미만이면 최고 상승 후보가 아니다", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    // 배치 완료자의 최근 변화를 모두 +0.4 이하로 바꾼다(반올림하면 0).
    for (const person of table.values()) person.delta10 = Math.min(person.delta10, 0.4);
    expect(rankingHighlights(ranked, table, placement).riser).toBeNull();
    table.get("id4")!.delta10 = 0.6;
    expect(rankingHighlights(ranked, table, placement).riser?.row.participantId).toBe("id4");
  });

  it("시상대는 누적 50경기 이상 묶음의 1~3위, 그런 사람이 없으면 비어 있다", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    expect(podiumOf(ranked, placement).map((r) => r.rank)).toEqual([1, 2, 3]);
    const fresh = [match(1, [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "A")];
    const freshPlacement = placements(fresh);
    const freshRanked = mmrRanking(fresh, computeRatings(fresh), freshPlacement, nameOf, "").ranked;
    expect(podiumOf(freshRanked, freshPlacement)).toEqual([]);
  });

  it("순위별 강조: 1~3 금·은·동, 4~5 브랜드, 6~10 굵게, 11부터·배치 진행 중은 없음", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 11].map((rank) => rankEmphasis(rank, false))).toEqual([
      "medal-1",
      "medal-2",
      "medal-3",
      "tier-brand",
      "tier-brand",
      "tier-bold",
      "tier-bold",
      null,
    ]);
    expect(rankEmphasis(1, true)).toBeNull();
  });

  it("MMR 막대 눈금: 배치 완료자의 최저·최고에 시작값을 넣어 넓히고, 배치 완료자가 없으면 null", () => {
    const matches = season();
    const table = computeRatings(matches);
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, nameOf, "");
    const placed = ranked.filter((r) => rankingGroup(placement, r.participantId) !== 2);
    const values = placed.map((r) => table.get(r.participantId)!.rating);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    expect(mmrScale(ranked, table, placement, 1200)).toEqual({ lo: Math.min(lo, 1200), hi: Math.max(hi, 1200), start: 1200 });
    // 시작값이 모두보다 낮으면 왼쪽 끝이 시작값이다.
    expect(mmrScale(ranked, table, placement, lo - 50)!.lo).toBe(lo - 50);
    expect(mmrScale([], table, placement, 1200)).toBeNull();
  });

  it("MMR 막대: 시작값보다 높으면 기준선에서 오른쪽, 낮으면 왼쪽, 눈금 폭이 0이면 길이 0", () => {
    const scale = { lo: 1000, hi: 1600, start: 1200 };
    const up = divergingBar(1500, scale);
    expect(up.up).toBe(true);
    expect(up.left).toBeCloseTo(1 / 3, 10);
    expect(up.width).toBeCloseTo(0.5, 10);
    const down = divergingBar(1050, scale);
    expect(down.up).toBe(false);
    expect(down.left).toBeCloseTo(50 / 600, 10);
    expect(down.width).toBeCloseTo(150 / 600, 10);
    expect(divergingBar(1200, scale).width).toBe(0);
    expect(divergingBar(1200, { lo: 1200, hi: 1200, start: 1200 })).toEqual({ left: 0, width: 0, up: true });
  });
});
