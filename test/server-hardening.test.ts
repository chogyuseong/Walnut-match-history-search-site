import { createExecutionContext, createScheduledController, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { backupKey, kstDay, runBackups } from "../src/server/backupCron";
import type { Env } from "../src/server/env";
import { groupLimitGuard, MAX_GROUPS_PER_ACCOUNT } from "../src/server/groups";
import worker from "../src/server/index";
import { api, apiRaw, login, playConfirmed, requestId, rosterOf, setupGroup, snapshot, unique } from "./helpers";

// 2026-11-07 서버 개선(docs/개선-서버-2026-11-07.md): 조건부 요청(ETag·304), 쓰기 경로 통일·동시 수정 보호,
// 모임 수 한도 경쟁, 자동 백업(예정 작업 + R2).

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, { headers: { "CF-Connecting-IP": unique("ip"), ...headers } });
}

async function dataVersion(gid: string): Promise<number> {
  const row = await env.DB.prepare("SELECT data_version FROM groups WHERE id = ?1").bind(gid).first<{ data_version: number }>();
  return row!.data_version;
}

describe("조회 링크 ETag(304)", () => {
  it("같은 ETag면 304(본문 없음), 경기를 저장하면 ETag가 바뀐다", async () => {
    const g = await setupGroup();
    const token = (await snapshot(g)).group.viewToken!;
    const first = await get(`/api/view/${token}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag")!;
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const body = (await first.json()) as { matches: unknown[] };
    expect(body.matches).toEqual([]);

    const again = await get(`/api/view/${token}`, { "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("ETag")).toBe(etag);
    // 여러 값·강한 비교 꼴로 보내도 맞춰 본다.
    expect((await get(`/api/view/${token}`, { "If-None-Match": `"zzz", ${etag.slice(2)}` })).status).toBe(304);

    await playConfirmed(g, rosterOf(g.people));
    const changed = await get(`/api/view/${token}`, { "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("ETag")).not.toBe(etag);
    expect(((await changed.json()) as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it("참가자 이름·시즌·설정·모임 이름이 바뀌어도 ETag가 바뀐다", async () => {
    const g = await setupGroup(2);
    const token = (await snapshot(g)).group.viewToken!;
    const tagOf = async () => (await get(`/api/view/${token}`)).headers.get("ETag")!;
    const steps: [string, () => Promise<unknown>][] = [
      ["참가자 이름", () => api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, { name: "새이름" })],
      ["시즌", () => api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, { name: "S1", startsOn: "2026-01-01", endsOn: "2026-02-01" })],
      [
        "설정",
        async () => {
          const s = await snapshot(g);
          return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
            requestId: requestId(),
            baseSettingsVersionId: s.group.settingsVersionId,
            settings: { ...s.group.settings, groupsPublic: !s.group.settings.groupsPublic },
          });
        },
      ],
      ["모임 이름", () => api(g.cookie, "PATCH", `/api/groups/${g.gid}`, { name: "바뀐 모임" })],
    ];
    let before = await tagOf();
    for (const [label, step] of steps) {
      await step();
      const after = await tagOf();
      expect(after, label).not.toBe(before);
      before = after;
    }
  });

  it("조회 토큰을 다시 만들면 예전 토큰은 ETag가 같아도 404", async () => {
    const g = await setupGroup(2);
    const token = (await snapshot(g)).group.viewToken!;
    const etag = (await get(`/api/view/${token}`)).headers.get("ETag")!;
    const renewed = await api(g.cookie, "POST", `/api/groups/${g.gid}/view-token`);
    expect(renewed.status).toBe(200);
    const old = await get(`/api/view/${token}`, { "If-None-Match": etag });
    expect(old.status).toBe(404);
    const fresh = await get(`/api/view/${renewed.body.viewToken}`, { "If-None-Match": etag });
    // 토큰이 ETag에 들어가므로 새 토큰은 처음 받는 것처럼 200이다.
    expect(fresh.status).toBe(200);
  });

  it("운영자 스냅숏도 같은 ETag면 304, 바뀌면 200(본문은 예전과 같다)", async () => {
    const g = await setupGroup(3);
    const path = `/api/groups/${g.gid}/snapshot`;
    const first = await get(path, { Cookie: g.cookie });
    const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200);
    expect(((await first.json()) as { role: string }).role).toBe("operator");
    expect((await get(path, { Cookie: g.cookie, "If-None-Match": etag })).status).toBe(304);
    // 다른 사람(운영자 아님)은 ETag를 알아도 404.
    expect((await get(path, { Cookie: await login(), "If-None-Match": etag })).status).toBe(404);
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[1]!.id}`, { skillGroup: 2 });
    expect((await get(path, { Cookie: g.cookie, "If-None-Match": etag })).status).toBe(200);
  });

  it("운영자 ETag는 시간만으로 바뀌지 않고, 연결 링크가 만료되는 순간에만 바뀐다(만료된 링크는 304로 남지 않는다)", async () => {
    const g = await setupGroup(3);
    const path = `/api/groups/${g.gid}/snapshot`;
    const claim = (token: string, participantId: string, expiresAt: string) =>
      env.DB.prepare(
        `INSERT INTO participant_claims (token_hash, group_id, participant_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(unique(token), g.gid, participantId, new Date().toISOString(), expiresAt)
        .run();
    // 이미 만료된 링크(ETag 재료에서 빠진다)와 곧 만료될 링크.
    await claim("old", g.people[0]!.id, new Date(Date.now() - 60_000).toISOString());
    await claim("soon", g.people[1]!.id, new Date(Date.now() + 1500).toISOString());
    const first = await get(path, { Cookie: g.cookie });
    const etag = first.headers.get("ETag")!;
    const claims = (await first.json()) as { memberClaims: { participantId: string }[] };
    expect(claims.memberClaims.map((c) => c.participantId)).toEqual([g.people[1]!.id]);
    expect((await get(path, { Cookie: g.cookie, "If-None-Match": etag })).status).toBe(304);

    await new Promise((resolve) => setTimeout(resolve, 1700));
    const expired = await get(path, { Cookie: g.cookie, "If-None-Match": etag });
    expect(expired.status).toBe(200);
    expect(((await expired.json()) as { memberClaims: unknown[] }).memberClaims).toEqual([]);
    const next = expired.headers.get("ETag")!;
    expect(next).not.toBe(etag);
    // 남은 링크가 없으면 시간이 지나도 같은 ETag(예전에는 1분마다 바뀌었다).
    expect((await get(path, { Cookie: g.cookie, "If-None-Match": next })).status).toBe(304);
  });

  it("참가 신청 공개 조회도 ETag로 304, 신청이 들어오면 바뀐다. 다른 경로는 no-store 그대로", async () => {
    const g = await setupGroup(3);
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/join/link`)).body.token as string;
    const first = await get(`/api/join/${token}`);
    const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200);
    expect((await get(`/api/join/${token}`, { "If-None-Match": etag })).status).toBe(304);
    await api(null, "POST", `/api/join/${token}`, { participantId: g.people[0]!.id });
    const after = await get(`/api/join/${token}`, { "If-None-Match": etag });
    expect(after.status).toBe(200);
    expect(((await after.json()) as { entries: unknown[] }).entries).toHaveLength(1);
    expect((await get("/api/health")).headers.get("Cache-Control")).toBe("no-store");
  });

  it("화면 자료 버전(data_version)은 트리거가 올린다: 참가자·경기·신청 표", async () => {
    // 마이그레이션 0021의 트리거가 모두 만들어졌다(BEGIN … END 안의 ;로 문장이 잘리지 않았다).
    const triggers = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_dv_%'",
    ).first<{ n: number }>();
    expect(triggers!.n).toBe(48);
    const g = await setupGroup(10);
    const v0 = await dataVersion(g.gid);
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, { skillGroup: 3 });
    const v1 = await dataVersion(g.gid);
    expect(v1).toBeGreaterThan(v0);
    await playConfirmed(g, rosterOf(g.people));
    expect(await dataVersion(g.gid)).toBeGreaterThan(v1);
  });
});

