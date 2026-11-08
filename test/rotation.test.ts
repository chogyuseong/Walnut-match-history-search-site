import { describe, expect, it } from "vitest";
import type { Position, RosterEntry } from "../src/shared/types";
import {
  api,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
} from "./helpers";

// 괄호 안 번호는 docs/P4 P4-5의 검증 시나리오 번호다.

/** 같은 팀 안에서 두 사람의 포지션을 맞바꾼다. */
function swap(roster: RosterEntry[], a: number, b: number): RosterEntry[] {
  const next = roster.map((r) => ({ ...r }));
  const pa = next[a]!.position;
  next[a]!.position = next[b]!.position;
  next[b]!.position = pa;
  return next;
}

/** 팀 A의 한 사람과 팀 B의 한 사람을 자리째 맞바꾼다(팀과 포지션을 교환). */
function crossTeams(roster: RosterEntry[], a: number, b: number): RosterEntry[] {
  const next = roster.map((r) => ({ ...r }));
  const idA = next[a]!.participantId;
  next[a]!.participantId = next[b]!.participantId;
  next[b]!.participantId = idA;
  return next;
}

function supporters(roster: RosterEntry[]): string[] {
  return roster.filter((r) => r.position === "support").map((r) => r.participantId);
}

describe("서포터 순환 — 서버 재검사", () => {
  it("이미 차례를 쓴 사람이 서포터면 확인 없이는 시작할 수 없다 (24)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    const before = await snapshot(g);

    const refused = await start(g, roster);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SUPPORT_REPEAT");
    expect(refused.body.error.details.participantIds.sort()).toEqual(supporters(roster).sort());
    const afterRefusal = await snapshot(g);
    expect(afterRefusal.matches).toHaveLength(1);
    expect(afterRefusal.rotation).toEqual(before.rotation);

    const accepted = await start(g, roster, { ackRepeat: supporters(roster) });
    expect(accepted.status).toBe(200);
    const events = (await snapshot(g)).rotation!.events;
    expect(events.filter((e) => e.kind === "used")).toHaveLength(2);
    // 반복 허용은 별도 사건으로 남고 "사용" 수를 늘리지 않는다.
    expect(events.filter((e) => e.kind === "repeat")).toHaveLength(2);
  });

  it("팀을 옮겨도 사용한 차례는 사람에게 남는다 (16)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    // 팀 A 서포터(4번)와 팀 B 서포터(9번)를 서로 다른 팀으로 옮긴다.
    const moved = crossTeams(roster, 4, 9);
    const refused = await start(g, moved);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("SUPPORT_REPEAT");
  });

  it("차례를 쓰지 않은 사람으로 바꾸면 확인 없이 시작된다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    const next = swap(swap(roster, 3, 4), 8, 9);
    const res = await start(g, next);
    expect(res.status).toBe(200);
    const events = (await snapshot(g)).rotation!.events;
    expect(events.filter((e) => e.kind === "used")).toHaveLength(4);
    expect(events.filter((e) => e.kind === "repeat")).toHaveLength(0);
  });

  it("미진행 취소는 차례를 돌려주고 전적 제외는 차례를 유지한다 (22)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const confirmed = await playConfirmed(g, roster);
    const second = await start(g, swap(swap(roster, 3, 4), 8, 9));
    expect((await snapshot(g)).rotation!.events).toHaveLength(4);

    // 전적 제외: 사건은 그대로다.
    await matchAction(g, confirmed, "exclude");
    expect((await snapshot(g)).rotation!.events).toHaveLength(4);

    // 미진행 취소: 그 경기의 사건 두 개가 무효가 된다.
    const canceled = await matchAction(g, second.body.match, "cancel");
    expect(canceled.status).toBe(200);
    expect(canceled.body.match.state).toBe("canceled");
    const events = (await snapshot(g)).rotation!.events;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.matchId === confirmed.id)).toBe(true);
  });

  it("취소로 차례를 돌려받은 사람의 뒤 반복 사건은 물어본 뒤에 바꾼다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const first = await start(g, roster);
    const waiting = await matchAction(g, first.body.match, "end-later");
    await playConfirmed(g, roster, "A", "blue", { ackRepeat: supporters(roster) });

    const undecided = await matchAction(g, waiting.body.match, "cancel");
    expect(undecided.status).toBe(409);
    expect(undecided.body.error.code).toBe("ROTATION_DECISION_REQUIRED");
    expect((await snapshot(g)).matches.find((m) => m.id === first.body.match.id)!.state).toBe(
      "awaiting_result",
    );

    const decided = await matchAction(g, waiting.body.match, "cancel", { convertRepeats: true });
    expect(decided.status).toBe(200);
    const events = (await snapshot(g)).rotation!.events;
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === "used")).toBe(true);
  });

  it("새 순환을 시작하면 후보가 초기화되고 전적은 그대로다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    const before = await snapshot(g);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/new-cycle`, {
      requestId: requestId(),
      baseLiveVersion: before.group.liveVersion,
    });
    expect(res.status).toBe(200);
    const after = await snapshot(g);
    expect(after.rotation!.cycleId).not.toBe(before.rotation!.cycleId);
    // 새 주기가 열린 시각이 함께 온다(화면의 "언제부터 세는지"). 이전 주기보다 뒤다.
    expect(after.rotation!.cycleStartedAt).toBeTruthy();
    expect(before.rotation!.cycleStartedAt).toBeTruthy();
    expect(after.rotation!.cycleStartedAt! >= before.rotation!.cycleStartedAt!).toBe(true);
    expect(after.rotation!.events).toHaveLength(0);
    expect(after.matches).toEqual(before.matches);
    // 새 주기에서는 같은 사람이 확인 없이 서포터를 할 수 있다.
    expect((await start(g, roster)).status).toBe(200);
  });

  it("새 내전(세션)은 새 순환 주기로 시작한다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    const res = await start(g, roster, { newSession: true });
    expect(res.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.rotation!.events).toHaveLength(2);
    expect(snap.rotation!.events.every((e) => e.kind === "used")).toBe(true);
  });

  it("순환을 끄면 사건을 만들지 않고 기존 사건은 남는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    const before = await snapshot(g);
    await api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: before.group.settingsVersionId,
      settings: { ...before.group.settings, rotationEnabled: false },
    });
    const res = await start(g, roster);
    expect(res.status).toBe(200);
    expect((await snapshot(g)).rotation!.events).toEqual(before.rotation!.events);
  });

  it("오늘 내전을 마치면 세션이 닫히고 진행 중 경기가 있으면 마칠 수 없다", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    const live = (await snapshot(g)).group.liveVersion;
    const blocked = await api(g.cookie, "POST", `/api/groups/${g.gid}/session/close`, {
      requestId: requestId(),
      baseLiveVersion: live,
    });
    expect(blocked.body.error.code).toBe("MATCH_IN_PROGRESS");
    await matchAction(g, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    const closed = await api(g.cookie, "POST", `/api/groups/${g.gid}/session/close`, {
      requestId: requestId(),
      baseLiveVersion: (await snapshot(g)).group.liveVersion,
    });
    expect(closed.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.session).toBeNull();
    expect(snap.rotation).toBeNull();
  });
});

