import { describe, expect, it } from "vitest";
import {
  AWARD_MIN_GAMES,
  AWARD_MIN_LINE_GAMES,
  AWARD_MIN_PAIR_GAMES,
  AWARD_MIN_RATE_GAMES,
  awardWinnersText,
  seasonSummary,
  seasonSummaryText,
  type Award,
  type AwardKey,
} from "../src/shared/seasonAwards";
import { DEFAULT_SETTINGS, type MatchView, type Position, type SeasonView, type Side, type Snapshot } from "../src/shared/types";

// 시즌 종료 요약과 시상(src/shared/seasonAwards.ts). 서버 없이 순수 계산만 본다.

const POS: Position[] = ["top", "jungle", "mid", "adc", "support"];
let seq = 0;

/** 경기 하나. a·b는 참가자 번호 5개씩(탑~서폿 순서). day는 2026-10-DD(모임 시간대 정오). */
function game(
  a: number[],
  b: number[],
  winner: "A" | "B",
  options: { date?: string; side?: Side; state?: MatchView["state"]; noPositions?: boolean } = {},
): MatchView {
  seq += 1;
  const playedAt = `${options.date ?? "2026-10-10"}T03:${String(seq % 60).padStart(2, "0")}:00.000Z`;
  const state = options.state ?? "confirmed";
  return {
    id: `m${seq}`,
    matchNo: seq,
    sessionId: "s1",
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: playedAt,
    winnerTeam: winner,
    teamASide: options.side ?? "blue",
    version: 1,
    roster: [
      ...a.map((i, k) => ({ participantId: `p${i}`, team: "A" as const, position: options.noPositions ? null : POS[k]! })),
      ...b.map((i, k) => ({ participantId: `p${i}`, team: "B" as const, position: options.noPositions ? null : POS[k]! })),
    ],
  };
}

const NAMES = ["가람", "나래", "다온", "라온", "마루", "바다", "사랑", "아라", "자람", "차오", "카이", "타라"];
const nameOf = (id: string) => NAMES[Number(id.slice(1))] ?? id;

const SEASONS: SeasonView[] = [
  { id: "s-old", name: "1시즌", startsOn: "2026-08-01", endsOn: "2026-09-30" },
  { id: "s-now", name: "2시즌", startsOn: "2026-10-01", endsOn: "2026-10-31" },
];

function snap(matches: MatchView[], seasons: SeasonView[] = SEASONS): Snapshot {
  return {
    role: "viewer",
    serverTime: "2026-11-06T00:00:00.000Z",
    group: { id: "g", name: "테스트 모임", timezone: "Asia/Seoul", liveVersion: 0, settings: DEFAULT_SETTINGS },
    participants: NAMES.map((name, i) => ({ id: `p${i}`, name, status: "active" as const })),
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons,
  };
}

const A = [0, 1, 2, 3, 4];
const B = [5, 6, 7, 8, 9];
const AFTER = new Date("2026-11-06T00:00:00.000Z");

function award(awards: Award[], key: AwardKey, position?: Position): Award {
  const found = awards.find((a) => a.key === key && (position === undefined || a.position === position));
  if (!found) throw new Error(`no award ${key}`);
  return found;
}
const ids = (a: Award) => a.winners.map((w) => w.participantIds.join("+"));

