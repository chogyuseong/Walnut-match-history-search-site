import { describe, expect, it } from "vitest";
import {
  api,
  fingerprint,
  login,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
} from "./helpers";

// 괄호 안 번호는 docs/P4 P4-5의 검증 시나리오 번호다.

describe("경기 시작", () => {
  it("한 요청으로 경기·명단·순환 사건이 함께 저장된다", async () => {
    const g = await setupGroup();
    const res = await start(g, rosterOf(g.people));
    expect(res.status).toBe(200);
    expect(res.body.match.state).toBe("in_progress");
    expect(res.body.match.matchNo).toBe(1);
    expect(res.body.match.roster).toHaveLength(10);
    const snap = await snapshot(g);
    expect(snap.group.liveVersion).toBe(1);
    expect(snap.session).not.toBeNull();
    expect(snap.rotation?.events).toHaveLength(2);
    expect(snap.rotation?.events.every((e) => e.kind === "used")).toBe(true);
  });

  it("같은 요청 ID로 다시 보내도 경기와 순환 사건이 늘지 않는다 (5)", async () => {
    const g = await setupGroup();
    const body = {
      requestId: requestId(),
      baseLiveVersion: 0,
      roster: rosterOf(g.people),
    };
    const first = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, body);
    const second = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, body);
    const third = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.body.match.id).toBe(first.body.match.id);
    const snap = await snapshot(g);
    expect(snap.matches).toHaveLength(1);
    expect(snap.rotation?.events).toHaveLength(2);
  });

  it("같은 요청 ID에 다른 내용을 보내면 거절한다", async () => {
    const g = await setupGroup();
    const id = requestId();
    const roster = rosterOf(g.people);
    await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: id,
      baseLiveVersion: 0,
      roster,
    });
    const swapped = roster.map((r) => ({ ...r, team: r.team === "A" ? "B" : "A" }));
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: id,
      baseLiveVersion: 0,
      roster: swapped,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_ID_REUSED");
  });

  it("무효 참가자가 있으면 아무것도 저장하지 않는다 (6)", async () => {
    const g = await setupGroup();
    const before = fingerprint(await snapshot(g));
    const roster = rosterOf(g.people);
    roster[3] = { ...roster[3]!, participantId: "없는-참가자" };
    const res = await start(g, roster);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARTICIPANT");
    expect(res.body.error.details.participantIds).toEqual(["없는-참가자"]);
    expect(fingerprint(await snapshot(g))).toBe(before);
  });

  it("인원·팀·포지션이 어긋난 명단을 거절한다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const nine = await start(g, roster.slice(0, 9));
    expect(nine.body.error.code).toBe("INVALID_ROSTER");
    const sixFour = await start(
      g,
      roster.map((r, i) => (i === 5 ? { ...r, team: "A" as const } : r)),
    );
    expect(sixFour.body.error.code).toBe("INVALID_ROSTER");
    const dupPosition = await start(
      g,
      roster.map((r, i) => (i === 1 ? { ...r, position: "top" as const } : r)),
    );
    expect(dupPosition.body.error.code).toBe("INVALID_ROSTER");
    const dupPerson = await start(
      g,
      roster.map((r, i) => (i === 9 ? { ...r, participantId: roster[0]!.participantId } : r)),
    );
    expect(dupPerson.body.error.code).toBe("INVALID_ROSTER");
    expect((await snapshot(g)).matches).toHaveLength(0);
  });

  it("오래된 진행 상태 버전으로 보낸 시작을 거절한다 (10)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const body = () => ({ requestId: requestId(), baseLiveVersion: 0, roster });
    const [a, b] = await Promise.all([
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, body()),
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, body()),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const failed = a.status === 409 ? a : b;
    expect(["VERSION_CONFLICT", "MATCH_IN_PROGRESS"]).toContain(failed.body.error.code);
    expect((await snapshot(g)).matches).toHaveLength(1);
  });

  it("진행 중 경기가 있으면 명시적으로 대기로 넘겨야 다음 경기를 시작한다 (27)", async () => {
    const g = await setupGroup();
    const first = await start(g, rosterOf(g.people));
    const blocked = await start(g, rosterOf(g.people));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("MATCH_IN_PROGRESS");

    const moved = await start(g, rosterOf(g.people), {
      moveCurrentToAwaiting: first.body.match.id,
      ackRepeat: rosterOf(g.people)
        .filter((r) => r.position === "support")
        .map((r) => r.participantId),
    });
    expect(moved.status).toBe(200);
    const snap = await snapshot(g);
    const states = snap.matches.map((m) => m.state).sort();
    expect(states).toEqual(["awaiting_result", "in_progress"]);
  });
});

