import { describe, expect, it } from "vitest";
import { buildDemoSnapshot } from "../src/shared/demo";
import {
  dayRecordOf,
  IDLE_STOP_AFTER_MS,
  liveDataOf,
  nextPollDelay,
  POLL_FAILURE_MAX_MS,
  POLL_IDLE_MS,
  POLL_MAX_FAILURES,
  POLL_PLAYING_MS,
  POLL_WAITING_MS,
  POLL_WAITING_SLOW_MS,
  rosterChanges,
  seatOf,
  WAITING_SLOW_AFTER_MS,
  WAITING_STOP_AFTER_MS,
} from "../src/shared/liveView";
import { DEFAULT_SETTINGS, POSITIONS, type MatchView, type Snapshot, type Team } from "../src/shared/types";

// 참가자 편성 화면의 순수 계산(src/shared/liveView.ts, 2026-11-10 실험 B-1).

/** p{ids[0..4]}가 팀 A 탑~서폿, p{ids[5..9]}가 팀 B. */
function match(
  no: number,
  options: { state?: MatchView["state"]; winner?: Team; ids?: number[]; session?: string | null; positions?: boolean } = {},
): MatchView {
  const ids = options.ids ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const state = options.state ?? "confirmed";
  const playedAt = new Date(Date.UTC(2026, 10, 10, 11) + no * 1800_000).toISOString();
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: options.session === undefined ? "s1" : options.session,
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: state === "in_progress" ? null : playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: state === "confirmed" ? (options.winner ?? "A") : null,
    teamASide: "blue",
    version: 1,
    roster: ids.map((n, i) => ({
      participantId: `p${n}`,
      team: (i < 5 ? "A" : "B") as Team,
      position: options.positions === false ? null : POSITIONS[i % 5]!,
    })),
  };
}

function snap(matches: MatchView[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    role: "viewer",
    serverTime: "2026-11-10T12:00:00.000Z",
    group: { id: "g", name: "모임", timezone: "Asia/Seoul", liveVersion: 0, settings: DEFAULT_SETTINGS },
    participants: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `사람${i}`, status: "active" as const })),
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons: [],
    ...extra,
  };
}

const openSession = { id: "s1", startedAt: "2026-11-10T11:00:00.000Z", lastActivityAt: "2026-11-10T11:00:00.000Z" };

describe("liveDataOf", () => {
  it("경기 0개: 보일 경기 없음, 열린 내전이 없으면 한가함", () => {
    const data = liveDataOf(snap([]));
    expect(data).toMatchObject({ shown: null, matches: [], phase: "idle", sessionOpen: false, groupName: "모임" });
    expect(liveDataOf(snap([], { session: openSession })).phase).toBe("waiting");
  });

  it("진행 중 경기가 있으면 그것을 보이고 상태는 경기 중", () => {
    const data = liveDataOf(snap([match(1), match(2, { state: "in_progress" })], { session: openSession }));
    expect(data.shown?.id).toBe("m2");
    expect(data.phase).toBe("playing");
  });

  it("예시 모임(약 100경기): 가장 최근 내전의 경기만 쓴다", () => {
    const demo = buildDemoSnapshot();
    const data = liveDataOf(demo);
    expect(demo.matches.length).toBeGreaterThan(50);
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches.length).toBeLessThan(15);
    expect(new Set(data.matches.map((m) => m.sessionId))).toEqual(new Set([data.shown!.sessionId]));
    // 최근 경기는 그 내전에서 가장 늦은 경기다.
    for (const m of data.matches) expect(m.playedAt <= data.shown!.playedAt).toBe(true);
  });

  it("취소·전적 제외는 최근 경기와 그날 경기에서 빠진다. 내전 없이 들어온 경기면 그 경기 하나", () => {
    const data = liveDataOf(snap([match(1), match(2), match(3, { state: "canceled" }), match(4, { state: "excluded" })]));
    expect(data.shown?.id).toBe("m2");
    expect(data.matches.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(liveDataOf(snap([match(1, { session: null })])).matches.map((m) => m.id)).toEqual(["m1"]);
  });

  it("합쳐진 사람의 옛 ID는 남은 사람으로 본다", () => {
    const s = snap([match(1)]);
    s.participants.push({ id: "old", name: "옛이름", status: "archived", mergedInto: "p3" });
    const data = liveDataOf(s);
    expect(data.resolve("old")).toBe("p3");
    expect(data.resolve("p3")).toBe("p3");
    expect(seatOf(data.shown!, data.resolve("old"))?.position).toBe("adc");
  });
});

