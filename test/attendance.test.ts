import { describe, expect, it } from "vitest";
import { ABSENT_DAYS, attendanceReport, longAbsent, meetingDays } from "../src/shared/attendance";
import type { MatchView, ParticipantView } from "../src/shared/types";

// 참석 통계(src/shared/attendance.ts). 서버 없이 순수 계산만 본다.

const TZ = "Asia/Seoul";
let seq = 0;

/** 경기 하나. people은 참가자 번호(앞 절반 팀 A). */
function game(playedAt: string, sessionId: string | null, people: number[], state: MatchView["state"] = "confirmed"): MatchView {
  seq += 1;
  const half = Math.ceil(people.length / 2);
  return {
    id: `m${seq}`,
    matchNo: seq,
    sessionId,
    state,
    source: sessionId ? "live" : "import",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: state === "confirmed" ? "A" : null,
    teamASide: "blue",
    version: 1,
    roster: people.map((i, k) => ({ participantId: `p${i}`, team: k < half ? ("A" as const) : ("B" as const), position: null })),
  };
}

/** n번째 모임 날(세션 sN, 2026-10-(N) 저녁 8시 KST). */
const day = (n: number, people: number[], state?: MatchView["state"]) =>
  game(`2026-10-${String(n).padStart(2, "0")}T11:00:00.000Z`, `s${n}`, people, state);

const nameOf = (id: string) => `사람${id.slice(1)}`;
const person = (i: number, status: ParticipantView["status"] = "active"): ParticipantView => ({
  id: `p${i}`,
  name: `사람${i}`,
  status,
});

describe("모임 날 묶기", () => {
  it("세션 하나가 하루다(자정을 넘겨도 같은 날)", () => {
    const days = meetingDays(
      [game("2026-10-01T14:00:00.000Z", "s1", [0, 1]), game("2026-10-01T15:30:00.000Z", "s1", [2, 3])],
      TZ,
    );
    expect(days).toHaveLength(1);
    expect(days[0]!.date).toBe("2026-10-01");
    expect([...days[0]!.attendees].sort()).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("세션 없는 기록은 모임 시간대 날짜로 묶는다", () => {
    const days = meetingDays(
      [
        // KST 10-02 01:00과 10-02 21:00은 같은 날, KST 10-01 23:00은 전날.
        game("2026-10-01T16:00:00.000Z", null, [0, 1]),
        game("2026-10-02T12:00:00.000Z", null, [2, 3]),
        game("2026-10-01T14:00:00.000Z", null, [4, 5]),
      ],
      TZ,
    );
    expect(days.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect([...days[1]!.attendees].sort()).toEqual(["p0", "p1", "p2", "p3"]);
  });

  it("취소 경기는 빼고 결과 대기·전적 제외 경기는 센다", () => {
    const days = meetingDays(
      [day(1, [0, 1], "canceled"), day(2, [0, 1], "excluded"), day(3, [2, 3], "awaiting_result")],
      TZ,
    );
    expect(days.map((d) => d.key)).toEqual(["s2", "s3"]);
  });
});

describe("사람별 참석", () => {
  // 모임 날 1~6. p0: 1·2·3·5·6, p1: 4·5·6(처음 온 날 4), p2: 1·2만.
  const matches = [
    day(1, [0, 2]),
    day(2, [0, 2]),
    day(3, [0]),
    day(4, [1]),
    day(5, [0, 1]),
    day(6, [0, 1]),
  ];
  const report = attendanceReport(matches, TZ);

  it("참석 날 수와 출석률 분모(첫 참석 전 날은 결석으로 치지 않는다)", () => {
    expect(report.days).toHaveLength(6);
    expect(report.people.get("p0")).toMatchObject({ days: 5, eligibleDays: 6 });
    // p1은 4일째에 처음 왔으므로 4·5·6일만 분모다(100%).
    expect(report.people.get("p1")).toMatchObject({ days: 3, eligibleDays: 3 });
    expect(report.people.get("p2")).toMatchObject({ days: 2, eligibleDays: 6 });
  });

  it("현재 연속·최장 연속", () => {
    expect(report.people.get("p0")).toMatchObject({ currentStreak: 2, longestStreak: 3 });
    expect(report.people.get("p1")).toMatchObject({ currentStreak: 3, longestStreak: 3 });
    expect(report.people.get("p2")).toMatchObject({ currentStreak: 0, longestStreak: 2 });
  });

  it("마지막 참석일과 그 뒤 지난 모임 날", () => {
    expect(report.people.get("p0")).toMatchObject({ lastDate: "2026-10-06", missedSinceLast: 0 });
    expect(report.people.get("p2")).toMatchObject({ lastDate: "2026-10-02", missedSinceLast: 4 });
  });

  it("날별 평균 참석 인원", () => {
    expect(report.avgAttendees).toBeCloseTo((2 + 2 + 1 + 1 + 2 + 2) / 6, 12);
    expect(attendanceReport([], TZ).avgAttendees).toBe(0);
  });

  it("오래 안 온 사람: 활성 참가자만, 기준 이상만, 오래 안 온 순", () => {
    expect(ABSENT_DAYS).toBe(3);
    // p3: 3일째까지 오고 3번 빠짐(기준 딱), p4: 4일째까지 오고 2번 빠짐(미달), p5: 보관.
    const more = [...matches, day(1, [3, 5]), day(3, [3]), day(4, [4])];
    const r = attendanceReport(more, TZ);
    const people = [person(0), person(1), person(2), person(3), person(4), person(5, "archived")];
    expect(longAbsent(r, people, nameOf).map((p) => [p.participantId, p.missedSinceLast])).toEqual([
      ["p2", 4],
      ["p3", 3],
    ]);
  });
});
