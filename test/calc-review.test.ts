import { describe, expect, it } from "vitest";
import { avoidViolations } from "../src/shared/avoid";
import { shiftYears } from "../src/shared/dateCheck";
import { createDraft } from "../src/shared/draft";
import { synergyPoints } from "../src/shared/insights";
import { shuffleDraft } from "../src/shared/rotation";
import { matchRank } from "../src/shared/search";
import { seasonSummary } from "../src/shared/seasonAwards";
import {
  detectMapping,
  fingerprinter,
  nextFreeFingerprint,
  parseSheet,
  type FingerprintInput,
} from "../src/shared/sheetTable";
import { fractionPercent, localDate, ratePercent, roundRatio } from "../src/shared/stats";
import type { MatchView, Position, Snapshot } from "../src/shared/types";

// 2026-11-08 계산 로직 리뷰에서 실제 값으로 확인한 문제들을 고정한다.

describe("정수 승률(ratePercent)", () => {
  it("0.5%는 올리고 소수 오차가 없다", () => {
    expect(ratePercent(23, 40)).toBe(58); // 57.5% (Math.round(23/40*100)은 57)
    expect(ratePercent(29, 200)).toBe(15); // 14.5%
    expect(ratePercent(113, 200)).toBe(57); // 56.5%
    expect(ratePercent(1, 3)).toBe(33);
    expect(ratePercent(2, 3)).toBe(67);
    expect(ratePercent(0, 0)).toBe(0);
    // 모든 작은 경우에 정확한 반올림이다: |100w/g − r| ≤ 0.5, 딱 0.5면 올린 쪽(정수끼리 비교).
    for (let g = 1; g <= 300; g++) {
      for (let w = 0; w <= g; w++) {
        const r = ratePercent(w, g);
        const gap = 2 * (r * g - 100 * w); // 2g × (r − 100w/g)
        expect(gap > -g && gap <= g, `${w}/${g}`).toBe(true);
      }
    }
  });

  it("비율만 있을 때(fractionPercent)도 57.5%는 58", () => {
    expect(fractionPercent(23 / 40)).toBe(58);
    expect(fractionPercent(0.5)).toBe(50);
  });

  it("roundRatio는 부호 대칭(0에서 먼 쪽)", () => {
    expect(roundRatio(1, 8)).toBe(13); // 12.5
    expect(roundRatio(-1, 8)).toBe(-13);
    expect(roundRatio(1, 3)).toBe(33);
    expect(roundRatio(5, 4000, 1000)).toBe(1); // 1.25 → 1
  });

  it("시너지 %p: .5는 0에서 먼 쪽으로", () => {
    // 같은 팀 23/40(57.5%) − 평균 50% = +7.5 → +8 (예전 7)
    expect(synergyPoints({ games: 40, wins: 23 }, { games: 2, wins: 1 }, { games: 2, wins: 1 })).toBe(8);
    // 3/8(37.5%) − 50% = −12.5 → −13 (예전 −12)
    expect(synergyPoints({ games: 8, wins: 3 }, { games: 2, wins: 1 }, { games: 2, wins: 1 })).toBe(-13);
    expect(synergyPoints({ games: 2, wins: 1 }, { games: 2, wins: 1 }, { games: 2, wins: 1 })).toBe(0);
    expect(Object.is(synergyPoints({ games: 2, wins: 1 }, { games: 2, wins: 1 }, { games: 2, wins: 1 }), -0)).toBe(false);
  });
});

describe("시트 가져오기: 한 줄 한 경기 표의 레드·블루 열 순서", () => {
  const header = ["날짜", "레드 탑", "레드 정글", "레드 미드", "레드 원딜", "레드 서폿", "블루 탑", "블루 정글", "블루 미드", "블루 원딜", "블루 서폿", "승리팀"];
  const red = ["r1", "r2", "r3", "r4", "r5"];
  const blue = ["b1", "b2", "b3", "b4", "b5"];

  it("레드 열이 먼저여도 \"블루\" 승리는 블루 5명의 승리이고, 팀 A의 진영은 블루", () => {
    const rows = [header, ["2026-11-01", ...red, ...blue, "블루"], ["2026-11-01", ...red, ...blue, "레드"]];
    const mapping = detectMapping(rows);
    expect(mapping.layout).toBe("wide");
    const parsed = parseSheet(rows, mapping, { today: "2026-11-08" });
    expect(parsed.errors).toEqual([]);
    const [first, second] = parsed.matches;
    const winners = (m: typeof first) => (m!.winner === "A" ? m!.teamA : m!.teamB).map((p) => p.name);
    expect(winners(first)).toEqual(blue);
    expect(winners(second)).toEqual(red);
    expect(first!.sideA).toBe("blue");
    expect(first!.teamA.map((p) => p.position)).toEqual(["top", "jungle", "mid", "adc", "support"]);
  });

  it("블루 열이 먼저인 표는 그대로", () => {
    const blueFirst = ["날짜", "블루 탑", "블루 정글", "블루 미드", "블루 원딜", "블루 서폿", "레드 탑", "레드 정글", "레드 미드", "레드 원딜", "레드 서폿", "승리팀"];
    const rows = [blueFirst, ["2026-11-01", ...blue, ...red, "블루"]];
    const parsed = parseSheet(rows, detectMapping(rows), { today: "2026-11-08" });
    expect(parsed.matches[0]!.teamA.map((p) => p.name)).toEqual(blue);
    expect(parsed.matches[0]!.winner).toBe("A");
    expect(parsed.matches[0]!.sideA).toBe("blue");
  });
});

