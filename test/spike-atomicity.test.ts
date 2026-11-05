import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * 구현 0번 스파이크 (docs/P4 P4-1, P4-7).
 * 확인할 것: D1 batch() 안에서 보호 문장이 CHECK 위반으로 실패하면
 * 같은 batch의 앞뒤 문장이 모두 되돌려지는가.
 */

const now = "2026-11-05T00:00:00.000Z";

async function createGroup(id: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO groups (id, name, view_token, created_at) VALUES (?1, ?2, ?3, ?4)",
  )
    .bind(id, `모임 ${id}`, `token-${id}`, now)
    .run();
}

async function liveVersion(id: string): Promise<number> {
  const row = await env.DB.prepare("SELECT live_version FROM groups WHERE id = ?1")
    .bind(id)
    .first<{ live_version: number }>();
  return row!.live_version;
}

async function participantCount(groupId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM participants WHERE group_id = ?1")
    .bind(groupId)
    .first<{ n: number }>();
  return row!.n;
}

/** 진행 상태 버전이 기대값과 다르면 CHECK 위반을 일으키는 보호 문장. */
function versionGuard(groupId: string, expected: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM groups WHERE id = ?1 AND live_version = ?2
     )`,
  ).bind(groupId, expected);
}

function insertParticipant(groupId: string, id: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO participants (id, group_id, name, name_key, created_at) VALUES (?1, ?2, ?3, ?3, ?4)",
  ).bind(id, groupId, id, now);
}

function bumpVersion(groupId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE groups SET live_version = live_version + 1 WHERE id = ?1").bind(
    groupId,
  );
}

describe("D1 batch 원자성 스파이크", () => {
  it("버전이 맞으면 batch 전체가 저장된다", async () => {
    await createGroup("spike-ok");
    await env.DB.batch([
      versionGuard("spike-ok", 0),
      insertParticipant("spike-ok", "spike-ok-p1"),
      bumpVersion("spike-ok"),
    ]);
    expect(await participantCount("spike-ok")).toBe(1);
    expect(await liveVersion("spike-ok")).toBe(1);
  });

  it("보호 문장이 맨 앞에서 실패하면 뒤 문장이 실행되지 않는다", async () => {
    await createGroup("spike-first");
    await expect(
      env.DB.batch([
        versionGuard("spike-first", 99),
        insertParticipant("spike-first", "spike-first-p1"),
        bumpVersion("spike-first"),
      ]),
    ).rejects.toThrow(/guard_version_conflict|CHECK constraint/i);
    expect(await participantCount("spike-first")).toBe(0);
    expect(await liveVersion("spike-first")).toBe(0);
  });

  it("보호 문장이 맨 뒤에서 실패하면 앞 문장이 되돌려진다", async () => {
    await createGroup("spike-last");
    await expect(
      env.DB.batch([
        insertParticipant("spike-last", "spike-last-p1"),
        bumpVersion("spike-last"),
        // 앞에서 버전이 1이 됐으므로 기대값 0은 어긋난다.
        versionGuard("spike-last", 0),
      ]),
    ).rejects.toThrow();
    expect(await participantCount("spike-last")).toBe(0);
    expect(await liveVersion("spike-last")).toBe(0);
  });

  it("중간 문장의 유일 제약 위반도 batch 전체를 되돌린다", async () => {
    await createGroup("spike-uniq");
    await insertParticipant("spike-uniq", "spike-uniq-p1").run();
    await expect(
      env.DB.batch([
        bumpVersion("spike-uniq"),
        insertParticipant("spike-uniq", "spike-uniq-p2"),
        // 같은 기본 키를 다시 넣어 실패시킨다.
        insertParticipant("spike-uniq", "spike-uniq-p1"),
        bumpVersion("spike-uniq"),
      ]),
    ).rejects.toThrow();
    expect(await participantCount("spike-uniq")).toBe(1);
    expect(await liveVersion("spike-uniq")).toBe(0);
  });

  it("동시에 보낸 두 batch 중 하나만 성공한다", async () => {
    await createGroup("spike-race");
    const attempt = (pid: string) =>
      env.DB.batch([
        versionGuard("spike-race", 0),
        insertParticipant("spike-race", pid),
        bumpVersion("spike-race"),
      ]);
    const results = await Promise.allSettled([attempt("spike-race-a"), attempt("spike-race-b")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);
    expect(await participantCount("spike-race")).toBe(1);
    expect(await liveVersion("spike-race")).toBe(1);
  });

  it("다른 모임의 참가자를 명단에 연결할 수 없다 (복합 외래 키)", async () => {
    await createGroup("spike-fk-a");
    await createGroup("spike-fk-b");
    await insertParticipant("spike-fk-b", "spike-fk-b-p1").run();
    await env.DB.prepare(
      `INSERT INTO matches (id, group_id, match_no, state, source, played_at)
       VALUES ('spike-fk-m1', 'spike-fk-a', 1, 'in_progress', 'live', ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO match_roster (match_id, group_id, participant_id, team, position)
         VALUES ('spike-fk-m1', 'spike-fk-a', 'spike-fk-b-p1', 'A', 'top')`,
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
