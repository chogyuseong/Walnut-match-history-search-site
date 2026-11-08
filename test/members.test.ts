import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { pathForLog } from "../src/server/http";
import { scrubPath } from "../src/shared/errorScrub";
import { personRecords } from "../src/shared/stats";
import type { Snapshot } from "../src/shared/types";
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

// 참가자 본인 연결 · 멤버 기능 · 요청 · 익명 처리(migrations/0019, src/server/members.ts).

async function claimLink(g: TestGroup, pid: string, cookie = g.cookie): Promise<string> {
  const res = await api(cookie, "POST", `/api/groups/${g.gid}/participants/${pid}/claim-link`);
  expect(res.status).toBe(200);
  return res.body.token as string;
}

/** 새 계정을 g의 참가자 pid에 연결한다. */
async function linkNew(g: TestGroup, pid: string): Promise<string> {
  const token = await claimLink(g, pid);
  const member = await login();
  const accepted = await api(member, "POST", `/api/claim/${token}/accept`);
  expect(accepted.status).toBe(200);
  expect(accepted.body).toEqual({ groupId: g.gid, participantId: pid });
  return member;
}

const memberSnap = async (cookie: string, gid: string) => api<Snapshot>(cookie, "GET", `/api/member/${gid}/snapshot`);

async function accountIdOf(cookie: string): Promise<string> {
  return (await api(cookie, "GET", "/api/me")).body.accountId as string;
}

