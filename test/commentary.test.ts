import { describe, expect, it } from "vitest";
import { attendanceReport } from "../src/shared/attendance";
import { COACHING_MAX, GROUP_REMARK_MAX, groupCommentary, PLAYER_REMARK_MAX, playerCommentary } from "../src/shared/commentary";
import { computeRatings } from "../src/shared/rating";
import type { MatchView, Position, Side, Team } from "../src/shared/types";
import { matchExpectations } from "../src/shared/upset";

// 경기는 match()로 만든다: 기본 팀 A = p0~p4, 팀 B = p5~p9, 라인은 팀 안 순서대로 탑·정글·미드·원딜·서폿.
// 시각은 2026-10-01 + 번호 시간(UTC), at으로 바꿀 수 있다. 이름은 "사람00"처럼 두 자리.

const TZ = "Asia/Seoul";
const LINES: Position[] = ["top", "jungle", "mid", "adc", "support"];

interface Options {
  winner?: Team;
  teamA?: number[];
  teamB?: number[];
  side?: Side;
  at?: string;
}

function match(no: number, options: Options = {}): MatchView {
  const teamA = options.teamA ?? [0, 1, 2, 3, 4];
  const teamB = options.teamB ?? [5, 6, 7, 8, 9];
  const playedAt = options.at ?? new Date(Date.UTC(2026, 9, 1) + no * 3600_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: null,
    state: "confirmed",
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: playedAt,
    winnerTeam: options.winner ?? "A",
    teamASide: options.side ?? "blue",
    version: 1,
    roster: [
      ...teamA.map((i, k) => ({ participantId: `p${i}`, team: "A" as const, position: LINES[k] ?? null })),
      ...teamB.map((i, k) => ({ participantId: `p${i}`, team: "B" as const, position: LINES[k] ?? null })),
    ],
  };
}

const range = (n: number, f: (i: number) => MatchView) => Array.from({ length: n }, (_, i) => f(i + 1));
const nameOf = (id: string) => `사람${id.slice(1).padStart(2, "0")}`;

/** scoped를 주면 그 경기만 범위로 보고, MMR·예상은 matches 전체로 구한다. */
function player(matches: MatchView[], id: string, scoped: MatchView[] = matches) {
  const cumulative = new Map<string, { games: number }>();
  for (const m of matches) for (const r of m.roster) cumulative.set(r.participantId, { games: (cumulative.get(r.participantId)?.games ?? 0) + 1 });
  return playerCommentary({
    scoped,
    participantId: id,
    nameOf,
    ratings: computeRatings(matches),
    expectations: matchExpectations(matches),
    attendance: attendanceReport(scoped, TZ),
    cumulative,
  });
}

function group(matches: MatchView[]) {
  return groupCommentary({
    allMatches: matches,
    scoped: matches,
    nameOf,
    ratings: computeRatings(matches),
    expectations: matchExpectations(matches),
    timeZone: TZ,
  });
}

const texts = (c: { remarks: { text: string }[] }) => c.remarks.map((r) => r.text);

