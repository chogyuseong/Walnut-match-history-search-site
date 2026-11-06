import { describe, expect, it } from "vitest";
import { createDraft, type Draft } from "../src/shared/draft";
import { fairRepeatSupporterIds, repeatSupporterIds, rotationContext, supportCounts } from "../src/shared/rotation";
import type { RosterEntry, Team } from "../src/shared/types";
import { api, matchAction, requestId, rosterOf, setupGroup, snapshot, start, type TestGroup } from "./helpers";

// 준비 화면 진영(시작 요청의 teamASide)과 서포터 횟수(활성 주기의 유효 사건 수)의 서버 쪽 확인.

/** 서버 명단과 같은 팀·포지션의 초안. 화면이 시작 전에 계산하는 것과 같은 입력이다. */
function draftOf(roster: RosterEntry[]): Draft {
  const people = roster.map((r) => ({ key: `p:${r.participantId}`, name: r.participantId, participantId: r.participantId }));
  const teamOf: Record<string, Team> = {};
  for (const r of roster) teamOf[`p:${r.participantId}`] = r.team;
  const draft = createDraft(people, { groupId: null, baseLiveVersion: null, seed: 1, now: new Date().toISOString(), teamOf });
  return {
    ...draft,
    slots: draft.slots.map((s) => ({ ...s, position: roster.find((r) => `p:${r.participantId}` === s.key)!.position! })),
  };
}

async function counts(g: TestGroup): Promise<ReadonlyMap<string, number>> {
  const snap = await snapshot(g);
  return supportCounts(rotationContext(true, snap.rotation));
}

/** 앞 5명 팀 A, 뒤 5명 팀 B. 각 팀 서포터를 지정한 사람으로 바꾼 명단. */
function withSupport(g: TestGroup, supA: number, supB: number): RosterEntry[] {
  const base = rosterOf(g.people);
  const swapInTeam = (roster: RosterEntry[], from: number, to: number) => {
    const next = roster.map((r) => ({ ...r }));
    const p = next[from]!.position;
    next[from]!.position = next[to]!.position;
    next[to]!.position = p;
    return next;
  };
  return swapInTeam(swapInTeam(base, 4, supA), 9, supB);
}

describe("시작 요청의 진영", () => {
  it("고른 진영을 진행 중 경기에 저장하고, 결과 입력에서 바꾸면 이력에 원래 값이 남는다", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people), { teamASide: "red" });
    expect(started.status).toBe(200);
    expect(started.body.match.teamASide).toBe("red");
    expect(started.body.match.state).toBe("in_progress");
    // 조회 링크에도 진영이 보인다.
    const view = await api(null, "GET", `/api/view/${(await snapshot(g)).group.viewToken}`);
    expect(view.body.matches[0].teamASide).toBe("red");

    // 결과 저장 때 확인한 값이 최종이다(팀 A 승, 승리 팀 진영 블루 → 팀 A 블루).
    const done = await matchAction(g, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    expect(done.status).toBe(200);
    expect(done.body.match.teamASide).toBe("blue");
    const result = (await snapshot(g)).revisions.find((r) => r.kind === "result")!;
    expect(result.changes.teamASide).toEqual({ from: "red", to: "blue" });
  });

  it("진영을 보내지 않으면 지금처럼 정하지 않은 채로 시작한다", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    expect(started.status).toBe(200);
    expect(started.body.match.teamASide).toBeNull();
  });

  it("블루·레드가 아닌 값(미상 포함)은 거절하고 아무것도 남기지 않는다", async () => {
    const g = await setupGroup();
    for (const bad of ["unknown", "BLUE", 1, "left"]) {
      const res = await start(g, rosterOf(g.people), { teamASide: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await snapshot(g)).matches).toHaveLength(0);
  });

  it("진영을 정해 시작한 경기도 확정 전에는 통계·진영 집계에 들어가지 않는다(취소하면 사라진다)", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people), { teamASide: "blue" });
    const canceled = await matchAction(g, started.body.match, "cancel");
    expect(canceled.status).toBe(200);
    expect(canceled.body.match.state).toBe("canceled");
    expect(canceled.body.match.winnerTeam).toBeNull();
  });
});