async function count(table: string, gid: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`).bind(gid).first<{ n: number }>();
  return row!.n;
}

describe("본인 연결: 연결 링크", () => {
  it("운영자가 만든 링크를 다른 계정이 수락하면 연결되고 /api/me의 memberships에 따로 보인다(groups는 그대로)", async () => {
    const g = await setupGroup();
    const p = g.people[2]!;
    const token = await claimLink(g, p.id);
    const member = await login();
    // 링크 정보: 모임 이름과 그 참가자 이름만.
    const info = await api(null, "GET", `/api/claim/${token}`);
    expect(info.status).toBe(200);
    expect(Object.keys(info.body).sort()).toEqual(["expiresAt", "groupName", "participantName"]);
    expect(info.body).toMatchObject({ groupName: "내 내전 모임", participantName: "참가자3" });
    // 로그인 없이 수락할 수 없다.
    expect((await api(null, "POST", `/api/claim/${token}/accept`)).status).toBe(401);
    expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);

    const me = (await api(member, "GET", "/api/me")).body;
    expect(me.groups).toEqual([]);
    expect(me.memberships).toEqual([
      { id: g.gid, name: "내 내전 모임", participantId: p.id, participantName: "참가자3", role: "member" },
    ]);
    // 운영자에게는 연결 여부만(계정 정보 없음) 보인다.
    const snap = await snapshot(g);
    expect(snap.memberLinks).toEqual([{ participantId: p.id, linkedAt: expect.any(String), avoidBySelf: false }]);
    expect(JSON.stringify(snap.memberLinks)).not.toContain(await accountIdOf(member));
    expect(snap.memberClaims).toEqual([]);
    // 링크는 한 번만.
    expect((await api(await login(), "POST", `/api/claim/${token}/accept`)).body.error.code).toBe("CLAIM_INVALID");
    // 토큰은 해시만 저장한다.
    const rows = await env.DB.prepare("SELECT token_hash FROM participant_claims WHERE group_id = ?1")
      .bind(g.gid)
      .all<{ token_hash: string }>();
    expect(rows.results.map((r) => r.token_hash)).not.toContain(token);
    expect(rows.results[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("다시 만들면 이전 링크는 무효, 만료된 링크는 거절, 쓰지 않은 링크는 운영자 화면에 만료 시각만 보인다", async () => {
    const g = await setupGroup();
    const p = g.people[0]!;
    const old = await claimLink(g, p.id);
    const fresh = await claimLink(g, p.id);
    const member = await login();
    for (const res of [await api(member, "POST", `/api/claim/${old}/accept`), await api(member, "GET", `/api/claim/${old}`)]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CLAIM_INVALID");
    }
    const snap = await snapshot(g);
    expect(snap.memberClaims).toEqual([{ participantId: p.id, expiresAt: expect.any(String) }]);
    expect(JSON.stringify(snap)).not.toContain(fresh);
    await env.DB.prepare("UPDATE participant_claims SET expires_at = '2000-01-01T00:00:00.000Z' WHERE group_id = ?1")
      .bind(g.gid)
      .run();
    expect((await api(member, "POST", `/api/claim/${fresh}/accept`)).body.error.code).toBe("CLAIM_INVALID");
    expect((await snapshot(g)).memberClaims).toEqual([]);
    expect((await api(member, "GET", "/api/me")).body.memberships).toEqual([]);
    // 잘못된 모양의 토큰도 같은 답.
    expect((await api(member, "GET", "/api/claim/x")).body.error.code).toBe("CLAIM_INVALID");
  });

  it("같은 링크를 두 계정이 동시에 수락하면 하나만 성공한다", async () => {
    const g = await setupGroup();
    const token = await claimLink(g, g.people[0]!.id);
    const a = await login();
    const b = await login();
    const results = await Promise.all([
      api(a, "POST", `/api/claim/${token}/accept`),
      api(b, "POST", `/api/claim/${token}/accept`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404].sort());
    expect(await count("participant_links", g.gid)).toBe(1);
  });

  it("한 참가자에 계정 하나, 한 계정은 한 모임에서 참가자 하나. 운영자 본인도 자기 이름에 연결할 수 있다", async () => {
    const g = await setupGroup();
    const member = await linkNew(g, g.people[0]!.id);
    // 이미 연결된 참가자에는 링크를 만들 수 없다.
    const again = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[0]!.id}/claim-link`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_LINKED");
    // 같은 계정이 같은 모임의 다른 이름에 연결하려 하면 거절.
    const second = await claimLink(g, g.people[1]!.id);
    const dup = await api(member, "POST", `/api/claim/${second}/accept`);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ALREADY_MEMBER");
    // 거절된 링크는 남아 다른 계정(여기서는 운영자 본인)이 쓸 수 있다.
    const own = await api(g.cookie, "POST", `/api/claim/${second}/accept`);
    expect(own.status).toBe(200);
    const me = (await api(g.cookie, "GET", "/api/me")).body;
    expect(me.groups).toEqual([{ id: g.gid, name: "내 내전 모임", role: "owner" }]);
    expect(me.memberships).toHaveLength(1);
    // 그 사이 참가자가 다른 계정과 연결된 경우(표에 직접 만듦) 남아 있던 링크로는 수락할 수 없다.
    const third = await claimLink(g, g.people[2]!.id);
    const other = await login();
    await env.DB.prepare(
      "INSERT INTO participant_links (group_id, participant_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(g.gid, g.people[2]!.id, await accountIdOf(other), new Date().toISOString())
      .run();
    const late = await api(await login(), "POST", `/api/claim/${third}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("ALREADY_LINKED");
  });

  it("연결은 계정당 모임 한도(5)에 세지 않고, 연결 수는 20개까지다", async () => {
    const member = await login();
    const accountId = await accountIdOf(member);
    const now = new Date().toISOString();
    for (let i = 0; i < 20; i++) {
      const gid = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO groups (id, name, view_token, created_at) VALUES (?1, '가짜', ?2, ?3)").bind(
          gid,
          crypto.randomUUID(),
          now,
        ),
        env.DB.prepare(
          "INSERT INTO participant_links (group_id, participant_id, account_id, created_at) VALUES (?1, ?2, ?3, ?4)",
        ).bind(gid, crypto.randomUUID(), accountId, now),
      ]);
    }
    // 모임은 여전히 만들 수 있다(대표·공동 합계에 세지 않음).
    expect((await api(member, "POST", "/api/groups", {})).status).toBe(200);
    const g = await setupGroup();
    const token = await claimLink(g, g.people[0]!.id);
    const full = await api(member, "POST", `/api/claim/${token}/accept`);
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("TOO_MANY_LINKS");
  });

  it("끊기: 운영자도 본인도 끊을 수 있고, 끊으면 다음 요청부터 바로 멤버 권한이 없다", async () => {
    const g = await setupGroup();
    const member = await linkNew(g, g.people[0]!.id);
    expect((await memberSnap(member, g.gid)).status).toBe(200);
    expect((await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${g.people[0]!.id}/link`)).status).toBe(200);
    expect((await memberSnap(member, g.gid)).status).toBe(404);
    expect((await api(member, "GET", "/api/me")).body.memberships).toEqual([]);
    expect((await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${g.people[0]!.id}/link`)).status).toBe(404);

    const again = await linkNew(g, g.people[0]!.id);
    expect((await api(again, "POST", `/api/member/${g.gid}/unlink`)).status).toBe(200);
    expect((await memberSnap(again, g.gid)).status).toBe(404);
    expect((await api(again, "POST", `/api/member/${g.gid}/unlink`)).status).toBe(404);
    expect(await count("participant_links", g.gid)).toBe(0);
  });

  it("다른 모임: 다른 모임 참가자에는 링크를 못 만들고, 멤버는 연결한 모임만 본다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const foreign = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${other.people[0]!.id}/claim-link`);
    expect(foreign.status).toBe(404);
    // 다른 모임의 운영자는 이 모임 참가자의 링크를 못 만든다.
    expect(
      (await api(other.cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[0]!.id}/claim-link`)).status,
    ).toBe(404);
    const member = await linkNew(g, g.people[0]!.id);
    expect((await memberSnap(member, other.gid)).status).toBe(404);
    expect((await api(member, "PUT", `/api/member/${other.gid}/avoid`, { avoidPositions: ["top"] })).status).toBe(404);
    expect((await api(member, "POST", `/api/member/${other.gid}/requests`, { kind: "erase" })).status).toBe(404);
    expect((await api(null, "GET", `/api/member/${g.gid}/snapshot`)).status).toBe(401);
    // 합쳐진 이름에는 링크를 만들 수 없다.
    await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: g.people[5]!.id,
      targetId: g.people[6]!.id,
    });
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[5]!.id}/claim-link`);
    expect(merged.body.error.code).toBe("MERGED_PARTICIPANT");
  });

  it("로그에는 연결 토큰을 남기지 않는다", () => {
    expect(pathForLog("/api/claim/AbCdEf123456789/accept")).toBe("/api/claim/[token]/accept");
    expect(scrubPath("/#/claim/AbCdEf123456789")).toBe("/#/claim/[token]");
    expect(scrubPath("/api/claim/AbCdEf123456789")).toBe("/api/claim/[token]");
  });
});