describe("seatOf", () => {
  it("팀·라인·같은 팀 4명(라인 순)·맞라인", () => {
    const seat = seatOf(match(1, { state: "in_progress" }), "p2");
    expect(seat).toMatchObject({ team: "A", position: "mid" });
    expect(seat!.teammates.map((r) => r.participantId)).toEqual(["p0", "p1", "p3", "p4"]);
    expect(seat!.opponent?.participantId).toBe("p7");
  });

  it("명단에 없으면 null, 포지션 없는 경기는 맞라인이 없다", () => {
    expect(seatOf(match(1), "p11")).toBeNull();
    const seat = seatOf(match(1, { positions: false }), "p2");
    expect(seat).toMatchObject({ team: "A", position: null, opponent: null });
    expect(seat!.teammates).toHaveLength(4);
  });
});

describe("rosterChanges", () => {
  it("같은 경기에서 한 명 교체: 바뀐 자리 1건", () => {
    const before = match(1, { state: "in_progress" });
    const after = match(1, { state: "in_progress", ids: [0, 1, 2, 3, 4, 5, 10, 7, 8, 9] });
    expect(rosterChanges(before, after)).toEqual([{ team: "B", position: "jungle", outId: "p6", inId: "p10" }]);
  });

  it("두 사람이 자리를 맞바꾸면 2건", () => {
    const before = match(1, { state: "in_progress" });
    const after = match(1, { state: "in_progress", ids: [5, 1, 2, 3, 4, 0, 6, 7, 8, 9] });
    expect(rosterChanges(before, after)).toEqual([
      { team: "A", position: "top", outId: "p0", inId: "p5" },
      { team: "B", position: "top", outId: "p5", inId: "p0" },
    ]);
  });

  it("다른 경기 ID면 빈 목록", () => {
    expect(rosterChanges(match(1), match(2, { ids: [10, 1, 2, 3, 4, 5, 6, 7, 8, 9] }))).toEqual([]);
  });

  it("포지션 없는 경기는 팀 단위로 빠진 사람과 들어온 사람을 짝짓는다", () => {
    const before = match(1, { positions: false });
    const after = match(1, { positions: false, ids: [0, 1, 2, 3, 11, 5, 6, 7, 8, 9] });
    expect(rosterChanges(before, after)).toEqual([{ team: "A", position: null, outId: "p4", inId: "p11" }]);
  });
});

describe("dayRecordOf", () => {
  it("확정 3경기 + 결과 대기 1경기: 2승 1패, 대기 1", () => {
    const matches = [
      match(1, { winner: "A" }),
      match(2, { winner: "B" }),
      match(3, { winner: "A" }),
      match(4, { state: "awaiting_result" }),
    ];
    expect(dayRecordOf(matches, "p0")).toEqual({ wins: 2, losses: 1, pending: 1 });
    expect(dayRecordOf(matches, "p5")).toEqual({ wins: 1, losses: 2, pending: 1 });
    expect(dayRecordOf(matches, "p11")).toEqual({ wins: 0, losses: 0, pending: 0 });
  });
});

