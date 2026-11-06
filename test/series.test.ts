import { describe, expect, it } from "vitest";
import { compositionKey, seriesLine, seriesScore, seriesTeamNames } from "../src/shared/series";
import type { MatchView, SeriesView } from "../src/shared/types";

// 시리즈 점수 계산(src/shared/series.ts). 사람 기준 팀, 제외 판·구성 다른 판 처리.

let seq = 0;
function game(a: string[], b: string[], winner: "A" | "B" | null, state: MatchView["state"] = "confirmed"): MatchView {
  seq += 1;
  const at = `2026-10-01T0${seq % 10}:00:00.000Z`;
  return {
    id: `g${seq}`,
    matchNo: seq,
    sessionId: null,
    state,
    source: "live",
    startedAt: at,
    endedAt: at,
    playedAt: at,
    confirmedAt: winner ? at : null,
    winnerTeam: winner,
    teamASide: winner ? "blue" : null,
    version: 1,
    roster: [
      ...a.map((id) => ({ participantId: id, team: "A" as const, position: null })),
      ...b.map((id) => ({ participantId: id, team: "B" as const, position: null })),
    ],
  };
}

const X = ["a", "b", "c", "d", "e"];
const Y = ["f", "g", "h", "i", "j"];
const series = (format: SeriesView["format"], matches: MatchView[], name: string | null = null): SeriesView => ({
  id: "s",
  name,
  format,
  createdAt: "2026-10-01T00:00:00.000Z",
  matchIds: matches.map((m) => m.id),
});

describe("시리즈 점수", () => {
  it("진영(팀 A/B)이 바뀌어도 같은 사람들의 팀으로 센다", () => {
    const games = [game(X, Y, "A"), game(Y, X, "B"), game(Y, X, "A")];
    expect(compositionKey(games[0]!.roster)).toBe(compositionKey(games[1]!.roster));
    const score = seriesScore(series("bo5", games, "결승"), games);
    expect(score.wins).toEqual([2, 1]);
    expect(score.winner).toBeNull();
    expect(seriesLine(score)).toBe("결승 · 5판 3선승 · 2:1");
  });

  it("구성이 달라진 판(넣은 뒤 참가자 교체 등)은 점수에서 빼고 센다. 진행 중 판은 기다린다", () => {
    const games = [game(X, Y, "A"), game(["a", "b", "c", "d", "z"], Y, "B"), game(X, Y, null, "in_progress")];
    const score = seriesScore(series("bo3", games), games);
    expect(score.games.map((g) => g.status)).toEqual(["counted", "mismatch", "pending"]);
    expect(score.mismatched).toBe(1);
    expect(score.wins).toEqual([1, 0]);
    expect(seriesLine(score)).toBe("시리즈 · 3판 2선승 · 1:0");
  });

  it("자유 형식은 승자를 정하지 않고 넘침 경고도 없다", () => {
    const games = [game(X, Y, "A"), game(X, Y, "A"), game(X, Y, "A"), game(X, Y, "B")];
    const score = seriesScore(series("free", games), games);
    expect(score.wins).toEqual([3, 1]);
    expect(score.winner).toBeNull();
    expect(score.overflow).toBe(false);
    const bo3 = seriesScore(series("bo3", games), games);
    expect(bo3.winner).toBe(0);
    expect(bo3.overflow).toBe(true);
  });

  it("팀 이름은 구성원 중 이름 순 첫 사람 + 팀, 겹치면 팀 1/팀 2", () => {
    const names: Record<string, string> = { a: "다온", b: "가람", f: "나래", g: "바다" };
    const nameOf = (id: string) => names[id] ?? `사람${id}`;
    expect(seriesTeamNames([["a", "b"], ["f", "g"]], nameOf)).toEqual(["가람팀", "나래팀"]);
    expect(seriesTeamNames([["a"], ["a"]], nameOf)).toEqual(["팀 1", "팀 2"]);
    expect(seriesTeamNames([[], []], nameOf)).toEqual(["팀 1", "팀 2"]);
  });
});