describe("멤버 읽기", () => {
  it("조회 링크 응답과 같은 범위에 내 것(me)만 더한다: 티어·남의 기피 라인·보정값·토큰 없음", async () => {
    const g = await setupGroup();
    const [mine, other] = g.people;
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${mine!.id}`, { skillGroup: 1, avoidPositions: ["mid"] });
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${other!.id}`, {
      skillGroup: 2,
      avoidPositions: ["support", "jungle"],
    });
    await playConfirmed(g, rosterOf(g.people));
    await api(g.cookie, "POST", `/api/groups/${g.gid}/rotation/counts`, {
      requestId: requestId(),
      counts: [{ participantId: other!.id, count: 3 }],
    });
    const member = await linkNew(g, mine!.id);
    const res = await memberSnap(member, g.gid);
    expect(res.status).toBe(200);
    const snap = await snapshot(g);
    const view = (await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`)).body;
    const { me, serverTime: _a, ...rest } = res.body;
    const { serverTime: _b, ...viewRest } = view;
    expect(rest).toEqual(viewRest);
    expect(me).toEqual({ participantId: mine!.id, avoidPositions: ["mid"], avoidBySelf: false, requests: [] });
    const text = JSON.stringify(rest);
    for (const word of ["skillGroup", "avoidPositions", "adjustments", "viewToken", "memberLinks", "memberRequests", snap.group.viewToken!]) {
      expect(text).not.toContain(word);
    }
    expect(rest.group.settingsVersionId).toBeUndefined();
    expect(rest.group.generation).toBeUndefined();
    // 조회 응답에는 멤버 정보가 없다.
    expect(JSON.stringify(view)).not.toContain('"me"');
    expect(view.memberLinks).toBeUndefined();
  });
});

describe("멤버는 운영자 경로를 쓸 수 없다", () => {
  it("대표적인 운영자 읽기·쓰기 경로에서 비운영자와 같은 응답(404)", async () => {
    const g = await setupGroup();
    const member = await linkNew(g, g.people[0]!.id);
    const stranger = await login();
    const match = await playConfirmed(g, rosterOf(g.people));
    const snap = await snapshot(g);
    const pid = g.people[0]!.id;
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/groups/${g.gid}/snapshot`],
      ["GET", `/api/groups/${g.gid}/export`],
      ["GET", `/api/groups/${g.gid}/join`],
      ["GET", `/api/groups/${g.gid}/co-operators`],
      ["PATCH", `/api/groups/${g.gid}`, { name: "바꿈" }],
      ["PATCH", `/api/groups/${g.gid}/participants/${pid}`, { avoidPositions: ["top"] }],
      ["PATCH", `/api/groups/${g.gid}/participants/${pid}`, { skillGroup: 1 }],
      ["POST", `/api/groups/${g.gid}/participants`, { names: ["새사람"] }],
      ["PUT", `/api/groups/${g.gid}/settings`, { requestId: requestId(), baseSettingsVersionId: "x", settings: snap.group.settings }],
      ["POST", `/api/groups/${g.gid}/matches/start`, { requestId: requestId(), baseLiveVersion: 0, roster: rosterOf(g.people) }],
      ["POST", `/api/groups/${g.gid}/matches/${match.id}/correct`, { requestId: requestId(), baseMatchVersion: match.version }],
      ["POST", `/api/groups/${g.gid}/matches/${match.id}/memo`, { requestId: requestId(), memo: "x", baseMemo: null }],
      ["POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: pid, targetId: g.people[1]!.id }],
      ["POST", `/api/groups/${g.gid}/view-token`],
      ["POST", `/api/groups/${g.gid}/join/link`],
      ["POST", `/api/groups/${g.gid}/participants/${g.people[1]!.id}/claim-link`],
      ["DELETE", `/api/groups/${g.gid}/participants/${pid}/link`],
      ["POST", `/api/groups/${g.gid}/participants/${pid}/anonymize`, { requestId: requestId(), confirm: "익명" }],
      ["POST", `/api/groups/${g.gid}/member-requests/x/resolve`, { status: "done" }],
      ["POST", `/api/groups/${g.gid}/co-operators/invite`],
      ["POST", `/api/groups/${g.gid}/transfer`],
      ["POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" }],
      ["POST", `/api/groups/${g.gid}/rotation/counts`, { requestId: requestId(), counts: [] }],
    ];
    for (const [method, path, body] of calls) {
      const asMember = await api(member, method, path, body);
      const asStranger = await api(stranger, method, path, body);
      expect(asMember.status, `${method} ${path}`).toBe(404);
      expect(asMember.status, `${method} ${path}`).toBe(asStranger.status);
      expect(asMember.body.error.code).toBe(asStranger.body.error.code);
    }
    // 아무것도 바뀌지 않았다.
    const after = await snapshot(g);
    expect(after.group.name).toBe("내 내전 모임");
    expect(after.participants.find((p) => p.id === pid)!.avoidPositions).toBeUndefined();
    expect(after.matches).toEqual(snap.matches);
    expect(after.group.viewToken).toBe(snap.group.viewToken);
  });
});

