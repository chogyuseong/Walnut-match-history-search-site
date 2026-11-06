import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

async function invite(g: TestGroup): Promise<string> {
  const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** 새 계정을 공동 운영자로 들인다. */
async function addCo(g: TestGroup): Promise<string> {
  const token = await invite(g);
  const co = await login();
  const accepted = await api(co, "POST", `/api/co-invite/${token}/accept`);
  expect(accepted.status).toBe(200);
  expect(accepted.body.groupId).toBe(g.gid);
  return co;
}

async function accountIdOf(cookie: string): Promise<string> {
  return (await api(cookie, "GET", "/api/me")).body.accountId as string;
}

describe("공동 운영자 초대", () => {
  it("초대를 수락하면 공동 운영자가 되고 /api/me에 역할과 함께 보인다", async () => {
    const g = await setupGroup();
    const token = await invite(g);
    const co = await login();
    const info = await api(co, "GET", `/api/co-invite/${token}`);
    expect(info.status).toBe(200);
    expect(info.body.groupName).toBe("내 내전 모임");
    expect((await api(co, "POST", `/api/co-invite/${token}/accept`)).status).toBe(200);

    expect((await api(co, "GET", "/api/me")).body.groups).toEqual([{ id: g.gid, name: "내 내전 모임", role: "co" }]);
    expect((await api(g.cookie, "GET", "/api/me")).body.groups).toEqual([
      { id: g.gid, name: "내 내전 모임", role: "owner" },
    ]);
    // 운영자용 스냅숏(조회 토큰 포함)을 본다.
    const snap = await api(co, "GET", `/api/groups/${g.gid}/snapshot`);
    expect(snap.status).toBe(200);
    expect(snap.body.role).toBe("operator");

    const list = await api(g.cookie, "GET", `/api/groups/${g.gid}/co-operators`);
    expect(list.status).toBe(200);
    expect(list.body.max).toBe(5);
    expect(list.body.coOperators).toHaveLength(1);
    expect(list.body.coOperators[0]).toMatchObject({ accountId: await accountIdOf(co), provider: "fake", loginId: null });
    // 가짜 로그인의 식별자(subject)는 내보내지 않는다.
    expect(Object.keys(list.body.coOperators[0]).sort()).toEqual(
      ["accountCreatedAt", "accountId", "joinedAt", "loginId", "provider"].sort(),
    );
  });

  it("초대 링크는 한 번만 쓸 수 있고, 만료됐거나 새 링크를 만들면 이전 링크는 거절된다", async () => {
    const g = await setupGroup();
    const token = await invite(g);
    const first = await login();
    const second = await login();
    expect((await api(first, "POST", `/api/co-invite/${token}/accept`)).status).toBe(200);
    const reuse = await api(second, "POST", `/api/co-invite/${token}/accept`);
    expect(reuse.status).toBe(404);
    expect(reuse.body.error.code).toBe("INVITE_INVALID");

    const old = await invite(g);
    const fresh = await invite(g);
    expect((await api(second, "POST", `/api/co-invite/${old}/accept`)).status).toBe(404);

    // 만료: 저장된 만료 시각을 과거로 돌린다.
    await env.DB.prepare("UPDATE co_operator_invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE group_id = ?1")
      .bind(g.gid)
      .run();
    const expired = await api(second, "POST", `/api/co-invite/${fresh}/accept`);
    expect(expired.status).toBe(404);
    expect(expired.body.error.code).toBe("INVITE_INVALID");
    expect((await api(second, "GET", `/api/co-invite/${fresh}`)).status).toBe(404);
    expect((await api(second, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
  });

  it("토큰은 해시만 저장한다", async () => {
    const g = await setupGroup();
    const token = await invite(g);
    const rows = await env.DB.prepare("SELECT token_hash FROM co_operator_invites WHERE group_id = ?1")
      .bind(g.gid)
      .all<{ token_hash: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).not.toBe(token);
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("공동 운영자는 5명까지다", async () => {
    const g = await setupGroup();
    for (let i = 0; i < 5; i++) await addCo(g);
    const full = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("CO_OPERATORS_FULL");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_co_operators WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(count!.n).toBe(5);
  });

  it("인원이 찬 뒤 남아 있던 링크로 수락하면 거절된다", async () => {
    const g = await setupGroup();
    for (let i = 0; i < 4; i++) await addCo(g);
    const token = await invite(g);
    // 링크를 만든 뒤 다른 경로로 다섯 번째가 들어온 상황(같은 시각의 다른 수락)을 표에 직접 만든다.
    const fifth = await login();
    await env.DB.prepare("INSERT INTO group_co_operators (group_id, account_id, created_at) VALUES (?1, ?2, ?3)")
      .bind(g.gid, await accountIdOf(fifth), new Date().toISOString())
      .run();
    const late = await api(await login(), "POST", `/api/co-invite/${token}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("CO_OPERATORS_FULL");
  });

  it("이미 모임이 있는 계정·대표 본인·로그인 안 한 사람은 수락할 수 없다", async () => {
    const g = await setupGroup();
    const token = await invite(g);
    expect((await api(null, "POST", `/api/co-invite/${token}/accept`)).status).toBe(401);
    const self = await api(g.cookie, "POST", `/api/co-invite/${token}/accept`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("ALREADY_OPERATOR");
    const other = await setupGroup();
    const busy = await api(other.cookie, "POST", `/api/co-invite/${token}/accept`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("HAS_GROUP");
    expect(busy.body.error.message).toContain("이미 운영 중인 모임");
    // 거절된 뒤에도 링크는 남아 다른 계정이 쓸 수 있다.
    expect((await api(await login(), "POST", `/api/co-invite/${token}/accept`)).status).toBe(200);
  });

  it("없는 링크는 모임 정보를 드러내지 않는다", async () => {
    const info = await api(await login(), "GET", "/api/co-invite/없는토큰");
    expect(info.status).toBe(404);
    expect(JSON.stringify(info.body)).not.toContain("groupName");
  });
});

describe("공동 운영자의 권한", () => {
  it("일반 쓰기(경기 시작·결과·정정·설정·참가자)는 대표와 같이 할 수 있다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const asCo: TestGroup = { ...g, cookie: co };
    const started = await start(asCo, rosterOf(g.people));
    expect(started.status).toBe(200);
    const done = await matchAction(asCo, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue" });
    expect(done.status).toBe(200);
    const fixed = await matchAction(asCo, done.body.match, "correct", { field: "side", winnerSide: "red" });
    expect(fixed.status).toBe(200);
    expect((await api(co, "POST", `/api/groups/${g.gid}/participants`, { names: ["새사람"] })).status).toBe(200);
    expect((await api(co, "PATCH", `/api/groups/${g.gid}`, { name: "바꾼 이름" })).status).toBe(200);
    expect((await api(co, "POST", `/api/groups/${g.gid}/view-token`)).status).toBe(200);
    expect((await api(co, "GET", `/api/groups/${g.gid}/export`)).status).toBe(200);
    // 대표가 보는 기록에도 그대로 있다.
    expect((await snapshot(g)).matches.filter((m) => m.state === "confirmed")).toHaveLength(1);
  });

  it("대표 전용 작업 4종(넘기기·삭제·복원·공동 운영자 초대와 내보내기)은 서버가 거절한다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    const co = await addCo(g);
    const other = await addCo(g);
    const otherId = await accountIdOf(other);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;

    const attempts: [string, string, unknown?][] = [
      ["POST", `/api/groups/${g.gid}/transfer`],
      ["POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" }],
      ["POST", `/api/groups/${g.gid}/restore/preview`, { backup }],
      ["POST", `/api/groups/${g.gid}/restore`, { requestId: requestId(), confirm: "복원", baseGeneration: 0, backup }],
      ["POST", `/api/groups/${g.gid}/co-operators/invite`],
      ["GET", `/api/groups/${g.gid}/co-operators`],
      ["DELETE", `/api/groups/${g.gid}/co-operators/${otherId}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await api(co, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code).toBe("OWNER_ONLY");
    }
    // 아무것도 바뀌지 않았다.
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(200);
    expect((await api(other, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(200);
    const transfers = await env.DB.prepare("SELECT COUNT(*) AS n FROM operator_transfers WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(transfers!.n).toBe(0);
  });

  it("내보내면 그 계정의 다음 쓰기가 바로 거절된다. 스스로 나갈 수도 있다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const leaver = await addCo(g);
    expect((await api(co, "POST", `/api/groups/${g.gid}/participants`, { names: ["가"] })).status).toBe(200);
    const kicked = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/co-operators/${await accountIdOf(co)}`);
    expect(kicked.status).toBe(200);
    expect((await api(co, "POST", `/api/groups/${g.gid}/participants`, { names: ["나"] })).status).toBe(404);
    expect((await api(co, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
    expect((await api(co, "GET", "/api/me")).body.groups).toEqual([]);

    expect((await api(leaver, "POST", `/api/groups/${g.gid}/co-operators/leave`)).status).toBe(200);
    expect((await api(leaver, "POST", `/api/groups/${g.gid}/participants`, { names: ["다"] })).status).toBe(404);
    // 대표는 "나가기"로 나갈 수 없다(공동 운영자 행이 없다).
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/leave`)).status).toBe(404);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/co-operators`)).body.coOperators).toEqual([]);
  });

  it("공동 운영자는 다른 모임에 접근할 수 없다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const other = await setupGroup();
    expect((await api(co, "GET", `/api/groups/${other.gid}/snapshot`)).status).toBe(404);
    expect((await api(co, "POST", `/api/groups/${other.gid}/participants`, { names: ["가"] })).status).toBe(404);
    // 다른 모임의 대표도 이 모임의 공동 운영자 목록을 볼 수 없다.
    expect((await api(other.cookie, "GET", `/api/groups/${g.gid}/co-operators`)).status).toBe(404);
    // 다른 모임 대표가 이 모임의 공동 운영자를 내보낼 수 없다.
    const res = await api(other.cookie, "DELETE", `/api/groups/${g.gid}/co-operators/${await accountIdOf(co)}`);
    expect(res.status).toBe(404);
    expect((await api(co, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(200);
  });
});

describe("공동 운영자 정리", () => {
  it("넘기기: 받는 계정이 공동 운영자였으면 그 행을 지우고, 이전 대표는 권한을 잃고, 다른 공동 운영자는 남는다", async () => {
    const g = await setupGroup();
    const heir = await addCo(g);
    const stay = await addCo(g);
    const pending = await invite(g);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).body.token as string;
    expect((await api(heir, "POST", `/api/transfer/${token}/accept`)).status).toBe(200);

    expect((await api(heir, "GET", "/api/me")).body.groups).toEqual([{ id: g.gid, name: "내 내전 모임", role: "owner" }]);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
    const list = await api(heir, "GET", `/api/groups/${g.gid}/co-operators`);
    expect(list.body.coOperators.map((c: { accountId: string }) => c.accountId)).toEqual([await accountIdOf(stay)]);
    // 이전 대표가 만든 쓰지 않은 초대 링크는 지워진다.
    expect((await api(await login(), "POST", `/api/co-invite/${pending}/accept`)).status).toBe(404);
  });

  it("탈퇴: 공동 운영자는 탈퇴할 수 있고 공동 운영자 행이 지워진다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const id = await accountIdOf(co);
    const res = await api(co, "POST", "/api/account/delete", { confirm: "탈퇴" });
    expect(res.status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_co_operators WHERE account_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    expect(left!.n).toBe(0);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/co-operators`)).body.coOperators).toEqual([]);
  });

  it("모임 삭제: 공동 운영자·초대 링크 행이 함께 지워진다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    await invite(g);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(200);
    for (const table of ["group_co_operators", "co_operator_invites"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`)
        .bind(g.gid)
        .first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
    expect((await api(co, "GET", "/api/me")).body.groups).toEqual([]);
  });

  it("백업에는 공동 운영자가 없고, 복원해도 기존 공동 운영자는 그대로다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    const co = await addCo(g);
    const coId = await accountIdOf(co);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(JSON.stringify(backup)).not.toContain(coId);
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: (await snapshot(g)).group.generation,
      backup,
    });
    expect(restored.status).toBe(200);
    expect((await api(co, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(200);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/co-operators`)).body.coOperators).toHaveLength(1);
  });

  it("조회 링크 응답에는 공동 운영자 정보가 없다", async () => {
    const g = await setupGroup();
    const co = await addCo(g);
    const snap = await snapshot(g);
    const view = await api(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain(await accountIdOf(co));
  });
});
