import { describe, expect, it } from "vitest";
import {
  championTiers,
  latestMatchWithoutChampions,
  sortChampionRows,
  tierOf,
  tierScore,
  TIER_CUTS,
  TIER_MIN_GAMES,
  TIER_TOP_MIN_GAMES,
} from "../src/shared/championTier";
import { CHAMPIONS, championInitial } from "../src/shared/champions";
import { buildDemoSnapshot } from "../src/shared/demo";
import { DEFAULT_SETTINGS, POSITIONS, type MatchView, type Snapshot, type Team } from "../src/shared/types";
import { championPortraitUrl } from "../src/web/portraits";

// 챔피언 티어(src/shared/championTier.ts)와 초상화 주소(src/web/portraits.ts).

/**
 * 한 경기. champs는 명단 10칸(앞 5칸 팀 A, 뒤 5칸 팀 B, 라인은 탑·정글·미드·원딜·서폿 순)의 챔피언이고 비운 칸은 기록 없음.
 * 사람은 p0~p9로 매 경기 같은 자리다.
 */
function game(
  no: number,
  champs: readonly (string | undefined)[],
  options: { winner?: Team; date?: string; state?: MatchView["state"] } = {},
): MatchView {
  const playedAt = options.date ? `${options.date}T11:00:00.000Z` : new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  const state = options.state ?? "confirmed";
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: state === "confirmed" ? (options.winner ?? "A") : null,
    teamASide: "blue",
    version: 1,
    roster: Array.from({ length: 10 }, (_, i) => ({
      participantId: `p${i}`,
      team: (i < 5 ? "A" : "B") as Team,
      position: POSITIONS[i % 5]!,
      ...(champs[i] ? { champion: champs[i] } : {}),
    })),
  };
}

function snap(matches: MatchView[], seasons: Snapshot["seasons"] = []): Snapshot {
  return {
    role: "viewer",
    serverTime: "2026-11-06T00:00:00.000Z",
    group: { id: "g", name: "모임", timezone: "Asia/Seoul", liveVersion: 0, settings: DEFAULT_SETTINGS },
    participants: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `사람${i}`, status: "active" as const })),
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons,
  };
}

const all = { scope: { kind: "all" } as const, lane: "all" as const };

