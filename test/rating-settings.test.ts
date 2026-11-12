import { describe, expect, it } from "vitest";
import { mmrRanking, ratingTierCounts } from "../src/shared/ranking";
import {
  computeRatings,
  DEFAULT_RATING_OPTIONS,
  RATING_TIERS,
  ratingBandOf,
  ratingOptionsOf,
  ratingTierOf,
} from "../src/shared/rating";
import { placements } from "../src/shared/stats";
import type { MatchView, Snapshot, Team } from "../src/shared/types";
import { api, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";

// MMR 시작값 설정(Settings.ratingStart)과 시즌 2 티어 이름표(rating.ts RATING_TIERS).
// K 둘(ratingKPlacement·ratingK)은 Elo 시절 설정이라 계산에 쓰지 않지만, 저장된 값·백업이 거절되지 않게 서버는 받는다.

function match(no: number, winner: Team): MatchView {
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
      ...[0, 1, 2, 3, 4].map((i) => ({ participantId: `id${i}`, team: "A" as const, position: null })),
      ...[5, 6, 7, 8, 9].map((i) => ({ participantId: `id${i}`, team: "B" as const, position: null })),
    ],
  };
}

describe("MMR 설정(계산)", () => {
  it("저장하지 않은 항목은 기본값(1200 · 배치 10), 옛 K 값은 무시한다", () => {
    expect(ratingOptionsOf({})).toEqual(DEFAULT_RATING_OPTIONS);
    expect(ratingOptionsOf({ ratingStart: 1000, ratingK: 20 })).toEqual({ ...DEFAULT_RATING_OPTIONS, start: 1000 });
  });

  it("시작값은 모든 점수를 같이 옮길 뿐이다", () => {
    const matches = [match(1, "A"), match(2, "A"), match(3, "B")];
    const base = computeRatings(matches).get("id0")!.rating;
    expect(computeRatings(matches, { start: 2000 }).get("id0")!.rating).toBeCloseTo(base + 800, 9);
  });

  it("단계 글자는 시작값 기준", () => {
    expect(ratingBandOf(1200)).toBe("1200대");
    expect(ratingBandOf(1400)).toBe("1400 이상");
    expect(ratingBandOf(1099)).toBe("1100 미만");
    expect(ratingBandOf(1000, 1000)).toBe("1000대");
  });
});

describe("MMR 티어 이름표(LoL 시즌 2 Elo 구간)", () => {
  const name = (rating: number) => ratingTierOf(rating, true)?.name;

  it("경계: 1249/1250 · 1519/1520 · 1899/1900 · 2199/2200, 보이는 정수로 비교", () => {
    expect(RATING_TIERS.map((t) => t.min)).toEqual([2200, 1900, 1520, 1250, -Infinity]);
    expect([name(0), name(1249), name(1250), name(1519), name(1520)]).toEqual(["브론즈", "브론즈", "실버", "실버", "골드"]);
    expect([name(1899), name(1900), name(2199), name(2200), name(3000)]).toEqual([
      "골드",
      "플래티넘",
      "플래티넘",
      "다이아몬드",
      "다이아몬드",
    ]);
    expect(name(1249.5)).toBe("실버");
    expect(name(1249.4)).toBe("브론즈");
  });

  it("배치 중이면 티어가 없다", () => {
    expect(ratingTierOf(2500, false)).toBeNull();
  });

  it("시작값을 바꿔도 구간 숫자는 그대로다(처음 놓이는 티어만 달라진다)", () => {
    const one = [match(1, "A")];
    const at = (start: number) => ratingTierOf(computeRatings(one, { start }).get("id0")!.rating, true)!.name;
    expect(at(1100)).toBe("브론즈"); // 약 1159
    expect(at(1500)).toBe("골드"); // 약 1559
    expect(at(2200)).toBe("다이아몬드");
  });

  it("티어별 인원은 배치 완료자만, 높은 티어부터 센다", () => {
    const matches = Array.from({ length: 10 }, (_, i) => match(i + 1, "A"));
    const table = computeRatings(matches, { start: 1500 });
    const placement = placements(matches);
    const { ranked } = mmrRanking(matches, table, placement, (id) => id, "");
    const counts = ratingTierCounts(ranked, table, placement);
    expect(counts.map(({ tier, count }) => [tier.short, count])).toEqual([
      ["골드", 5],
      ["실버", 5],
    ]);
    expect(ratingTierCounts(ranked, table, placements(matches.slice(0, 9)))).toEqual([]);
  });
});

describe("MMR 설정 저장(서버)", () => {
  async function save(g: TestGroup, patch: Record<string, unknown>) {
    const snap = await snapshot(g);
    return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: snap.group.settingsVersionId,
      settings: { ...snap.group.settings, ...patch },
    });
  }

  it("범위 밖·소수·문자열은 400, 경계값은 저장되고 조회 응답에도 나간다", async () => {
    const g = await setupGroup(10);
    const bad: Record<string, unknown>[] = [
      { ratingStart: 599 },
      { ratingStart: 3001 },
      { ratingStart: 1200.5 },
      { ratingKPlacement: 0 },
      { ratingKPlacement: 101 },
      { ratingK: "30" },
      { ratingK: null },
    ];
    for (const patch of bad) {
      const res = await save(g, patch);
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_FIELD");
    }
    expect((await save(g, { ratingStart: 600, ratingKPlacement: 1, ratingK: 100 })).status).toBe(200);
    expect((await save(g, { ratingStart: 3000 })).status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.group.settings).toMatchObject({ ratingStart: 3000, ratingKPlacement: 1, ratingK: 100 });
    const view = await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(view.body.group.settings).toMatchObject({ ratingStart: 3000, ratingKPlacement: 1, ratingK: 100 });
  });
});
