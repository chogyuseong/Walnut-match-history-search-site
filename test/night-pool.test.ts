import { describe, expect, it } from "vitest";
import { draftFromMatch, type Draft, type DraftPerson } from "../src/shared/draft";
import {
  carryRecord,
  goneFromSession,
  nextLineup,
  parseCarry,
  parseNightPool,
  planNextDraft,
  poolIsLive,
  poolText,
  rotateDraft,
  sessionMatchesOf,
  syncPool,
  tonightStats,
  type NightPool,
} from "../src/shared/nightPool";
import { POSITIONS, type MatchState, type MatchView, type ParticipantView, type Snapshot } from "../src/shared/types";

// 오늘 명단 이어가기(src/shared/nightPool.ts, docs/개선-오늘명단-설계-2026-11-10.md ⑥ 테스트 ①~⑨)와
// "다음 경기 준비"가 팀 조건을 이어받는 작은 개선(⑤).

const NOW = Date.parse("2026-11-10T13:00:00.000Z");
const ids = Array.from({ length: 13 }, (_, i) => `p${i}`);
const person = (id: string): DraftPerson => ({ key: `p:${id}`, name: `이름${id}`, participantId: id });
const participants: ParticipantView[] = ids.map((id) => ({ id, name: `이름${id}`, status: "active" }));

function poolOf(n: number, sessionId: string | null = "s1"): NightPool {
  return { v: 1, groupId: "g", sessionId, createdAt: "2026-11-10T11:00:00.000Z", people: ids.slice(0, n).map(person) };
}

/** 앞 5명이 팀 A(탑~서폿), 뒤 5명이 팀 B. */
function matchOf(no: number, roster: readonly string[], state: MatchState = "confirmed", sessionId = "s1"): MatchView {
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId,
    state,
    source: "live",
    startedAt: "2026-11-10T12:00:00.000Z",
    endedAt: null,
    playedAt: "2026-11-10T12:00:00.000Z",
    confirmedAt: null,
    winnerTeam: state === "confirmed" ? "A" : null,
    teamASide: "blue",
    version: 1,
    roster: roster.map((id, i) => ({ participantId: id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5]! })),
  };
}

function snapshotOf(matches: MatchView[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    group: { id: "g", name: "호두나무 내전", timezone: "Asia/Seoul", liveVersion: 1 },
    participants,
    session: { id: "s1", startedAt: "2026-11-10T11:00:00.000Z", lastActivityAt: "2026-11-10T12:30:00.000Z" },
    rotation: null,
    matches,
    revisions: [],
    seasons: [],
    ...extra,
  } as unknown as Snapshot;
}

const nameOf = (id: string) => `이름${id}`;
const baseOf = (m: MatchView): Draft =>
  draftFromMatch(m, nameOf, { groupId: "g", baseLiveVersion: 1, seed: 7, now: "2026-11-10T12:00:00.000Z" });

/** 초안을 서버 경기 명단 꼴로(팀 A 먼저, 탑~서폿 순). */
function rosterOfDraft(draft: Draft): string[] {
  const order = (s: Draft["slots"][number]) => (s.team === "A" ? 0 : 5) + POSITIONS.indexOf(s.position);
  return [...draft.slots].sort((a, b) => order(a) - order(b)).map((s) => draft.people.find((p) => p.key === s.key)!.participantId!);
}