describe("챔피언 티어 계산", () => {
  it("기록이 없으면 빈 결과(분모 0이어도 나눗셈 오류 없음)", () => {
    const result = championTiers(snap([game(1, []), game(2, [])]), all);
    expect(result).toMatchObject({ rows: [], few: [], countedMatches: 2, recordedMatches: 0, pickBase: 0 });
    expect(championTiers(snap([]), all).countedMatches).toBe(0);
  });

  it("최소 판 수 경계: 3판부터 티어, 2판은 기록 부족 묶음", () => {
    const matches = [
      game(1, ["Garen", "Amumu"]),
      game(2, ["Garen", "Amumu"]),
      game(3, ["Garen"]),
    ];
    const result = championTiers(snap(matches), all);
    expect(TIER_MIN_GAMES).toBe(3);
    expect(result.rows.map((r) => r.key)).toEqual(["Garen"]);
    expect(result.rows[0]).toMatchObject({ games: 3, wins: 3, rank: 1 });
    expect(result.few.map((r) => [r.key, r.tier, r.rank])).toEqual([["Amumu", null, null]]);
    // 최소 판 수를 바꿔 부를 수 있다.
    expect(championTiers(snap(matches), { ...all, minGames: 2 }).rows.map((r) => r.key)).toEqual(["Garen", "Amumu"]);
  });

  it("승패는 그 칸의 팀으로 센다. 취소·진행 중 경기는 세지 않는다", () => {
    const matches = [
      game(1, [undefined, undefined, undefined, undefined, undefined, "Ahri"], { winner: "A" }),
      game(2, [undefined, undefined, undefined, undefined, undefined, "Ahri"], { winner: "B" }),
      game(3, [undefined, undefined, undefined, undefined, undefined, "Ahri"], { winner: "B" }),
      game(4, [undefined, undefined, undefined, undefined, undefined, "Ahri"], { state: "canceled" }),
      game(5, [undefined, undefined, undefined, undefined, undefined, "Ahri"], { state: "in_progress" }),
    ];
    const result = championTiers(snap(matches), all);
    expect(result.rows[0]).toMatchObject({ key: "Ahri", games: 3, wins: 2 });
    expect(result.countedMatches).toBe(3);
    expect(result.rows[0]!.players).toEqual([{ participantId: "p5", games: 3, wins: 2 }]);
  });

  it("픽률 분모: 챔피언이 하나라도 기록된 경기 수(라인 필터면 그 라인에 기록된 경기 수)", () => {
    const matches = [
      game(1, ["Garen", undefined, "Ahri"]),
      game(2, ["Garen"]),
      game(3, [undefined, undefined, "Ahri"]),
      game(4, []), // 기록 없는 경기는 분모에서 빠진다.
    ];
    const result = championTiers(snap(matches), { ...all, minGames: 1 });
    expect(result).toMatchObject({ countedMatches: 4, recordedMatches: 3, pickBase: 3 });
    const garen = result.rows.find((r) => r.key === "Garen")!;
    expect(garen.pickRate).toBeCloseTo(2 / 3);

    const mid = championTiers(snap(matches), { scope: { kind: "all" }, lane: "mid", minGames: 1 });
    // 미드에 챔피언이 기록된 경기는 1·3경기. 입력률(recordedMatches)은 라인과 상관없다.
    expect(mid).toMatchObject({ recordedMatches: 3, pickBase: 2 });
    expect(mid.rows.map((r) => r.key)).toEqual(["Ahri"]);
    expect(mid.rows[0]!.pickRate).toBe(1);
  });

  it("같은 챔피언이 한 경기 양 팀에 기록되면 판 수는 둘, 픽률의 경기 수는 하나", () => {
    const result = championTiers(snap([game(1, ["Garen", undefined, undefined, undefined, undefined, "Garen"])]), {
      ...all,
      minGames: 1,
    });
    expect(result.rows[0]).toMatchObject({ games: 2, wins: 1, pickRate: 1 });
  });

  it("라인 필터: 그 라인 판만 세고, 라인 분포는 범위 안 전체를 보여 준다", () => {
    const matches = [
      game(1, ["Gragas", "Gragas"]), // 탑·정글 양쪽에 기록(실제로는 드물지만 손 입력이라 생길 수 있다)
      game(2, [undefined, "Gragas"]),
      game(3, [undefined, "Gragas"], { winner: "B" }),
    ];
    const jungle = championTiers(snap(matches), { scope: { kind: "all" }, lane: "jungle" });
    expect(jungle.rows[0]).toMatchObject({ key: "Gragas", games: 3, wins: 2 });
    expect(jungle.rows[0]!.lanes).toEqual([
      { position: "top", games: 1 },
      { position: "jungle", games: 3 },
    ]);
    expect(championTiers(snap(matches), { scope: { kind: "all" }, lane: "support" }).rows).toEqual([]);
  });

  it("범위 필터: 시즌·연도 밖 경기는 빠진다", () => {
    const matches = [
      game(1, ["Garen"], { date: "2025-12-01" }),
      game(2, ["Garen"], { date: "2026-03-01" }),
      game(3, ["Garen"], { date: "2026-03-02" }),
    ];
    const seasons = [{ id: "s26", name: "2026 봄", startsOn: "2026-03-01", endsOn: "2026-05-31" }];
    const season = championTiers(snap(matches, seasons), { scope: { kind: "season", seasonId: "s26" }, lane: "all", minGames: 1 });
    expect(season.rows[0]!.games).toBe(2);
    expect(season.countedMatches).toBe(2);
    const year = championTiers(snap(matches, seasons), { scope: { kind: "year", year: 2025 }, lane: "all", minGames: 1 });
    expect(year.rows[0]!.games).toBe(1);
  });

  it("보정: 2판 2승은 20판 13승 위에 오지 않는다(픽률이 같아도)", () => {
    const small = tierScore(2, 2, 0.1);
    const big = tierScore(13, 20, 0.1);
    expect(small.score).toBeLessThan(big.score);
    // 날것의 승률은 반대다(100% > 65%). 보정 없이 세우면 뒤집힌다.
    expect(2 / 2).toBeGreaterThan(13 / 20);
    // 실제 기록으로도: 최소 판 수를 1로 낮춰 둘 다 표에 올려도 20판 13승이 위다.
    const matches: MatchView[] = [];
    for (let i = 0; i < 20; i++) matches.push(game(i + 1, ["Garen"], { winner: i < 13 ? "A" : "B" }));
    matches.push(game(21, [undefined, "Amumu"]), game(22, [undefined, "Amumu"]));
    const result = championTiers(snap(matches), { ...all, minGames: 1 });
    expect(result.rows.map((r) => r.key)).toEqual(["Garen", "Amumu"]);
  });

  it("티어 경계: 점수가 경계값과 같으면 위 티어", () => {
    expect(TIER_CUTS.map((cut) => tierOf(cut))).toEqual([1, 2, 3, 4]);
    expect(tierOf(TIER_CUTS[3] - 0.0001)).toBe(5);
    expect(tierOf(1)).toBe(1);
    // 본전(픽률 몫 없이 50%)은 3티어.
    expect(tierOf(tierScore(5, 10, 0).score)).toBe(3);
  });

  it("작은 표본은 1티어가 되지 않는다: 3판 3승은 2티어, 10판 7승은 1티어(2026-11-10 보정)", () => {
    expect(TIER_TOP_MIN_GAMES).toBe(10);
    // 점수만 보면 3판 3승도 1티어 경계를 넘는다. 판 수를 넘기면 2티어로 내린다.
    const small = tierScore(3, 3, 0.1).score;
    expect(tierOf(small)).toBe(1);
    expect(tierOf(small, 3)).toBe(2);
    expect(tierOf(tierScore(9, 9, 0.5).score, 9)).toBe(2);
    expect(tierOf(tierScore(7, 10, 0).score, 10)).toBe(1);
    // 유지할 성질: 2판 2승 < 20판 13승, 10판 5승 가운데(3티어), 10판 3승 아래(5티어).
    expect(tierScore(2, 2, 0.1).score).toBeLessThan(tierScore(13, 20, 0.1).score);
    expect(tierOf(tierScore(5, 10, 0).score, 10)).toBe(3);
    expect(tierOf(tierScore(3, 10, 0).score, 10)).toBe(5);

    // 실제 기록: 가렌 5판 5승, 아무무 10판 7승. 점수는 가렌이 높지만 1티어는 아무무뿐이고, 표도 티어 순이라 아무무가 위다.
    const matches = [
      ...Array.from({ length: 5 }, (_, i) => game(i + 1, ["Garen"])),
      ...Array.from({ length: 10 }, (_, i) =>
        game(i + 6, [undefined, undefined, undefined, undefined, undefined, undefined, "Amumu"], { winner: i < 7 ? "B" : "A" }),
      ),
    ];
    const rows = championTiers(snap(matches), all).rows;
    expect(rows.map((r) => [r.key, r.tier, r.rank])).toEqual([
      ["Amumu", 1, 1],
      ["Garen", 2, 2],
    ]);
    expect(rows.find((r) => r.key === "Garen")!.score).toBeGreaterThan(rows.find((r) => r.key === "Amumu")!.score);
    expect(sortChampionRows(rows, "tier", "asc").map((r) => r.key)).toEqual(["Garen", "Amumu"]);
  });

  it("결정적 정렬: 점수가 같으면 판 수 → 이름 순, 기록 순서를 바꿔도 같은 결과", () => {
    const a = [game(1, ["Garen", "Amumu", "Ahri"]), game(2, ["Garen", "Amumu", "Ahri"]), game(3, ["Garen", "Amumu", "Ahri"])];
    const forward = championTiers(snap(a), all).rows.map((r) => r.key);
    const backward = championTiers(snap([...a].reverse()), all).rows.map((r) => r.key);
    // 셋 다 같은 기록(3판 3승, 픽률 100%) → 이름 가나다: 가렌, 아리, 아무무.
    expect(forward).toEqual(["Garen", "Ahri", "Amumu"]);
    expect(backward).toEqual(forward);
    const rows = championTiers(snap(a), all).rows;
    expect(sortChampionRows(rows, "games", "asc").map((r) => r.key)).toEqual(forward);
  });

  it("표 정렬: 승률·픽률·판 수, 오름·내림", () => {
    const matches = [
      // 가렌은 팀 A 탑(2승 4패), 아무무는 팀 B 정글(4승 2패).
      ...Array.from({ length: 6 }, (_, i) =>
        game(i + 1, ["Garen", undefined, undefined, undefined, undefined, undefined, "Amumu"], { winner: i < 2 ? "A" : "B" }),
      ),
      ...Array.from({ length: 3 }, (_, i) => game(i + 7, [undefined, undefined, "Ahri"])),
    ];
    const rows = championTiers(snap(matches), all).rows;
    expect(sortChampionRows(rows, "rate", "desc").map((r) => r.key)).toEqual(["Ahri", "Amumu", "Garen"]);
    expect(sortChampionRows(rows, "rate", "asc")[0]!.key).toBe("Garen");
    expect(sortChampionRows(rows, "games", "desc").map((r) => r.games)).toEqual([6, 6, 3]);
    expect(sortChampionRows(rows, "pick", "asc")[0]!.key).toBe("Ahri");
  });

  it("최근 경기와 주로 쓴 사람", () => {
    const matches = Array.from({ length: 7 }, (_, i) => game(i + 1, i % 2 === 0 ? ["Garen"] : [undefined, undefined, undefined, undefined, undefined, "Garen"]));
    const row = championTiers(snap(matches), all).rows[0]!;
    expect(row.recentMatchIds).toEqual(["m7", "m6", "m5", "m4", "m3"]);
    expect(row.players.map((p) => [p.participantId, p.games])).toEqual([
      ["p0", 4],
      ["p5", 3],
    ]);
  });

  it("최근 경기 결과는 그 챔피언 칸의 승패다(같은 경기의 다른 칸이 아니라)", () => {
    // m3: 양 팀 탑이 같은 챔피언 → 한쪽은 이기고 한쪽은 짐. m2: B팀 탑만 Garen이고 A팀이 이김 → 패.
    const matches = [
      game(1, ["Garen"], { winner: "A" }),
      game(2, [undefined, undefined, undefined, undefined, undefined, "Garen"], { winner: "A" }),
      game(3, ["Garen", undefined, undefined, undefined, undefined, "Garen"], { winner: "B" }),
    ];
    const row = championTiers(snap(matches), { ...all, minGames: 1 }).rows[0]!;
    expect(row.recentMatchIds).toEqual(["m3", "m2", "m1"]);
    expect(row.recentResults).toEqual(["split", "loss", "win"]);
  });

  it("챔피언이 빠진 가장 최근 확정 경기", () => {
    const matches = [game(1, []), game(2, ["Garen"]), game(3, []), game(4, [], { state: "canceled" })];
    expect(latestMatchWithoutChampions(matches)?.id).toBe("m3");
    expect(latestMatchWithoutChampions([game(1, ["Garen"])])).toBeNull();
  });

  it("예시 모임: 챔피언이 일부 경기에만 기록돼 있고 표가 채워진다", () => {
    const demo = buildDemoSnapshot();
    const result = championTiers(demo, all);
    expect(result.recordedMatches).toBeGreaterThan(result.countedMatches / 2);
    expect(result.recordedMatches).toBeLessThan(result.countedMatches);
    expect(result.rows.length).toBeGreaterThanOrEqual(20);
    expect(result.few.length).toBeGreaterThan(0);
    expect(new Set(result.rows.map((r) => r.tier)).size).toBeGreaterThanOrEqual(4);
    for (const m of demo.matches) for (const r of m.roster) if (r.champion) expect(CHAMPIONS.some((c) => c.key === r.champion)).toBe(true);
  });
});