describe("내 기피 라인", () => {
  it("멤버는 자기 것만 고치고(검증은 운영자와 같다), 운영자 화면에 '본인이 정함'이 보이고, 운영자가 다시 고칠 수 있다", async () => {
    const g = await setupGroup();
    const pid = g.people[0]!.id;
    const member = await linkNew(g, pid);
    const set = await api(member, "PUT", `/api/member/${g.gid}/avoid`, { avoidPositions: ["support", "top", "support"] });
    expect(set.status).toBe(200);
    let snap = await snapshot(g);
    expect(snap.participants.find((p) => p.id === pid)!.avoidPositions).toEqual(["top", "support"]);
    expect(snap.memberLinks![0]!.avoidBySelf).toBe(true);
    expect((await memberSnap(member, g.gid)).body.me).toMatchObject({ avoidPositions: ["top", "support"], avoidBySelf: true });

    for (const bad of [["top", "jungle", "mid", "adc", "support"], ["탑"], "top", 3]) {
      const res = await api(member, "PUT", `/api/member/${g.gid}/avoid`, { avoidPositions: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api(member, "PUT", `/api/member/${g.gid}/avoid`, {})).status).toBe(400);
    // 다른 사람 것을 고칠 길이 없다(참가자 ID를 받지 않는다).
    const other = await api(member, "PUT", `/api/member/${g.gid}/avoid`, {
      participantId: g.people[1]!.id,
      avoidPositions: ["top"],
    });
    expect(other.status).toBe(400);
    snap = await snapshot(g);
    expect(snap.participants.find((p) => p.id === g.people[1]!.id)!.avoidPositions).toBeUndefined();

    // 운영자가 고치면 '본인이 정함' 표시가 지워진다.
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { avoidPositions: ["mid"] });
    snap = await snapshot(g);
    expect(snap.participants.find((p) => p.id === pid)!.avoidPositions).toEqual(["mid"]);
    expect(snap.memberLinks![0]!.avoidBySelf).toBe(false);
    // 운영자가 이름만 고치면 표시는 그대로다.
    await api(member, "PUT", `/api/member/${g.gid}/avoid`, { avoidPositions: null });
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { name: "새이름" });
    snap = await snapshot(g);
    expect(snap.participants.find((p) => p.id === pid)!.avoidPositions).toBeUndefined();
    expect(snap.memberLinks![0]!.avoidBySelf).toBe(true);
  });
});

