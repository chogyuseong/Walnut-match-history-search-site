import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { exportBackup } from "../src/server/groups";
import { rateClock } from "../src/server/ratelimit";
import { direct } from "./direct";
import { api, apiRaw, login, playConfirmed, requestId, rosterOf, setupGroup, snapshot, unique, type TestGroup } from "./helpers";

// 2026-11-08 서버 후속(docs/개선-서버-2026-11-08.md): 요청 ID 필수화, 남은 운영자 쓰기의 runMutation 이전,
// 백업 내려받기 batch화, 304 응답의 요청 수 제한 쓰기 줄이기.

describe("요청 ID 필수(운영자 쓰기)", () => {
  it("요청 ID가 없으면 400 INVALID_FIELD이고 아무것도 바뀌지 않는다", async () => {
    const g = await setupGroup(2);
    const pid = g.people[0]!.id;
    const before = await snapshot(g);
    const cases: [string, string, unknown][] = [
      ["POST", "/api/groups", { name: "요청 ID 없음" }],
      ["PATCH", `/api/groups/${g.gid}`, { name: "바뀌면 안 됨" }],
      ["POST", `/api/groups/${g.gid}/participants`, { names: ["새사람"] }],
      ["PATCH", `/api/groups/${g.gid}/participants/${pid}`, { name: "바뀌면 안 됨" }],
      ["POST", `/api/groups/${g.gid}/seasons`, { name: "S", startsOn: "2026-05-01", endsOn: "2026-05-31" }],
      ["DELETE", `/api/groups/${g.gid}/seasons/none`, undefined],
      ["POST", `/api/groups/${g.gid}/view-token`, undefined],
      ["DELETE", `/api/groups/${g.gid}/participants/${pid}/link`, undefined],
      ["POST", `/api/groups/${g.gid}/member-requests/none/resolve`, { status: "done" }],
    ];
    for (const [method, path, body] of cases) {
      const res = await apiRaw(g.cookie, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body.error.code, `${method} ${path}`).toBe("INVALID_FIELD");
    }
    const after = await snapshot(g);
    expect(after.group.name).toBe(before.group.name);
    expect(after.group.viewToken).toBe(before.group.viewToken);
    expect(after.participants).toEqual(before.participants);
    expect(after.seasons).toEqual([]);
    expect((await api(g.cookie, "GET", "/api/me")).body.groups).toHaveLength(1);
  });
});

/** g의 참가자 pid를 새 계정과 연결한다. */
async function link(g: TestGroup, pid: string): Promise<string> {
  const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${pid}/claim-link`)).body.token as string;
  const member = await login();
  expect((await api(member, "POST", `/api/claim/${token}/accept`)).status).toBe(200);
  return member;
}

async function countRequests(gid: string, op: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE group_id = ?1 AND op = ?2")
    .bind(gid, op)
    .first<{ n: number }>();
  return row!.n;
}

describe("연결 끊기(운영자)·요청 처리: 공통 경로(runMutation)", () => {
  it("연결 끊기: 같은 요청 ID로 다시 보내면 같은 결과(200)이고 한 번만 처리한다. 같은 ID로 다른 사람이면 409", async () => {
    const g = await setupGroup(3);
    const [a, b] = [g.people[0]!.id, g.people[1]!.id];
    const memberA = await link(g, a);
    await link(g, b);
    const id = requestId();
    const first = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${a}/link`, { requestId: id });
    const again = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${a}/link`, { requestId: id });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await countRequests(g.gid, "unlink-participant")).toBe(1);
    expect((await api(memberA, "GET", `/api/member/${g.gid}/snapshot`)).status).toBe(404);
    // 새 요청 ID면 이미 끊긴 연결이라 404(예전과 같다).
    const fresh = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${a}/link`, { requestId: requestId() });
    expect(fresh.status).toBe(404);
    // 같은 요청 ID를 다른 참가자에 쓰면 거절하고 b의 연결은 그대로다.
    const reused = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${b}/link`, { requestId: id });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
    expect((await snapshot(g)).memberLinks!.map((l) => l.participantId)).toEqual([b]);
  });

  it("연결이 없을 때의 404도 재전송에 그대로(쓰지 않은 연결 링크는 지운다)", async () => {
    const g = await setupGroup(2);
    const pid = g.people[0]!.id;
    await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${pid}/claim-link`);
    expect((await snapshot(g)).memberClaims).toHaveLength(1);
    const id = requestId();
    const first = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${pid}/link`, { requestId: id });
    expect(first.status).toBe(404);
    expect((await snapshot(g)).memberClaims).toEqual([]);
    const again = await api(g.cookie, "DELETE", `/api/groups/${g.gid}/participants/${pid}/link`, { requestId: id });
    expect(again.status).toBe(404);
    expect(again.body).toEqual(first.body);
  });

  it("요청 처리: 같은 요청 ID 재전송은 200(409 아님), 새 ID는 ALREADY_RESOLVED, 같은 ID 다른 내용은 REQUEST_ID_REUSED", async () => {
    const g = await setupGroup(2);
    const member = await link(g, g.people[0]!.id);
    const created = await api(member, "POST", `/api/member/${g.gid}/requests`, { kind: "erase", text: "지워 주세요" });
    expect(created.status).toBe(200);
    const rid = created.body.id as string;
    const path = `/api/groups/${g.gid}/member-requests/${rid}/resolve`;
    const id = requestId();
    const first = await api(g.cookie, "POST", path, { requestId: id, status: "declined", reply: "확인했어요" });
    const again = await api(g.cookie, "POST", path, { requestId: id, status: "declined", reply: "확인했어요" });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(await countRequests(g.gid, "resolve-member-request")).toBe(1);
    const row = await env.DB.prepare("SELECT status, reply FROM participant_requests WHERE id = ?1")
      .bind(rid)
      .first<{ status: string; reply: string }>();
    expect(row).toEqual({ status: "declined", reply: "확인했어요" });
    const fresh = await api(g.cookie, "POST", path, { requestId: requestId(), status: "done" });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("ALREADY_RESOLVED");
    const reused = await api(g.cookie, "POST", path, { requestId: id, status: "done" });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/member-requests/none/resolve`, { status: "done" })).status).toBe(404);
  });

  it("요청 처리: 동시에 두 운영자가 처리하면 하나만 성공한다", async () => {
    const g = await setupGroup(2);
    const member = await link(g, g.people[0]!.id);
    const rid = (await api(member, "POST", `/api/member/${g.gid}/requests`, { kind: "erase" })).body.id as string;
    const path = `/api/groups/${g.gid}/member-requests/${rid}/resolve`;
    const results = await Promise.all(
      (["done", "declined"] as const).map((status) => api(g.cookie, "POST", path, { requestId: requestId(), status })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("ALREADY_RESOLVED");
  });
});

