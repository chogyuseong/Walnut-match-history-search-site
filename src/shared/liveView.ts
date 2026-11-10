import { resolveMerged } from "./merge";
import { POSITIONS, type MatchView, type Position, type RosterEntry, type Snapshot, type Team } from "./types";

/**
 * 참가자 편성 화면(#/v/토큰/live, src/web/screens/ViewerLive.tsx)의 순수 계산(2026-11-10 실험 B-1).
 * 설계: docs/개선-경험-설계-2026-11-10.md 5·6절. 화면은 DOM이 없는 이 파일의 결과만 그린다(vitest가 Workers 런타임이라).
 * 스냅숏은 liveDataOf 한 곳에서만 읽는다. 나중에 경량 응답(B-2)으로 바꿀 때 이 함수만 고치면 되게 하려는 것이다.
 */

export type LivePhase = "waiting" | "playing" | "idle";

export interface LiveData {
  groupName: string;
  timeZone: string;
  maintenance: boolean;
  /** 열린 내전이 있는지(서버가 아는 것은 이것뿐이다. 운영자가 다음 편성을 짜는 중인지는 모른다). */
  sessionOpen: boolean;
  /** 가장 최근 내전의 경기(취소·전적 제외 빼고). 내전 없이 들어온 경기면 그 경기 하나. */
  matches: MatchView[];
  /** 진행 중 경기, 없으면 최근 경기. 둘 다 없으면 null. */
  shown: MatchView | null;
  phase: LivePhase;
  nameOf: (id: string) => string;
  /** 합쳐진 사람의 옛 ID → 남은 사람의 ID. 기기에 저장한 "내 이름"이 합치기 전 ID일 수 있다. */
  resolve: (id: string) => string;
}

export function liveDataOf(snapshot: Snapshot): LiveData {
  const names = new Map(snapshot.participants.map((p) => [p.id, p.name]));
  const live = snapshot.matches.find((m) => m.state === "in_progress") ?? null;
  const shown = live ?? latestMatch(snapshot.matches);
  const sessionOpen = snapshot.session !== null;
  const matches = !shown
    ? []
    : shown.sessionId === null
      ? [shown]
      : snapshot.matches.filter(
          (m) => m.sessionId === shown.sessionId && m.state !== "canceled" && m.state !== "excluded",
        );
  return {
    groupName: snapshot.group.name,
    timeZone: snapshot.group.timezone,
    maintenance: snapshot.group.maintenance === true,
    sessionOpen,
    matches,
    shown,
    phase: live ? "playing" : sessionOpen ? "waiting" : "idle",
    nameOf: (id) => names.get(id) ?? "(알 수 없음)",
    resolve: (id) => resolveMerged(snapshot.participants, id),
  };
}

/** 최근 경기: 미진행 취소·전적 제외가 아닌 경기 중 경기 시각이 가장 늦은 것(같으면 번호가 큰 것). */
function latestMatch(matches: readonly MatchView[]): MatchView | null {
  let best: MatchView | null = null;
  for (const m of matches) {
    if (m.state === "canceled" || m.state === "excluded") continue;
    if (!best || m.playedAt > best.playedAt || (m.playedAt === best.playedAt && m.matchNo > best.matchNo)) best = m;
  }
  return best;
}

function positionOrder(p: Position | null): number {
  return p === null ? POSITIONS.length : POSITIONS.indexOf(p);
}

export interface Seat {
  team: Team;
  position: Position | null;
  /** 같은 팀 나머지(라인 순). */
  teammates: RosterEntry[];
  /** 상대 팀 같은 라인. 포지션 없는 경기면 null. */
  opponent: RosterEntry | null;
}

/** 그 경기에서 id의 자리. 명단에 없으면 null. id는 resolve를 거친 값을 넘긴다. */
export function seatOf(match: MatchView, id: string): Seat | null {
  const me = match.roster.find((r) => r.participantId === id);
  if (!me) return null;
  const teammates = match.roster
    .filter((r) => r.team === me.team && r.participantId !== id)
    .sort((a, b) => positionOrder(a.position) - positionOrder(b.position));
  const opponent =
    me.position === null ? null : (match.roster.find((r) => r.team !== me.team && r.position === me.position) ?? null);
  return { team: me.team, position: me.position, teammates, opponent };
}

export interface SeatChange {
  team: Team;
  position: Position | null;
  outId: string;
  inId: string;
}

/**
 * 같은 경기 안에서 바뀐 자리. 경기 ID가 다르면 비교하지 않는다(새 경기는 "편성이 올라왔어요" 한 줄로 알린다).
 * 포지션이 있으면 팀·라인 칸마다, 없으면 팀마다 빠진 사람과 들어온 사람을 순서대로 짝짓는다.
 * 두 사람이 자리를 맞바꾸면 두 칸이 바뀐 것이라 두 건이다.
 */