describe("쉬는 순서 규칙(nextLineup)", () => {
  it("① 12명·6경기: 모두가 한 번 쉬기 전에 두 번 쉬는 사람이 없다", () => {
    const pool = poolOf(12);
    const matches = [matchOf(1, ids.slice(0, 10))];
    const rests = new Map(ids.slice(0, 12).map((id) => [id, 0]));
    const countRest = (m: MatchView) => {
      for (const id of rests.keys()) if (!m.roster.some((r) => r.participantId === id)) rests.set(id, rests.get(id)! + 1);
    };
    countRest(matches[0]!);
    for (let no = 2; no <= 6; no++) {
      const last = matches[matches.length - 1]!;
      const lineup = nextLineup(pool, last, sessionMatchesOf(pool, matches));
      expect(lineup.inKeys).toHaveLength(2);
      const next = matchOf(no, rosterOfDraft(rotateDraft(baseOf(last), lineup, pool.people)));
      matches.push(next);
      countRest(next);
      expect(Math.max(...rests.values()), `${no}경기 뒤`).toBeLessThanOrEqual(1);
    }
    expect([...rests.values()].every((n) => n === 1)).toBe(true);
  });

  it("② 동률이면 명단 앞쪽이 먼저 쉬고, 같은 입력이면 같은 결과다", () => {
    const pool = poolOf(12);
    const first = matchOf(1, ids.slice(0, 10));
    const lineup = nextLineup(pool, first, [first]);
    // 열 명 모두 연속 1판·오늘 1경기로 같다 → 명단 앞쪽(p0, p1)이 쉰다.
    expect(lineup).toEqual(nextLineup(pool, first, [first]));
    expect(lineup.inKeys).toEqual(["p:p10", "p:p11"]);
    expect(lineup.outKeys).toEqual(["p:p0", "p:p1"]);
    expect(lineup.bench.map((p) => p.key)).toEqual(["p:p0", "p:p1"]);
    // 명단 순서를 바꾸면 그 순서를 따른다.
    const reordered: NightPool = { ...pool, people: [...pool.people].reverse() };
    expect(nextLineup(reordered, first, [first]).outKeys).toEqual(["p:p9", "p:p8"]);
  });

  it("③ 늦게 온 사람은 바로 다음 판에 들어온다", () => {
    const pool = poolOf(12);
    const m1 = matchOf(1, ids.slice(0, 10));
    const m2 = matchOf(2, [...ids.slice(2, 10), "p10", "p11"]);
    const late: NightPool = { ...pool, people: [...pool.people, person("p12")] };
    const lineup = nextLineup(late, m2, [m1, m2]);
    expect(lineup.inKeys).toEqual(["p:p0", "p:p1", "p:p12"]);
    // 연속 2판 뛴 p2~p9 중 명단 앞쪽 셋이 쉰다(p10·p11은 연속 1판).
    expect(lineup.outKeys).toEqual(["p:p2", "p:p3", "p:p4"]);
  });

  it("④ 미진행 취소 경기는 세지 않고 결과 대기·전적 제외·진행 중 경기는 뛴 판으로 센다", () => {
    const pool = poolOf(12);
    const matches = [
      matchOf(1, ids.slice(0, 10), "excluded"),
      matchOf(2, ids.slice(2, 12), "canceled"),
      matchOf(3, ids.slice(0, 10), "awaiting_result"),
      matchOf(4, ids.slice(0, 10), "in_progress"),
      matchOf(5, ids.slice(0, 10), "confirmed", "다른 세션"),
    ];
    const counted = sessionMatchesOf(pool, matches);
    expect(counted.map((m) => m.matchNo)).toEqual([1, 3, 4]);
    const stats = tonightStats(pool, counted);
    expect(stats.get("p:p0")).toEqual({ games: 3, playStreak: 3, restStreak: 0 });
    expect(stats.get("p:p11")).toEqual({ games: 0, playStreak: 0, restStreak: 3 });
    // 묶이기 전 명단은 셀 경기가 없다.
    expect(sessionMatchesOf(poolOf(12, null), matches)).toEqual([]);
  });

  it("⑤ 그날 경기에 뛰었는데 명단에 없는 사람은 끝에 더하고, 합쳐진 사람은 하나만 남긴다", () => {
    const pool: NightPool = {
      ...poolOf(11),
      // 새 이름으로 고른 사람(시작하면서 참가자가 생김)과, 같은 사람으로 합쳐질 p1·p2.
      people: [...poolOf(11).people.slice(0, 10), { key: "n:이름p12", name: "이름p12", participantId: null }],
    };
    const snap = snapshotOf([matchOf(1, [...ids.slice(0, 9), "p12"]), matchOf(2, [...ids.slice(1, 10), "p11"])], {
      participants: participants.map((p) => (p.id === "p2" ? { ...p, status: "archived", mergedInto: "p1" } : p)),
    });
    const synced = syncPool(pool, snap);
    const keys = synced.pool.people.map((p) => p.key);
    expect(keys.filter((k) => k === "p:p1")).toHaveLength(1);
    expect(keys).not.toContain("p:p2");
    expect(keys).toContain("p:p12");
    expect(keys).not.toContain("n:이름p12");
    expect(synced.added.map((p) => p.key)).toEqual(["p:p11"]);
    expect(keys[keys.length - 1]).toBe("p:p11");
    // 한 번 맞춘 명단은 다시 맞춰도 그대로(같은 객체).
    expect(syncPool(synced.pool, snap).pool).toBe(synced.pool);
    // 빼기로 뺀 사람은 그날 뛰었어도 다시 넣지 않는다.
    const left = syncPool({ ...pool, left: ["p:p11"] }, snap);
    expect(left.added).toEqual([]);
    expect(left.pool.people.map((p) => p.key)).not.toContain("p:p11");
  });

  it("⑥ 오래된 명단이면 poolIsLive가 false다", () => {
    const snap = snapshotOf([]);
    expect(poolIsLive(poolOf(12), snap, NOW)).toBe(true);
    expect(poolIsLive(poolOf(12, null), snap, NOW)).toBe(true);
    expect(poolIsLive(poolOf(12, null), snap, NOW + 13 * 3600_000)).toBe(false);
    expect(poolIsLive(poolOf(12, "s0"), snap, NOW)).toBe(false);
    expect(poolIsLive(poolOf(12), snapshotOf([], { session: null }), NOW)).toBe(false);
    // "오늘 내전 마치기"를 안 눌러 세션이 열려 있어도 마지막 활동에서 12시간이 지나면 지난 밤이다.
    expect(poolIsLive(poolOf(12), snap, Date.parse("2026-11-11T01:00:00.000Z"))).toBe(false);
    expect(poolIsLive({ ...poolOf(12), groupId: "다른 모임" }, snap, NOW)).toBe(false);
  });
});