describe("서포터 횟수", () => {
  it("같은 사람이 여러 경기 서포터를 하면 경기 수만큼 오르고, 미진행 취소한 경기는 세지 않는다", async () => {
    const g = await setupGroup();
    const supA = g.people[0]!.id;
    const roster = withSupport(g, 0, 9);
    for (let i = 0; i < 3; i++) {
      const s = await start(g, roster, i === 0 ? {} : { ackRepeat: [supA, g.people[9]!.id] });
      expect(s.status).toBe(200);
      await matchAction(g, s.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    }
    expect((await counts(g)).get(supA)).toBe(3);
    const fourth = await start(g, roster, { ackRepeat: [supA, g.people[9]!.id] });
    expect((await counts(g)).get(supA)).toBe(4);
    await matchAction(g, fourth.body.match, "cancel");
    expect((await counts(g)).get(supA)).toBe(3);
  });

  it("초기화(새 주기)하면 모두 0회다. 전적은 그대로다", async () => {
    const g = await setupGroup();
    const s = await start(g, rosterOf(g.people));
    await matchAction(g, s.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    expect([...(await counts(g)).values()].reduce((a, b) => a + b, 0)).toBe(2);
    const reset = await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/new-cycle`, {
      requestId: requestId(),
      baseLiveVersion: (await snapshot(g)).group.liveVersion,
    });
    expect(reset.status).toBe(200);
    expect((await counts(g)).size).toBe(0);
    expect((await snapshot(g)).matches.filter((m) => m.state === "confirmed")).toHaveLength(1);
  });

  it("공평한 반복은 확인 없이 시작되고, 더 적게 간 사람이 있는데 반복하면 확인을 묻는다", async () => {
    const g = await setupGroup();
    // 1~5경기: 팀 A의 다섯 명이 한 번씩 서포터, 팀 B는 늘 같은 사람(people[9])이 서포터.
    const supB = g.people[9]!.id;
    for (let k = 0; k < 5; k++) {
      const s = await start(g, withSupport(g, k, 9), k === 0 ? {} : { ackRepeat: [supB] });
      expect(s.status).toBe(200);
      await matchAction(g, s.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    }
    const snap = await snapshot(g);
    const ctx = rotationContext(snap.group.settings.rotationEnabled, snap.rotation);

    // 팀 A는 모두 1회라 누가 서포터여도 공평하다. 팀 B의 people[9]는 5회, 나머지는 0회라 불공평하다.
    const roster = withSupport(g, 2, 9);
    const draft = draftOf(roster);
    const fair = fairRepeatSupporterIds(draft, ctx);
    const unfair = repeatSupporterIds(draft, ctx);
    expect(fair).toEqual([g.people[2]!.id]);
    expect(unfair).toEqual([supB]);

    // 화면은 공평한 반복만 ackRepeat에 넣어 보낸다 → 서버는 불공평한 쪽만 확인을 요구한다.
    const asked = await start(g, roster, { ackRepeat: fair });
    expect(asked.status).toBe(409);
    expect(asked.body.error.code).toBe("SUPPORT_REPEAT");
    expect(asked.body.error.details.participantIds).toEqual([supB]);
    // 확인 창에서 "이대로 시작"을 누르면 둘 다 넣어 보낸다.
    const ok = await start(g, roster, { ackRepeat: [...fair, ...unfair] });
    expect(ok.status).toBe(200);

    // 팀 B 서포터를 0회인 사람으로 바꾸면 묻지 않고 시작된다.
    await matchAction(g, ok.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    const snap2 = await snapshot(g);
    const ctx2 = rotationContext(true, snap2.rotation);
    const fairRoster = withSupport(g, 3, 5);
    const fairDraft = draftOf(fairRoster);
    // 팀 A: people[2]가 2회, 나머지 1회 → people[3](1회)은 공평. 팀 B: people[5] 0회 → 처음.
    expect(repeatSupporterIds(fairDraft, ctx2)).toEqual([]);
    const smooth = await start(g, fairRoster, { ackRepeat: fairRepeatSupporterIds(fairDraft, ctx2) });
    expect(smooth.status).toBe(200);
  });
});