describe("시즌 요약", () => {
  it("범위 안의 확정 경기만 센다: 경기 수·참가자·진영 승률(아는 경기만)·날 수·가장 많이 한 날(동률 모두)", () => {
    const matches = [
      game(A, B, "A", { date: "2026-10-03", side: "blue" }),
      game(A, B, "B", { date: "2026-10-03", side: "blue" }),
      game(A, B, "A", { date: "2026-10-05", side: "red" }),
      game(A, B, "A", { date: "2026-10-05", side: "unknown" }),
      game(A, [5, 6, 7, 8, 10], "A", { date: "2026-10-07", side: "blue", state: "excluded" }),
      game(A, B, "A", { date: "2026-09-20", side: "blue" }), // 1시즌
    ];
    const s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(s.label).toBe("2시즌");
    expect(s.ongoing).toBe(false);
    expect(s.games).toBe(4);
    expect(s.participants).toBe(10);
    // 진영 아는 3경기: 1경기 A(블루) 승 → 블루, 2경기 B(레드) 승 → 레드, 3경기 A(레드) 승 → 레드.
    expect(s.sides).toEqual({ known: 3, blueWins: 1, redWins: 2, unknown: 1 });
    expect(s.days).toBe(2);
    expect(s.busiestDays).toEqual([
      { date: "2026-10-03", games: 2 },
      { date: "2026-10-05", games: 2 },
    ]);
  });

  it("끝나는 날이 오늘 이후면 진행 중이다. 연도 범위도 된다", () => {
    const matches = [game(A, B, "A", { date: "2026-10-03" })];
    const during = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, new Date("2026-10-15T00:00:00Z"));
    expect(during.ongoing).toBe(true);
    const year = seasonSummary(snap(matches), { kind: "year", year: 2026 }, nameOf, new Date("2026-10-15T00:00:00Z"));
    expect(year).toMatchObject({ label: "2026년", startsOn: "2026-01-01", endsOn: "2026-12-31", ongoing: true, games: 1 });
  });
});