describe("정정과 서포터 차례 기록 (25)", () => {
  it("서포터가 바뀌는 포지션 정정은 차례 기록 처리를 정해야 한다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const match = await playConfirmed(g, roster);
    const adc = roster[3]!.participantId;
    const support = roster[4]!.participantId;
    const positions: { participantId: string; position: Position }[] = [
      { participantId: adc, position: "support" },
      { participantId: support, position: "adc" },
    ];

    const undecided = await matchAction(g, match, "correct", { field: "positions", positions });
    expect(undecided.status).toBe(409);
    expect(undecided.body.error.code).toBe("ROTATION_DECISION_REQUIRED");
    expect(undecided.body.error.details).toMatchObject({ team: "A", from: support, to: adc });

    const fixed = await matchAction(g, match, "correct", {
      field: "positions",
      positions,
      fixRotation: true,
    });
    expect(fixed.status).toBe(200);
    const after = fixed.body.match.roster;
    expect(after.find((r) => r.participantId === adc)!.position).toBe("support");
    expect(after.find((r) => r.participantId === support)!.position).toBe("adc");
    const events = (await snapshot(g)).rotation!.events;
    expect(events.map((e) => e.participantId)).toContain(adc);
    expect(events.map((e) => e.participantId)).not.toContain(support);
  });

  it("차례 기록을 그대로 두기로 하면 명단만 바뀐다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const match = await playConfirmed(g, roster);
    const before = (await snapshot(g)).rotation!.events;
    const res = await matchAction(g, match, "correct", {
      field: "positions",
      positions: [
        { participantId: roster[3]!.participantId, position: "support" },
        { participantId: roster[4]!.participantId, position: "adc" },
      ],
      fixRotation: false,
    });
    expect(res.status).toBe(200);
    expect((await snapshot(g)).rotation!.events).toEqual(before);
  });

  it("서포터와 무관한 포지션 정정은 묻지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const match = await playConfirmed(g, roster);
    const res = await matchAction(g, match, "correct", {
      field: "positions",
      positions: [
        { participantId: roster[0]!.participantId, position: "jungle" },
        { participantId: roster[1]!.participantId, position: "top" },
      ],
    });
    expect(res.status).toBe(200);
  });

  it("참가자 교체 정정은 나머지 9명과 승패를 바꾸지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const match = await playConfirmed(g, roster, "B", "red");
    const outId = roster[0]!.participantId;
    const inId = g.people[10]!.id;
    const res = await matchAction(g, match, "correct", {
      field: "participant",
      outParticipantId: outId,
      inParticipantId: inId,
    });
    expect(res.status).toBe(200);
    const after = res.body.match;
    expect(after.winnerTeam).toBe("B");
    expect(after.roster.map((r) => r.participantId)).toContain(inId);
    expect(after.roster.map((r) => r.participantId)).not.toContain(outId);
    expect(after.roster.find((r) => r.participantId === inId)).toMatchObject({
      team: "A",
      position: "top",
    });
    // 이미 경기에 있는 사람으로는 바꿀 수 없다.
    const dup = await matchAction(g, after, "correct", {
      field: "participant",
      outParticipantId: inId,
      inParticipantId: roster[1]!.participantId,
    });
    expect(dup.status).toBe(400);
  });

  it("승리 팀 정정은 진영을 다시 받아 함께 저장한다", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people), "A", "blue");
    const missingSide = await matchAction(g, match, "correct", {
      field: "winner",
      winnerTeam: "B",
    });
    expect(missingSide.status).toBe(400);
    const res = await matchAction(g, match, "correct", {
      field: "winner",
      winnerTeam: "B",
      winnerSide: "red",
    });
    expect(res.status).toBe(200);
    expect(res.body.match.winnerTeam).toBe("B");
    // 팀 B가 레드였다면 팀 A는 블루다. 진영 자체는 바뀌지 않았다.
    expect(res.body.match.teamASide).toBe("blue");
  });
});

describe("참가자", () => {
  it("같은 이름으로 여러 번 불러도 같은 참가자를 돌려준다", async () => {
    const g = await setupGroup(3);
    const again = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, {
      names: ["  참가자1 ", "새사람"],
    });
    expect(again.body.participants[0].id).toBe(g.people[0]!.id);
    expect((await snapshot(g)).participants).toHaveLength(4);
  });

  it("이름을 바꿔도 과거 경기의 소속은 그대로다", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people));
    const target = g.people[0]!;
    const renamed = await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${target.id}`, {
      name: "바뀐이름",
    });
    expect(renamed.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.participants.find((p) => p.id === target.id)!.name).toBe("바뀐이름");
    expect(snap.matches.find((m) => m.id === match.id)!.roster.map((r) => r.participantId)).toContain(
      target.id,
    );
  });

  it("활성 참가자와 같은 이름으로는 바꿀 수 없다", async () => {
    const g = await setupGroup(3);
    const res = await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, {
      name: "참가자2",
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("NAME_TAKEN");
  });
});