describe("라인 섞기 + 서폿 돌아가며: 피할 수 있는 기피 라인", () => {
  it("팀 A p0·p2·p3 원딜 기피, 아직 서포터를 안 간 사람은 p1뿐 → 시드 1~300 모두 어김 0", () => {
    const people = Array.from({ length: 10 }, (_, i) => ({ key: `p:${i}`, name: `n${i}`, participantId: String(i) }));
    const teamOf: Record<string, "A" | "B"> = {};
    people.forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
    const ctx = {
      enabled: true,
      cycleId: "c",
      usedIds: new Set(["0", "2", "3", "4"]),
      eventCount: 4,
      counts: new Map([["0", 1], ["2", 1], ["3", 1], ["4", 1]]),
    };
    const avoid: Record<string, Position[]> = { "p:0": ["adc"], "p:2": ["adc"], "p:3": ["adc"] };
    for (let seed = 1; seed <= 300; seed++) {
      const draft = createDraft(people, { groupId: null, baseLiveVersion: null, seed, now: "x", teamOf });
      const shuffled = shuffleDraft(draft, { fairSupport: true, avoid }, ctx);
      expect(avoidViolations(shuffled, avoid), `seed ${seed}`).toEqual([]);
      // 서포터는 규칙대로 p1, 잠시 건 고정은 풀려 있고, 되돌리기는 섞기 전 편성으로 간다.
      expect(shuffled.slots.find((s) => s.key === "p:1")!.position).toBe("support");
      expect(shuffled.slots.every((s) => !s.locked)).toBe(true);
      expect(shuffled.previousSlots).toEqual(draft.slots);
    }
  });
});

describe("가장 많이 성장: 반올림 차가 0이면 소수 한 자리", () => {
  it("50.5% → 51.0%는 \"51% → 51% (+0.5%p)\"", () => {
    const A = ["a1", "a2", "a3", "a4", "a5"];
    const B = ["b1", "b2", "b3", "b4", "b5"];
    let n = 0;
    const mk = (playedAt: string, winner: "A" | "B"): MatchView =>
      ({
        id: `m${++n}`,
        matchNo: n,
        sessionId: "s",
        state: "confirmed",
        source: "live",
        startedAt: null,
        endedAt: null,
        playedAt,
        confirmedAt: null,
        winnerTeam: winner,
        teamASide: "blue",
        version: 1,
        roster: [
          ...A.map((p) => ({ participantId: p, team: "A" as const, position: null })),
          ...B.map((p) => ({ participantId: p, team: "B" as const, position: null })),
        ],
      }) as unknown as MatchView;
    const matches: MatchView[] = [];
    for (let i = 0; i < 200; i++) matches.push(mk(new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(), i < 101 ? "A" : "B"));
    for (let i = 0; i < 200; i++) matches.push(mk(new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), i < 102 ? "A" : "B"));
    const snapshot = {
      group: { timezone: "Asia/Seoul", settings: {} },
      matches,
      participants: [],
      seasons: [
        { id: "s1", name: "S1", startsOn: "2026-01-01", endsOn: "2026-06-30" },
        { id: "s2", name: "S2", startsOn: "2026-07-01", endsOn: "2026-12-31" },
      ],
    } as unknown as Snapshot;
    const summary = seasonSummary(snapshot, { kind: "season", seasonId: "s2" }, (x) => x, new Date("2026-11-08T00:00:00Z"));
    const award = summary.awards.find((a) => a.key === "mostImproved")!;
    expect(award.winners[0]!.value).toBe("51% → 51% (+0.5%p)");
  });
});

