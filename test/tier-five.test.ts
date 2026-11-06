import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, upgradeGroupWeights, type Snapshot } from "../src/shared/types";
import { api, login, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";

// 티어 5단계(2026-11-06): 1~5 저장·거절, migrations/0020, 4개짜리 가중치 읽기, 4단계 시절 백업 복원, 조회 응답.

type Backup = Record<string, any>;

async function setTier(g: TestGroup, index: number, skillGroup: unknown) {
  return api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[index]!.id}`, { skillGroup });
}

async function saveWeights(g: TestGroup, groupWeights: unknown, extra: Record<string, unknown> = {}) {
  const snap = await snapshot(g);
  return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
    requestId: requestId(),
    baseSettingsVersionId: snap.group.settingsVersionId,
    settings: { ...snap.group.settings, groupWeights, ...extra },
  });
}

/** 4단계 시절처럼 가중치 4개짜리 설정 버전을 DB에 바로 넣고 현재 설정으로 둔다(저장 API는 이제 5개로 바꿔 저장하므로). */
async function storeOldSettings(g: TestGroup, groupWeights: number[]) {
  const id = `old-${crypto.randomUUID()}`;
  const payload = JSON.stringify({ rotationEnabled: true, groupsPublic: false, groupWeights });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO settings_versions (id, group_id, version_no, payload, created_at)
       SELECT ?1, ?2, COALESCE(MAX(version_no), 0) + 1, ?3, '2026-11-01T00:00:00.000Z'
       FROM settings_versions WHERE group_id = ?2`,
    ).bind(id, g.gid, payload),
    env.DB.prepare("UPDATE groups SET settings_version_id = ?1 WHERE id = ?2").bind(id, g.gid),
  ]);
}

describe("티어 1~5 저장", () => {
  it("5티어를 저장하고, 0·6·소수·글자는 거절하며 거절된 요청은 값을 바꾸지 않는다", async () => {
    const g = await setupGroup(6);
    for (let tier = 1; tier <= 5; tier++) expect((await setTier(g, tier - 1, tier)).status).toBe(200);
    for (const bad of [0, 6, -1, 2.5, "5"]) {
      const res = await setTier(g, 4, bad);
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_FIELD");
    }
    const snap = await snapshot(g);
    expect(g.people.slice(0, 6).map((p) => snap.participants.find((x) => x.id === p.id)!.skillGroup)).toEqual([
      1, 2, 3, 4, 5, null,
    ]);
    expect((await setTier(g, 4, null)).status).toBe(200);
    expect((await snapshot(g)).participants.find((x) => x.id === g.people[4]!.id)!.skillGroup).toBeNull();
  });

  it("DB도 1~5만 받는다(CHECK): 5는 되고 0·6은 거절", async () => {
    const g = await setupGroup(1);
    const id = g.people[0]!.id;
    const set = (v: number) => env.DB.prepare("UPDATE participants SET skill_group = ?1 WHERE id = ?2").bind(v, id).run();
    await set(5);
    await expect(set(6)).rejects.toThrow(/CHECK/);
    await expect(set(0)).rejects.toThrow(/CHECK/);
    const row = await env.DB.prepare("SELECT skill_group FROM participants WHERE id = ?1").bind(id).first();
    expect(row).toEqual({ skill_group: 5 });
  });
});

