import { describe, expect, it } from "vitest";
import { laneDuels, laneRivals, laneRivalSummary, type LaneRival } from "../src/shared/headToHead";
import { headToHead, leadOf, rateLeadOf, recentResults, resultsOf, streakOf, synergyPoints } from "../src/shared/insights";
import { POSITIONS, type MatchState, type MatchView, type Position, type Team } from "../src/shared/types";

// 두 사람 비교 화면(2026-11-08 재설계)의 계산: 같은 라인 맞대결, 맞대결 최근 흐름, 앞선 쪽, 함께 뛸 때 시너지.

let seq = 0;
/** teamA·teamB는 탑~서폿 순서. positions로 사람별 포지션을 덮어쓸 수 있다(null = 기록 없음). */
function match(
  teamA: string[],
  teamB: string[],
  winner: Team | null,
  opts: { state?: MatchState; positions?: Record<string, Position | null> } = {},
): MatchView {
  seq += 1;
  const state = opts.state ?? "confirmed";
  const playedAt = `2026-11-08T${String(Math.floor(seq / 60) % 24).padStart(2, "0")}:${String(seq % 60).padStart(2, "0")}:00.000Z`;
  const pos = (id: string, i: number) =>
    opts.positions && id in opts.positions ? opts.positions[id]! : POSITIONS[i]!;
  return {
    id: `m${seq}`,
    matchNo: seq,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((id, i) => ({ participantId: id, team: "A" as Team, position: pos(id, i) })),
      ...teamB.map((id, i) => ({ participantId: id, team: "B" as Team, position: pos(id, i) })),
    ],
  };
}

const ids = (from: number, n = 5) => Array.from({ length: n }, (_, i) => `id${from + i}`);

describe("같은 라인 맞대결(headToHead.ts laneDuels)", () => {
  it("상대 팀으로 같은 포지션에서 만난 경기만 라인별로 a 기준으로 센다", () => {
    const ms = [
      match(ids(0), ids(5), "A"), // id0 탑 vs id5 탑: id0 승
      match(ids(0), ids(5), "B"), // 탑 맞대결 id0 패
      match(ids(0), ids(5), "A", { positions: { id0: "mid", id5: "mid", id2: "top", id7: "top" } }), // 미드 승
      match(ids(0), ids(5), "A", { positions: { id0: "jungle", id1: "top" } }), // 다른 라인: 빼기
      match(ids(0), ids(5), "A", { positions: { id0: null } }), // 포지션 기록 없음: 빼기
      match(["id0", "id5", "id1", "id2", "id3"], ids(6), "A"), // 같은 팀: 빼기
      match(ids(0), ids(5), "A", { state: "excluded" }), // 전적 제외: 빼기
      match(ids(0), ids(5), null, { state: "awaiting_result" }), // 결과 대기: 빼기
    ];
    expect(laneDuels(ms, "id0", "id5")).toEqual([
      { position: "top", games: 2, wins: 1, losses: 1 },
      { position: "mid", games: 1, wins: 1, losses: 0 },
    ]);
    // 기준을 바꾸면 승패가 뒤집힌다.
    expect(laneDuels(ms, "id5", "id0")).toEqual([
      { position: "top", games: 2, wins: 1, losses: 1 },
      { position: "mid", games: 1, wins: 0, losses: 1 },
    ]);
    expect(laneDuels(ms, "id0", "id0")).toEqual([]);
    expect(laneDuels([], "id0", "id5")).toEqual([]);
  });
});