export function rosterChanges(prev: MatchView, next: MatchView): SeatChange[] {
  if (prev.id !== next.id) return [];
  const changes: SeatChange[] = [];
  for (const team of ["A", "B"] as const) {
    const before = prev.roster.filter((r) => r.team === team);
    const after = next.roster.filter((r) => r.team === team);
    if (after.every((r) => r.position !== null) && before.every((r) => r.position !== null)) {
      for (const seat of after) {
        const old = before.find((r) => r.position === seat.position);
        if (old && old.participantId !== seat.participantId) {
          changes.push({ team, position: seat.position, outId: old.participantId, inId: seat.participantId });
        }
      }
      continue;
    }
    const afterIds = new Set(after.map((r) => r.participantId));
    const beforeIds = new Set(before.map((r) => r.participantId));
    const outs = before.filter((r) => !afterIds.has(r.participantId));
    const ins = after.filter((r) => !beforeIds.has(r.participantId));
    for (let i = 0; i < Math.min(outs.length, ins.length); i++) {
      changes.push({ team, position: null, outId: outs[i]!.participantId, inId: ins[i]!.participantId });
    }
  }
  return changes;
}

/** 그날(넘겨준 경기들) 성적. 결과가 확정된 경기만 승패로 세고, 결과 입력 대기는 pending으로 따로 센다. */
export function dayRecordOf(matches: readonly MatchView[], id: string): { wins: number; losses: number; pending: number } {
  const record = { wins: 0, losses: 0, pending: 0 };
  for (const m of matches) {
    const me = m.roster.find((r) => r.participantId === id);
    if (!me) continue;
    if (m.state === "awaiting_result") record.pending += 1;
    else if (m.state === "confirmed" && m.winnerTeam) {
      if (m.winnerTeam === me.team) record.wins += 1;
      else record.losses += 1;
    }
  }
  return record;
}

/*
 * 자동 확인 간격(설계 6절 "B-1 확인 규칙"). 바꾸면 요청 수가 그대로 달라진다: 한 명이 한 판에 약 70번(대기 15초 × 10분 + 경기 60초 × 30분).
 * 조회 응답은 ETag가 같으면 304라 요청 수 제한·D1 쓰기를 쓰지 않는다. 바뀐 응답(200)만 view-ip 한도(IP당 분 30회)를 쓴다.
 */
/** 대기(열린 내전, 진행 중 경기 없음): 운영자가 곧 시작할 수 있어 짧게. */
export const POLL_WAITING_MS = 15_000;
/** 대기가 이만큼 조용하면 간격을 POLL_WAITING_SLOW_MS로 늘린다. */
export const WAITING_SLOW_AFTER_MS = 10 * 60_000;
export const POLL_WAITING_SLOW_MS = 30_000;
/** 대기 중 변화 없이 이만큼 지나면 멈춘다(내전을 닫지 않고 끝낸 날). */
export const WAITING_STOP_AFTER_MS = 60 * 60_000;
/** 경기 중: 한 판이 30분 안팎이고 그 사이 바뀌는 것은 사람 교체뿐이다. 멈추지 않는다. */
export const POLL_PLAYING_MS = 60_000;
/** 한가함(열린 내전 없음). */
export const POLL_IDLE_MS = 120_000;
export const IDLE_STOP_AFTER_MS = 30 * 60_000;
/** 실패하면 간격을 두 배씩, 이 값까지. */
export const POLL_FAILURE_MAX_MS = 5 * 60_000;
/** 연속 실패가 이만큼이면 멈춘다(429 포함). "지금 확인"으로 다시 시작한다. */
export const POLL_MAX_FAILURES = 5;
/** 흩뜨림 ±20%: 같은 IP(같은 와이파이)의 여러 명이 같은 초에 몰리지 않게. */
export const POLL_JITTER = 0.2;

/**
 * 다음 확인까지 기다릴 시간(ms). null이면 자동 확인을 멈춘다.
 * quietMs는 마지막으로 내용이 바뀐 뒤(처음 연 뒤) 지난 시간, failures는 연속 실패 수, retryAfterMs는 429의 retryAfter.
 * random은 0~1(Math.random). 404는 여기로 오지 않는다(화면이 곧바로 멈춘다).
 */
export function nextPollDelay(
  s: { phase: LivePhase; failures: number; quietMs: number; retryAfterMs?: number },
  random: () => number,
): number | null {
  if (s.failures >= POLL_MAX_FAILURES) return null;
  const jitter = 1 - POLL_JITTER + 2 * POLL_JITTER * random();
  // 429는 서버가 알려 준 시각 전에 다시 보내면 또 거절되므로 아래쪽으로는 흩뜨리지 않는다.
  if (s.failures > 0 && s.retryAfterMs !== undefined) return Math.round(s.retryAfterMs * (1 + POLL_JITTER * random()));
  let base: number;
  if (s.phase === "playing") base = POLL_PLAYING_MS;
  else if (s.phase === "waiting") {
    if (s.failures === 0 && s.quietMs >= WAITING_STOP_AFTER_MS) return null;
    base = s.quietMs >= WAITING_SLOW_AFTER_MS ? POLL_WAITING_SLOW_MS : POLL_WAITING_MS;
  } else {
    if (s.failures === 0 && s.quietMs >= IDLE_STOP_AFTER_MS) return null;
    base = POLL_IDLE_MS;
  }
  // 실패 뒤에는 흩뜨린 뒤에도 5분을 넘기지 않는다(끊긴 화면이 그보다 오래 멈춰 있지 않게).
  if (s.failures > 0) return Math.min(Math.round(base * 2 ** s.failures * jitter), POLL_FAILURE_MAX_MS);
  return Math.round(base * jitter);
}