describe("결과 확정과 진영", () => {
  it("팀 A가 레드에서 이기면 팀 A의 진영이 레드로 저장된다 (2)", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people), "A", "red");
    expect(match.state).toBe("confirmed");
    expect(match.winnerTeam).toBe("A");
    expect(match.teamASide).toBe("red");
  });

  it("팀 B가 블루에서 이기면 팀 A의 진영은 레드다", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people), "B", "blue");
    expect(match.winnerTeam).toBe("B");
    expect(match.teamASide).toBe("red");
  });

  it("진영 미상으로 저장한 뒤 진영만 정정하면 승리 팀은 그대로다 (4)", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people), "B", "unknown");
    expect(match.teamASide).toBe("unknown");
    const corrected = await matchAction(g, match, "correct", { field: "side", winnerSide: "red" });
    expect(corrected.status).toBe(200);
    expect(corrected.body.match.winnerTeam).toBe("B");
    expect(corrected.body.match.teamASide).toBe("blue");
    expect(corrected.body.match.id).toBe(match.id);
    const snap = await snapshot(g);
    const revision = snap.revisions.find((r) => r.kind === "correction");
    expect(revision?.changes.teamASide).toEqual({ from: "unknown", to: "blue" });
    expect(revision?.changes.winnerTeam).toBeUndefined();
  });

  it("다음 경기를 준비해도 진행 중 경기의 명단은 시작 때 그대로다 (1)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const started = await start(g, roster);
    // 서버에는 초안이 없으므로 초안을 바꾸는 요청 자체가 존재하지 않는다.
    const confirmed = await matchAction(g, started.body.match, "result", {
      winnerTeam: "A",
      winnerSide: "blue",
    });
    const sortById = (r: typeof roster) =>
      [...r].sort((a, b) => a.participantId.localeCompare(b.participantId));
    expect(sortById(confirmed.body.match.roster)).toEqual(sortById(roster));
  });

  it("결과 저장을 같은 요청 ID로 다시 보내도 이력이 한 줄이다 (7)", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    const body = {
      requestId: requestId(),
      baseMatchVersion: started.body.match.version,
      winnerTeam: "A",
      winnerSide: "blue",
    };
    const path = `/api/groups/${g.gid}/matches/${started.body.match.id}/result`;
    const first = await api(g.cookie, "POST", path, body);
    const second = await api(g.cookie, "POST", path, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.revisions.filter((r) => r.kind === "result")).toHaveLength(1);
  });

  it("같은 명단·같은 승패의 새 경기는 정상 저장된다 (8)", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const supporters = roster.filter((r) => r.position === "support").map((r) => r.participantId);
    const first = await playConfirmed(g, roster, "A", "blue");
    const second = await playConfirmed(g, roster, "A", "blue", { ackRepeat: supporters });
    expect(second.id).not.toBe(first.id);
    const snap = await snapshot(g);
    expect(snap.matches.filter((m) => m.state === "confirmed")).toHaveLength(2);
  });

  it("오래된 경기 버전으로 보낸 정정을 거절하고 아무것도 바꾸지 않는다 (9)", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people));
    const excluded = await matchAction(g, match, "exclude");
    expect(excluded.body.match.state).toBe("excluded");
    const before = fingerprint(await snapshot(g));
    // 제외 전에 열어 둔 창에서 보낸 정정
    const stale = await matchAction(g, match, "correct", { field: "side", winnerSide: "red" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect(fingerprint(await snapshot(g))).toBe(before);
  });
});