describe("맞라인 상대(headToHead.ts laneRivals·laneRivalSummary)", () => {
  it("상대 팀·같은 포지션만, 라인마다 따로 세고 라인 순 → 경기 수 순으로 둔다", () => {
    const ms = [
      match(ids(0), ids(5), "A"), // id0 탑 vs id5 탑: 승
      match(ids(0), ids(5), "B"), // 패
      match(ids(0), ["id9", "id6", "id7", "id8", "id5"], "A"), // id0 탑 vs id9 탑: 승
      match(ids(0), ids(5), "A", { positions: { id0: "mid", id2: "top" } }), // id0 미드 vs id7 미드
      match(ids(0), ids(5), "B", { positions: { id0: "mid", id5: "mid", id2: "top", id7: "top" } }), // 미드 vs id5: 패
      match(["id0", "id5", "id1", "id2", "id3"], ids(6), "A"), // 같은 팀 id5: 안 셈(상대 탑 id6만)
      match(ids(0), ids(5), "A", { positions: { id0: null } }), // 내 포지션 없음
      match(ids(0), ids(5), "A", { state: "excluded" }),
    ];
    expect(laneRivals(ms, "id0")).toEqual([
      { position: "top", opponentId: "id5", games: 2, wins: 1, losses: 1 },
      { position: "top", opponentId: "id9", games: 1, wins: 1, losses: 0 },
      { position: "top", opponentId: "id6", games: 1, wins: 1, losses: 0 },
      { position: "mid", opponentId: "id7", games: 1, wins: 1, losses: 0 },
      { position: "mid", opponentId: "id5", games: 1, wins: 0, losses: 1 },
    ]);
    expect(laneRivals([], "id0")).toEqual([]);
  });

  it("요약은 min경기 이상 중 승률 최저·최고, 같은 승률이면 경기 수 많은 쪽", () => {
    const r = (position: LaneRival["position"], opponentId: string, wins: number, losses: number): LaneRival => ({
      position,
      opponentId,
      games: wins + losses,
      wins,
      losses,
    });
    const rivals = [
      r("top", "a", 1, 2), // 33%
      r("top", "b", 2, 4), // 33%, 경기 더 많음 → 가장 어려운
      r("top", "c", 3, 0), // 100% → 가장 쉬운
      r("top", "d", 0, 2), // 2경기: min 미만
      r("mid", "e", 1, 1), // 2경기뿐
    ];
    expect(laneRivalSummary(rivals)).toEqual([
      { position: "top", hardest: rivals[1], easiest: rivals[2] },
      { position: "mid", hardest: null, easiest: null },
    ]);
    expect(laneRivalSummary(rivals, 2)[0]!.hardest).toBe(rivals[3]);
    expect(laneRivalSummary([])).toEqual([]);
  });
  it("이기는 상대만 있으면 '어려운'은 없고, 지는 상대만 있으면 '쉬운'은 없다", () => {
    const r = (opponentId: string, wins: number, losses: number): LaneRival => ({
      position: "top",
      opponentId,
      games: wins + losses,
      wins,
      losses,
    });
    // 67%·100%로 모두 이기는 상대뿐: 최저인 67%를 "가장 어려운"이라 부르지 않는다.
    expect(laneRivalSummary([r("a", 2, 1), r("b", 3, 0)])[0]).toEqual({ position: "top", hardest: null, easiest: expect.objectContaining({ opponentId: "b" }) });
    expect(laneRivalSummary([r("a", 1, 2), r("b", 0, 3)])[0]).toEqual({ position: "top", hardest: expect.objectContaining({ opponentId: "b" }), easiest: null });
  });
});

describe("두 사람 비교 보조 계산(insights.ts)", () => {
  it("맞대결 최근 흐름은 a 기준 승패를 최근 것부터 담는다", () => {
    const ms = [
      match(ids(0), ids(5), "A"), // 가장 오래된: id0 승
      match(ids(0), ids(5), "B"),
      match(["id0", "id5", "id1", "id2", "id3"], ids(6), "A"), // 같은 팀: 맞대결 흐름에 넣지 않는다
      match(ids(5), ids(0), "A"), // id0이 팀 B, 패
      match(ids(5), ids(0), "B"), // 가장 최근: id0 승
    ];
    const h = headToHead(ms, "id0", "id5");
    expect(h.againstResults).toEqual([true, false, false, true]);
    expect(h.againstResults).toHaveLength(h.againstMatches.length);
    expect(headToHead(ms, "id5", "id0").againstResults).toEqual([false, true, true, false]);
  });

  it("사람별 최근 흐름은 범위 안 경기에서 최근 것부터 count개", () => {
    const ms = [match(ids(0), ids(5), "A"), match(ids(0), ids(5), "B"), match(ids(0), ids(5), "B")];
    const results = resultsOf(ms, "id0");
    expect(recentResults({ results, ...streakOf(results) }, 10)).toEqual([false, false, true]);
    expect(recentResults({ results, ...streakOf(results) }, 2)).toEqual([false, false]);
  });

  it("앞선 쪽: 큰 값, 같으면 없음. 승률은 한쪽이라도 경기가 없으면 견주지 않는다", () => {
    expect(leadOf(3, 1)).toBe("a");
    expect(leadOf(-1, 2)).toBe("b");
    expect(leadOf(5, 5)).toBeNull();
    expect(rateLeadOf({ games: 4, wins: 3 }, { games: 10, wins: 5 })).toBe("a");
    expect(rateLeadOf({ games: 4, wins: 2 }, { games: 10, wins: 5 })).toBeNull(); // 50% = 50%
    expect(rateLeadOf({ games: 3, wins: 1 }, { games: 2, wins: 1 })).toBe("b");
    expect(rateLeadOf({ games: 0, wins: 0 }, { games: 2, wins: 1 })).toBeNull();
  });

  it("시너지: 같은 팀일 때 승률 − 두 사람 승률 평균(정수 %p), 경기가 없으면 null", () => {
    // 함께 80%, 각자 60%·50% → 평균 55% → +25
    expect(synergyPoints({ games: 10, wins: 8 }, { games: 20, wins: 12 }, { games: 10, wins: 5 })).toBe(25);
    // 함께 40%, 평균 55% → −15
    expect(synergyPoints({ games: 5, wins: 2 }, { games: 20, wins: 12 }, { games: 10, wins: 5 })).toBe(-15);
    // 차이가 0.5%p 미만이면 0(−0이 아니라)
    expect(Object.is(synergyPoints({ games: 1000, wins: 549 }, { games: 1, wins: 1 }, { games: 10, wins: 1 }), 0)).toBe(true);
    expect(synergyPoints({ games: 0, wins: 0 }, { games: 20, wins: 12 }, { games: 10, wins: 5 })).toBeNull();
    expect(synergyPoints({ games: 3, wins: 1 }, { games: 0, wins: 0 }, { games: 10, wins: 5 })).toBeNull();
  });
});