describe("챔피언 초상화·초성", () => {
  it("목록의 모든 키가 Data Dragon 그림 주소가 된다(키 = Data Dragon id)", () => {
    for (const champion of CHAMPIONS) {
      // Data Dragon id는 영문자만 쓴다(공백·따옴표·마침표 없음: Kai'Sa → Kaisa, Dr. Mundo → DrMundo).
      expect(champion.key, champion.name).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(championPortraitUrl(champion.key)).toMatch(
        new RegExp(`^https://ddragon\\.leagueoflegends\\.com/cdn/\\d+\\.\\d+\\.\\d+/img/champion/${champion.key}\\.png$`),
      );
    }
    // 이름과 id가 다른 챔피언: 오공 = MonkeyKing, 누누와 윌럼프 = Nunu, 레나타 글라스크 = Renata.
    const byName = new Map(CHAMPIONS.map((c) => [c.name, c.key]));
    expect(byName.get("오공")).toBe("MonkeyKing");
    expect(byName.get("누누와 윌럼프")).toBe("Nunu");
    expect(byName.get("레나타 글라스크")).toBe("Renata");
    // 16.22.1 자료로 채운 새 챔피언.
    expect(byName.get("로크")).toBe("Locke");
    expect(byName.get("자헨")).toBe("Zaahen");
    expect(CHAMPIONS).toHaveLength(173);
  });

  it("초성 묶음: 된소리는 예사소리로", () => {
    expect(championInitial("가렌")).toBe("ㄱ");
    expect(championInitial("쉬바나")).toBe("ㅅ");
    expect(championInitial("Garen")).toBeNull();
    for (const c of CHAMPIONS) expect(championInitial(c.name), c.name).not.toBeNull();
  });
});