describe("집에 간 사람과 깨진 보관값(리뷰 2026-11-10)", () => {
  const keysOf = (ids_: readonly string[]) => ids_.map((id) => `p:${id}`);

  it("재현 A: 10명이 2경기 뒤 2명 귀가·3명 합류로 다시 고르면, 간 사람이 명단·다음 판에 돌아오지 않는다", () => {
    const m1 = matchOf(1, ids.slice(0, 10));
    const m2 = matchOf(2, ids.slice(0, 10));
    // p0·p1 귀가, p10~p12 합류. 10명이던 밤이라 아직 명단이 없다(묶이지 않은 새 명단).
    const people = ids.slice(2, 13).map(person);
    const left = goneFromSession(snapshotOf([m1, m2]), people, NOW);
    expect(left).toEqual(keysOf(["p0", "p1"]));
    // 시작에 성공해 세션에 묶인 뒤(bindNightPool), 3경기는 p12가 쉰다.
    const bound: NightPool = { ...poolOf(0), people, left };
    const m3 = matchOf(3, ids.slice(2, 12));
    const synced = syncPool(bound, snapshotOf([m1, m2, m3]));
    expect(synced.added).toEqual([]);
    expect(synced.pool.people.map((p) => p.key)).toEqual(keysOf(ids.slice(2, 13)));
    const lineup = nextLineup(synced.pool, m3, sessionMatchesOf(synced.pool, [m1, m2, m3]));
    expect(lineup.inKeys).toEqual(["p:p12"]);
    expect(lineup.bench.map((p) => p.key)).not.toContain("p:p0");
    // left가 없으면 예전처럼 "다른 기기에서 넣은 사람"으로 되살아났다.
    expect(syncPool({ ...bound, left: [] }, snapshotOf([m1, m2, m3])).added.map((p) => p.key)).toEqual(keysOf(["p0", "p1"]));
  });

  it("재현 B: 12명인 밤 중간에 2명이 가고 남은 10명으로 다시 골라도 간 사람이 돌아오지 않는다", () => {
    const m1 = matchOf(1, ids.slice(0, 10));
    const m2 = matchOf(2, ids.slice(2, 12));
    const people = ids.slice(2, 12).map(person);
    const left = goneFromSession(snapshotOf([m1, m2]), people, NOW);
    expect(left).toEqual(keysOf(["p0", "p1"]));
    const pool: NightPool = { ...poolOf(0), people, left };
    const synced = syncPool(pool, snapshotOf([m1, m2]));
    expect(synced.added).toEqual([]);
    expect(synced.pool).toBe(pool);
  });

  it("명단을 만든 뒤 다른 기기가 교체로 넣은 사람은 여전히 명단 끝에 더한다", () => {
    const m1 = matchOf(1, ids.slice(0, 10));
    const m2 = matchOf(2, ids.slice(2, 12));
    const people = ids.slice(2, 12).map(person);
    const pool: NightPool = { ...poolOf(0), people, left: goneFromSession(snapshotOf([m1, m2]), people, NOW) };
    // 다른 기기의 3경기: p11 대신 p12.
    const m3 = matchOf(3, [...ids.slice(2, 11), "p12"]);
    const synced = syncPool(pool, snapshotOf([m1, m2, m3]));
    expect(synced.added.map((p) => p.key)).toEqual(["p:p12"]);
  });

  it("세션이 없거나 12시간이 지났으면 간 사람을 남기지 않고, 미진행 취소 경기는 보지 않는다", () => {
    const snap = snapshotOf([matchOf(1, ids.slice(0, 10)), matchOf(2, ids.slice(3, 13), "canceled")]);
    const people = ids.slice(1, 12).map(person);
    expect(goneFromSession(snap, people, NOW)).toEqual(["p:p0"]);
    expect(goneFromSession(snap, people, Date.parse("2026-11-11T01:00:00.000Z"))).toEqual([]);
    expect(goneFromSession(snapshotOf([matchOf(1, ids.slice(0, 10))], { session: null }), people, NOW)).toEqual([]);
  });

  it("직전 경기에 뛰고 명단에서 뺀 사람이 가장 먼저 쉰다", () => {
    const m1 = matchOf(1, ids.slice(0, 10));
    // p0을 빼고 p10·p11이 남은 11명.
    const pool: NightPool = { ...poolOf(0), people: ids.slice(1, 12).map(person), left: ["p:p0"] };
    const lineup = nextLineup(pool, m1, [m1]);
    expect(lineup.inKeys).toEqual(["p:p10", "p:p11"]);
    expect(lineup.outKeys).toEqual(["p:p0", "p:p1"]);
  });

  it("11명 밤에 직전 경기에 뛴 한 명을 빼서 10명이 되면, 그 자리를 쉬던 사람이 채운다", () => {
    const m1 = matchOf(1, ids.slice(0, 10));
    // p0이 먼저 가서 명단은 p1~p10(10명). p10은 1경기에서 쉬었다.
    const pool: NightPool = { ...poolOf(0), people: ids.slice(1, 11).map(person), left: ["p:p0"] };
    const lineup = nextLineup(pool, m1, [m1]);
    expect(lineup.inKeys).toEqual(["p:p10"]);
    expect(lineup.outKeys).toEqual(["p:p0"]);
    expect(lineup.bench).toEqual([]);
    // 간 사람이 없으면 10명 밤은 그대로다(⑦과 같은 기대).
    const same = nextLineup(poolOf(10), m1, [m1]);
    expect(same.inKeys).toEqual([]);
    expect(same.outKeys).toEqual([]);
  });

  it("보관값의 left가 문자열 목록이 아니면 그 명단을 버린다", () => {
    const stored = poolOf(12);
    const text = (value: unknown) => JSON.stringify(value);
    expect(parseNightPool(text(stored), "g")).toEqual(stored);
    expect(parseNightPool(text({ ...stored, left: ["p:p0"] }), "g")?.left).toEqual(["p:p0"]);
    for (const left of [3, { a: 1 }, "p:p0", [1], [null]]) expect(parseNightPool(text({ ...stored, left }), "g")).toBeNull();
    expect(parseNightPool(text(stored), "다른 모임")).toBeNull();
    expect(parseNightPool("{깨진", "g")).toBeNull();
    expect(parseNightPool(null, "g")).toBeNull();
  });
});