describe("migrations/0020: 기존 값 보존", () => {
  it("4단계 시절 표(CHECK 1~4, 외래 키로 참조됨)에 같은 문장을 돌리면 값·행·외래 키가 그대로이고 범위만 1~5가 된다", async () => {
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0020"));
    expect(migration).toBeDefined();
    // 마이그레이션 문장을 표 이름만 바꿔 따로 만든 옛 모양 표에 적용한다(실제 participants는 이미 적용된 상태라).
    const parent = `sim_participants_${crypto.randomUUID().replaceAll("-", "")}`;
    const child = `${parent}_child`;
    await env.DB.batch([
      env.DB.prepare(
        `CREATE TABLE ${parent} (
          id TEXT NOT NULL, group_id TEXT NOT NULL, name TEXT NOT NULL,
          skill_group INTEGER CHECK (skill_group IS NULL OR skill_group BETWEEN 1 AND 4),
          status TEXT NOT NULL DEFAULT 'active', avoid_positions TEXT,
          PRIMARY KEY (id), UNIQUE (group_id, id))`,
      ),
      env.DB.prepare(`CREATE UNIQUE INDEX ${parent}_name ON ${parent} (group_id, name) WHERE status = 'active'`),
      env.DB.prepare(
        `CREATE TABLE ${child} (group_id TEXT NOT NULL, participant_id TEXT NOT NULL,
          FOREIGN KEY (group_id, participant_id) REFERENCES ${parent} (group_id, id))`,
      ),
    ]);
    const values = [1, 2, 3, 4, null, 4, 1, null];
    await env.DB.batch(
      values.flatMap((v, i) => [
        env.DB.prepare(`INSERT INTO ${parent} (id, group_id, name, skill_group, avoid_positions) VALUES (?1, 'g', ?2, ?3, ?4)`).bind(
          `p${i}`,
          `n${i}`,
          v,
          i === 2 ? "top" : null,
        ),
        env.DB.prepare(`INSERT INTO ${child} (group_id, participant_id) VALUES ('g', ?1)`).bind(`p${i}`),
      ]),
    );
    await expect(env.DB.prepare(`UPDATE ${parent} SET skill_group = 5 WHERE id = 'p0'`).run()).rejects.toThrow(/CHECK/);

    for (const query of migration!.queries) {
      await env.DB.prepare(query.replaceAll("participants", parent)).run();
    }

    const rows = await env.DB.prepare(`SELECT id, name, skill_group, status, avoid_positions FROM ${parent} ORDER BY id`).all();
    expect(rows.results).toEqual(
      values.map((v, i) => ({ id: `p${i}`, name: `n${i}`, skill_group: v, status: "active", avoid_positions: i === 2 ? "top" : null })),
    );
    const columns = (await env.DB.prepare(`PRAGMA table_info(${parent})`).all<{ name: string }>()).results.map((c) => c.name);
    expect(columns).not.toContain("skill_group_new");
    expect(columns.filter((c) => c === "skill_group")).toHaveLength(1);
    // 외래 키가 여전히 맞고(어긋난 행 없음), 걸려 있다(없는 참가자는 못 넣음).
    expect((await env.DB.prepare(`PRAGMA foreign_key_check(${child})`).all()).results).toEqual([]);
    await expect(env.DB.prepare(`INSERT INTO ${child} (group_id, participant_id) VALUES ('g', 'nobody')`).run()).rejects.toThrow(
      /FOREIGN KEY/,
    );
    // 범위는 1~5.
    await env.DB.prepare(`UPDATE ${parent} SET skill_group = 5 WHERE id = 'p0'`).run();
    await expect(env.DB.prepare(`UPDATE ${parent} SET skill_group = 6 WHERE id = 'p0'`).run()).rejects.toThrow(/CHECK/);
    await expect(env.DB.prepare(`UPDATE ${parent} SET skill_group = 0 WHERE id = 'p0'`).run()).rejects.toThrow(/CHECK/);
    await env.DB.batch([env.DB.prepare(`DROP TABLE ${child}`), env.DB.prepare(`DROP TABLE ${parent}`)]);
  });

  it("실제 participants 표도 열이 하나이고 1~5 검사가 걸려 있다", async () => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'participants'").first<{
      sql: string;
    }>();
    expect(row!.sql).toContain("skill_group BETWEEN 1 AND 5");
    expect(row!.sql).not.toContain("BETWEEN 1 AND 4");
    expect(row!.sql).not.toContain("skill_group_new");
  });
});