describe("시상: 기준 경계와 공동 수상", () => {
  it(`최고 승률은 ${AWARD_MIN_RATE_GAMES}경기 이상만, 동률은 공동 수상`, () => {
    // 49경기 A 전승, 50경기째는 p0 대신 p10이 들어가 진다.
    const matches = [
      ...Array.from({ length: AWARD_MIN_RATE_GAMES - 1 }, () => game(A, B, "A")),
      game([10, 1, 2, 3, 4], B, "B"),
    ];
    let s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    let best = award(s.awards, "bestRate");
    // p0은 49경기 100%라 기준 미달. p1~p4가 50경기 98%로 공동.
    expect(ids(best)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(best.winners[0]!.value).toBe("98% · 49승 1패 (50경기)");
    expect(awardWinnersText(best, nameOf)).toContain("(공동)");

    // p0이 한 경기 더(이김) → 50경기 100%로 단독.
    s = seasonSummary(snap([...matches, game(A, B, "A")]), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    best = award(s.awards, "bestRate");
    expect(ids(best)).toEqual(["p0"]);
    expect(best.winners[0]!.value).toBe("100% · 50승 0패 (50경기)");

    // 배치 완료(10경기)만으로는 부족하다: 10경기 전승이어도 해당 없음.
    s = seasonSummary(snap(matches.slice(0, 10)), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    best = award(s.awards, "bestRate");
    expect(best.winners).toEqual([]);
    expect(best.none).toBe(`${AWARD_MIN_RATE_GAMES}경기 이상 뛴 사람이 없어요.`);
  });

  it("최다 승·개근상·최장 연승", () => {
    const matches = [
      ...Array.from({ length: 9 }, () => game(A, B, "A")),
      game([10, 1, 2, 3, 4], B, "B"),
      game(A, B, "A"),
    ];
    const s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    // p0: 10경기 10승, p1~p4: 11경기 10승 → 최다 승 공동 5명.
    const wins = award(s.awards, "mostWins");
    expect(ids(wins)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(wins.winners[0]!.value).toBe("10승 (10경기)");
    // 개근상: p1~p9 11경기.
    expect(ids(award(s.awards, "mostGames"))).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"]);
    // 연승: p0은 자기가 뛴 경기만 세므로 10연승(10경기째를 쉬었다), p1~p4는 9연승에서 끊김.
    const streak = award(s.awards, "longestStreak");
    expect(ids(streak)).toEqual(["p0"]);
    expect(streak.winners[0]!.value).toBe("10연승");
  });

  it(`라인별 최고 승률은 그 라인 ${AWARD_MIN_LINE_GAMES}경기 이상만`, () => {
    // p0은 탑 4경기 전승(기준 미달), p5는 탑 5경기 3승.
    const matches = [
      ...Array.from({ length: 4 }, () => game(A, B, "A")),
      game([10, 1, 2, 3, 4], B, "B"),
      game([10, 1, 2, 3, 4], B, "B"),
      game([10, 1, 2, 3, 4], B, "B"),
    ];
    // p5(B 탑): 7경기 3승 = 43%. p10(A 탑): 3경기. p0: 4경기 100%.
    const s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    const top = award(s.awards, "lineBest", "top");
    expect(ids(top)).toEqual(["p5"]);
    expect(top.winners[0]!.value).toBe("43% · 3승 4패 (7경기)");
    // 서폿 라인: p4(A 서폿) 7경기 4승 57%, p9(B 서폿) 7경기 3승.
    expect(ids(award(s.awards, "lineBest", "support"))).toEqual(["p4"]);
    // 포지션 기록이 없는 경기는 라인별에서 빠진다.
    const none = seasonSummary(
      snap(Array.from({ length: 6 }, () => game(A, B, "A", { noPositions: true }))),
      { kind: "season", seasonId: "s-now" },
      nameOf,
      AFTER,
    );
    const empty = award(none.awards, "lineBest", "mid");
    expect(empty.winners).toEqual([]);
    expect(empty.none).toContain(`${AWARD_MIN_LINE_GAMES}경기`);
  });

  it(`최고의 듀오·천적은 ${AWARD_MIN_PAIR_GAMES}경기 이상인 쌍만, 천적은 한쪽이 더 이긴 쌍만`, () => {
    // p0·p1은 같은 팀 5경기 4승. p2는 4경기만 p0과 같이.
    const base = (a: number[], b: number[], w: "A" | "B") => game(a, b, w);
    const matches = [
      base([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "A"),
      base([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "A"),
      base([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "A"),
      base([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "B"),
      base([0, 1, 10, 3, 4], [5, 6, 7, 8, 9], "A"),
    ];
    const s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    const duo = award(s.awards, "bestDuo");
    // 5경기 함께한 쌍: p0·p1, p0·p3, p0·p4, p1·p3, p1·p4, p3·p4(모두 4승 1패) → 공동. p2 쌍은 4경기라 빠진다.
    expect(ids(duo)).toEqual(["p0+p1", "p0+p3", "p0+p4", "p1+p3", "p1+p4", "p3+p4"]);
    expect(duo.winners[0]!.value).toBe("함께 80% · 4승 1패 (5경기)");
    const nemesis = award(s.awards, "nemesis");
    // A쪽 5경기 사람(p0·p1·p3·p4) → B 전원(5경기) 4승 1패.
    expect(nemesis.winners).toHaveLength(4 * 5);
    expect(nemesis.winners[0]!.participantIds).toEqual(["p0", "p5"]);
    expect(nemesis.winners[0]!.value).toBe("상대 전적 80% · 4승 1패 (5경기)");
    expect(awardWinnersText({ ...nemesis, winners: nemesis.winners.slice(0, 1) }, nameOf)).toBe(
      "가람 → 바다 상대 전적 80% · 4승 1패 (5경기)",
    );

    // 반반이면 천적이 없다.
    const even = seasonSummary(
      snap([...Array.from({ length: 3 }, () => game(A, B, "A")), ...Array.from({ length: 3 }, () => game(A, B, "B"))]),
      { kind: "season", seasonId: "s-now" },
      nameOf,
      AFTER,
    );
    const evenNemesis = award(even.awards, "nemesis");
    expect(evenNemesis.winners).toEqual([]);
    expect(evenNemesis.none).toContain("반반");
    // 4경기뿐이면 듀오·천적 모두 해당 없음.
    const few = seasonSummary(snap(Array.from({ length: 4 }, () => game(A, B, "A"))), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(award(few.awards, "bestDuo").winners).toEqual([]);
    expect(award(few.awards, "nemesis").winners).toEqual([]);
  });

  it("헌신상은 서포터로 뛴 판 수, 동률은 공동", () => {
    const matches = [game(A, B, "A"), game(A, B, "B"), game([4, 1, 2, 3, 0], B, "A")];
    const s = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    const support = award(s.awards, "mostSupport");
    // p9는 서폿 3경기, p4는 2경기(3경기째는 탑).
    expect(ids(support)).toEqual(["p9"]);
    expect(support.winners[0]!.value).toBe("서포터 3경기");
  });
});

describe("가장 많이 성장", () => {
  it("직전 시즌 대비 상승 폭이 가장 큰 사람(두 시즌 모두 10경기 이상)", () => {
    const old = [
      ...Array.from({ length: 3 }, () => game(A, B, "A", { date: "2026-09-01" })),
      ...Array.from({ length: 7 }, () => game(A, B, "B", { date: "2026-09-02" })),
    ];
    const now = [
      ...Array.from({ length: 8 }, () => game(A, B, "A", { date: "2026-10-01" })),
      ...Array.from({ length: 2 }, () => game(A, B, "B", { date: "2026-10-02" })),
    ];
    const s = seasonSummary(snap([...old, ...now]), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(s.previous).toEqual({ label: "1시즌" });
    const grow = award(s.awards, "mostImproved");
    expect(ids(grow)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(grow.winners[0]!.value).toBe("30% → 80% (+50%p)");
    expect(grow.rule).toContain("1시즌");

    // 이번 시즌 9경기뿐이면 기준 미달 → 해당 없음(항목은 있다).
    const short = seasonSummary(snap([...old, ...now.slice(0, 9)]), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(award(short.awards, "mostImproved").winners).toEqual([]);
  });

  it("직전 시즌이 없으면 항목 자체를 넣지 않는다", () => {
    const s = seasonSummary(snap([game(A, B, "A", { date: "2026-09-01" })]), { kind: "season", seasonId: "s-old" }, nameOf, AFTER);
    expect(s.previous).toBeNull();
    expect(s.awards.some((a) => a.key === "mostImproved")).toBe(false);
    // 연도 범위: 앞 해에 경기가 없으면 생략.
    const y = seasonSummary(snap([game(A, B, "A")]), { kind: "year", year: 2026 }, nameOf, AFTER);
    expect(y.awards.some((a) => a.key === "mostImproved")).toBe(false);
  });
});

describe("해당 없음과 결정성", () => {
  it("경기가 없으면 모든 항목이 해당 없음이다(놀리는 상은 없다)", () => {
    const s = seasonSummary(snap([]), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(s.games).toBe(0);
    expect(s.busiestDays).toEqual([]);
    expect(s.awards.every((a) => a.winners.length === 0 && typeof a.none === "string")).toBe(true);
    const keys = new Set(s.awards.map((a) => a.key));
    expect([...keys].sort()).toEqual(
      ["bestDuo", "bestRate", "lineBest", "longestStreak", "mostGames", "mostImproved", "mostSupport", "mostWins", "nemesis"].sort(),
    );
    expect(seasonSummaryText(s, "모임", nameOf)).toContain("최고 승률: 해당 없음");
  });

  it("연승이 1뿐이면 최장 연승은 해당 없음이다", () => {
    const s = seasonSummary(snap([game(A, B, "A"), game(A, B, "B")]), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    // A쪽은 1연승, B쪽도 1연승.
    expect(award(s.awards, "longestStreak").winners).toEqual([]);
  });

  it("같은 입력이면 경기 순서·티어·기피 라인과 상관없이 같은 결과다", () => {
    seq = 100;
    const matches = [
      ...Array.from({ length: 6 }, (_, i) => game(A, B, i % 3 === 0 ? "B" : "A", { date: `2026-10-0${1 + (i % 5)}` })),
      ...Array.from({ length: 6 }, (_, i) => game([0, 5, 2, 7, 4], [1, 6, 3, 8, 9], i % 2 === 0 ? "A" : "B")),
    ];
    const first = seasonSummary(snap(matches), { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    const shuffled = snap([...matches].reverse());
    shuffled.participants = shuffled.participants.map((p, i) => ({ ...p, skillGroup: (i % 4) + 1, avoidPositions: ["support"] }));
    const second = seasonSummary(shuffled, { kind: "season", seasonId: "s-now" }, nameOf, AFTER);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