describe("초안 적용(rotateDraft·planNextDraft)", () => {
  const m1 = matchOf(1, ids.slice(0, 10));
  const plan = (pool: NightPool | null, series = false, carried: Draft["constraints"] = []) =>
    planNextDraft(baseOf(m1), m1, { pool, added: [], matches: [m1], carried: carried ?? [], series });

  it("⑦ 10명 이하이거나 시리즈면 사람·팀이 draftFromMatch와 같다", () => {
    const base = baseOf(m1);
    const team = (d: Draft) => d.slots.map((s) => [s.key, s.team, s.position]);
    // 오늘 명단도 이어 온 조건도 없는 10명 밤: 내용이 그대로다.
    expect(plan(null)).toEqual(base);
    const ten = plan(poolOf(10));
    expect(ten.people).toEqual(base.people);
    expect(team(ten)).toEqual(team(base));
    expect(ten.bench).toBeUndefined();
    expect(ten.night?.swaps).toEqual([]);
    const series = plan(poolOf(12), true);
    expect(series.people).toEqual(base.people);
    expect(team(series)).toEqual(team(base));
    expect(series.bench?.map((p) => p.key)).toEqual(["p:p10", "p:p11"]);
  });

  it("⑧ 들어온 사람이 나간 사람의 팀·포지션을 물려받고, 빠진 사람의 조건이 지워진다", () => {
    const base: Draft = {
      ...baseOf(m1),
      constraints: [
        { kind: "different", a: "p:p0", b: "p:p5" },
        { kind: "same", a: "p:p3", b: "p:p4" },
      ],
      history: [baseOf(m1).slots],
    };
    const pool = poolOf(12);
    const lineup = nextLineup(pool, m1, [m1]);
    const rotated = rotateDraft(base, lineup, pool.people);
    for (const [i, out] of lineup.outKeys.entries()) {
      const was = base.slots.find((s) => s.key === out)!;
      const now = rotated.slots.find((s) => s.key === lineup.inKeys[i])!;
      expect([now.team, now.position]).toEqual([was.team, was.position]);
    }
    expect(rotated.people.map((p) => p.key)).not.toContain("p:p0");
    expect(rotated.people.map((p) => p.key)).toContain("p:p10");
    expect(rotated.constraints).toEqual([{ kind: "same", a: "p:p3", b: "p:p4" }]);
    expect(rotated.history).toBeUndefined();
    expect(rotated.bench?.map((p) => p.key)).toEqual(["p:p0", "p:p1"]);
    // 안내 줄에 쓸 짝도 같은 자리를 가리킨다.
    const planned = plan(pool);
    expect(planned.night?.swaps.map((s) => [s.inName, s.outName])).toEqual([
      ["이름p10", "이름p0"],
      ["이름p11", "이름p1"],
    ]);
    expect(planned.night?.matchNo).toBe(2);
    expect(poolText(pool).split("\n")).toHaveLength(12);
  });

  it("⑨ 입력한 초안과 명단을 바꾸지 않는다", () => {
    const base = baseOf(m1);
    const pool = poolOf(12);
    const before = JSON.stringify({ base, pool });
    const lineup = nextLineup(pool, m1, [m1]);
    rotateDraft(base, lineup, pool.people);
    planNextDraft(base, m1, { pool, added: [], matches: [m1], carried: [], series: false });
    syncPool(pool, snapshotOf([m1]));
    expect(JSON.stringify({ base, pool })).toBe(before);
  });
});