describe("playerCommentary", () => {
  it("경기가 없으면 빈 코멘트", () => {
    expect(player([match(1)], "p99")).toEqual({ summary: "", remarks: [] });
  });

  it("경기가 적으면 '아직 판단하기 일러요'를 앞에 두고 문장을 줄인다", () => {
    const c = player(range(6, (i) => match(i)), "p0");
    expect(c.remarks[0]!.text).toContain("경기가 6개뿐이라 아직 판단하기 일러요");
    expect(c.remarks.length).toBeLessThanOrEqual(3);
    expect(c.summary).toContain("일러요");
  });

  it("강점·약점 라인: 5경기 이상 라인끼리 15%p 이상 차이", () => {
    // p0이 미드(팀 A 세 번째)로 10전 10승, 탑(팀 B 첫 번째)으로 10전 2승.
    const mid = range(10, (i) => match(i, { teamA: [1, 2, 0, 3, 4], winner: "A" }));
    const top = range(10, (i) => match(100 + i, { teamA: [5, 6, 7, 8, 9], teamB: [0, 1, 2, 3, 4], winner: i <= 2 ? "B" : "A" }));
    const c = player([...mid, ...top], "p0");
    const line = c.remarks.find((r) => r.text.includes("미드에서"));
    expect(line?.text).toContain("탑은 약점");
    expect(line?.tone).toBe("good");
    expect(c.summary).toMatch(/권|성장 중/);
  });

  it("한 라인만 서면 '전담'", () => {
    const c = player(range(12, (i) => match(i, { winner: i % 2 ? "A" : "B" })), "p0");
    expect(texts(c).some((t) => t.includes("거의 탑 전담"))).toBe(true);
  });

  it("최근 10경기가 누적보다 높으면 상승 구간(+ 긴 연승), 낮으면 하락 구간", () => {
    const rising = [...range(10, (i) => match(i, { winner: "B" })), ...range(10, (i) => match(20 + i, { winner: "A" }))];
    const up = player(rising, "p0").remarks.find((r) => r.text.includes("상승 구간"));
    expect(up?.tone).toBe("good");
    expect(up?.text).toContain("10연승");

    const falling = [...range(10, (i) => match(i, { winner: "A" })), ...range(10, (i) => match(20 + i, { winner: "B" }))];
    const down = player(falling, "p0").remarks.find((r) => r.text.includes("하락 구간"));
    expect(down?.tone).toBe("warn");
    expect(player(falling, "p0").summary).toContain("최근 주춤");
  });

  it("이변 성향: 약팀일 때도 자주 이기면 '이변을 자주 만드는 유형'", () => {
    // p0~p4가 먼저 20연패해 MMR이 낮아진 뒤(범위 밖), 범위 안 12경기를 약팀으로 뛰며 반을 이긴다.
    const base = range(20, (i) => match(i, { winner: "B" }));
    const underdog = range(12, (i) => match(100 + i, { winner: i % 2 ? "A" : "B" }));
    const c = player([...base, ...underdog], "p0", underdog);
    const r = c.remarks.find((x) => x.text.includes("이변을 자주 만드는"));
    expect(r?.tone).toBe("good");
  });

  it("코칭 한 줄: 자료 부족 → 몇 경기 더, 라인 강약 → 강한 라인부터, 전담 → 다른 라인도, 하락 → 감 되찾기", () => {
    expect(player(range(6, (i) => match(i)), "p0").coaching?.map((t) => t.text)).toEqual([expect.stringContaining("4경기를 더 하면")]);

    const mid = range(10, (i) => match(i, { teamA: [1, 2, 0, 3, 4], winner: "A" }));
    const top = range(10, (i) => match(100 + i, { teamA: [5, 6, 7, 8, 9], teamB: [0, 1, 2, 3, 4], winner: i <= 2 ? "B" : "A" }));
    const lines = player([...mid, ...top], "p0").coaching!;
    expect(lines.length).toBeLessThanOrEqual(COACHING_MAX);
    expect(lines.some((t) => t.text.includes("미드"))).toBe(true);

    const only = player(range(12, (i) => match(i, { winner: i % 2 ? "A" : "B" })), "p0").coaching!;
    expect(only.some((t) => t.text.includes("거의 탑만"))).toBe(true);

    const falling = [...range(10, (i) => match(i, { winner: "A" })), ...range(10, (i) => match(20 + i, { winner: "B" }))];
    const down = player(falling, "p0").coaching!;
    // 10연승 뒤 10연패라 "진 다음 판이 약해요"(같은 날 다음 경기)가 맨 앞이다. 흐름 하락은 내용이 겹쳐 같이 쓰지 않는다.
    expect(down[0]!.text).toMatch(/진 다음 판이 약해요|흐름이 내려가/);
    expect(down[0]!.tone).toBe("warn");
    expect(down.every((t) => t.basis)).toBe(true);
    expect(down.filter((t) => /진 다음 판이 약해요|흐름이 내려가/.test(t.text))).toHaveLength(1);
  });

  it("진 다음 판: 같은 날 진 다음 경기가 이긴 다음 경기보다 15%p 이상 낮으면 경고", () => {
    // 4승 4패를 번갈아 묶어 이긴 다음은 대개 이기고, 진 다음은 대개 진다. 시각은 한 시간 간격이라 날이 바뀌면 끊긴다.
    const pattern = range(32, (i) => match(i, { winner: Math.floor((i - 1) / 4) % 2 === 0 ? "A" : "B" }));
    const r = player(pattern, "p0").remarks.find((x) => x.text.includes("진 다음 판 승률이"));
    expect(r?.tone).toBe("warn");
  });

  it("챔피언: 5판 이상 쓴 챔피언이 평소 승률보다 우연으로 보기 어렵게 높으면 이름과 승률", () => {
    // 아리 10판 전승, 나머지 10판 전패: 평소 50%인 사람이 10연승할 확률은 0.2%다.
    const withAhri = range(20, (i) => {
      const m = match(i, { winner: i <= 10 ? "A" : "B" });
      if (i <= 10) m.roster[0] = { ...m.roster[0]!, champion: "Ahri" };
      return m;
    });
    const ahri = player(withAhri, "p0").remarks.find((r) => r.text.startsWith("아리로 10판"));
    expect(ahri).toBeDefined();
    expect(ahri!.basis).toMatch(/우연 가능성 1% 미만/);
  });

  it("챔피언: 평소에도 잘 이기는 사람의 6판 5승은 우연으로 설명돼 말하지 않는다(2026-11-13 전에는 말했다)", () => {
    // 12판 8승(67%)인 사람이 아리로 6판 5승: 평소 실력으로 약 70% 확률로 나오는 결과다.
    const withAhri = range(12, (i) => {
      const m = match(i, { winner: i <= 5 || i % 3 === 0 ? "A" : "B" });
      if (i <= 6) m.roster[0] = { ...m.roster[0]!, champion: "Ahri" };
      return m;
    });
    expect(player(withAhri, "p0").remarks.some((r) => r.text.includes("아리"))).toBe(false);
  });

  it("문장 수는 상한을 넘지 않는다", () => {
    const many = range(60, (i) => match(i, { winner: i % 3 ? "A" : "B", side: i % 2 ? "blue" : "red" }));
    expect(player(many, "p0").remarks.length).toBeLessThanOrEqual(PLAYER_REMARK_MAX);
  });
});