describe("쓰기 경로 통일(runMutation)", () => {
  it("참가자 수정: 같은 baseVersion으로 동시에 두 건이면 하나는 409 VERSION_CONFLICT", async () => {
    const g = await setupGroup(2);
    const pid = g.people[0]!.id;
    const base = (await snapshot(g)).participants.find((p) => p.id === pid)!.version!;
    expect(base).toBe(0);
    const results = await Promise.all(
      ["가", "나"].map((name) =>
        api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { name: `동시${name}`, baseVersion: base }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect(conflict.body.error.code).toBe("VERSION_CONFLICT");
    expect(conflict.body.error.details.version).toBe(1);
    const p = (await snapshot(g)).participants.find((x) => x.id === pid)!;
    expect(p.version).toBe(1);
    expect(["동시가", "동시나"]).toContain(p.name);
    // baseVersion 없이 보내는 예전 화면도 그대로 된다.
    expect((await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { skillGroup: 1 })).status).toBe(200);
  });

  it("참가자 수정: 읽은 뒤 다른 수정이 끼면 batch 안의 보호 문장이 막는다(화면이 버전을 보내지 않아도)", async () => {
    const g = await setupGroup(2);
    const pid = g.people[0]!.id;
    // 동시에 여러 건: 모두 200이거나 409이고, 성공한 수만큼 버전이 오른다(잃어버린 수정이 없다).
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, { name: `경쟁${n}` })),
    );
    for (const r of results) expect([200, 409]).toContain(r.status);
    const ok = results.filter((r) => r.status === 200).length;
    expect((await snapshot(g)).participants.find((x) => x.id === pid)!.version).toBe(ok);
  });

  it("요청 ID를 다시 보내면 한 번만 처리한다: 모임 만들기·이름 바꾸기·참가자·시즌·조회 토큰", async () => {
    const cookie = await login();
    const createId = requestId();
    const a = await api(cookie, "POST", "/api/groups", { name: "재전송 모임", requestId: createId });
    const b = await api(cookie, "POST", "/api/groups", { name: "재전송 모임", requestId: createId });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const me = await api(cookie, "GET", "/api/me");
    expect(me.body.groups.filter((x: { id: string }) => x.id === a.body.id)).toHaveLength(1);
    expect(me.body.groups).toHaveLength(1);
    // 다른 계정이 같은 요청 ID를 써도 다른 모임이다.
    const other = await api(await login(), "POST", "/api/groups", { name: "남", requestId: createId });
    expect(other.body.id).not.toBe(a.body.id);

    const gid = a.body.id as string;
    const renameId = requestId();
    expect((await api(cookie, "PATCH", `/api/groups/${gid}`, { name: "이름1", requestId: renameId })).status).toBe(200);
    expect((await api(cookie, "PATCH", `/api/groups/${gid}`, { name: "이름1", requestId: renameId })).status).toBe(200);
    const reused = await api(cookie, "PATCH", `/api/groups/${gid}`, { name: "이름2", requestId: renameId });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");

    const ensureId = requestId();
    const p1 = await api(cookie, "POST", `/api/groups/${gid}/participants`, { names: ["갑", "을"], requestId: ensureId });
    const p2 = await api(cookie, "POST", `/api/groups/${gid}/participants`, { names: ["갑", "을"], requestId: ensureId });
    expect(p2.body).toEqual(p1.body);

    const seasonId = requestId();
    const season = { name: "시즌", startsOn: "2026-03-01", endsOn: "2026-03-31", requestId: seasonId };
    const s1 = await api(cookie, "POST", `/api/groups/${gid}/seasons`, season);
    const s2 = await api(cookie, "POST", `/api/groups/${gid}/seasons`, season);
    expect(s1.status).toBe(200);
    expect(s2.body).toEqual(s1.body); // 겹침(SEASON_OVERLAP)이 아니라 같은 결과
    const overlap = await api(cookie, "POST", `/api/groups/${gid}/seasons`, { ...season, requestId: requestId() });
    expect(overlap.body.error.code).toBe("SEASON_OVERLAP");

    const tokenId = requestId();
    const t1 = await api(cookie, "POST", `/api/groups/${gid}/view-token`, { requestId: tokenId });
    const t2 = await api(cookie, "POST", `/api/groups/${gid}/view-token`, { requestId: tokenId });
    expect(t2.body.viewToken).toBe(t1.body.viewToken);
    // 새 요청 ID면 새 토큰.
    const t3 = await api(cookie, "POST", `/api/groups/${gid}/view-token`, { requestId: requestId() });
    expect(t3.status).toBe(200);
    expect(t3.body.viewToken).not.toBe(t1.body.viewToken);
    // 2026-11-08부터 요청 ID는 필수: 본문 없는 예전 요청은 400(test/server-followup.test.ts에서 경로마다 확인).
    expect((await apiRaw(cookie, "POST", `/api/groups/${gid}/view-token`)).status).toBe(400);
    // 시즌 지우기: 같은 요청 ID로 다시 보내도 같은 결과.
    const delId = requestId();
    expect((await api(cookie, "DELETE", `/api/groups/${gid}/seasons/${s1.body.id}`, { requestId: delId })).status).toBe(200);
    expect((await api(cookie, "DELETE", `/api/groups/${gid}/seasons/${s1.body.id}`, { requestId: delId })).status).toBe(200);
    expect((await apiRaw(cookie, "DELETE", `/api/groups/${gid}/seasons/${s1.body.id}`)).status).toBe(400);
  });

  it("모임 수 한도: 동시에 여러 개를 만들어도 한도를 넘지 않는다", async () => {
    const cookie = await login();
    for (let i = 0; i < MAX_GROUPS_PER_ACCOUNT - 1; i++) {
      expect((await api(cookie, "POST", "/api/groups", { name: `모임${i}` })).status).toBe(200);
    }
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => api(cookie, "POST", "/api/groups", { name: `동시${n}`, requestId: requestId() })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("TOO_MANY_GROUPS");
    }
    expect((await api(cookie, "GET", "/api/me")).body.groups).toHaveLength(MAX_GROUPS_PER_ACCOUNT);
  });

  it("모임 수 한도 보호 문장: 한도에 닿은 계정이면 batch 전체가 되돌려진다", async () => {
    const cookie = await login();
    for (let i = 0; i < MAX_GROUPS_PER_ACCOUNT; i++) await api(cookie, "POST", "/api/groups", {});
    const accountId = (await api(cookie, "GET", "/api/me")).body.accountId as string;
    const marker = unique("guard-probe");
    await expect(
      env.DB.batch([
        groupLimitGuard(env as unknown as Env, accountId),
        env.DB.prepare("INSERT INTO accounts (id, provider, subject, created_at) VALUES (?1, 'probe', ?1, '2026-01-01')").bind(marker),
      ]),
    ).rejects.toThrow(/guard_group_limit/);
    expect(await env.DB.prepare("SELECT id FROM accounts WHERE id = ?1").bind(marker).first()).toBeNull();
    // 한도 아래면 통과한다.
    const fresh = await login();
    const freshId = (await api(fresh, "GET", "/api/me")).body.accountId as string;
    await env.DB.batch([groupLimitGuard(env as unknown as Env, freshId)]);
  });
});