describe("결과 입력 대기·제외·복구", () => {
  it("대기 경기는 결과를 넣으면 확정되고 순환 사건은 그대로다 (28)", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    const waiting = await matchAction(g, started.body.match, "end-later");
    expect(waiting.body.match.state).toBe("awaiting_result");
    const eventsBefore = (await snapshot(g)).rotation?.events;
    const confirmed = await matchAction(g, waiting.body.match, "result", {
      winnerTeam: "B",
      winnerSide: "unknown",
    });
    expect(confirmed.body.match.state).toBe("confirmed");
    expect((await snapshot(g)).rotation?.events).toEqual(eventsBefore);
  });

  it("전적 제외 뒤 복구하면 제외 전 상태로 돌아간다 (32)", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people), "A", "blue");
    const excluded = await matchAction(g, match, "exclude");
    expect(excluded.body.match.state).toBe("excluded");
    const restored = await matchAction(g, excluded.body.match, "restore");
    expect(restored.body.match.state).toBe("confirmed");
    expect(restored.body.match.winnerTeam).toBe("A");
    expect(restored.body.match.teamASide).toBe("blue");
    const kinds = (await snapshot(g)).revisions.map((r) => r.kind);
    expect(kinds).toContain("exclude");
    expect(kinds).toContain("restore");
  });

  it("진행 중 경기는 전적 제외할 수 없다", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    const res = await matchAction(g, started.body.match, "exclude");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATE_CONFLICT");
  });
});

describe("지난 경기 입력", () => {
  it("현재 경기·순환·진행 상태 버전을 바꾸지 않는다 (23)", async () => {
    const g = await setupGroup();
    await start(g, rosterOf(g.people));
    const before = await snapshot(g);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, {
      requestId: requestId(),
      playedAt: "2026-10-01T12:00:00.000Z",
      roster: rosterOf(g.people).map((r) => ({ ...r, position: null })),
      winnerTeam: "B",
      winnerSide: "unknown",
    });
    expect(res.status).toBe(200);
    expect(res.body.match.state).toBe("confirmed");
    expect(res.body.match.source).toBe("backfill");
    expect(res.body.match.sessionId).toBeNull();
    const after = await snapshot(g);
    expect(after.group.liveVersion).toBe(before.group.liveVersion);
    expect(after.rotation).toEqual(before.rotation);
    expect(after.matches.filter((m) => m.state === "in_progress")).toHaveLength(1);
  });
});