describe("본인 확인된 참가 신청", () => {
  const joinAs = (cookie: string | null, token: string, body: unknown) => api(cookie, "POST", `/api/join/${token}`, body);
  const cancelAs = (cookie: string | null, token: string, key: string) =>
    api(cookie, "POST", `/api/join/${token}/cancel`, { key });

  it("멤버가 자기 이름으로 신청하면 본인 확인됨: 다른 사람은 못 빼고, 본인·운영자는 뺀다", async () => {
    const g = await setupGroup();
    const pid = g.people[0]!.id;
    const member = await linkNew(g, pid);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    // 멤버로 열면 내 이름이 미리 정해진다.
    const info = await api(member, "GET", `/api/join/${token}`);
    expect(info.body.me).toEqual({ participantId: pid });
    expect((await api(null, "GET", `/api/join/${token}`)).body.me).toBeUndefined();

    const joined = await joinAs(member, token, { participantId: pid });
    expect(joined.body.entries).toEqual([{ key: `p:${pid}`, name: "참가자1", verified: true, mine: true }]);
    // 로그인 안 한 사람·다른 계정은 못 뺀다.
    for (const cookie of [null, await login()]) {
      const res = await cancelAs(cookie, token, `p:${pid}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("JOIN_VERIFIED");
    }
    const anon = await api(null, "GET", `/api/join/${token}`);
    expect(anon.body.entries).toEqual([{ key: `p:${pid}`, name: "참가자1", verified: true }]);
    // 운영자 화면에도 본인 확인됨.
    const admin = await api(g.cookie, "GET", `/api/groups/${g.gid}/join`);
    expect(admin.body.entries[0]).toMatchObject({ key: `p:${pid}`, verified: true });
    // 본인은 뺀다.
    expect((await cancelAs(member, token, `p:${pid}`)).body.entries).toEqual([]);
    // 운영자는 공개 화면에서도, 운영 화면에서도 뺀다.
    await joinAs(member, token, { participantId: pid });
    expect((await cancelAs(g.cookie, token, `p:${pid}`)).body.entries).toEqual([]);
    await joinAs(member, token, { participantId: pid });
    const removed = await api(g.cookie, "POST", `/api/groups/${g.gid}/join/remove`, { requestId: requestId(), key: `p:${pid}` });
    expect(removed.body.entries).toEqual([]);
  });

  it("연결된 이름으로 남이 익명 신청하면 예전처럼 받고 누구나 뺀다. 본인이 나중에 신청하면 본인 것으로 바뀐다", async () => {
    const g = await setupGroup();
    const pid = g.people[0]!.id;
    const member = await linkNew(g, pid);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    const anon = await joinAs(null, token, { participantId: pid });
    expect(anon.body.entries).toEqual([{ key: `p:${pid}`, name: "참가자1" }]);
    expect((await cancelAs(null, token, `p:${pid}`)).body.entries).toEqual([]);
    await joinAs(null, token, { name: "참가자1" });
    // 멤버가 다른 사람 이름으로 신청하면 본인 확인 없이 들어간다.
    const forOther = await joinAs(member, token, { participantId: g.people[1]!.id });
    expect(forOther.body.entries[1]).toEqual({ key: `p:${g.people[1]!.id}`, name: "참가자2" });
    // 본인이 신청하면 같은 줄이 본인 확인 신청으로 바뀐다(줄은 하나).
    const upgraded = await joinAs(member, token, { participantId: pid });
    expect(upgraded.body.entries[0]).toEqual({ key: `p:${pid}`, name: "참가자1", verified: true, mine: true });
    expect(upgraded.body.entries).toHaveLength(2);
    expect((await cancelAs(null, token, `p:${pid}`)).status).toBe(403);
    // 연결을 끊으면 본인 확인 표시가 사라지고 다시 누구나 뺄 수 있다.
    await api(member, "POST", `/api/member/${g.gid}/unlink`);
    expect((await api(null, "GET", `/api/join/${token}`)).body.entries[0]).toEqual({ key: `p:${pid}`, name: "참가자1" });
    expect((await cancelAs(null, token, `p:${pid}`)).status).toBe(200);
  });
});

describe("참가자 요청", () => {
  it("정정 요청은 자기가 뛴 경기만, 열린 요청은 5개까지, 남의 요청은 보이지 않고, 운영자가 처리하면 상태와 답이 보인다", async () => {
    const g = await setupGroup();
    const [a, b] = g.people;
    const played = await playConfirmed(g, rosterOf(g.people)); // 앞 10명
    const other = await setupGroup();
    const foreign = await playConfirmed(other, rosterOf(other.people));
    const memberA = await linkNew(g, a!.id);
    const memberK = await linkNew(g, g.people[10]!.id); // 첫 경기에 없는 사람

    const ok = await api(memberA, "POST", `/api/member/${g.gid}/requests`, {
      kind: "correction",
      matchId: played.id,
      text: "  레드팀이 이겼어요\n<b>확인</b> 부탁해요 ",
    });
    expect(ok.status).toBe(200);
    expect((await api(memberK, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: played.id, text: "x" })).status).toBe(404);
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: foreign.id, text: "x" })).status).toBe(404);
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: "없음", text: "x" })).status).toBe(404);
    // 글 검증: 정정은 내용 필수, 200자, 모르는 항목·종류 거절.
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: played.id, text: "  " })).status).toBe(400);
    expect(
      (await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: played.id, text: "가".repeat(201) })).body.error.code,
    ).toBe("TEXT_TOO_LONG");
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "delete" })).status).toBe(400);
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", matchId: played.id })).status).toBe(400);
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", participantId: b!.id })).status).toBe(400);
    // 기록은 바뀌지 않는다.
    expect((await snapshot(g)).matches.find((m) => m.id === played.id)).toEqual(played);

    for (let i = 0; i < 4; i++) {
      expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: `요청 ${i}` })).status).toBe(200);
    }
    const sixth = await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase" });
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe("TOO_MANY_REQUESTS");
    // 다른 멤버의 요청은 보이지 않는다(내 것만). 조회 응답에도 없다.
    await api(memberK, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "K의 요청" });
    const mineA = (await memberSnap(memberA, g.gid)).body.me!.requests;
    expect(mineA).toHaveLength(5);
    expect(JSON.stringify((await memberSnap(memberA, g.gid)).body)).not.toContain("K의 요청");
    const snap = await snapshot(g);
    const view = await api(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(JSON.stringify(view.body)).not.toContain("레드팀이 이겼어요");
    expect(snap.memberRequests).toHaveLength(6);
    const correction = snap.memberRequests!.find((r) => r.kind === "correction")!;
    expect(correction).toMatchObject({
      participantId: a!.id,
      matchId: played.id,
      text: "레드팀이 이겼어요\n<b>확인</b> 부탁해요",
      status: "open",
      reply: null,
    });
    // 멤버는 요청을 처리할 수 없다(운영자 경로).
    expect((await api(memberA, "POST", `/api/groups/${g.gid}/member-requests/${correction.id}/resolve`, { status: "done" })).status).toBe(404);
    // 운영자가 처리한다. 다른 모임 운영자는 못 한다.
    expect(
      (await api(other.cookie, "POST", `/api/groups/${g.gid}/member-requests/${correction.id}/resolve`, { status: "done" })).status,
    ).toBe(404);
    expect(
      (await api(other.cookie, "POST", `/api/groups/${other.gid}/member-requests/${correction.id}/resolve`, { status: "done" })).status,
    ).toBe(404);
    const resolved = await api(g.cookie, "POST", `/api/groups/${g.gid}/member-requests/${correction.id}/resolve`, {
      status: "done",
      reply: "고쳤어요",
    });
    expect(resolved.status).toBe(200);
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/member-requests/${correction.id}/resolve`, { status: "declined" })).body.error.code,
    ).toBe("ALREADY_RESOLVED");
    const seen = (await memberSnap(memberA, g.gid)).body.me!.requests.find((r) => r.id === correction.id)!;
    expect(seen).toMatchObject({ status: "done", reply: "고쳤어요", resolvedAt: expect.any(String) });
    // 처리하면 다시 남길 수 있다(열린 요청 4개).
    expect((await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase" })).status).toBe(200);
  });
});

describe("익명 처리", () => {
  it("이름·보관·연결·기피 라인·티어·요청·신청을 정리하고, 경기 기록과 통계는 그대로다", async () => {
    const g = await setupGroup();
    const target = g.people[0]!;
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${target.id}`, { skillGroup: 1, avoidPositions: ["mid"] });
    const m1 = await playConfirmed(g, rosterOf(g.people));
    await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${m1.id}/memo`, {
      requestId: requestId(),
      memo: "참가자1 캐리",
      baseMemo: null,
    });
    await playConfirmed(g, rosterOf(g.people.slice(2)), "B", "red");
    const member = await linkNew(g, target.id);
    await api(member, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "지워 주세요" });
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    await api(member, "POST", `/api/join/${token}`, { participantId: target.id });
    await api(null, "POST", `/api/join/${token}`, { participantId: g.people[1]!.id });
    const before = await snapshot(g);

    // 확인 문구가 없으면 거절.
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${target.id}/anonymize`, { requestId: requestId(), confirm: "네" })).body.error.code,
    ).toBe("CONFIRM_REQUIRED");
    const done = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${target.id}/anonymize`, {
      requestId: requestId(),
      confirm: "익명",
    });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ name: "탈퇴한 참가자 1", count: 1, memoMatchNos: [m1.matchNo] });

    const after = await snapshot(g);
    const p = after.participants.find((x) => x.id === target.id)!;
    // version: 참가자 행 버전(migrations/0021, 운영자 스냅숏에만).
    expect(p).toEqual({ id: target.id, name: "탈퇴한 참가자 1", status: "archived", skillGroup: null, version: expect.any(Number) });
    expect(after.memberLinks).toEqual([]);
    expect(after.memberRequests).toEqual([]);
    expect((await memberSnap(member, g.gid)).status).toBe(404);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/join`)).body.entries.map((e: { name: string }) => e.name)).toEqual([
      "참가자2",
    ]);
    // 경기 기록(명단·승패·라인)과 통계는 그대로다.
    expect(after.matches).toEqual(before.matches);
    expect([...personRecords(after.matches)]).toEqual([...personRecords(before.matches)]);
    // 옛 이름은 모임 자료에 남지 않는다(메모는 운영자가 직접 고친다 — 경기 번호를 알려 줌).
    const withoutMemo = JSON.stringify({ ...after, matches: after.matches.map(({ memo: _m, ...m }) => m) });
    expect(withoutMemo).not.toContain('"참가자1"');
    // 다시 익명 처리는 거절, 다음 사람은 다음 번호.
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${target.id}/anonymize`, { requestId: requestId(), confirm: "익명" })).body.error.code,
    ).toBe("ALREADY_ANONYMIZED");
    const second = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[1]!.id}/anonymize`, {
      requestId: requestId(),
      confirm: "익명",
    });
    expect(second.body.name).toBe("탈퇴한 참가자 2");
  });

  it("이 사람에게 합쳐진 이름도 함께 익명으로 바꾸고, 합쳐진 이름 자체는 남은 사람으로 하라고 거절한다", async () => {
    const g = await setupGroup();
    const [src, dst] = g.people;
    await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: src!.id, targetId: dst!.id });
    const onSource = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${src!.id}/anonymize`, {
      requestId: requestId(),
      confirm: "익명",
    });
    expect(onSource.body.error.code).toBe("MERGED_PARTICIPANT");
    const done = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${dst!.id}/anonymize`, {
      requestId: requestId(),
      confirm: "익명",
    });
    expect(done.body).toMatchObject({ name: "탈퇴한 참가자 1", count: 2 });
    const names = (await snapshot(g)).participants.filter((p) => p.id === src!.id || p.id === dst!.id).map((p) => p.name);
    expect(names.sort()).toEqual(["탈퇴한 참가자 1", "탈퇴한 참가자 2"]);
  });
});

describe("다른 기능과의 정리", () => {
  it("합치기: 남은 사람에게 연결이 없으면 옮기고, 있으면 합쳐진 쪽 연결을 지운다. 되돌려도 연결은 남은 사람에게 남는다", async () => {
    const g = await setupGroup();
    const [a, b, c, d] = g.people;
    const memberA = await linkNew(g, a!.id);
    await api(memberA, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "A 요청" });
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: a!.id, targetId: b!.id });
    expect(merged.status).toBe(200);
    let me = (await memberSnap(memberA, g.gid)).body.me!;
    expect(me.participantId).toBe(b!.id);
    expect(me.requests.map((r) => r.text)).toEqual(["A 요청"]);
    const undo = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${merged.body.mergeId}/undo`, { requestId: requestId() });
    expect(undo.status).toBe(200);
    me = (await memberSnap(memberA, g.gid)).body.me!;
    expect(me.participantId).toBe(b!.id);

    const memberC = await linkNew(g, c!.id);
    const memberD = await linkNew(g, d!.id);
    await api(memberC, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "C 요청" });
    await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, { requestId: requestId(), sourceId: c!.id, targetId: d!.id });
    expect((await memberSnap(memberC, g.gid)).status).toBe(404);
    const dView = (await memberSnap(memberD, g.gid)).body.me!;
    expect(dView.participantId).toBe(d!.id);
    // 합쳐진 쪽의 요청은 남은 사람의 멤버에게 넘어가지 않는다(운영자만 본다).
    expect(dView.requests).toEqual([]);
    expect((await snapshot(g)).memberRequests!.some((r) => r.text === "C 요청" && r.participantId === c!.id)).toBe(true);
  });

  it("탈퇴하면 연결을 지우고 본인 확인 신청은 익명 신청으로 남는다. 참가자와 기록은 그대로다", async () => {
    const g = await setupGroup();
    const pid = g.people[0]!.id;
    const member = await linkNew(g, pid);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    await api(member, "POST", `/api/join/${token}`, { participantId: pid });
    expect((await api(member, "POST", "/api/account/delete", { confirm: "탈퇴" })).status).toBe(200);
    expect(await count("participant_links", g.gid)).toBe(0);
    expect((await api(null, "GET", `/api/join/${token}`)).body.entries).toEqual([{ key: `p:${pid}`, name: "참가자1" }]);
    expect((await snapshot(g)).participants.find((p) => p.id === pid)!.name).toBe("참가자1");
  });

  it("모임 삭제는 연결·연결 링크·요청을 함께 지운다", async () => {
    const g = await setupGroup();
    const member = await linkNew(g, g.people[0]!.id);
    await claimLink(g, g.people[1]!.id);
    await api(member, "POST", `/api/member/${g.gid}/requests`, { kind: "erase" });
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(200);
    for (const table of ["participant_links", "participant_claims", "participant_requests"]) {
      expect(await count(table, g.gid), table).toBe(0);
    }
    expect((await api(member, "GET", "/api/me")).body.memberships).toEqual([]);
  });

  it("백업에는 연결·요청이 없고, 복원해도 참가자가 남아 있으면 연결은 유지, 없어지면 지운다", async () => {
    const g = await setupGroup();
    const match = await playConfirmed(g, rosterOf(g.people));
    const kept = await linkNew(g, g.people[0]!.id);
    await api(kept, "POST", `/api/member/${g.gid}/requests`, { kind: "correction", matchId: match.id, text: "남는 요청" });
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    const text = JSON.stringify(backup);
    expect(text).not.toContain("남는 요청");
    expect(text).not.toMatch(/memberLinks|memberRequests|memberClaims|participant_links/);
    // 백업 뒤에 생긴 참가자와 그 연결은 복원하면 없어진다.
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["새사람"] });
    const newId = created.body.participants[0].id as string;
    const gone = await linkNew(g, newId);
    await api(gone, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "사라질 요청" });
    await claimLink(g, newId === g.people[1]!.id ? g.people[2]!.id : g.people[1]!.id);
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: (await snapshot(g)).group.generation,
      backup,
    });
    expect(restored.status).toBe(200);
    expect((await memberSnap(kept, g.gid)).status).toBe(200);
    expect((await memberSnap(kept, g.gid)).body.me!.requests.map((r) => r.text)).toEqual(["남는 요청"]);
    expect((await memberSnap(gone, g.gid)).status).toBe(404);
    const snap = await snapshot(g);
    expect(snap.memberLinks!.map((l) => l.participantId)).toEqual([g.people[0]!.id]);
    expect(snap.memberRequests!.map((r) => r.text)).toEqual(["남는 요청"]);
    // 같은 백업을 새 모임으로 가져오면 연결은 따라가지 않는다.
    const other = await login();
    const imported = await api(other, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    if (imported.status === 200) {
      expect(await count("participant_links", imported.body.groupId as string)).toBe(0);
    }
  });
});