describe("초성 검색: 입력 중 받침 이동", () => {
  it("\"김선\"은 \"김서나\"에 맞는다(받침 ㄴ이 다음 글자 초성)", () => {
    expect(matchRank("김서나", "김선")).toBe(3);
    expect(matchRank("서나", "선")).toBe(3);
    expect(matchRank("박김서나", "김선")).toBe(4);
    // 겹받침: "닭"을 치다 멈춘 것은 "달기"에 맞는다(ㄹ은 남고 ㄱ이 넘어감).
    expect(matchRank("달기", "닭")).toBe(3);
  });

  it("다음 글자 초성이 다르거나 다음 글자가 없으면 맞지 않는다", () => {
    expect(matchRank("김서우", "김선")).toBe(5);
    expect(matchRank("김서", "김선")).toBe(5);
    expect(matchRank("김섬나", "김선")).toBe(5);
    // 기존 동작 그대로: 받침 없는 마지막 글자는 초성·중성만 같아도 맞는다.
    expect(matchRank("김선우", "김서")).toBe(3);
  });
});

describe("날짜 점검: 연도 옮기기는 모임 시간대 날짜 기준", () => {
  it("2025-02-28T22:00Z(한국 3월 1일)를 -1년 → 한국 2024-03-01", () => {
    const iso = "2025-02-28T22:00:00.000Z";
    const moved = shiftYears(iso, -1, "Asia/Seoul");
    expect(localDate(moved, "Asia/Seoul")).toBe("2024-03-01");
    expect(moved).toBe("2024-02-29T22:00:00.000Z");
    // 시간대를 주지 않으면 기본 시간대(Asia/Seoul)
    expect(shiftYears(iso, -1)).toBe(moved);
  });

  it("초·밀리초를 지키고, 2월 29일이 없는 해는 28일", () => {
    expect(shiftYears("2026-11-05T11:30:01.000Z", -1, "Asia/Seoul")).toBe("2025-11-05T11:30:01.000Z");
    // 한국 2024-02-29 21:00 → 2025-02-28 21:00
    expect(shiftYears("2024-02-29T12:00:00.000Z", 1, "Asia/Seoul")).toBe("2025-02-28T12:00:00.000Z");
    // 서머타임 시간대: 뉴욕 2026-07-15 20:00(EDT) → 2025-07-15 20:00(EDT)
    expect(shiftYears("2026-07-16T00:00:00.000Z", -1, "America/New_York")).toBe("2025-07-16T00:00:00.000Z");
  });
});

describe("두 자리 연도", () => {
  const header = ["날짜", "A탑", "A정글", "A미드", "A원딜", "A서폿", "B탑", "B정글", "B미드", "B원딜", "B서폿", "승리팀"];
  const names = ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "b3", "b4", "b5"];

  it("\"99.1.1\"은 2099년으로 넣지 않고 두 자리라 확실하지 않다고 알린다", () => {
    const rows = [header, ["99.1.1", ...names, "A"], ["26.11.05", ...names, "B"]];
    const parsed = parseSheet(rows, detectMapping(rows), { today: "2026-11-08" });
    expect(parsed.matches.map((m) => m.date)).toEqual(["2026-11-05"]);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]!.line).toBe(2);
    expect(parsed.errors[0]!.message).toContain("두 자리");
    expect(parsed.errors[0]!.message).toContain("2099");
    expect(parsed.errors[0]!.message).toContain("1999");
  });
});

describe("같은 날 같은 10명·같은 결과 두 경기의 지문", () => {
  const team = (p: string) => [1, 2, 3, 4, 5].map((i) => ({ name: `${p}${i}`, position: null }));
  const game: FingerprintInput = { date: "2026-11-01", time: null, teamA: team("a"), teamB: team("b"), winner: "A" };

  it("한 묶음 안에서는 #1·#2로 갈린다", () => {
    const fp = fingerprinter();
    expect(fp(game)).not.toBe(fp(game));
  });

  it("두 번째 경기만 따로 읽으면 #1로 첫 경기와 같은 지문이 된다 → nextFreeFingerprint로 다음 순번", () => {
    const first = fingerprinter()(game);
    const alone = fingerprinter()(game);
    expect(alone).toBe(first); // 내용만으로는 다시 붙여 넣은 것과 구별할 수 없다
    const second = nextFreeFingerprint(game, new Set([first]));
    expect(second).not.toBe(first);
    // 한 묶음에서 두 번째로 매긴 지문과 같다(나중에 시트 전체를 다시 읽어도 둘 다 "이미 들어감").
    const both = fingerprinter();
    both(game);
    expect(second).toBe(both(game));
    expect(nextFreeFingerprint(game, new Set())).toBe(first);
  });
});
