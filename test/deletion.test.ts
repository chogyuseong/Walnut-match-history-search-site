import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { backupKey } from "../src/server/backupCron";
import { deletionHooks } from "../src/server/deletion";
import type { Env } from "../src/server/env";
import { direct } from "./direct";
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
  type TestGroup,
} from "./helpers";

// 모임 삭제와 계정 삭제(탈퇴) — src/server/deletion.ts.

afterEach(() => {
  deletionHooks.afterStage = null;
});

const GROUP_TABLES = [
  "rotation_events",
  "match_revisions",
  "match_roster",
  "participant_merges",
  "rotation_cycles",
  "matches",
  "sessions",
  "seasons",
  "participants",
  "settings_versions",
  "requests",
  "operator_transfers",
  "restore_jobs",
  "group_operators",
];

/** 모임의 모든 표에 남은 행 수. */
async function leftovers(gid: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of GROUP_TABLES) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`)
      .bind(gid)
      .first<{ n: number }>();
    if ((row?.n ?? 0) > 0) out[table] = row!.n;
  }
  const group = await env.DB.prepare("SELECT COUNT(*) AS n FROM groups WHERE id = ?1").bind(gid).first<{ n: number }>();
  if ((group?.n ?? 0) > 0) out.groups = group!.n;
  return out;
}

/** 모든 표에 행이 있는 모임: 경기(확정·제외·대기), 순환, 시즌, 합치기, 인수 링크. */
async function fullGroup(): Promise<TestGroup> {
  const g = await setupGroup(12);
  const m1 = await playConfirmed(g, rosterOf(g.people), "A", "blue");
  await playConfirmed(g, rosterOf([...g.people.slice(2), ...g.people.slice(0, 2)]), "B", "red");
  expect((await matchAction(g, m1, "exclude")).status).toBe(200);
  await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, { name: "1시즌", startsOn: "2026-01-01", endsOn: "2026-12-31" });
  const dup = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["부캐"] });
  await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
    requestId: requestId(),
    sourceId: dup.body.participants[0].id,
    targetId: g.people[11]!.id,
  });
  await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`);
  const pending = await start(g, rosterOf([...g.people.slice(1), g.people[0]!]));
  expect(pending.status).toBe(200);
  return g;
}

function deleteGroup(g: TestGroup, confirm = "삭제", cookie = g.cookie) {
  return api(cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm });
}