describe("nextPollDelay", () => {
  const mid = () => 0.5;
  it("상태별 간격(흩뜨림 가운데 값)", () => {
    expect(nextPollDelay({ phase: "playing", failures: 0, quietMs: 0 }, mid)).toBe(POLL_PLAYING_MS);
    expect(nextPollDelay({ phase: "playing", failures: 0, quietMs: 10 * 3600_000 }, mid)).toBe(POLL_PLAYING_MS);
    expect(nextPollDelay({ phase: "waiting", failures: 0, quietMs: 0 }, mid)).toBe(POLL_WAITING_MS);
    expect(nextPollDelay({ phase: "waiting", failures: 0, quietMs: WAITING_SLOW_AFTER_MS }, mid)).toBe(POLL_WAITING_SLOW_MS);
    expect(nextPollDelay({ phase: "idle", failures: 0, quietMs: 0 }, mid)).toBe(POLL_IDLE_MS);
    expect([POLL_WAITING_MS, POLL_WAITING_SLOW_MS, POLL_PLAYING_MS, POLL_IDLE_MS]).toEqual([15_000, 30_000, 60_000, 120_000]);
  });

  it("오래 바뀐 것이 없으면 멈춘다: 대기 60분, 한가함 30분. 경기 중은 멈추지 않는다", () => {
    expect(WAITING_STOP_AFTER_MS).toBe(60 * 60_000);
    expect(IDLE_STOP_AFTER_MS).toBe(30 * 60_000);
    expect(nextPollDelay({ phase: "waiting", failures: 0, quietMs: WAITING_STOP_AFTER_MS - 1 }, mid)).not.toBeNull();
    expect(nextPollDelay({ phase: "waiting", failures: 0, quietMs: WAITING_STOP_AFTER_MS }, mid)).toBeNull();
    expect(nextPollDelay({ phase: "idle", failures: 0, quietMs: IDLE_STOP_AFTER_MS }, mid)).toBeNull();
  });

  it("실패하면 두 배씩 최대 5분, 연속 5번이면 멈춘다", () => {
    expect(nextPollDelay({ phase: "playing", failures: 1, quietMs: 0 }, mid)).toBe(120_000);
    expect(nextPollDelay({ phase: "waiting", failures: 2, quietMs: 0 }, mid)).toBe(60_000);
    expect(nextPollDelay({ phase: "idle", failures: 4, quietMs: 0 }, mid)).toBe(POLL_FAILURE_MAX_MS);
    expect(nextPollDelay({ phase: "idle", failures: 4, quietMs: 0 }, () => 1)).toBe(POLL_FAILURE_MAX_MS);
    expect(nextPollDelay({ phase: "playing", failures: POLL_MAX_FAILURES, quietMs: 0 }, mid)).toBeNull();
    // 실패 중에는 조용한 시간으로 멈추지 않는다(멈춤은 실패 수가 정한다).
    expect(nextPollDelay({ phase: "idle", failures: 1, quietMs: IDLE_STOP_AFTER_MS }, mid)).not.toBeNull();
  });

  it("429는 retryAfter보다 일찍 보내지 않는다(위로만 흩뜨림)", () => {
    expect(nextPollDelay({ phase: "playing", failures: 1, quietMs: 0, retryAfterMs: 20_000 }, () => 0)).toBe(20_000);
    expect(nextPollDelay({ phase: "playing", failures: 1, quietMs: 0, retryAfterMs: 20_000 }, () => 1)).toBe(24_000);
    expect(nextPollDelay({ phase: "playing", failures: POLL_MAX_FAILURES, quietMs: 0, retryAfterMs: 20_000 }, mid)).toBeNull();
  });

  it("난수 0과 1: ±20% 안", () => {
    for (const phase of ["waiting", "playing", "idle"] as const) {
      const base = nextPollDelay({ phase, failures: 0, quietMs: 0 }, mid)!;
      expect(nextPollDelay({ phase, failures: 0, quietMs: 0 }, () => 0)).toBe(Math.round(base * 0.8));
      expect(nextPollDelay({ phase, failures: 0, quietMs: 0 }, () => 1)).toBe(Math.round(base * 1.2));
    }
  });
});
