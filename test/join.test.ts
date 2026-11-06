import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pathForLog } from "../src/server/http";
import {
  api,
  login,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  type TestGroup,
} from "./helpers";

// 참가 신청 링크(migrations/0014, src/server/join.ts).

async function makeLink(g: TestGroup, cookie = g.cookie): Promise<string> {
  const res = await api(cookie, "POST", `/api/groups/${g.gid}/join/link`);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

async function admin(g: TestGroup, cookie = g.cookie) {
  const res = await api(cookie, "GET", `/api/groups/${g.gid}/join`);
  expect(res.status).toBe(200);
  return res.body as {
    link: { open: boolean; token: string | null } | null;
    entries: { key: string; name: string; participantId: string | null }[];
    max: number;
  };
}

const join = (token: string, body: unknown) => api(null, "POST", `/api/join/${token}`, body);
const cancel = (token: string, key: string) => api(null, "POST", `/api/join/${token}/cancel`, { key });

async function addCo(g: TestGroup): Promise<string> {
  const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`)).body.token as string;
  const co = await login();
  expect((await api(co, "POST", `/api/co-invite/${token}/accept`)).status).toBe(200);
  return co;
}

describe("참가 신청: 공개 링크", () => {
  it("로그인 없이 명단의 이름으로 신청하고, 신청 순으로 보이고, 취소한다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    const info = await api(null, "GET", `/api/join/${token}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({ groupName: "내 내전 모임", open: true, max: 30, target: 10, entries: [] });
    expect(info.body.people).toHaveLength(12);

    expect((await join(token, { participantId: g.people[2]!.id })).status).toBe(200);
    const second = await join(token, { participantId: g.people[0]!.id });
    expect(second.body.entries.map((e: { name: string }) => e.name)).toEqual(["참가자3", "참가자1"]);

    const after = await cancel(token, `p:${g.people[2]!.id}`);
    expect(after.status).toBe(200);
    expect(after.body.entries.map((e: { name: string }) => e.name)).toEqual(["참가자1"]);
    // 이미 없는 신청을 취소해도 그대로 성공한다.
    expect((await cancel(token, `p:${g.people[2]!.id}`)).status).toBe(200);
  });

  it("같은 사람은 한 번만: 다시 신청하거나 같은 이름을 새 이름으로 넣어도 한 줄", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    await join(token, { participantId: g.people[0]!.id });
    await join(token, { participantId: g.people[0]!.id });
    // 명단에 있는 이름을 새 이름 칸에 넣으면 그 사람으로 본다(대소문자·공백 정리 포함).
    const byName = await join(token, { name: "  참가자1 " });
    expect(byName.status).toBe(200);
    expect(byName.body.entries).toEqual([{ key: `p:${g.people[0]!.id}`, name: "참가자1" }]);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("새 이름은 참가자를 만들지 않고, 같은 새 이름은 한 번만, 이름 규칙을 지킨다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    const added = await join(token, { name: "새친구" });
    expect(added.status).toBe(200);
    expect(added.body.entries).toEqual([{ key: "n:새친구", name: "새친구" }]);
    expect((await join(token, { name: "새친구" })).body.entries).toHaveLength(1);
    expect((await snapshot(g)).participants).toHaveLength(12);
    // 이름 검증(1~20자)은 참가자 이름과 같다.
    expect((await join(token, { name: "   " })).status).toBe(400);
    expect((await join(token, { name: "가".repeat(21) })).body.error.code).toBe("INVALID_NAME");
    // 둘 다 보내거나 둘 다 없으면 거절.
    expect((await join(token, { name: "가", participantId: g.people[0]!.id })).status).toBe(400);
    expect((await join(token, {})).status).toBe(400);
    expect((await join(token, { participantId: g.people[0]!.id, extra: 1 })).status).toBe(400);

    // 운영자가 경기를 시작하며 그 이름의 참가자를 만들면 신청은 그 사람 것으로 보인다.
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["새친구"] });
    const id = created.body.participants[0].id as string;
    expect((await admin(g)).entries).toEqual([
      expect.objectContaining({ key: `p:${id}`, name: "새친구", participantId: id }),
    ]);
    // 그 뒤 명단에서 같은 사람을 눌러도 한 줄.
    expect((await join(token, { participantId: id })).body.entries).toHaveLength(1);
  });

  it("닫혀 있으면 신청·취소를 거절하고, 다시 열면 받는다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    await join(token, { participantId: g.people[0]!.id });
    const closed = await api(g.cookie, "POST", `/api/groups/${g.gid}/join/open`, { requestId: requestId(), open: false });
    expect(closed.status).toBe(200);
    expect(closed.body.link.open).toBe(false);
    const info = await api(null, "GET", `/api/join/${token}`);
    expect(info.body.open).toBe(false);
    const add = await join(token, { participantId: g.people[1]!.id });
    expect(add.status).toBe(409);
    expect(add.body.error.code).toBe("JOIN_CLOSED");
    expect((await cancel(token, `p:${g.people[0]!.id}`)).body.error.code).toBe("JOIN_CLOSED");
    expect((await admin(g)).entries).toHaveLength(1);

    await api(g.cookie, "POST", `/api/groups/${g.gid}/join/open`, { requestId: requestId(), open: true });
    expect((await join(token, { participantId: g.people[1]!.id })).status).toBe(200);
  });

  it("신청은 30명까지", async () => {
    const g = await setupGroup(30);
    const token = await makeLink(g);
    for (const p of g.people) expect((await join(token, { participantId: p.id })).status).toBe(200);
    const full = await join(token, { name: "서른한번째" });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("JOIN_FULL");
    // 이미 신청한 사람이 다시 눌러도 거절하지 않는다(변화 없음).
    expect((await join(token, { participantId: g.people[0]!.id })).status).toBe(200);
    expect((await admin(g)).entries).toHaveLength(30);
  });

  it("잘못된 토큰, 다시 만든 뒤의 이전 토큰은 같은 답(404)이고 모임 정보를 드러내지 않는다", async () => {
    const g = await setupGroup();
    const old = await makeLink(g);
    await join(old, { participantId: g.people[0]!.id });
    const fresh = await makeLink(g);
    for (const token of [old, "없는토큰없는토큰", "x"]) {
      const info = await api(null, "GET", `/api/join/${token}`);
      expect(info.status).toBe(404);
      expect(info.body.error.code).toBe("JOIN_INVALID");
      expect(JSON.stringify(info.body)).not.toContain("내 내전 모임");
      expect((await join(token, { participantId: g.people[1]!.id })).status).toBe(404);
    }
    // 다시 만들어도 신청 목록은 그대로이고 새 링크로 이어서 받는다.
    const info = await api(null, "GET", `/api/join/${fresh}`);
    expect(info.body.entries).toHaveLength(1);
    expect((await join(fresh, { participantId: g.people[1]!.id })).body.entries).toHaveLength(2);
    // 조회는 해시로 하고, 원문도 저장해 운영자 응답으로 다시 준다(migrations/0015). 이전 링크는 남지 않는다.
    const row = await env.DB.prepare("SELECT token_hash, token FROM join_links WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ token_hash: string; token: string | null }>();
    expect(row!.token_hash).not.toBe(fresh);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.token).toBe(fresh);
    expect((await admin(g)).link!.token).toBe(fresh);
    // 공개 응답에는 토큰이 다시 나가지 않는다.
    expect(JSON.stringify(info.body)).not.toContain(fresh);
    // 0015 이전에 만든 링크(원문 없음)는 token이 null이고 링크는 그대로 열린다.
    await env.DB.prepare("UPDATE join_links SET token = NULL WHERE group_id = ?1").bind(g.gid).run();
    expect((await admin(g)).link!.token).toBeNull();
    expect((await api(null, "GET", `/api/join/${fresh}`)).status).toBe(200);
  });

  it("다른 모임·보관·합쳐진 참가자로는 신청할 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const token = await makeLink(g);
    const foreign = await join(token, { participantId: other.people[0]!.id });
    expect(foreign.status).toBe(404);
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[5]!.id}`, { status: "archived" });
    expect((await join(token, { participantId: g.people[5]!.id })).status).toBe(404);
    // 보관한 사람은 공개 명단에도 없다.
    const info = await api(null, "GET", `/api/join/${token}`);
    expect(info.body.people.map((p: { id: string }) => p.id)).not.toContain(g.people[5]!.id);
    // 외래 키도 다른 모임 참가자를 막는다.
    await expect(
      env.DB.prepare(
        "INSERT INTO join_requests (id, group_id, participant_id, created_at) VALUES ('x1', ?1, ?2, '2026-01-01')",
      )
        .bind(g.gid, other.people[0]!.id)
        .run(),
    ).rejects.toThrow();
  });

  it("공개 응답에는 이름·신청 여부만 있다: 우선순위·기피 라인·서포터 횟수·전적·ID 밖의 값 없음", async () => {
    const g = await setupGroup();
    const p = g.people[0]!;
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${p.id}`, {
      skillGroup: 1,
      avoidPositions: ["support", "jungle"],
    });
    // 우선순위 공개 설정을 켜도 신청 응답에는 넣지 않는다.
    const snap = await snapshot(g);
    await api(
      g.cookie,
      "PUT",
      `/api/groups/${g.gid}/settings`,
      {
        requestId: requestId(),
        baseSettingsVersionId: snap.group.settingsVersionId,
        settings: { ...snap.group.settings, groupsPublic: true },
      },
    );
    await playConfirmed(g, rosterOf(g.people));
    await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
      requestId: requestId(),
      counts: [{ participantId: p.id, count: 3 }],
    });
    const token = await makeLink(g);
    await join(token, { participantId: p.id });
    await join(token, { name: "새친구" });
    for (const res of [
      await api(null, "GET", `/api/join/${token}`),
      await join(token, { participantId: g.people[1]!.id }),
      await cancel(token, `p:${g.people[1]!.id}`),
    ]) {
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["entries", "groupName", "max", "open", "people", "target"]);
      for (const e of res.body.entries) expect(Object.keys(e).sort()).toEqual(["key", "name"]);
      for (const person of res.body.people) expect(Object.keys(person).sort()).toEqual(["id", "name"]);
      const text = JSON.stringify(res.body);
      for (const word of ["skillGroup", "avoid", "support", "jungle", "rotation", "matches", "wins", "games", "viewToken", "delta"]) {
        expect(text).not.toContain(word);
      }
    }
  });

  it("신청 요청은 Origin 확인·JSON 본문만 허용을 거친다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    const { SELF } = await import("cloudflare:test");
    const foreign = await SELF.fetch(`https://example.test/api/join/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ participantId: g.people[0]!.id }),
    });
    expect(foreign.status).toBe(403);
    const form = await SELF.fetch(`https://example.test/api/join/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `participantId=${g.people[0]!.id}`,
    });
    expect(form.status).toBe(415);
    expect((await admin(g)).entries).toHaveLength(0);
    // 로그에 남기는 경로에서 토큰을 가린다.
    expect(pathForLog(`/api/join/${token}/cancel`)).toBe("/api/join/[token]/cancel");
  });
});

