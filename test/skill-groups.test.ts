import { describe, expect, it } from "vitest";
import { MAX_PARTICIPANTS_PER_GROUP } from "../src/server/groups";
import { direct } from "./direct";
import { api, apiRaw, login, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";
import { directCounted, FREE_PLAN_QUERY_LIMIT } from "./queryCount";

// 티어 일괄 저장(POST …/participants/skill-groups, src/server/groups.ts saveSkillGroups).
// 화면 "티어 배정 → 기록으로 제안받기"의 여러 명 적용이 사람마다 PATCH를 보내던 것을 요청 한 번으로 바꿨다.

type Change = { participantId: string; skillGroup: number | null; baseVersion?: number };

function setGroups(g: TestGroup, changes: Change[], rid = requestId(), cookie: string | null = g.cookie) {
  return apiRaw(cookie, "POST", `/api/groups/${g.gid}/participants/skill-groups`, { requestId: rid, changes });
}

async function groupsOf(g: TestGroup): Promise<Map<string, { skillGroup?: number | null; version?: number }>> {
  const snap = await snapshot(g);
  return new Map(snap.participants.map((p) => [p.id, { skillGroup: p.skillGroup, version: p.version }]));
}

describe("티어 일괄 저장", () => {
  it("30명을 한 요청으로 저장하고, 사람마다 버전이 1 오르며, 질의 수는 인원과 상관없다", async () => {
    const g = await setupGroup(30);
    const before = await groupsOf(g);
    const changes = g.people.map((p, i) => ({
      participantId: p.id,
      skillGroup: i % 6 === 5 ? null : (i % 6) + 1,
      baseVersion: before.get(p.id)!.version,
    }));
    const res = await directCounted("POST", `/api/groups/${g.gid}/participants/skill-groups`, {
      cookie: g.cookie,
      body: { requestId: requestId(), changes },
    });
    expect(res.status).toBe(200);
    expect(res.queries).toBeLessThan(FREE_PLAN_QUERY_LIMIT);
    const after = await groupsOf(g);
    for (const c of changes) {
      expect(after.get(c.participantId)!.skillGroup).toBe(c.skillGroup);
      expect(after.get(c.participantId)!.version).toBe(before.get(c.participantId)!.version! + 1);
    }

    // 2명이어도 질의 수가 같다(읽기 1회 + batch 1회는 인원에 따라 늘지 않는다).
    const small = await directCounted("POST", `/api/groups/${g.gid}/participants/skill-groups`, {
      cookie: g.cookie,
      body: {
        requestId: requestId(),
        changes: changes.slice(0, 2).map((c) => ({ participantId: c.participantId, skillGroup: 3 })),
      },
    });
    expect(small.status).toBe(200);
    expect(small.queries).toBe(res.queries);
  });

  it("한 명이라도 화면이 본 버전과 다르면 409이고 아무도 저장되지 않는다", async () => {
    const g = await setupGroup(3);
    const before = await groupsOf(g);
    const [a, b] = g.people;
    // 다른 기기가 b를 먼저 고쳤다.
    expect((await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${b!.id}`, { skillGroup: 2 })).status).toBe(200);
    const res = await setGroups(g, [
      { participantId: a!.id, skillGroup: 1, baseVersion: before.get(a!.id)!.version },
      { participantId: b!.id, skillGroup: 5, baseVersion: before.get(b!.id)!.version },
    ]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("VERSION_CONFLICT");
    expect(res.body.error.details).toEqual({ participantId: b!.id, version: before.get(b!.id)!.version! + 1 });
    const after = await groupsOf(g);
    expect(after.get(a!.id)!.skillGroup).toBe(null);
    expect(after.get(b!.id)!.skillGroup).toBe(2);
  });

  it("같은 요청 ID로 다시 보내면 한 번만 처리하고, 다른 내용이면 거절한다", async () => {
    const g = await setupGroup(3);
    const id = g.people[0]!.id;
    const rid = requestId();
    expect((await setGroups(g, [{ participantId: id, skillGroup: 4 }], rid)).status).toBe(200);
    const version = (await groupsOf(g)).get(id)!.version;
    expect((await setGroups(g, [{ participantId: id, skillGroup: 4 }], rid)).status).toBe(200);
    expect((await groupsOf(g)).get(id)!.version).toBe(version);
    const reused = await setGroups(g, [{ participantId: id, skillGroup: 1 }], rid);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
    expect((await groupsOf(g)).get(id)!.skillGroup).toBe(4);
  });

  it("요청 ID 없음·형식 오류·같은 사람 두 번·인원 상한 초과는 400, 다른 모임 참가자는 404", async () => {
    const g = await setupGroup(3);
    const id = g.people[0]!.id;
    const path = `/api/groups/${g.gid}/participants/skill-groups`;
    expect((await apiRaw(g.cookie, "POST", path, { changes: [{ participantId: id, skillGroup: 1 }] })).status).toBe(400);
    for (const bad of [0, 6, 1.5, "2"]) {
      expect((await setGroups(g, [{ participantId: id, skillGroup: bad as number }])).status).toBe(400);
    }
    expect((await setGroups(g, [])).status).toBe(400);
    expect(
      (
        await setGroups(g, [
          { participantId: id, skillGroup: 1 },
          { participantId: id, skillGroup: 2 },
        ])
      ).status,
    ).toBe(400);
    const extra = await apiRaw(g.cookie, "POST", path, {
      requestId: requestId(),
      changes: [{ participantId: id, skillGroup: 1, name: "바꿈" }],
    });
    expect(extra.status).toBe(400);

    // 상한까지는 형식 검사를 지나고(없는 사람이라 404), 하나 넘으면 400.
    const fake = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ participantId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, skillGroup: 1 }));
    expect((await setGroups(g, fake(MAX_PARTICIPANTS_PER_GROUP))).status).toBe(404);
    expect((await setGroups(g, fake(MAX_PARTICIPANTS_PER_GROUP + 1))).status).toBe(400);

    // 다른 모임 참가자를 섞으면 아무도 저장되지 않는다.
    const other = await setupGroup(2);
    const foreign = await setGroups(g, [
      { participantId: id, skillGroup: 1 },
      { participantId: other.people[0]!.id, skillGroup: 1 },
    ]);
    expect(foreign.status).toBe(404);
    expect((await groupsOf(g)).get(id)!.skillGroup).toBe(null);
    expect((await groupsOf(other)).get(other.people[0]!.id)!.skillGroup).toBe(null);
  });

  it("다른 모임 운영자·로그인 안 한 사람·다른 출처는 거절하고, 공동 운영자는 된다", async () => {
    const g = await setupGroup(3);
    const id = g.people[0]!.id;
    const other = await setupGroup(2);
    expect((await setGroups(g, [{ participantId: id, skillGroup: 1 }], requestId(), other.cookie)).status).toBe(404);
    expect((await setGroups(g, [{ participantId: id, skillGroup: 1 }], requestId(), null)).status).toBe(401);
    const cross = await direct({}, "POST", `/api/groups/${g.gid}/participants/skill-groups`, {
      cookie: g.cookie,
      headers: { Origin: "https://evil.example" },
      body: { requestId: requestId(), changes: [{ participantId: id, skillGroup: 1 }] },
    });
    expect(cross.status).toBe(403);
    expect((await groupsOf(g)).get(id)!.skillGroup).toBe(null);

    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    expect((await setGroups(g, [{ participantId: id, skillGroup: 2 }], requestId(), co)).status).toBe(200);
    expect((await groupsOf(g)).get(id)!.skillGroup).toBe(2);
  });
});
