import { describe, expect, it } from "vitest";
import { attendanceReport } from "../src/shared/attendance";
import { GROUP_REMARK_MAX, groupCommentary, PLAYER_REMARK_MAX, playerCommentary } from "../src/shared/commentary";
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
    expect(player(range(6, (i) => match(i)), "p0").coaching?.text).toContain("4경기를 더 하면");

    const mid = range(10, (i) => match(i, { teamA: [1, 2, 0, 3, 4], winner: "A" }));
    const top = range(10, (i) => match(100 + i, { teamA: [5, 6, 7, 8, 9], teamB: [0, 1, 2, 3, 4], winner: i <= 2 ? "B" : "A" }));
    const lines = player([...mid, ...top], "p0").coaching!;
    // 마지막 7판을 연속으로 져 "흐름 하락"이 먼저일 수도 있어, 둘 중 하나가 미드를 권하는지만 본다.
    expect(lines.text).toContain("미드");

    const only = player(range(12, (i) => match(i, { winner: i % 2 ? "A" : "B" })), "p0").coaching!;
    expect(only.text).toContain("거의 탑만");

    const falling = [...range(10, (i) => match(i, { winner: "A" })), ...range(10, (i) => match(20 + i, { winner: "B" }))];
    const down = player(falling, "p0").coaching!;
    expect(down.text).toContain("흐름이 내려가");
    expect(down.tone).toBe("warn");
    expect(down.basis).toBeTruthy();
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
    expect(group(range(3, (i) => match(i))).coaching?.text).toContain("결과를 빠짐없이 입력");
    const c = group(range(30, (i) => match(i, { winner: i % 2 ? "A" : "B", side: i % 4 < 2 ? "blue" : "red" })));
    expect(c.coaching?.text).toBeTruthy();
    expect(c.coaching?.basis).toBeTruthy();
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