describe("다음 경기 준비가 팀 조건을 이어받음(⑤)", () => {
  const m1 = matchOf(1, ids.slice(0, 10));
  it("두 사람이 모두 새 초안에 있는 조건만 이어 오고, 안내에 그 수를 남긴다", () => {
    const carried = [
      { kind: "different" as const, a: "p:p2", b: "p:p7" },
      { kind: "same" as const, a: "p:p3", b: "p:p11" },
    ];
    const next = planNextDraft(baseOf(m1), m1, { pool: null, added: [], matches: [m1], carried, series: false });
    expect(next.constraints).toEqual([carried[0]]);
    expect(next.night?.carried).toBe(1);
    expect(next.night?.swaps).toEqual([]);
  });

  it("쉬는 사람으로 빠진 사람의 조건은 이어 오지 않는다", () => {
    const carried = [{ kind: "different" as const, a: "p:p0", b: "p:p7" }];
    const next = planNextDraft(baseOf(m1), m1, { pool: poolOf(12), added: [], matches: [m1], carried, series: false });
    expect(next.constraints).toEqual([]);
    expect(next.night?.carried).toBe(0);
  });

  it("시작한 편성의 조건을 남기고(새 이름은 참가자 키로), 12시간이 지나거나 조건이 없으면 이어 오지 않는다", () => {
    const started: Draft = {
      ...baseOf(m1),
      people: [...baseOf(m1).people.slice(0, 9), { key: "n:새사람", name: "새사람", participantId: "p12" }],
      constraints: [{ kind: "different", a: "p:p0", b: "n:새사람" }],
    };
    const saved = JSON.stringify(carryRecord(started, "2026-11-10T12:00:00.000Z"));
    expect(parseCarry(saved, NOW)).toEqual([{ kind: "different", a: "p:p0", b: "p:p12" }]);
    expect(parseCarry(saved, NOW + 13 * 3600_000)).toEqual([]);
    expect(carryRecord({ ...started, constraints: [] }, "2026-11-10T12:00:00.000Z")).toBeNull();
    expect(parseCarry("{깨진 값", NOW)).toEqual([]);
    expect(parseCarry(null, NOW)).toEqual([]);
  });
});