describe("모임 삭제", () => {
  it("확인 문구가 맞아야 지운다. 모든 표의 행과 모임 행이 사라지고 조회 링크가 바로 막힌다", async () => {
    const g = await fullGroup();
    const token = (await snapshot(g)).group.viewToken!;
    const before = await leftovers(g.gid);
    // 모든 표에 행이 있는지 먼저 확인(빠진 표가 있으면 이 테스트가 의미 없다).
    for (const table of GROUP_TABLES.filter((t) => t !== "restore_jobs")) expect(before[table]).toBeGreaterThan(0);

    const wrong = await deleteGroup(g, "삭제해");
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("CONFIRM_REQUIRED");
    expect(await leftovers(g.gid)).toEqual(before);

    const res = await deleteGroup(g);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, matches: 3, participants: 13 });
    expect(await leftovers(g.gid)).toEqual({});
    expect((await api(null, "GET", `/api/view/${token}`)).status).toBe(404);
    expect((await api(g.cookie, "GET", "/api/me")).body.groups).toEqual([]);
  });

  it("삭제 뒤 오래된 탭의 쓰기·같은 삭제 재전송은 '찾을 수 없음'이다", async () => {
    const g = await setupGroup(10);
    const snap = await snapshot(g);
    expect((await deleteGroup(g)).status).toBe(200);
    const stale = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snap.group.liveVersion,
      roster: rosterOf(g.people),
    });
    expect(stale.status).toBe(404);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
    expect((await deleteGroup(g)).status).toBe(404);
  });

  it("운영자가 아닌 사람·로그인 없음은 지울 수 없고, 다른 모임의 데이터는 그대로다", async () => {
    const g = await fullGroup();
    const other = await fullGroup();
    const otherBefore = fingerprint(await snapshot(other));
    const otherRows = await leftovers(other.gid);
    const stranger = await login();
    expect((await deleteGroup(g, "삭제", stranger)).status).toBe(404);
    expect((await api(null, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(401);
    expect(Object.keys(await leftovers(g.gid)).length).toBeGreaterThan(0);

    expect((await deleteGroup(g)).status).toBe(200);
    expect(fingerprint(await snapshot(other))).toBe(otherBefore);
    expect(await leftovers(other.gid)).toEqual(otherRows);
  });

  it("행이 많으면 단계로 나눠 지운다. 중간에 끊기면 점검 상태·링크 무효로 남고, 다시 실행하면 끝난다", async () => {
    const g = await fullGroup();
    const token = (await snapshot(g)).group.viewToken!;
    const small = { GROUP_DELETE_BATCH_ROWS: "7" };
    deletionHooks.afterStage = (i) => {
      if (i === 1) throw new Error("끊김");
    };
    const cut = await direct(small, "POST", `/api/groups/${g.gid}/delete`, {
      cookie: g.cookie,
      body: { confirm: "삭제" },
    });
    expect(cut.status).toBe(503);
    expect(((await cut.json()) as any).error.code).toBe("DELETE_INCOMPLETE");
    // 조회 링크는 이미 막혔고, 다른 쓰기는 점검 상태로 거절된다.
    expect((await api(null, "GET", `/api/view/${token}`)).status).toBe(404);
    const snap = await snapshot(g);
    expect(snap.group.maintenance).toBe(true);
    const write = await api(g.cookie, "PATCH", `/api/groups/${g.gid}`, { name: "바뀌면 안 됨" });
    expect(write.status).toBe(503);
    expect(write.body.error.code).toBe("MAINTENANCE");

    deletionHooks.afterStage = null;
    const again = await direct(small, "POST", `/api/groups/${g.gid}/delete`, {
      cookie: g.cookie,
      body: { confirm: "삭제" },
    });
    expect(again.status).toBe(200);
    expect(await leftovers(g.gid)).toEqual({});
  });

  describe("서버 자동 백업(R2)도 함께 지운다", () => {
    const bucket = () => (env as unknown as Env).BACKUPS!;
    const keysOf = async (gid: string) =>
      (await bucket().list({ prefix: `backups/${gid}/` })).objects.map((o) => o.key).sort();

    it("한 batch 삭제: 그 모임의 백업만 지우고 다른 모임의 백업은 남긴다", async () => {
      const g = await setupGroup(10);
      const other = await setupGroup(10);
      await bucket().put(backupKey(g.gid, "2026-11-01"), "{}");
      await bucket().put(backupKey(g.gid, "2026-11-02"), "{}");
      await bucket().put(backupKey(other.gid, "2026-11-01"), "{}");

      expect((await deleteGroup(g)).status).toBe(200);
      expect(await keysOf(g.gid)).toEqual([]);
      expect(await keysOf(other.gid)).toEqual([backupKey(other.gid, "2026-11-01")]);
    });

    it("여러 단계 삭제: 중간에 끊기면 백업은 남고(모임도 남음), 다시 실행해 끝나면 지운다", async () => {
      const g = await fullGroup();
      await bucket().put(backupKey(g.gid, "2026-11-01"), "{}");
      const small = { GROUP_DELETE_BATCH_ROWS: "7" };
      deletionHooks.afterStage = (i) => {
        if (i === 1) throw new Error("끊김");
      };
      const cut = await direct(small, "POST", `/api/groups/${g.gid}/delete`, { cookie: g.cookie, body: { confirm: "삭제" } });
      expect(cut.status).toBe(503);
      expect(await keysOf(g.gid)).toEqual([backupKey(g.gid, "2026-11-01")]);

      deletionHooks.afterStage = null;
      const again = await direct(small, "POST", `/api/groups/${g.gid}/delete`, { cookie: g.cookie, body: { confirm: "삭제" } });
      expect(again.status).toBe(200);
      expect(await keysOf(g.gid)).toEqual([]);
    });

    it("1000개가 넘어도(목록이 여러 쪽) 모두 지운다", async () => {
      const g = await setupGroup(0);
      const keys = Array.from({ length: 1005 }, (_, i) => `backups/${g.gid}/x-${String(i).padStart(4, "0")}.json`);
      for (let i = 0; i < keys.length; i += 100) {
        await Promise.all(keys.slice(i, i + 100).map((k) => bucket().put(k, "{}")));
      }
      expect((await deleteGroup(g)).status).toBe(200);
      expect(await keysOf(g.gid)).toEqual([]);
    });

    it("R2가 실패해도 모임 삭제는 성공한다(오류는 기록만). 바인딩이 없어도 지운다", async () => {
      const g = await setupGroup(10);
      const broken = {
        list: () => Promise.reject(new Error("R2 끊김")),
        delete: () => Promise.reject(new Error("R2 끊김")),
      } as unknown as R2Bucket;
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
      try {
        const res = await direct({ BACKUPS: broken }, "POST", `/api/groups/${g.gid}/delete`, {
          cookie: g.cookie,
          body: { confirm: "삭제" },
        });
        expect(res.status).toBe(200);
      } finally {
        console.error = original;
      }
      expect(await leftovers(g.gid)).toEqual({});
      expect(errors.some((e) => e.includes('"backup":"delete-failed"') && e.includes(g.gid))).toBe(true);

      const h = await setupGroup(10);
      const res = await direct({ BACKUPS: undefined }, "POST", `/api/groups/${h.gid}/delete`, {
        cookie: h.cookie,
        body: { confirm: "삭제" },
      });
      expect(res.status).toBe(200);
      expect(await leftovers(h.gid)).toEqual({});
    });
  });
});

describe("계정 삭제(탈퇴)", () => {
  it("운영 중인 모임이 있으면 거절하고 그 모임을 알려준다", async () => {
    const g = await setupGroup(10);
    const res = await api(g.cookie, "POST", "/api/account/delete", { confirm: "탈퇴" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HAS_GROUPS");
    expect(res.body.error.details.groups).toEqual([{ id: g.gid, name: "내 내전 모임" }]);
    expect((await api(g.cookie, "GET", "/api/me")).body.accountId).not.toBeNull();
  });

  it("모임을 지운 뒤에는 탈퇴된다. 계정 행이 사라지고 모든 세션이 바로 무효다", async () => {
    const subject = `quit-${Date.now()}`;
    const cookie = await login(subject);
    const second = await login(subject); // 다른 기기의 세션
    const accountId = (await api(cookie, "GET", "/api/me")).body.accountId as string;
    const created = await api(cookie, "POST", "/api/groups", {});
    const g: TestGroup = { cookie, gid: created.body.id, people: [] };

    expect((await api(cookie, "POST", "/api/account/delete", { confirm: "탈퇴할래" })).status).toBe(400);
    expect((await deleteGroup(g)).status).toBe(200);
    const res = await direct({}, "POST", "/api/account/delete", { cookie, body: { confirm: "탈퇴" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("sid=;");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE id = ?1").bind(accountId).first<{ n: number }>();
    expect(row!.n).toBe(0);
    expect((await api(cookie, "GET", "/api/me")).body.accountId).toBeNull();
    expect((await api(second, "GET", "/api/me")).body.accountId).toBeNull();
    expect((await api(second, "POST", "/api/groups", {})).status).toBe(401);

    // 같은 로그인 수단으로 다시 들어오면 새 계정 번호로 시작한다.
    const back = await login(subject);
    const newId = (await api(back, "GET", "/api/me")).body.accountId as string;
    expect(newId).not.toBe(accountId);
  });

  it("로그인 없이는 탈퇴 요청을 받지 않는다", async () => {
    expect((await api(null, "POST", "/api/account/delete", { confirm: "탈퇴" })).status).toBe(401);
  });
});