describe("groupCommentary", () => {
  it("공정성: 판정 경기 수와 예상 45~55% 경기 수를 사실로 쓴다(판정 낱말 없이, 2026-11-10 F5)", () => {
    // 매 경기 팀을 번갈아 이기게 해 MMR이 비슷하게 유지된다.
    const c = group(range(30, (i) => match(i, { winner: i % 2 ? "A" : "B", side: i % 4 < 2 ? "blue" : "red" })));
    const fair = c.remarks.find((r) => r.text.includes("예상 45~55%"));
    expect(fair?.text).toMatch(/^판정 \d+경기 중 \d+경기가 예상 45~55%였어요\(균형 경기 \d+%\)\./);
    expect(fair?.text).toMatch(/예상 우세 팀이 \d+경기 중 \d+경기 이겼어요\(\d+%\)/);
    expect(fair?.basis).toContain("판정");
    expect(c.summary).toMatch(/^균형 경기 \d+%/);
    // 표본이 말해 주는 것보다 많이 말하던 문구는 어디에도 남지 않는다.
    for (const t of [c.summary, ...texts(c)]) expect(t).not.toMatch(/공정해요|공정한 섞기|실력을 잘 반영|안정된 MMR|자리 잡는/);
  });

  it("모임 코칭 한 줄: 판정 경기가 적으면 결과 입력 안내, 고르게 섞였으면 유지", () => {
    expect(group(range(3, (i) => match(i))).coaching?.map((t) => t.text)).toEqual([expect.stringContaining("결과를 빠짐없이 입력")]);
    const c = group(range(30, (i) => match(i, { winner: i % 2 ? "A" : "B", side: i % 4 < 2 ? "blue" : "red" })));
    expect(c.coaching!.length).toBeGreaterThanOrEqual(1);
    expect(c.coaching!.length).toBeLessThanOrEqual(COACHING_MAX);
    expect(c.coaching!.every((t) => t.basis)).toBe(true);
  });

  it("모임 새 규칙: 서폿 쏠림·연승 행진·챔피언 기록률", () => {
    // 라인은 팀 안 순서라 p4·p9가 늘 서폿, 팀 A가 6연승으로 끝난다, 챔피언은 아무도 기록하지 않았다.
    const matches = range(24, (i) => match(i, { winner: i > 18 || i % 2 ? "A" : "B" }));
    const t = texts(group(matches));
    expect(t.some((x) => x.includes("서폿을 많이 맡아요(자기 경기의 100%)"))).toBe(true);
    expect(t.some((x) => /6연승 중이에요/.test(x))).toBe(true);
    expect(t.some((x) => x.startsWith("챔피언 기록이 0%뿐이에요"))).toBe(true);
  });

  it("진영 편차: 블루가 15%p 이상 많이 이기면 진영 랜덤 권유", () => {
    const c = group(range(24, (i) => match(i, { winner: i % 5 === 0 ? "B" : "A", teamA: i % 2 ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9], teamB: i % 2 ? [5, 6, 7, 8, 9] : [0, 1, 2, 3, 4] })));
    const side = c.remarks.find((r) => r.text.includes("블루 승률이 눈에 띄게"));
    expect(side?.tone).toBe("warn");
    expect(side?.text).toContain("진영 랜덤");
    expect(c.summary).toContain("진영");
  });

  it("뭉침: 함께 나온 경기마다 같은 팀이면 경고, 무작위 수준이면 말하지 않는다", () => {
    const stuck = group(range(12, (i) => match(i, { winner: i % 2 ? "A" : "B" })));
    const pair = stuck.remarks.find((r) => r.text.includes("자주 같은 팀"));
    expect(pair?.tone).toBe("warn");
    expect(pair?.text).toContain("최근 조합 피하기");

    // p0과 p5가 같은 팀인 경기가 절반(우연 수준 44%와 비슷) → 다른 쌍은 고정이라 p0·p5 문장은 없다.
    const mixed = group(
      range(12, (i) => (i % 2 ? match(i) : match(i, { teamA: [5, 1, 2, 3, 4], teamB: [0, 6, 7, 8, 9] }))),
    );
    expect(texts(mixed).some((t) => t.includes("사람00·사람05"))).toBe(false);
  });

  it("이변 비율이 높으면 이변 경기 수를 사실로 쓴다(까닭을 짐작하지 않는다)", () => {
    // 팀 A가 15연승해 강팀이 된 뒤 연달아 진다.
    const matches = [...range(15, (i) => match(i, { winner: "A" })), ...range(10, (i) => match(100 + i, { winner: "B" }))];
    const c = group(matches);
    expect(texts(c).some((t) => /^판정 \d+경기 중 \d+경기가 이변이었어요\(\d+%\)\.$/.test(t))).toBe(true);
    expect(texts(c).some((t) => /아슬아슬|뜻이에요/.test(t))).toBe(false);
    // 강팀으로 연달아 진 사람: "방심" 같은 성향 판정 대신 횟수만.
    const loser = player(matches, "p0");
    expect(loser.remarks.some((r) => r.text.includes("방심"))).toBe(false);
    expect(loser.remarks.some((r) => /^예상 승률 60% 넘는 강팀으로 진 경기가 \d+회로, 약팀으로 이긴 \d+회보다 많아요\.$/.test(r.text))).toBe(true);
  });

  it("문장 수 상한과 빈 범위", () => {
    expect(group([])).toEqual({ summary: "", remarks: [] });
    const c = group(range(40, (i) => match(i, { winner: i % 4 ? "A" : "B" })));
    expect(c.remarks.length).toBeLessThanOrEqual(GROUP_REMARK_MAX);
  });
});

