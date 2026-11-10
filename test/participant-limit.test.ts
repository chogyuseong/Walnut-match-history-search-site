import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { nameKey } from "../src/shared/names";
import { api, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";
import { directCounted } from "./queryCount";

// R1(docs/개선-오늘명단-설계-2026-11-10.md ②): 이름 추가가 "지금 수 ≥ 200"만 보던 때는 199명에서 30명을 넣어
// 229명이 될 수 있었고, 그 모임의 백업은 복원이 200명 초과로 거절했다. 추가와 복원이 같은 상한을 지키는지 고정한다.

async function addNames(g: TestGroup, names: string[]) {
  return api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names });
}

/** 참가자 n명(참가자1~n)인 모임. 이름 추가는 한 번에 30명까지라 나눠 넣는다. */
async function groupOf(n: number): Promise<TestGroup> {
  const g = await setupGroup(Math.min(n, 30));
  for (let from = 31; from <= n; from += 30) {
    const names = Array.from({ length: Math.min(30, n - from + 1) }, (_, i) => `참가자${from + i}`);
    expect((await addNames(g, names)).status).toBe(200);
  }
  return g;
}

describe("참가자 상한", () => {
  it("199명에 새 이름 2명은 거절하고 아무도 넣지 않는다", async () => {
    const g = await groupOf(199);
    const res = await addNames(g, ["새사람1", "새사람2"]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TOO_MANY_PARTICIPANTS");
    expect((await snapshot(g)).participants).toHaveLength(199);
  });

  it("199명에 새 이름 1명은 넣고, 이미 있는 이름은 상한을 채운 뒤에도 돌려준다", async () => {
    const g = await groupOf(199);
    const added = await addNames(g, ["새사람1"]);
    expect(added.status).toBe(200);
    // 이미 활성 참가자인 이름은 새로 생기지 않으므로 200명이어도 그대로 돌려준다(고르기 화면이 기존 이름을 섞어 보낸다).
    const again = await addNames(g, ["새사람1", "참가자1"]);
    expect(again.status).toBe(200);
    expect(again.body.participants).toHaveLength(2);
    expect((await snapshot(g)).participants).toHaveLength(200);
  });

  it("인원 확인 뒤 batch 전에 다른 기기가 채우면 batch 안 보호 문장이 막는다(동시 추가)", async () => {
    const g = await groupOf(195);
    const res = await directCounted("POST", `/api/groups/${g.gid}/participants`, {
      cookie: g.cookie,
      body: { names: ["새사람1", "새사람2", "새사람3", "새사람4", "새사람5"], requestId: requestId() },
      // 이 요청의 batch 밖 확인(195 + 5 = 200)은 통과한 뒤, 다른 기기의 5명이 먼저 들어간 상황.
      beforeBatch: async (sqls) => {
        if (!sqls.some((s) => s.includes("INSERT INTO participants"))) return;
        await env.DB.batch(
          ["다른1", "다른2", "다른3", "다른4", "다른5"].map((name) =>
            env.DB.prepare(
              "INSERT INTO participants (id, group_id, name, name_key, created_at) VALUES (?1, ?2, ?3, ?4, '2026-11-10T00:00:00.000Z')",
            ).bind(crypto.randomUUID(), g.gid, name, nameKey(name)),
          ),
        );
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TOO_MANY_PARTICIPANTS");
    const names = (await snapshot(g)).participants.map((p) => p.name);
    expect(names).toHaveLength(200);
    expect(names).not.toContain("새사람1");
  });

  it("200명 모임의 백업을 그대로 복원할 수 있다", async () => {
    const g = await groupOf(200);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.participants).toHaveLength(200);
    const snap = await snapshot(g);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
    expect(res.status).toBe(200);
    expect(res.body.participants).toBe(200);
  });
});
