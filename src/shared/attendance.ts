import { byPlayedAt } from "./insights";
import { localDate } from "./stats";
import type { MatchView, ParticipantView } from "./types";

/**
 * 참석 통계(2026-11-09). 저장하지 않고 스냅숏의 경기로 매번 계산한다(서버·스키마와 무관).
 *
 * - 모임 날: 경기의 세션(sessionId) 하나가 하루다. 세션이 없는 가져온·지난 경기(sessionId null)는
 *   모임 시간대 날짜(localDate) 하나를 하루로 묶는다.
 * - 참석: 그날 경기의 명단에 들어 있으면 참석이다. 취소(미진행) 경기만 빼고 결과 확정·전적 제외·결과 대기·진행 중
 *   경기는 모두 센다. 참석은 "그 자리에 왔는지"라 승패가 확정됐는지나 전적에 넣는지와는 상관이 없고,
 *   취소 경기는 실제로 하지 않은 경기라 온 것으로 볼 근거가 없다.
 * - 범위(오늘·시즌·연도)는 넘겨받은 경기(matchesInScope 결과)로 정해진다.
 */

/** 마지막 참석 뒤 모임 날이 이만큼 이상 지나면 "오래 안 온 사람"이다(임시값: 주 1회 모이는 모임이면 3주쯤 안 온 것). */
export const ABSENT_DAYS = 3;

export interface MeetingDay {
  /** 세션 ID 또는 "date:YYYY-MM-DD". */
  key: string;
  /** 그날 첫 경기의 모임 시간대 날짜. */
  date: string;
  /** 참석자 ID(중복 없음). */
  attendees: Set<string>;
}

export interface PersonAttendance {
  participantId: string;
  /** 참석한 모임 날 수. */
  days: number;
  /** 첫 참석 날부터 마지막 모임 날까지의 모임 날 수(출석률 분모). */
  eligibleDays: number;
  /** 지금 이어지는 연속 참석(가장 최근 모임 날부터 거꾸로). 최근 날에 없었으면 0. */
  currentStreak: number;
  longestStreak: number;
  /** 마지막 참석 날짜(YYYY-MM-DD). */
  lastDate: string;
  /** 마지막 참석 뒤 지난 모임 날 수. */
  missedSinceLast: number;
}

export interface AttendanceReport {
  /** 오래된 날부터. */
  days: MeetingDay[];
  people: Map<string, PersonAttendance>;
  /** 날별 평균 참석 인원(날이 없으면 0). */
  avgAttendees: number;
}

/** 경기를 모임 날로 묶는다(오래된 날부터). 취소 경기는 뺀다. */
export function meetingDays(matches: readonly MatchView[], timeZone: string): MeetingDay[] {
  const byKey = new Map<string, MeetingDay>();
  for (const match of [...matches].sort(byPlayedAt)) {
    if (match.state === "canceled") continue;
    const date = localDate(match.playedAt, timeZone);
    const key = match.sessionId ?? `date:${date}`;
    let day = byKey.get(key);
    if (!day) {
      // 경기 시각 순으로 돌므로 처음 만난 경기가 그날 첫 경기다.
      day = { key, date, attendees: new Set() };
      byKey.set(key, day);
    }
    for (const r of match.roster) day.attendees.add(r.participantId);
  }
  // 같은 순서로 넣었으므로 첫 경기 시각 순이다.
  return [...byKey.values()];
}

/**
 * 모임 날별 참석으로 사람별 참석 통계를 낸다.
 * 출석률은 그 사람의 첫 참석 날부터 센다: 처음 오기 전의 날(가입 전)을 결석으로 치면 새로 온 사람의 출석률이
 * 실제보다 낮게 나와서다.
 */
export function attendanceReport(matches: readonly MatchView[], timeZone: string): AttendanceReport {
  const days = meetingDays(matches, timeZone);
  // 모임 날 순번으로 연속 참석을 센다. first·last·streak는 결과에 넣지 않는 중간값이다.
  const tracks = new Map<string, { person: PersonAttendance; first: number; last: number; streak: number }>();

  days.forEach((day, i) => {
    for (const id of day.attendees) {
      let track = tracks.get(id);
      if (!track) {
        const person = { participantId: id, days: 0, eligibleDays: 0, currentStreak: 0, longestStreak: 0, lastDate: day.date, missedSinceLast: 0 };
        track = { person, first: i, last: -1, streak: 0 };
        tracks.set(id, track);
      }
      track.streak = track.last === i - 1 ? track.streak + 1 : 1;
      track.last = i;
      track.person.longestStreak = Math.max(track.person.longestStreak, track.streak);
      track.person.days += 1;
      track.person.lastDate = day.date;
    }
  });

  const lastDay = days.length - 1;
  const people = new Map<string, PersonAttendance>();
  for (const [id, { person, first, last, streak }] of tracks) {
    person.eligibleDays = lastDay - first + 1;
    person.missedSinceLast = lastDay - last;
    person.currentStreak = last === lastDay ? streak : 0;
    people.set(id, person);
  }

  const total = days.reduce((n, d) => n + d.attendees.size, 0);
  return { days, people, avgAttendees: days.length > 0 ? total / days.length : 0 };
}

/**
 * 오래 안 온 사람: 활성 참가자(보관·합쳐진 사람 제외) 중 마지막 참석 뒤 모임 날이 ABSENT_DAYS번 이상 지난 사람.
 * 오래 안 온 순, 같으면 이름 순.
 */
export function longAbsent(
  report: AttendanceReport,
  participants: readonly ParticipantView[],
  nameOf: (id: string) => string,
): PersonAttendance[] {
  const active = new Set(participants.filter((p) => p.status === "active" && !p.mergedInto).map((p) => p.id));
  return [...report.people.values()]
    .filter((p) => active.has(p.participantId) && p.missedSinceLast >= ABSENT_DAYS)
    .sort(
      (a, b) =>
        b.missedSinceLast - a.missedSinceLast ||
        nameOf(a.participantId).localeCompare(nameOf(b.participantId), "ko") ||
        a.participantId.localeCompare(b.participantId),
    );
}