describe("백업 내려받기 batch", () => {
  it("D1 batch 한 번으로 읽고, 결과는 화면 내려받기(HTTP)와 같다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, { name: "S1", startsOn: "2026-01-01", endsOn: "2026-12-31" });
    const base = env as unknown as Env;
    let batches = 0;
    const counted: Env = {
      ...base,
      DB: new Proxy(base.DB, {
        get(target, prop, receiver) {
          if (prop === "batch") {
            return (statements: D1PreparedStatement[]) => {
              batches += 1;
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }),
    };
    const exported = await exportBackup(counted, g.gid);
    expect(batches).toBe(1);
    const http = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body as Record<string, unknown>;
    const { createdAt: _a, ...left } = exported;
    const { createdAt: _b, ...right } = http;
    // JSON 문자열로 비교해 키 순서까지 같은지 본다(파일 형식이 그대로).
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(Object.keys(exported)).toEqual([
      "formatVersion",
      "createdAt",
      "scope",
      "group",
      "matchCount",
      "participants",
      "seasons",
      "series",
      "matches",
      "importBatches",
      "revisions",
      "sessions",
      "rotationCycles",
      "rotationEvents",
      "supportAdjustments",
      "settingsVersions",
      "participantMerges",
    ]);
    expect((exported.matches as unknown[]).length).toBe(1);
    expect((exported.settingsVersions as unknown[]).length).toBeGreaterThan(0);
    expect((exported.sessions as unknown[]).length).toBe(1);
  });

  it("없는 모임은 404", async () => {
    await expect(exportBackup(env as unknown as Env, "no-such-group")).rejects.toMatchObject({ status: 404 });
  });
});

describe("304 응답은 요청 수 제한에 세지 않는다(D1 쓰기 절약)", () => {
  const realNow = rateClock.now;
  afterEach(() => {
    rateClock.now = realNow;
  });
  const LIMITS: Partial<Env> = { RATE_WINDOW_SECONDS: "60", RATE_VIEW_PER_IP: "2" };
  function fixClock(): void {
    const now = Math.floor(Date.now() / 60_000) * 60_000 + 20 * 60_000 + 1000;
    rateClock.now = () => now;
  }

  it("조회 링크: 304는 세지 않고 200·없는 토큰(404)은 센다", async () => {
    const g = await setupGroup(2);
    const token = (await snapshot(g)).group.viewToken!;
    fixClock();
    const ip = unique("ip");
    const get = (path: string, etag?: string) =>
      direct(LIMITS, "GET", path, { headers: { "CF-Connecting-IP": ip, ...(etag ? { "If-None-Match": etag } : {}) } });
    const first = await get(`/api/view/${token}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    for (let i = 0; i < 5; i++) expect((await get(`/api/view/${token}`, etag)).status).toBe(304);
    // 304를 다섯 번 받았어도 한도(2)의 두 번째로 센다: 304는 rate_limits에 쓰지 않았다.
    expect((await get(`/api/view/${token}`)).status).toBe(200);
    const over = await get(`/api/view/${token}`);
    expect(over.status).toBe(429);
    // 429 응답에는 ETag·private 캐시 헤더가 붙지 않는다(브라우저가 저장해 304로 되살리지 않게).
    expect(over.headers.get("ETag")).toBeNull();
    expect(over.headers.get("Cache-Control")).toBe("no-store");
    // 한도에 걸려도 같은 ETag의 304는 계속 된다(본문을 다시 만들지 않는다).
    expect((await get(`/api/view/${token}`, etag)).status).toBe(304);

    // 없는 토큰(토큰 맞히기)은 센다.
    const ip2 = unique("ip");
    const guess = () => direct(LIMITS, "GET", `/api/view/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip2 } });
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
  });

  it("참가 신청 공개 조회: 304는 세지 않고 200·없는 링크는 센다", async () => {
    const g = await setupGroup(2);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    fixClock();
    const ip = unique("ip");
    const get = (path: string, etag?: string) =>
      direct(LIMITS, "GET", path, { headers: { "CF-Connecting-IP": ip, ...(etag ? { "If-None-Match": etag } : {}) } });
    const first = await get(`/api/join/${token}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    for (let i = 0; i < 5; i++) expect((await get(`/api/join/${token}`, etag)).status).toBe(304);
    expect((await get(`/api/join/${token}`)).status).toBe(200);
    expect((await get(`/api/join/${token}`)).status).toBe(429);
    const ip2 = unique("ip");
    const guess = () => direct(LIMITS, "GET", `/api/join/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip2 } });
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
  });
});