describe("가중치 5개", () => {
  it("4개짜리 값 맞추기: 예전 기본값은 새 기본값, 직접 바꾼 값은 같은 간격으로 한 칸 더(0 밑으로는 안 감)", () => {
    expect(upgradeGroupWeights([4, 3, 2, 1])).toEqual([5, 4, 3, 2, 1]);
    expect(upgradeGroupWeights([9, 7, 5, 3])).toEqual([9, 7, 5, 3, 1]);
    expect(upgradeGroupWeights([10, 6, 3, 1])).toEqual([10, 6, 3, 1, 0]);
    expect(upgradeGroupWeights([4, 3, 1, 0])).toEqual([4, 3, 1, 0, 0]);
    expect(upgradeGroupWeights([1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1]);
    expect(upgradeGroupWeights([0.5, 0.4, 0.3, 0.2])).toEqual([0.5, 0.4, 0.3, 0.2, 0.1]);
    expect(upgradeGroupWeights([1, 2, 3, 4])).toEqual([1, 2, 3, 4, 5]);
    expect(upgradeGroupWeights([1, 2, 3, 1000])).toEqual([1, 2, 3, 1000, 1000]);
    expect(upgradeGroupWeights([5, 4, 3, 2, 1])).toEqual([5, 4, 3, 2, 1]);
    expect(DEFAULT_SETTINGS.groupWeights).toEqual([5, 4, 3, 2, 1]);
  });

  it("새 모임의 기본값은 [5,4,3,2,1]", async () => {
    const g = await setupGroup(1);
    expect((await snapshot(g)).group.settings.groupWeights).toEqual([5, 4, 3, 2, 1]);
  });

  it("이미 저장된 4개짜리 설정은 읽을 때 5개로 맞춘다(기본값·직접 바꾼 값). 저장 행은 그대로 둔다", async () => {
    const g = await setupGroup(1);
    await storeOldSettings(g, [4, 3, 2, 1]);
    expect((await snapshot(g)).group.settings.groupWeights).toEqual([5, 4, 3, 2, 1]);
    await storeOldSettings(g, [9, 7, 5, 3]);
    const snap = await snapshot(g);
    expect(snap.group.settings.groupWeights).toEqual([9, 7, 5, 3, 1]);
    const stored = await env.DB.prepare("SELECT payload FROM settings_versions WHERE id = ?1")
      .bind(snap.group.settingsVersionId)
      .first<{ payload: string }>();
    expect(JSON.parse(stored!.payload).groupWeights).toEqual([9, 7, 5, 3]);
    // 그 상태에서 다른 설정을 바꿔 저장하면 5개로 저장된다.
    expect((await saveWeights(g, snap.group.settings.groupWeights, { rotationEnabled: false })).status).toBe(200);
    const saved = await snapshot(g);
    const payload = await env.DB.prepare("SELECT payload FROM settings_versions WHERE id = ?1")
      .bind(saved.group.settingsVersionId)
      .first<{ payload: string }>();
    expect(JSON.parse(payload!.payload).groupWeights).toEqual([9, 7, 5, 3, 1]);
  });

  it("저장: 5개를 받고, 예전 화면이 보낸 4개는 5개로 맞춰 저장한다. 3개·6개·음수·1000 초과는 거절", async () => {
    const g = await setupGroup(1);
    expect((await saveWeights(g, [8, 6, 4, 2, 1])).status).toBe(200);
    expect((await snapshot(g)).group.settings.groupWeights).toEqual([8, 6, 4, 2, 1]);
    expect((await saveWeights(g, [4, 3, 2, 1])).status).toBe(200);
    expect((await snapshot(g)).group.settings.groupWeights).toEqual([5, 4, 3, 2, 1]);
    for (const bad of [[3, 2, 1], [6, 5, 4, 3, 2, 1], [5, 4, 3, 2, -1], [5, 4, 3, 2, 1001], [5, 4, 3, 2, "1"]]) {
      const res = await saveWeights(g, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("조회 응답", () => {
  it("비공개면 가중치는 [0,0,0,0,0]이고 5티어도 나가지 않는다. 공개하면 5개 가중치와 티어가 나간다", async () => {
    const g = await setupGroup(5);
    for (let i = 0; i < 5; i++) await setTier(g, i, i + 1);
    const snap = await snapshot(g);
    const view = await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(view.body.group.settings.groupWeights).toEqual([0, 0, 0, 0, 0]);
    expect(JSON.stringify(view.body)).not.toContain("skillGroup");
    expect((await saveWeights(g, snap.group.settings.groupWeights, { groupsPublic: true })).status).toBe(200);
    const open = await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`);
    expect(open.body.group.settings.groupWeights).toEqual([5, 4, 3, 2, 1]);
    expect(open.body.participants.map((p) => p.skillGroup).sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("백업 복원", () => {
  async function exportOf(g: TestGroup): Promise<Backup> {
    const res = await api<Backup>(g.cookie, "GET", `/api/groups/${g.gid}/export`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("4단계 시절 백업(티어 1~4, 가중치 4개)은 그대로 복원되고 가중치는 5개로 읽힌다", async () => {
    const g = await setupGroup(6);
    for (let i = 0; i < 4; i++) await setTier(g, i, i + 1);
    const backup = await exportOf(g);
    expect(backup.formatVersion).toBe(4);
    // 옛 백업 모양: 모든 설정 버전의 가중치가 4개(기본값 하나, 직접 바꾼 값 하나).
    backup.settingsVersions.forEach((v: Backup, i: number) => {
      v.settings.groupWeights = i === backup.settingsVersions.length - 1 ? [9, 7, 5, 3] : [4, 3, 2, 1];
    });
    const newcomer = await login();
    const res = await api(newcomer, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(res.status).toBe(200);
    const imported = (await api<Snapshot>(newcomer, "GET", `/api/groups/${res.body.groupId}/snapshot`)).body;
    expect(imported.group.settings.groupWeights).toEqual([9, 7, 5, 3, 1]);
    const tierOf = new Map(imported.participants.map((p) => [p.name, p.skillGroup]));
    expect(g.people.map((p) => tierOf.get(p.name))).toEqual([1, 2, 3, 4, null, null]);

    // 같은 모임 복구도 같다.
    const snap = await snapshot(g);
    const same = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
    expect(same.status).toBe(200);
    expect((await snapshot(g)).group.settings.groupWeights).toEqual([9, 7, 5, 3, 1]);
  });

  it("5티어가 든 백업은 복원되고, 티어 6이 든 백업은 거절된다", async () => {
    const g = await setupGroup(2);
    await setTier(g, 0, 5);
    const backup = await exportOf(g);
    const newcomer = await login();
    const ok = await api(newcomer, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(ok.status).toBe(200);
    const imported = (await api<Snapshot>(newcomer, "GET", `/api/groups/${ok.body.groupId}/snapshot`)).body;
    expect(imported.participants.find((p) => p.name === g.people[0]!.name)!.skillGroup).toBe(5);

    backup.participants[0].skillGroup = 6;
    const other = await login();
    const bad = await api(other, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("실력 그룹 값 오류");
  });
});
