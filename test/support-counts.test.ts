import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, type Draft } from "../src/shared/draft";
import {
  fairRepeatSupporterIds,
  repeatSupporterIds,
  resetCountsReady,
  rotationContext,
  supportCounts,
} from "../src/shared/rotation";
import type { ParticipantView, RosterEntry, Snapshot, Team } from "../src/shared/types";
import {
  api,
  login,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
  type TestGroup,
} from "./helpers";

// 서포터 횟수 직접 입력(migrations/0012_support_adjustments.sql, src/server/supportCounts.ts).
// 표시·규칙에 쓰는 횟수 = 사건 수 + 보정값(0 미만이면 0).

function setCounts(g: TestGroup, counts: Record<string, number>, rid = requestId(), cookie = g.cookie) {
  return api(cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
    requestId: rid,
    counts: Object.entries(counts).map(([participantId, count]) => ({ participantId, count })),
  });
}

function countsOf(snap: Snapshot): ReadonlyMap<string, number> {
  return supportCounts(rotationContext(snap.group.settings.rotationEnabled, snap.rotation));
}

async function resetCycle(g: TestGroup) {
  const snap = await snapshot(g);
  return api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/new-cycle`, {
    requestId: requestId(),
    baseLiveVersion: snap.group.liveVersion,
  });
}

/** 앞 5명 팀 A, 뒤 5명 팀 B, rosterOf와 같은 포지션으로 초안을 만든다(서포터 = 5·10번째). */
function draftOf(people: ParticipantView[]): Draft {
  const teamOf: Record<string, Team> = {};
  const ten = people.slice(0, 10);
  ten.forEach((p, i) => (teamOf[`p:${p.id}`] = i < 5 ? "A" : "B"));
  const d = createDraft(
    ten.map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id })),
    { groupId: "g", baseLiveVersion: 0, seed: 1, now: "2026-11-06T00:00:00.000Z", teamOf },
  );
  const order = ["top", "jungle", "mid", "adc", "support"] as const;
  return { ...d, slots: d.slots.map((s, i) => ({ ...s, position: order[i % 5]! })) };
}

const id = (g: TestGroup, i: number) => g.people[i]!.id;

describe("서포터 횟수 직접 입력", () => {
  it("N회로 정하면 스냅숏 합산값이 N이고, 그 뒤 실제 경기로 간 횟수가 더해진다. 0으로 내릴 수도 있다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people)); // 참가자5·참가자10이 서포터(1회)
    expect((await setCounts(g, { [id(g, 0)]: 3, [id(g, 4)]: 2 })).status).toBe(200);
    let counts = countsOf(await snapshot(g));
    expect(counts.get(id(g, 0))).toBe(3);
    expect(counts.get(id(g, 4))).toBe(2); // 사건 1 + 보정 1
    expect(counts.get(id(g, 9))).toBe(1);

    // 참가자1이 서포터로 한 경기 더(1번째 자리를 서포터로) → 4회.
    const roster: RosterEntry[] = rosterOf(g.people).map((r, i) =>
      i === 0 ? { ...r, position: "support" } : i === 4 ? { ...r, position: "top" } : r,
    );
    await playConfirmed(g, roster, "A", "blue", { ackRepeat: [id(g, 0), id(g, 9)] });
    counts = countsOf(await snapshot(g));
    expect(counts.get(id(g, 0))).toBe(4);
    expect(counts.get(id(g, 9))).toBe(2);

    // 0으로 내리기: 사건이 있어도 0으로 보인다.
    expect((await setCounts(g, { [id(g, 0)]: 0, [id(g, 4)]: 0 })).status).toBe(200);
    counts = countsOf(await snapshot(g));
    expect(counts.has(id(g, 0))).toBe(false);
    expect(counts.has(id(g, 4))).toBe(false);
  });

  it("범위 밖 값·형식 오류·다른 모임 참가자·권한 없는 계정은 거절하고, 공동 운영자는 된다", async () => {
    const g = await setupGroup();
    for (const bad of [-1, 100, 1.5, "3"]) {
      const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
        requestId: requestId(),
        counts: [{ participantId: id(g, 0), count: bad }],
      });
      expect(res.status).toBe(400);
    }
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, { requestId: requestId(), counts: [] }))
        .status,
    ).toBe(400);
    const dup = await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
      requestId: requestId(),
      counts: [
        { participantId: id(g, 0), count: 1 },
        { participantId: id(g, 0), count: 2 },
      ],
    });
    expect(dup.status).toBe(400);
    const other = await setupGroup(2);
    const foreign = await setCounts(g, { [other.people[0]!.id]: 1 });
    expect(foreign.status).toBe(404);
    // 다른 모임의 운영자·로그인 안 한 사람.
    expect((await setCounts(g, { [id(g, 0)]: 1 }, requestId(), other.cookie)).status).toBe(404);
    expect((await setCounts(g, { [id(g, 0)]: 1 }, requestId(), null as unknown as string)).status).toBe(401);
    expect(countsOf(await snapshot(g)).size).toBe(0);

    // 공동 운영자는 고칠 수 있다.
    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    expect((await setCounts(g, { [id(g, 1)]: 5 }, requestId(), co)).status).toBe(200);
    expect(countsOf(await snapshot(g)).get(id(g, 1))).toBe(5);
  });

  it("같은 요청 ID로 다시 보내면 한 번만 처리하고, 다른 내용이면 거절한다. 나중 저장이 이긴다", async () => {
    const g = await setupGroup();
    const rid = requestId();
    expect((await setCounts(g, { [id(g, 0)]: 2 }, rid)).status).toBe(200);
    const live = (await snapshot(g)).group.liveVersion;
    expect((await setCounts(g, { [id(g, 0)]: 2 }, rid)).status).toBe(200);
    expect((await snapshot(g)).group.liveVersion).toBe(live);
    expect((await setCounts(g, { [id(g, 0)]: 7 }, rid)).status).toBe(409);
    // 두 운영자가 차례로 고치면 나중 값.
    expect((await setCounts(g, { [id(g, 0)]: 4 })).status).toBe(200);
    expect(countsOf(await snapshot(g)).get(id(g, 0))).toBe(4);
  });

  it("조회 링크 응답에는 보정값이 없다(새 정보를 늘리지 않는다)", async () => {
    const g = await setupGroup();
    await setCounts(g, { [id(g, 0)]: 3 });
    const token = (await snapshot(g)).group.viewToken!;
    const view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain("adjustments");
  });
});

describe("첫 경기 전 · 새 내전 · 초기화", () => {
  it("첫 경기 전(주기 없음)에 넣은 값이 보이고, 경기를 시작하면 새 주기가 물려받는다", async () => {
    const g = await setupGroup();
    expect((await snapshot(g)).rotation).toBeNull();
    expect((await setCounts(g, { [id(g, 0)]: 2, [id(g, 1)]: 1 })).status).toBe(200);
    const before = await snapshot(g);
    expect(before.session).toBeNull();
    expect(before.rotation!.cycleId).toBeNull();
    expect(countsOf(before).get(id(g, 0))).toBe(2);

    await playConfirmed(g, rosterOf(g.people));
    const after = await snapshot(g);
    expect(after.rotation!.cycleId).not.toBeNull();
    expect(countsOf(after).get(id(g, 0))).toBe(2);
    expect(countsOf(after).get(id(g, 1))).toBe(1);
    expect(countsOf(after).get(id(g, 4))).toBe(1); // 실제 서포터
    const pending = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM support_adjustments WHERE group_id = ?1 AND cycle_id IS NULL",
    )
      .bind(g.gid)
      .first<{ n: number }>();
    expect(pending!.n).toBe(0);
  });

  it("'새 내전으로 시작'이면 횟수와 보정값이 함께 사라지고, '지난 내전에 이어서'면 유지된다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    await setCounts(g, { [id(g, 0)]: 3 });
    // 이어서: 유지.
    const shifted = rosterOf([...g.people.slice(1), g.people[0]!]);
    await playConfirmed(g, shifted, "A", "blue", { newSession: false });
    expect(countsOf(await snapshot(g)).get(id(g, 0))).toBe(3);
    // 새 내전: 사라진다.
    await playConfirmed(g, shifted, "A", "blue", { newSession: true });
    const fresh = countsOf(await snapshot(g));
    expect(fresh.has(id(g, 0))).toBe(false);
    expect([...fresh.values()].every((n) => n === 1)).toBe(true);
  });

  it("초기화하면 보정값도 0이 된다(열린 내전이 있을 때와 첫 경기 전 모두)", async () => {
    const g = await setupGroup();
    await setCounts(g, { [id(g, 0)]: 2 });
    expect((await resetCycle(g)).status).toBe(200); // 첫 경기 전: 미리 넣은 값만 지운다
    expect((await snapshot(g)).rotation).toBeNull();

    await playConfirmed(g, rosterOf(g.people));
    await setCounts(g, { [id(g, 0)]: 2 });
    expect(countsOf(await snapshot(g)).get(id(g, 0))).toBe(2);
    expect((await resetCycle(g)).status).toBe(200);
    expect(countsOf(await snapshot(g)).size).toBe(0);
  });
});

describe("규칙·시작과의 정합", () => {
  it("보정으로 한 팀 5명이 모두 1회 이상이면 초기화 버튼 조건이 참이 된다", async () => {
    const g = await setupGroup();
    const draft = draftOf(g.people);
    const ctx0 = rotationContext(true, (await snapshot(g)).rotation);
    expect(resetCountsReady(draft, ctx0)).toBe(false);
    await setCounts(g, Object.fromEntries([0, 1, 2, 3, 4].map((i) => [id(g, i), 1])));
    const ctx = rotationContext(true, (await snapshot(g)).rotation);
    expect(resetCountsReady(draft, ctx)).toBe(true);
  });

  it("보정으로 0이 된 'used' 서포터는 묻지 않고 시작되고(ack), 서버가 SUPPORT_REPEAT로 튕기지 않는다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people)); // 참가자5·참가자10 used
    await setCounts(g, { [id(g, 4)]: 0, [id(g, 9)]: 0 });
    const draft = draftOf(g.people); // 같은 두 사람이 다시 서포터
    const snap = await snapshot(g);
    const ctx = rotationContext(true, snap.rotation);
    expect(repeatSupporterIds(draft, ctx)).toEqual([]);
    const fair = fairRepeatSupporterIds(draft, ctx);
    expect(fair.sort()).toEqual([id(g, 4), id(g, 9)].sort());
    // ack 없이 보내면 서버는 여전히 'used' 사건으로 거절한다 → 기기는 fair 목록을 반드시 넣는다.
    expect((await start(g, rosterOf(g.people))).body).toMatchObject({ error: { code: "SUPPORT_REPEAT" } });
    const started = await start(g, rosterOf(g.people), { ackRepeat: fair });
    expect(started.status).toBe(200);
    // 'used' 사건이 없는 사람을 ack에 넣어도 서버는 거절하지 않는다(무시).
    const next = await matchAction(g, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    expect(next.status).toBe(200);
    const extra = await start(g, rosterOf([...g.people.slice(2), ...g.people.slice(0, 2)]), {
      ackRepeat: [id(g, 0), id(g, 1), id(g, 4), id(g, 9), id(g, 11)],
    });
    expect(extra.status).toBe(200);
  });

  it("미진행 취소로 사건이 없어져도 합산은 0 미만으로 보이지 않는다", async () => {
    const g = await setupGroup();
    const started = await start(g, rosterOf(g.people));
    await setCounts(g, { [id(g, 4)]: 0 }); // 사건 1 → 보정 -1
    expect((await matchAction(g, started.body.match, "cancel")).status).toBe(200);
    const counts = countsOf(await snapshot(g));
    expect(counts.has(id(g, 4))).toBe(false);
    expect([...counts.values()].every((n) => n >= 0)).toBe(true);
  });
});

describe("백업·복원·합치기·삭제", () => {
  it("백업 → 복원 왕복으로 보정값이 그대로이고, 보정값 항목이 없는 예전 백업도 복원된다", async () => {
    const g = await setupGroup();
    await setCounts(g, { [id(g, 2)]: 4 }); // 주기 없음
    await playConfirmed(g, rosterOf(g.people));
    await setCounts(g, { [id(g, 0)]: 3 }); // 활성 주기
    const before = countsOf(await snapshot(g));
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.supportAdjustments).toHaveLength(2);

    await setCounts(g, { [id(g, 0)]: 9, [id(g, 2)]: 0 });
    const restore = async (file: unknown) => {
      const snap = await snapshot(g);
      return api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
        requestId: requestId(),
        confirm: "복원",
        baseGeneration: snap.group.generation,
        backup: file,
      });
    };
    expect((await restore(backup)).status).toBe(200);
    expect([...countsOf(await snapshot(g))]).toEqual([...before]);

    const { supportAdjustments: _drop, ...old } = backup;
    expect((await restore(old)).status).toBe(200);
    const plain = countsOf(await snapshot(g));
    expect(plain.get(id(g, 0))).toBeUndefined(); // 보정값 없이 사건만
    expect(plain.get(id(g, 4))).toBe(1);

    // 새 모임으로 가져오기(ID를 새로 만든다)도 보정값을 옮긴다.
    const newcomer = await login();
    const imported = await api(newcomer, "POST", "/api/restore/new-group", {
      requestId: requestId(),
      confirm: "복원",
      backup,
    });
    expect(imported.status).toBe(200);
    const snap = (await api<Snapshot>(newcomer, "GET", `/api/groups/${imported.body.groupId}/snapshot`)).body;
    expect([...countsOf(snap).values()].sort()).toEqual([...before.values()].sort());
  });

  it("합치면 합쳐진 이름의 보정값이 남은 사람에게 더해져 보이고, 되돌리면 원래대로다", async () => {
    const g = await setupGroup();
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1 부캐"] });
    const dup = added.body.participants[0] as ParticipantView;
    await setCounts(g, { [id(g, 0)]: 2, [dup.id]: 3 });
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: dup.id,
      targetId: id(g, 0),
    });
    expect(merged.status).toBe(200);
    let counts = countsOf(await snapshot(g));
    expect(counts.get(id(g, 0))).toBe(5);
    expect(counts.has(dup.id)).toBe(false);
    // 합쳐진 이름은 고칠 수 없다. 남은 사람을 4회로 정하면 4회로 보인다.
    expect((await setCounts(g, { [dup.id]: 1 })).status).toBe(409);
    expect((await setCounts(g, { [id(g, 0)]: 4 })).status).toBe(200);
    expect(countsOf(await snapshot(g)).get(id(g, 0))).toBe(4);

    const undone = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${merged.body.mergeId}/undo`, {
      requestId: requestId(),
    });
    expect(undone.status).toBe(200);
    counts = countsOf(await snapshot(g));
    expect(counts.get(dup.id)).toBe(3);
    expect(counts.get(id(g, 0))).toBe(1); // 합친 동안 4회로 정한 몫(4 - 3)이 남는다
  });

  it("모임을 삭제하면 보정값 행도 지워진다", async () => {
    const g = await setupGroup();
    await setCounts(g, { [id(g, 0)]: 2 });
    await playConfirmed(g, rosterOf(g.people));
    await setCounts(g, { [id(g, 1)]: 2 });
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM support_adjustments WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