describe("문장 다듬기", () => {
  it("이름 끝 숫자에 맞는 조사(사람01과)", () => {
    // p0은 p1과 같은 팀일 때 이기고 p1이 상대 팀일 때 진다. 모두 누적 30경기 이상.
    const withP1 = range(20, (i) => match(i, { teamA: [0, 1, 5, 6, 7], teamB: [2, 3, 4, 8, 9], winner: "A" }));
    const withP2 = range(20, (i) => match(100 + i, { teamA: [0, 2, 5, 6, 7], teamB: [1, 3, 4, 8, 9], winner: "B" }));
    const pair = player([...withP1, ...withP2], "p0").remarks.find((r) => r.text.includes("같은 팀이면"));
    // p1은 같은 팀이면 전승, 상대 팀이면 전패라 동료·상대가 한 문장으로 묶인다.
    expect(pair?.text).toContain("사람01과는 같은 팀이면 100%, 상대 팀이면 0%");
  });
});

describe("우연 거르기(2026-11-13)", () => {
  // 승률 비교형 문장: 같은 실력이라도 표본이 작으면 우연히 나오는 차이를 근거로 삼는 문장들. basis 앞부분으로 가린다.
  const COMPARISON_BASIS = [
    "라인별 승률",
    "최근 10경기 승률",
    "같은 팀·상대 팀 전적",
    "진영별 승률",
    "경기 전 예상 우세 팀",
    "같은 날 바로 다음 경기",
    "모임 날 자기 경기 순서",
    "맞라인 상대",
    "기록한 챔피언",
  ];
  const isComparison = (basis: string | undefined) => COMPARISON_BASIS.some((b) => basis?.startsWith(b));
  const PEOPLE = 26;
  const GAMES = 500;
  const CHAMPIONS = ["Ahri", "Garen", "LeeSin", "Jinx", "Thresh", "Darius", "Lux", "Ezreal", "Leona", "Zed", "Vi", "Annie"];

  function rngOf(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  /** 무작위 열 명·라인·진영·챔피언으로 경기를 만든다. 승패는 aWins(경기, rng)가 정한다. 하루 8판씩 모임 날을 나눈다. */
  function randomGroup(seed: number, aWins: (m: MatchView, rnd: () => number) => boolean): MatchView[] {
    const rnd = rngOf(seed);
    return range(GAMES, (i) => {
      const pool = Array.from({ length: PEOPLE }, (_, k) => k).sort(() => rnd() - 0.5).slice(0, 10);
      const day = Math.floor((i - 1) / 8);
      const m = match(i, {
        teamA: pool.slice(0, 5),
        teamB: pool.slice(5),
        side: rnd() < 0.5 ? "blue" : "red",
        at: new Date(Date.UTC(2026, 0, 1 + day * 3, 11, i % 8)).toISOString(),
      });
      m.roster = m.roster.map((r) => ({ ...r, champion: CHAMPIONS[Math.floor(rnd() * CHAMPIONS.length)]! }));
      m.winnerTeam = aWins(m, rnd) ? "A" : "B";
      return m;
    });
  }

  function comparisonCount(matches: MatchView[]): number {
    let count = 0;
    for (let k = 0; k < PEOPLE; k++) count += player(matches, `p${k}`).remarks.filter((r) => isComparison(r.basis)).length;
    return count;
  }

  it("결과가 동전 던지기인 모임(26명·500경기)을 20번 만들어도 승률 비교형 문장은 사람당 평균 0.2개 이하다", () => {
    const SEEDS = 20;
    let total = 0;
    for (let seed = 1; seed <= SEEDS; seed++) total += comparisonCount(randomGroup(seed, (_m, rnd) => rnd() < 0.5));
    expect(total / (SEEDS * PEOPLE)).toBeLessThanOrEqual(0.2);
  }, 120000);

  it("최근 흐름이 우연으로 걸러져도 긴 연승 중이면 총평이 '숨 고르기'가 아니라 연승을 말한다", () => {
    // 앞 20판 10승 10패, 뒤 10판 1패 뒤 9연승: 최근 90% 대 앞 50%는 비교 규칙 10개로 나눈 문턱을 넘지 못한다.
    const matches = range(30, (i) => match(i, { winner: i <= 20 ? (i % 2 ? "A" : "B") : i === 21 ? "B" : "A" }));
    const summary = player(matches, "p0").summary;
    expect(summary).toMatch(/지금 9연승 중$/);
    expect(summary).not.toMatch(/숨 고르기/);
  });

  it("심어 둔 진짜 차이는 남는다: p0이 블루에서 85%·레드에서 15%면 진영 문장이 우연 가능성과 함께 나온다", () => {
    const matches = randomGroup(7, (m, rnd) => {
      const p0 = m.roster.find((r) => r.participantId === "p0");
      if (!p0) return rnd() < 0.5;
      const p0Blue = (p0.team === "A") === (m.teamASide === "blue");
      const p0Wins = rnd() < (p0Blue ? 0.85 : 0.15);
      return p0.team === "A" ? p0Wins : !p0Wins;
    });
    const side = player(matches, "p0").remarks.find((r) => r.basis?.startsWith("진영별 승률"));
    expect(side?.text).toMatch(/블루에서 유독 강해요/);
    expect(side?.basis).toMatch(/우연 가능성 (1% 미만|\d+%)/);
  });
});