describe("참가 신청: 운영자", () => {
  it("대표·공동 운영자 모두 링크를 만들고 목록을 보고 한 사람 지우기·비우기를 한다. 다른 계정은 404", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const stranger = await setupGroup();
    for (const cookie of [stranger.cookie, null]) {
      expect((await api(cookie, "GET", `/api/groups/${g.gid}/join`)).status).toBe(cookie ? 404 : 401);
      expect((await api(cookie, "POST", `/api/groups/${g.gid}/join/link`)).status).toBe(cookie ? 404 : 401);
      expect(
        (await api(cookie, "POST", `/api/groups/${g.gid}/join/clear`, { requestId: requestId() })).status,
      ).toBe(cookie ? 404 : 401);
    }
    expect((await admin(g, co)).link).toBeNull();
    const token = await makeLink(g, co);
    // 공동 운영자가 만든 링크를 대표도 그대로 받는다(다른 기기에서도 같은 주소).
    expect((await admin(g)).link).toMatchObject({ open: true, token });
    for (const p of g.people.slice(0, 3)) await join(token, { participantId: p.id });
    await join(token, { name: "새친구" });

    const removed = await api(co, "POST", `/api/groups/${g.gid}/join/remove`, {
      requestId: requestId(),
      key: `p:${g.people[1]!.id}`,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.entries.map((e: { name: string }) => e.name)).toEqual(["참가자1", "참가자3", "새친구"]);
    const removedNew = await api(g.cookie, "POST", `/api/groups/${g.gid}/join/remove`, {
      requestId: requestId(),
      key: "n:새친구",
    });
    expect(removedNew.body.entries).toHaveLength(2);

    const cleared = await api(co, "POST", `/api/groups/${g.gid}/join/clear`, { requestId: requestId() });
    expect(cleared.status).toBe(200);
    expect(cleared.body.entries).toEqual([]);
    // 다른 모임 운영자는 이 모임의 신청을 지울 수 없다.
    await join(token, { participantId: g.people[0]!.id });
    expect(
      (await api(stranger.cookie, "POST", `/api/groups/${g.gid}/join/remove`, {
        requestId: requestId(),
        key: `p:${g.people[0]!.id}`,
      })).status,
    ).toBe(404);
    expect((await admin(g)).entries).toHaveLength(1);
  });

  it("경기를 시작해도 신청 목록은 남고, 운영자 스냅숏·조회 응답에는 신청이 없다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    for (const p of g.people.slice(0, 10)) await join(token, { participantId: p.id });
    await playConfirmed(g, rosterOf(g.people));
    expect((await admin(g)).entries).toHaveLength(10);
    const snap = await snapshot(g);
    expect(JSON.stringify(snap)).not.toContain("join");
    const view = await api(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(JSON.stringify(view.body)).not.toContain("join");
  });

  it("합치기: 합쳐진 사람의 신청은 남은 사람 것으로 보이고, 둘 다 했으면 먼저 한 하나로. 되돌리면 갈라진다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    const [a, b, c] = g.people;
    await join(token, { participantId: c!.id });
    await join(token, { participantId: a!.id }); // a: 합쳐질 사람(먼저)
    await join(token, { participantId: b!.id }); // b: 남을 사람
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: a!.id,
      targetId: b!.id,
    });
    expect(merged.status).toBe(200);
    const after = await admin(g);
    expect(after.entries.map((e) => e.key)).toEqual([`p:${c!.id}`, `p:${b!.id}`]);
    expect(after.entries[1]!.name).toBe("참가자2");
    // 합쳐진 사람은 공개 명단에서 빠지고, 남은 사람이 신청된 것으로 보인다.
    const info = await api(null, "GET", `/api/join/${token}`);
    expect(info.body.people.map((p: { id: string }) => p.id)).not.toContain(a!.id);
    expect(info.body.entries).toHaveLength(2);
    // 남은 사람으로 취소하면 두 행이 모두 지워진다.
    await cancel(token, `p:${b!.id}`);
    expect((await admin(g)).entries.map((e) => e.key)).toEqual([`p:${c!.id}`]);

    // 되돌리면 각자 자기 행으로 보인다.
    await join(token, { participantId: b!.id });
    const m2 = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: c!.id,
      targetId: b!.id,
    });
    expect((await admin(g)).entries.map((e) => e.key)).toEqual([`p:${b!.id}`]);
    const undo = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${m2.body.mergeId}/undo`, {
      requestId: requestId(),
    });
    expect(undo.status).toBe(200);
    expect((await admin(g)).entries.map((e) => e.key)).toEqual([`p:${c!.id}`, `p:${b!.id}`]);
  });

  it("모임 삭제는 링크·신청을 함께 지우고, 백업에는 신청이 없으며 복원하면 비워진다", async () => {
    const g = await setupGroup();
    const token = await makeLink(g);
    await join(token, { participantId: g.people[0]!.id });
    await join(token, { name: "새친구" });
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(JSON.stringify(backup)).not.toContain("새친구");
    expect(JSON.stringify(backup)).not.toMatch(/join/i);

    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: (await snapshot(g)).group.generation,
      backup,
    });
    expect(restored.status).toBe(200);
    // 복원은 링크를 바꾸지 않고(조회 링크와 같다) 신청 목록만 비운다.
    expect((await api(null, "GET", `/api/join/${token}`)).body.entries).toEqual([]);

    await join(token, { participantId: g.people[0]!.id });
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(200);
    for (const table of ["join_links", "join_requests"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`)
        .bind(g.gid)
        .first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
    expect((await api(null, "GET", `/api/join/${token}`)).status).toBe(404);
  });

  it("운영 쓰기 요청은 요청 ID 중복 방지를 탄다", async () => {
    const g = await setupGroup();
    await makeLink(g);
    const id = requestId();
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/join/open`, { requestId: id, open: false })).status).toBe(200);
    const reused = await api(g.cookie, "POST", `/api/groups/${g.gid}/join/open`, { requestId: id, open: true });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
    expect((await admin(g)).link!.open).toBe(false);
    // 링크가 없으면 열기·닫기는 404.
    const g2 = await setupGroup();
    expect(
      (await api(g2.cookie, "POST", `/api/groups/${g2.gid}/join/open`, { requestId: requestId(), open: true })).status,
    ).toBe(404);
  });
});