describe("자동 백업(예정 작업 + R2)", () => {
  const bucket = () => (env as unknown as Env).BACKUPS!;

  async function runUntilDone(gid: string, now: number): Promise<void> {
    const e = { ...(env as unknown as Env), BACKUP_GROUPS_PER_RUN: "1000" };
    for (let i = 0; i < 20; i++) {
      const row = await env.DB.prepare("SELECT backup_done_at FROM groups WHERE id = ?1").bind(gid).first<{ backup_done_at: string | null }>();
      if (row?.backup_done_at && kstDay(Date.parse(row.backup_done_at)) === kstDay(now)) return;
      await runBackups(e, now);
    }
    throw new Error("백업이 끝나지 않음");
  }

  it("모임 백업을 backups/{모임}/{날짜}.json으로 넣고, 30일 지난 것은 지운다. 내용은 백업 내려받기와 같은 형식", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    const now = Date.now();
    const oldKey = `backups/${g.gid}/2000-01-01.json`;
    const recentKey = backupKey(g.gid, kstDay(now - 5 * 86400_000));
    await bucket().put(oldKey, "{}");
    await bucket().put(recentKey, "{}");

    await runUntilDone(g.gid, now);
    const today = await bucket().get(backupKey(g.gid, kstDay(now)));
    expect(today).not.toBeNull();
    const saved = (await today!.json()) as Record<string, any>;
    const exported = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(saved.formatVersion).toBe(exported.formatVersion);
    expect(saved.group.id).toBe(g.gid);
    expect(saved.matches).toHaveLength(1);
    expect(Object.keys(saved).sort()).toEqual(Object.keys(exported).sort());
    expect(await bucket().head(oldKey)).toBeNull();
    expect(await bucket().head(recentKey)).not.toBeNull();

    // 같은 날 다시 돌려도 이 모임은 다시 하지 않는다(오늘 끝남).
    const before = (await bucket().head(backupKey(g.gid, kstDay(now))))!.uploaded.getTime();
    await runBackups({ ...(env as unknown as Env), BACKUP_GROUPS_PER_RUN: "1000" }, now);
    expect((await bucket().head(backupKey(g.gid, kstDay(now))))!.uploaded.getTime()).toBe(before);
  });

  it("한 실행에 N개까지만 하고, 다음 실행이 이어간다. 점검 중인 모임은 건너뛴다", async () => {
    const now = Date.now() + 3 * 86400_000; // 다른 테스트와 겹치지 않는 날
    const e = { ...(env as unknown as Env), BACKUP_GROUPS_PER_RUN: "2" };
    const groups = await Promise.all([1, 2, 3].map(() => setupGroup(0)));
    const busy = await setupGroup(0);
    await env.DB.prepare("UPDATE groups SET maintenance = 1 WHERE id = ?1").bind(busy.gid).run();
    try {
      const first = await runBackups(e, now);
      expect(first.done).toBe(2);
      expect(first.more).toBe(true);
      for (let i = 0; i < 200; i++) if (!(await runBackups(e, now)).more) break;
      for (const g of groups) expect(await bucket().head(backupKey(g.gid, kstDay(now)))).not.toBeNull();
      expect(await bucket().head(backupKey(busy.gid, kstDay(now)))).toBeNull();
    } finally {
      await env.DB.prepare("UPDATE groups SET maintenance = 0 WHERE id = ?1").bind(busy.gid).run();
    }
  });

  it("scheduled 진입점이 백업을 돌리고, 사이트 현황에 마지막 백업 시각이 나온다", async () => {
    const g = await setupGroup(0);
    const now = Date.now() + 7 * 86400_000;
    const ctx = createExecutionContext();
    // 테스트 환경의 다른 모임이 많아도 이 모임까지 가도록 한도를 넉넉히 준다.
    await worker.scheduled(
      createScheduledController({ scheduledTime: now, cron: "*/5 18-20 * * *" }),
      { ...(env as unknown as Env), BACKUP_GROUPS_PER_RUN: "100000" },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(await bucket().head(backupKey(g.gid, kstDay(now)))).not.toBeNull();

    const admin = await login("e2e-site-admin");
    const overview = await api(admin, "GET", "/api/admin/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.backup.enabled).toBe(true);
    expect(overview.body.backup.lastBackupAt).toBeTruthy();
  });
});