describe("권한 (11)", () => {
  it("로그인하지 않은 요청은 거절되고 아무것도 바뀌지 않는다", async () => {
    const g = await setupGroup();
    const before = fingerprint(await snapshot(g));
    const res = await api(null, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: 0,
      roster: rosterOf(g.people),
    });
    expect(res.status).toBe(401);
    expect(fingerprint(await snapshot(g))).toBe(before);
  });

  it("변조한 세션 쿠키는 인정하지 않는다", async () => {
    const g = await setupGroup();
    const forged = `${g.cookie.slice(0, -3)}abc`;
    const res = await api(forged, "GET", `/api/groups/${g.gid}/snapshot`);
    expect(res.status).toBe(401);
  });

  it("다른 모임의 운영자는 없는 모임과 같은 응답을 받고 아무것도 바꾸지 못한다", async () => {
    const g = await setupGroup();
    const other = await login();
    const before = fingerprint(await snapshot(g));
    const foreign = await api(other, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: 0,
      roster: rosterOf(g.people),
    });
    const missing = await api(other, "POST", "/api/groups/없는-모임/matches/start", {
      requestId: requestId(),
      baseLiveVersion: 0,
      roster: rosterOf(g.people),
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect((await api(other, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
    expect((await api(other, "GET", `/api/groups/${g.gid}/export`)).status).toBe(404);
    expect(fingerprint(await snapshot(g))).toBe(before);
  });

  it("다른 모임의 참가자를 명단에 넣을 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const roster = rosterOf(g.people);
    roster[0] = { ...roster[0]!, participantId: other.people[0]!.id };
    const res = await start(g, roster);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARTICIPANT");
  });

  it("다른 모임의 경기 ID로는 결과를 저장할 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const started = await start(other, rosterOf(other.people));
    const res = await matchAction(g, started.body.match, "result", {
      winnerTeam: "A",
      winnerSide: "blue",
    });
    expect(res.status).toBe(404);
    expect((await snapshot(other)).matches[0]!.state).toBe("in_progress");
  });

  it("조회 토큰으로는 읽기만 되고 수정 경로가 열리지 않는다", async () => {
    const g = await setupGroup();
    const token = (await snapshot(g)).group.viewToken!;
    const view = await api(null, "GET", `/api/view/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.role).toBe("viewer");
    const write = await api(null, "POST", `/api/view/${token}`, {});
    expect(write.status).toBe(404);
  });

  it("토큰을 재발급하면 이전 링크가 열리지 않는다", async () => {
    const g = await setupGroup();
    const oldToken = (await snapshot(g)).group.viewToken!;
    const renewed = await api(g.cookie, "POST", `/api/groups/${g.gid}/view-token`);
    expect((await api(null, "GET", `/api/view/${oldToken}`)).status).toBe(404);
    expect((await api(null, "GET", `/api/view/${renewed.body.viewToken}`)).status).toBe(200);
  });

  it("허용하지 않은 필드와 너무 큰 요청을 거절한다", async () => {
    const g = await setupGroup();
    const unknown = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: 0,
      roster: rosterOf(g.people),
      isAdmin: true,
    });
    expect(unknown.body.error.code).toBe("UNKNOWN_FIELD");
    const big = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, {
      names: ["가".repeat(20000)],
    });
    expect(big.status).toBe(413);
  });
});

describe("비공개 실력 그룹 (12)", () => {
  it("조회 응답 어디에도 그룹·가중치·토큰이 없다", async () => {
    const g = await setupGroup();
    for (const [i, p] of g.people.entries()) {
      await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${p.id}`, {
        skillGroup: (i % 4) + 1,
      });
    }
    await playConfirmed(g, rosterOf(g.people));
    const operator = await snapshot(g);
    expect(operator.participants.find((p) => p.id === g.people[0]!.id)?.skillGroup).toBe(1);
    const view = await api(null, "GET", `/api/view/${operator.group.viewToken}`);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain("skillGroup");
    expect(text).not.toContain(operator.group.viewToken!);
    expect(text).not.toContain("settingsVersionId");
    expect(view.body.group.settings.groupWeights).toEqual([0, 0, 0, 0]);
  });

  it("그룹 공개로 바꾸면 조회 응답에 그룹이 나온다", async () => {
    const g = await setupGroup();
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, {
      skillGroup: 2,
    });
    const before = await snapshot(g);
    const saved = await api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: before.group.settingsVersionId,
      settings: { ...before.group.settings, groupsPublic: true },
    });
    expect(saved.status).toBe(200);
    const view = await api(null, "GET", `/api/view/${before.group.viewToken}`);
    const shown = view.body.participants.find((p: { id: string }) => p.id === g.people[0]!.id);
    expect(shown.skillGroup).toBe(2);
  });

  it("백업에는 계정·토큰·요청 기록이 없다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    const token = (await snapshot(g)).group.viewToken!;
    const backup = await api(g.cookie, "GET", `/api/groups/${g.gid}/export`);
    expect(backup.status).toBe(200);
    // 형식 4: 복원용 값(제외 직전 상태 등), 중복 참가자 합치기 기록, 일괄 입력 출처·지문을 더한 형식(src/server/restore.ts).
    expect(backup.body.formatVersion).toBe(4);
    expect(backup.body.matchCount).toBe(1);
    const text = JSON.stringify(backup.body);
    expect(text).not.toContain(token);
    expect(text).not.toContain("account");
    expect(text).not.toContain("requestId");
  });
});

describe("지난 경기 한 건 입력의 미래 시각(서버 검사)", () => {
  const body = (g: Awaited<ReturnType<typeof setupGroup>>, playedAt: string) => ({
    requestId: requestId(),
    playedAt,
    roster: rosterOf(g.people),
    winnerTeam: "A",
    winnerSide: "blue",
  });

  it("허용 폭(60초) 안은 저장하고, 넘으면 400 FUTURE_MATCH로 거절하며 아무것도 저장하지 않는다", async () => {
    const g = await setupGroup();
    const within = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, body(g, new Date(Date.now() + 30_000).toISOString()));
    expect(within.status).toBe(200);
    const before = await snapshot(g);
    for (const ahead of [5 * 60_000, 3 * 86400_000]) {
      const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, body(g, new Date(Date.now() + ahead).toISOString()));
      expect(res.status, String(ahead)).toBe(400);
      expect(res.body.error.code).toBe("FUTURE_MATCH");
      expect(res.body.error.message).toContain("아직 오지 않은 시각");
    }
    const after = await snapshot(g);
    expect(fingerprint(after)).toBe(fingerprint(before));
    expect(after.matches).toHaveLength(1);
  });
});
