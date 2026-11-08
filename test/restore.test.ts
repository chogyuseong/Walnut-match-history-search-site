import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { deletionHooks } from "../src/server/deletion";
import { ApiError } from "../src/server/http";
import { runMutation } from "../src/server/mutation";
import { chunkRows, JOB_STALE_MS, restoreHooks, utf8Bytes } from "../src/server/restore";
import type { Snapshot } from "../src/shared/types";
import { direct } from "./direct";
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

// 백업 복원·가져오기(docs/P4 P4-3, 검증 시나리오 36·37·38).

afterEach(() => {
  restoreHooks.afterStage = null;
  deletionHooks.afterStage = null;
});

type Backup = Record<string, any>;

async function exportOf(g: TestGroup): Promise<Backup> {
  const res = await api<Backup>(g.cookie, "GET", `/api/groups/${g.gid}/export`);
  expect(res.status).toBe(200);
  return res.body;
}

/** 앞에서 n명 밀어 고른 10명. 서포터가 이전 경기와 겹치지 않게 할 때 쓴다(rosterOf는 5·10번째가 서포터). */
function shifted(g: TestGroup, n: number) {
  return rosterOf([...g.people.slice(n), ...g.people.slice(0, n)]);
}

/** 경기 2개(하나는 전적 제외), 시즌, 이름이 바뀐 참가자가 있는 모임. */
async function richGroup(): Promise<TestGroup> {
  const g = await setupGroup(12);
  await playConfirmed(g, rosterOf(g.people), "A", "blue");
  const second = await playConfirmed(g, rosterOf([...g.people.slice(2), ...g.people.slice(0, 2)]), "B", "unknown");
  expect((await matchAction(g, second, "exclude")).status).toBe(200);
  await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, {
    name: "1시즌",
    startsOn: "2026-01-01",
    endsOn: "2026-12-31",
  });
  return g;
}

/** 복원 결과 비교용: 버전·변경 이력 번호처럼 복원이 일부러 바꾸는 값은 뺀다. */
function content(snap: Snapshot): string {
  return JSON.stringify({
    name: snap.group.name,
    settings: snap.group.settings,
    participants: snap.participants,
    matches: snap.matches.map((m) => ({ ...m, version: undefined })),
    revisions: snap.revisions.map((r) => [r.matchId, r.kind, r.changes]),
    seasons: snap.seasons,
    session: snap.session,
    rotation: snap.rotation,
  });
}

async function restore(g: TestGroup, backup: Backup, extra: Record<string, unknown> = {}) {
  const snap = await snapshot(g);
  return api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
    requestId: requestId(),
    confirm: "복원",
    baseGeneration: snap.group.generation,
    backup,
    ...extra,
  });
}

describe("같은 모임 복구", () => {
  it("백업 뒤에 바뀐 것을 파일 내용으로 되돌린다(ID 유지)", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const before = await snapshot(g);

    // 백업 뒤의 변경: 경기 추가, 이름 변경.
    await playConfirmed(g, shifted(g, 4), "B", "red");
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, { name: "바뀐이름" });
    expect((await snapshot(g)).matches).toHaveLength(3);

    const preview = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore/preview`, { backup });
    expect(preview.status).toBe(200);
    expect(preview.body.ok).toBe(true);
    expect(preview.body.sameGroup).toBe(true);
    expect(preview.body.current).toEqual({ matches: 3, confirmed: 2, participants: 12 });
    expect(preview.body.file.matches).toBe(2);
    expect(preview.body.file.confirmed).toBe(1);
    expect(preview.body.file.participants).toBe(12);

    const res = await restore(g, backup);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ groupId: g.gid, matches: 2, participants: 12 });

    const after = await snapshot(g);
    expect(content(after)).toBe(content(before));
    expect(after.matches.map((m) => m.id)).toEqual(before.matches.map((m) => m.id));
    expect(after.group.generation).toBe((before.group.generation ?? 0) + 1);
    expect(after.group.liveVersion).toBeGreaterThan(before.group.liveVersion);
    expect(after.group.maintenance).toBe(false);

    // 전적 제외 경기는 복구할 수 있는 상태로 돌아온다(제외 직전 상태가 파일에 있다).
    const excluded = after.matches.find((m) => m.state === "excluded")!;
    expect((await matchAction(g, excluded, "restore")).status).toBe(200);
    // 복원 뒤에도 새 경기를 이어서 시작할 수 있다(경기 번호가 겹치지 않는다).
    const next = await start(g, shifted(g, 4));
    expect(next.status).toBe(200);
    expect(next.body.match.matchNo).toBe(3);
  });

  it("운영자와 조회 토큰은 바뀌지 않는다. 파일에 다른 값이 있어도 무시한다", async () => {
    const g = await richGroup();
    const before = await snapshot(g);
    const backup = await exportOf(g);
    backup.group.viewToken = "attacker-token";
    backup.operator = "someone";
    const res = await restore(g, backup);
    expect(res.status).toBe(200);
    const after = await snapshot(g);
    expect(after.group.viewToken).toBe(before.group.viewToken);
    const operator = await env.DB.prepare("SELECT account_id FROM group_operators WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ account_id: string }>();
    expect(operator!.account_id).toBe((await api(g.cookie, "GET", "/api/me")).body.accountId);
    expect((await api(null, "GET", `/api/view/${before.group.viewToken}`)).status).toBe(200);
    // 다른 계정은 여전히 이 모임을 복원할 수 없다(존재 여부도 드러내지 않음).
    const stranger = await login();
    const denied = await api(stranger, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: after.group.generation,
      backup,
    });
    expect(denied.status).toBe(404);
  });

  it("형식 1(첫 백업 형식) 파일도 복원한다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const before = await snapshot(g);
    backup.formatVersion = 1;
    delete backup.group.currentSettingsVersionId;
    for (const p of backup.participants) delete p.createdAt;
    for (const m of backup.matches) {
      delete m.prevState;
      delete m.settingsVersionId;
      delete m.importBatchId;
    }
    await playConfirmed(g, shifted(g, 4));
    expect((await restore(g, backup)).status).toBe(200);
    const after = await snapshot(g);
    expect(after.matches.map((m) => [m.id, m.state])).toEqual(before.matches.map((m) => [m.id, m.state]));
  });

  it("확인 문구가 없으면, 다른 모임 파일이면 거절한다", async () => {
    const g = await richGroup();
    const other = await richGroup();
    const fp = content(await snapshot(g));
    expect((await restore(g, await exportOf(g), { confirm: "" })).body.error.code).toBe("CONFIRM_REQUIRED");
    const foreign = await restore(g, await exportOf(other));
    expect(foreign.status).toBe(409);
    expect(foreign.body.error.code).toBe("OTHER_GROUP_FILE");
    const preview = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore/preview`, {
      backup: await exportOf(other),
    });
    expect(preview.body.sameGroup).toBe(false);
    expect(content(await snapshot(g))).toBe(fp);
  });
});

describe("손상된 파일은 아무것도 바꾸지 않는다(시나리오 37)", () => {
  const breakers: [string, (b: Backup) => void, RegExp][] = [
    ["참조 누락", (b) => (b.matches[0].roster[0].participantId = "missing-person"), /참가자가 파일에 없습니다/],
    ["경기 수 불일치", (b) => (b.matchCount = 5), /경기 수가 맞지 않습니다/],
    ["명단 9명", (b) => b.matches[0].roster.pop(), /10명이 아닙니다/],
    ["팀 인원", (b) => (b.matches[0].roster.find((r: any) => r.team === "A").team = "B"), /팀당 5명|같은 포지션/],
    ["형식 버전", (b) => (b.formatVersion = 99), /형식 버전/],
    ["이력 참조", (b) => (b.revisions[0].matchId = "nope"), /연결된 경기가 파일에 없습니다/],
    ["순환 참조", (b) => b.rotationEvents.push({ ...b.rotationEvents[0], id: "x1", cycle_id: "nope" }), /주기·경기·참가자/],
    ["시즌 겹침", (b) => b.seasons.push({ id: "s2", name: "겹침", startsOn: "2026-05-01", endsOn: "2027-01-01" }), /겹칩니다/],
    ["결과 없는 확정", (b) => (b.matches[0].winnerTeam = null), /승리 팀·진영이 없습니다/],
    // 검토 L2: 검증을 통과한 큰 행이 단계 도중 D1 값 한도에 걸리지 않게 검증에서 거절한다.
    ["큰 변경 이력 행", (b) => (b.revisions[0].changes = { note: { from: null, to: "가".repeat(20_000) } }), /변경 이력 .*너무 큽니다/],
    ["합치기 기록의 옮긴 경기 중복", (b) => b.participantMerges.push({
      id: "m1", sourceId: b.participants[10].id, targetId: b.participants[11].id, sourcePrevStatus: "active",
      movedMatches: [b.matches[0].id, b.matches[0].id], rotationChanges: [], createdAt: b.createdAt, undoneAt: b.createdAt,
    }), /옮긴 경기가 중복됩니다/],
    // 검토 L3: 화면의 Intl이 거절하는 시간대.
    ["잘못된 시간대", (b) => (b.group.timezone = "Mars/Olympus"), /시간대/],
    ["빈 시간대", (b) => (b.group.timezone = ""), /시간대/],
  ];
  for (const [label, breakIt, message] of breakers) {
    it(label, async () => {
      const g = await richGroup();
      const backup = await exportOf(g);
      breakIt(backup);
      const before = await snapshot(g);
      const preview = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore/preview`, { backup });
      expect(preview.body.ok).toBe(false);
      expect(preview.body.problems.join("\n")).toMatch(message);
      const res = await restore(g, backup);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("RESTORE_INVALID");
      expect(res.body.error.details.problems.join("\n")).toMatch(message);
      const after = await snapshot(g);
      expect(content(after)).toBe(content(before));
      expect(after.group.generation).toBe(before.group.generation);
      expect(after.group.liveVersion).toBe(before.group.liveVersion);
    });
  }

  it("JSON이 아니거나 목록이 아니면 거절", async () => {
    const g = await setupGroup(10);
    for (const backup of [null, "text", [1, 2], { formatVersion: 2, scope: "group" }]) {
      const res = await restore(g, backup as Backup);
      expect(res.status).toBe(400);
    }
  });
});

describe("복원 중·복원 뒤의 다른 탭(시나리오 38)", () => {
  it("복원 뒤 오래된 탭의 요청은 거절된다(모임 세대·진행 상태 버전·경기 버전)", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const oldTab = await snapshot(g);
    const confirmed = oldTab.matches.find((m) => m.state === "confirmed")!;
    expect((await restore(g, backup)).status).toBe(200);

    // 화면은 마지막으로 받은 세대를 X-Group-Generation으로 보낸다.
    const withHeader = await direct({}, "PATCH", `/api/groups/${g.gid}`, {
      cookie: g.cookie,
      body: { name: "오래된 탭", requestId: requestId() },
      headers: { "X-Group-Generation": String(oldTab.group.generation) },
    });
    expect(withHeader.status).toBe(409);
    expect(((await withHeader.json()) as any).error.code).toBe("GROUP_RESTORED");

    // 세대를 보내지 않는 요청도 버전 검사로 막힌다.
    const startOld = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: oldTab.group.liveVersion,
      roster: rosterOf(g.people),
    });
    expect(startOld.status).toBe(409);
    const correctOld = await matchAction(g, confirmed, "correct", { field: "side", winnerSide: "red" });
    expect(correctOld.status).toBe(409);

    // 새로 고친 탭(현재 세대)은 된다.
    const fresh = await snapshot(g);
    const ok = await direct({}, "PATCH", `/api/groups/${g.gid}`, {
      cookie: g.cookie,
      body: { name: "새 탭", requestId: requestId() },
      headers: { "X-Group-Generation": String(fresh.group.generation) },
    });
    expect(ok.status).toBe(200);

    // 복원도 오래된 세대로는 실행되지 않는다(두 탭에서 연달아 복원).
    const stale = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: oldTab.group.generation,
      backup,
    });
    expect(stale.status).toBe(409);
  });

  it("여러 단계 복원이 중간에 멈추면 점검 상태로 다른 쓰기를 거절하고, 같은 파일로 다시 복원하면 끝난다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const before = await snapshot(g);
    await playConfirmed(g, shifted(g, 4), "B", "red");
    const tab2 = await snapshot(g);

    // 데이터 상한을 작게 두어 여러 batch로 나누게 하고, 두 번째 단계 뒤에서 끊는다.
    const small: Partial<Env> = { RESTORE_BATCH_BYTES: "600" };
    restoreHooks.afterStage = (i) => {
      if (i === 1) throw new Error("테스트: 연결 끊김");
    };
    const body = {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: before.group.generation,
      backup,
    };
    const broken = await direct(small, "POST", `/api/groups/${g.gid}/restore`, { cookie: g.cookie, body });
    expect(broken.status).toBe(503);
    expect(((await broken.json()) as any).error.code).toBe("RESTORE_INCOMPLETE");
    restoreHooks.afterStage = null;
    expect((await snapshot(g)).group.maintenance).toBe(true);

    // 다른 탭의 쓰기: runMutation 경로와 그 밖의 경로 모두 점검 상태로 거절.
    const attempts = [
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/start`, {
        requestId: requestId(),
        baseLiveVersion: tab2.group.liveVersion,
        roster: rosterOf(g.people),
      }),
      api(g.cookie, "PATCH", `/api/groups/${g.gid}`, { name: "점검 중" }),
      api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, { skillGroup: 1 }),
      api(g.cookie, "POST", `/api/groups/${g.gid}/view-token`),
      api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
        requestId: requestId(),
        baseSettingsVersionId: tab2.group.settingsVersionId,
        settings: tab2.group.settings,
      }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("MAINTENANCE");
    }
    expect((await snapshot(g)).group.viewToken).toBe(before.group.viewToken);

    // 같은 요청으로 다시 복원하면 처음부터 다시 지우고 넣어 끝난다.
    const retried = await direct(small, "POST", `/api/groups/${g.gid}/restore`, { cookie: g.cookie, body });
    expect(retried.status).toBe(200);
    const after = await snapshot(g);
    expect(after.group.maintenance).toBe(false);
    expect(content(after)).toBe(content(before));
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM restore_jobs WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(jobs!.n).toBe(0);
    // 점검이 풀리면 다시 쓸 수 있다.
    expect((await api(g.cookie, "PATCH", `/api/groups/${g.gid}`, { name: "다시 사용" })).status).toBe(200);
  });

  it("여러 단계 복원도 끊기지 않으면 한 번에 끝난다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const before = await snapshot(g);
    await playConfirmed(g, shifted(g, 4));
    const stages: number[] = [];
    restoreHooks.afterStage = (i) => {
      stages.push(i);
    };
    const res = await direct({ RESTORE_BATCH_BYTES: "600" }, "POST", `/api/groups/${g.gid}/restore`, {
      cookie: g.cookie,
      body: { requestId: requestId(), confirm: "복원", baseGeneration: before.group.generation, backup },
    });
    expect(res.status).toBe(200);
    expect(stages.length).toBeGreaterThan(2);
    expect(content(await snapshot(g))).toBe(content(before));
  });
});

describe("새 모임으로 가져오기(시나리오 36)", () => {
  function record(snap: Snapshot): Record<string, string> {
    const nameOf = new Map(snap.participants.map((p) => [p.id, p.name]));
    const out: Record<string, { w: number; l: number }> = {};
    for (const m of snap.matches) {
      if (m.state !== "confirmed") continue;
      for (const r of m.roster) {
        const name = nameOf.get(r.participantId)!;
        out[name] ??= { w: 0, l: 0 };
        if (r.team === m.winnerTeam) out[name].w += 1;
        else out[name].l += 1;
      }
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, `${v.w}승 ${v.l}패`]));
  }

  it("빈 계정에 가져오면 경기 수·사람별 승패가 같고 ID는 모두 새로 만든다", async () => {
    const g = await richGroup();
    await playConfirmed(g, shifted(g, 4), "B", "red");
    const backup = await exportOf(g);
    const source = await snapshot(g);

    const newcomer = await login();
    const body = { requestId: requestId(), confirm: "복원", backup };
    const res = await api(newcomer, "POST", "/api/restore/new-group", body);
    expect(res.status).toBe(200);
    const gid = res.body.groupId as string;
    expect(gid).not.toBe(g.gid);
    const imported = (await api<Snapshot>(newcomer, "GET", `/api/groups/${gid}/snapshot`)).body;

    expect(imported.matches).toHaveLength(source.matches.length);
    expect(imported.matches.filter((m) => m.state === "confirmed")).toHaveLength(
      source.matches.filter((m) => m.state === "confirmed").length,
    );
    expect(record(imported)).toEqual(record(source));
    expect(imported.group.name).toBe(source.group.name);
    expect(imported.group.maintenance).toBe(false);
    // ID 재대응: 경기·참가자·시즌 ID가 원본과 겹치지 않는다. 조회 토큰도 새것이다.
    const oldIds = new Set([
      ...source.matches.map((m) => m.id),
      ...source.participants.map((p) => p.id),
      ...source.seasons.map((s) => s.id),
    ]);
    for (const id of [
      ...imported.matches.map((m) => m.id),
      ...imported.participants.map((p) => p.id),
      ...imported.seasons.map((s) => s.id),
    ]) {
      expect(oldIds.has(id)).toBe(false);
    }
    expect(imported.group.viewToken).not.toBe(source.group.viewToken);
    // 원본 모임은 그대로다.
    expect(content(await snapshot(g))).toBe(content(source));

    // 같은 요청을 다시 보내면 같은 모임을 돌려주고 새로 만들지 않는다.
    const again = await api(newcomer, "POST", "/api/restore/new-group", body);
    expect(again.body.groupId).toBe(gid);
    expect((await api(newcomer, "GET", "/api/me")).body.groups).toHaveLength(1);

    // 가져온 모임에서 바로 새 경기를 시작할 수 있다.
    const people = imported.participants.filter((p) => p.status === "active");
    const started = await api(newcomer, "POST", `/api/groups/${gid}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: imported.group.liveVersion,
      roster: rosterOf(people),
      // 서포터 차례 기록도 함께 옮겨졌으므로 이미 차례를 쓴 사람이면 반복을 확인해 둔다.
      ackRepeat: rosterOf(people).filter((r) => r.position === "support").map((r) => r.participantId),
    });
    expect(started.status).toBe(200);
  });

  it("손상된 파일이면 모임을 만들지 않는다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    backup.matchCount = 99;
    const newcomer = await login();
    const res = await api(newcomer, "POST", "/api/restore/new-group", {
      requestId: requestId(),
      confirm: "복원",
      backup,
    });
    expect(res.status).toBe(400);
    expect((await api(newcomer, "GET", "/api/me")).body.groups).toHaveLength(0);
  });
});

describe("백업 파일에는 계정·토큰이 없다", () => {
  it("계정 ID·로그인 식별자·조회 토큰·인수 링크·요청 기록이 들어가지 않는다", async () => {
    const g = await richGroup();
    const snap = await snapshot(g);
    const me = (await api(g.cookie, "GET", "/api/me")).body;
    const account = await env.DB.prepare("SELECT subject FROM accounts WHERE id = ?1")
      .bind(me.accountId)
      .first<{ subject: string }>();
    const transfer = await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`);
    const text = JSON.stringify(await exportOf(g));
    expect(text).not.toContain(me.accountId);
    expect(text).not.toContain(account!.subject);
    expect(text).not.toContain(snap.group.viewToken!);
    expect(text).not.toContain(transfer.body.token);
    expect(text).not.toMatch(/viewToken|account|operator|subject|requestId|session_epoch/i);
  });
});

describe("여러 단계 복원의 잠금(검토 M2)", () => {
  const small: Partial<Env> = { RESTORE_BATCH_BYTES: "600" };
  const bodyOf = (backup: Backup, generation: number | undefined, id = requestId()) => ({
    requestId: id,
    confirm: "복원",
    baseGeneration: generation,
    backup,
  });
  const run = (g: TestGroup, body: unknown, overrides: Partial<Env> = small) =>
    direct(overrides, "POST", `/api/groups/${g.gid}/restore`, { cookie: g.cookie, body });
  const codeOf = async (res: Response) => ((await res.clone().json()) as any).error?.code;
  const jobOf = (gid: string) =>
    env.DB.prepare("SELECT request_id, run_token, heartbeat_ms FROM restore_jobs WHERE group_id = ?1")
      .bind(gid)
      .first<{ request_id: string | null; run_token: string | null; heartbeat_ms: number }>();

  it("두 복원이 동시에 돌면 한쪽만 끝나고 내용이 섞이지 않는다(뒤 요청이 한 batch든 여러 단계든)", async () => {
    const g = await richGroup();
    const fileX = await exportOf(g);
    const x = await snapshot(g);
    await playConfirmed(g, shifted(g, 4), "B", "red");
    const fileY = await exportOf(g);
    for (const other of [{}, small]) {
      const gen = (await snapshot(g)).group.generation;
      let fired = false;
      let second: Response | null = null;
      restoreHooks.afterStage = async (i) => {
        if (i === 0 && !fired) {
          fired = true;
          second = await run(g, bodyOf(fileY, gen), other);
        }
      };
      const first = await run(g, bodyOf(fileX, gen));
      restoreHooks.afterStage = null;
      expect(first.status).toBe(200);
      expect(second!.status).toBe(409);
      expect(await codeOf(second!)).toBe("RESTORE_IN_PROGRESS");
      const after = await snapshot(g);
      expect(content(after)).toBe(content(x));
      expect(after.group.maintenance).toBe(false);
      expect(await jobOf(g.gid)).toBeNull();
    }
  });

  it("살아 있는 실행의 작업은 이어받지 않고, 실패를 알고 놓았거나 오래 소식이 없으면 다른 요청이 이어받아 끝낸다", async () => {
    const g = await richGroup();
    const file = await exportOf(g);
    const before = await snapshot(g);
    await playConfirmed(g, shifted(g, 4), "B", "red");
    const gen = before.group.generation;

    restoreHooks.afterStage = (i) => {
      if (i === 1) throw new Error("테스트: 연결 끊김");
    };
    const broken = await run(g, bodyOf(file, gen));
    restoreHooks.afterStage = null;
    expect(broken.status).toBe(503);
    expect(await codeOf(broken)).toBe("RESTORE_INCOMPLETE");
    // 실패를 안 실행은 잠금을 놓는다.
    expect((await jobOf(g.gid))!.run_token).toBeNull();

    // 실행이 소식 없이 죽은 경우를 흉내: 주인 표시가 있고 마지막 소식이 최근.
    await env.DB.prepare("UPDATE restore_jobs SET run_token = 'dead-run', heartbeat_ms = ?2 WHERE group_id = ?1")
      .bind(g.gid, Date.now())
      .run();
    for (const overrides of [small, {}]) {
      const busy = await run(g, bodyOf(file, gen), overrides);
      expect(busy.status).toBe(409);
      expect(await codeOf(busy)).toBe("RESTORE_IN_PROGRESS");
    }
    expect((await snapshot(g)).group.maintenance).toBe(true);

    // 마지막 소식이 JOB_STALE_MS보다 오래되면 이어받는다(같은 파일, 새 요청 ID).
    await env.DB.prepare("UPDATE restore_jobs SET heartbeat_ms = ?2 WHERE group_id = ?1")
      .bind(g.gid, Date.now() - JOB_STALE_MS - 1000)
      .run();
    const resumed = await run(g, bodyOf(file, gen));
    expect(resumed.status).toBe(200);
    const after = await snapshot(g);
    expect(content(after)).toBe(content(before));
    expect(after.group.maintenance).toBe(false);
    expect(await jobOf(g.gid)).toBeNull();
  });

  it("같은 요청 ID 재전송이 진행 중인 실행과 겹치면 기다리라고 하고, 끝난 뒤에는 저장된 결과를 돌려준다", async () => {
    const g = await richGroup();
    const file = await exportOf(g);
    const before = await snapshot(g);
    await playConfirmed(g, shifted(g, 4));
    const body = bodyOf(file, before.group.generation);
    let fired = false;
    let resent: Response | null = null;
    restoreHooks.afterStage = async (i) => {
      if (i === 0 && !fired) {
        fired = true;
        resent = await run(g, body);
      }
    };
    const first = await run(g, body);
    restoreHooks.afterStage = null;
    expect(first.status).toBe(200);
    expect(resent!.status).toBe(409);
    expect(await codeOf(resent!)).toBe("RESTORE_IN_PROGRESS");
    const again = await run(g, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect(content(await snapshot(g))).toBe(content(before));
  });

  it("이어받힌 실행의 늦은 단계는 아무것도 넣지 않고 잠금도 건드리지 않는다", async () => {
    const g = await richGroup();
    const file = await exportOf(g);
    const gen = (await snapshot(g)).group.generation;
    restoreHooks.afterStage = async (i) => {
      if (i === 0) {
        await env.DB.prepare("UPDATE restore_jobs SET run_token = 'someone-else' WHERE group_id = ?1")
          .bind(g.gid)
          .run();
      }
    };
    const res = await run(g, bodyOf(file, gen));
    restoreHooks.afterStage = null;
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("RESTORE_IN_PROGRESS");
    const rows = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM participants WHERE group_id = ?1) + (SELECT COUNT(*) FROM matches WHERE group_id = ?1)
         + (SELECT COUNT(*) FROM settings_versions WHERE group_id = ?1) AS n`,
    )
      .bind(g.gid)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
    expect((await jobOf(g.gid))!.run_token).toBe("someone-else");
  });

  it("점검 확인을 통과한 다른 운영자의 쓰기라도 그 사이 복원 1단계가 점검을 켰으면 batch에서 점검 오류로 막힌다", async () => {
    const g = await richGroup();
    const file = await exportOf(g);
    const before = await snapshot(g);
    const writeId = requestId();
    // 쓰기: 점검 확인(batch 밖)까지 마친 뒤 build 안에서 멈춰 있다가, 복원 1단계 뒤에 batch를 실행한다.
    let entered!: () => void;
    const enteredBuild = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const write = runMutation(env as unknown as Env, {
      groupId: g.gid,
      requestId: writeId,
      op: "season-create",
      payload: { name: "끼어든 시즌" },
      build: async () => {
        entered();
        await gate;
        return {
          stored: {},
          statements: [
            env.DB.prepare(
              `INSERT INTO seasons (id, group_id, name, starts_on, ends_on, created_at)
               VALUES (?1, ?2, '끼어든 시즌', '2026-01-01', '2026-12-31', '2026-11-08T00:00:00.000Z')`,
            ).bind(crypto.randomUUID(), g.gid),
          ],
        };
      },
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await enteredBuild;
    let writeError: unknown = undefined;
    restoreHooks.afterStage = async (i) => {
      if (i === 0) {
        release();
        writeError = await write;
      }
    };
    const res = await run(g, bodyOf(file, before.group.generation));
    restoreHooks.afterStage = null;
    expect(res.status).toBe(200);
    expect(writeError).toBeInstanceOf(ApiError);
    expect((writeError as ApiError).code).toBe("MAINTENANCE");
    // 쓰기는 아무것도 남기지 않았다: 시즌은 백업의 것뿐이고 요청 기록도 없다.
    const after = await snapshot(g);
    expect(after.seasons.map((s) => s.name)).toEqual(before.seasons.map((s) => s.name));
    expect(content(after)).toBe(content(before));
    const record = await env.DB.prepare("SELECT 1 AS ok FROM requests WHERE group_id = ?1 AND request_id = ?2")
      .bind(g.gid, writeId)
      .first();
    expect(record).toBeNull();
  });

  it("모임 삭제가 진행 중인 복원을 끊으면 복원은 멈추고, 복원은 삭제 작업을 이어받지 못한다(삭제를 다시 실행해 끝낸다)", async () => {
    const g = await richGroup();
    const file = await exportOf(g);
    const gen = (await snapshot(g)).group.generation;
    let deletion: Response | null = null;
    restoreHooks.afterStage = async (i) => {
      if (i === 2 && !deletion) {
        deletionHooks.afterStage = (j) => {
          if (j === 1) throw new Error("테스트: 삭제 끊김");
        };
        deletion = await direct({ GROUP_DELETE_BATCH_ROWS: "1" }, "POST", `/api/groups/${g.gid}/delete`, {
          cookie: g.cookie,
          body: { confirm: "삭제" },
        });
        deletionHooks.afterStage = null;
      }
    };
    const res = await run(g, bodyOf(file, gen));
    restoreHooks.afterStage = null;
    expect(deletion!.status).toBe(503);
    expect(await codeOf(deletion!)).toBe("DELETE_INCOMPLETE");
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe("RESTORE_IN_PROGRESS");
    expect((await snapshot(g)).group.maintenance).toBe(true);

    const retry = await run(g, bodyOf(file, gen));
    expect(retry.status).toBe(503);
    expect(await codeOf(retry)).toBe("MAINTENANCE");

    const again = await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" });
    expect(again.status).toBe(200);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
  });
});

describe("새 모임 가져오기의 재전송(검토 L11)", () => {
  it("요청 기록이 보관 기간 뒤 지워진 다음 같은 요청 ID가 다시 오면 그 모임을 덮어쓰지 않는다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const newcomer = await login();
    const body = { requestId: requestId(), confirm: "복원", backup };
    const res = await api(newcomer, "POST", "/api/restore/new-group", body);
    expect(res.status).toBe(200);
    const gid = res.body.groupId as string;
    expect((await api(newcomer, "PATCH", `/api/groups/${gid}`, { name: "가져온 뒤 바꾼 이름" })).status).toBe(200);
    // 14일 보관 기간이 지나 요청 기록이 지워진 상황.
    await env.DB.prepare("DELETE FROM requests WHERE group_id = ?1").bind(gid).run();
    const again = await api(newcomer, "POST", "/api/restore/new-group", body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("REQUEST_EXPIRED");
    const snap = (await api<Snapshot>(newcomer, "GET", `/api/groups/${gid}/snapshot`)).body;
    expect(snap.group.name).toBe("가져온 뒤 바꾼 이름");
  });

  it("중간에 끊긴 새 모임 가져오기는 같은 요청을 다시 보내면 끝난다", async () => {
    const g = await richGroup();
    const backup = await exportOf(g);
    const newcomer = await login();
    const body = { requestId: requestId(), confirm: "복원", backup };
    const small: Partial<Env> = { RESTORE_BATCH_BYTES: "600" };
    restoreHooks.afterStage = (i) => {
      if (i === 1) throw new Error("테스트: 연결 끊김");
    };
    const cut = await direct(small, "POST", "/api/restore/new-group", { cookie: newcomer, body });
    restoreHooks.afterStage = null;
    expect(cut.status).toBe(503);
    const again = await direct(small, "POST", "/api/restore/new-group", { cookie: newcomer, body });
    expect(again.status).toBe(200);
    const gid = ((await again.json()) as any).groupId as string;
    const snap = (await api<Snapshot>(newcomer, "GET", `/api/groups/${gid}/snapshot`)).body;
    expect(snap.group.maintenance).toBe(false);
    expect(snap.matches).toHaveLength((await snapshot(g)).matches.length);
  });
});

describe("복원 묶음 크기는 UTF-8 바이트로 센다(검토 L2)", () => {
  it("한글 행도 묶음 하나가 상한(바이트)을 넘지 않고, 행 순서와 내용은 그대로다", () => {
    expect(utf8Bytes("가")).toBe(3);
    expect(utf8Bytes("é")).toBe(2);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("abc")).toBe(3);
    const rows = Array.from({ length: 50 }, (_, i) => [`id-${i}`, "가나다라마바사아자차".repeat(5)]);
    const max = 1000;
    const chunks = chunkRows(rows, max);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(new TextEncoder().encode(c.json).length).toBe(c.bytes);
      expect(c.bytes).toBeLessThanOrEqual(max);
    }
    expect(chunks.flatMap((c) => JSON.parse(c.json))).toEqual(rows);
  });

  it("한 행이 D1 값 한도에 가까우면 아무것도 실행하기 전(계획 단계)에 거절한다", () => {
    let thrown: any = null;
    try {
      chunkRows([["가".repeat(200 * 1024)]], 1000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown?.code).toBe("RESTORE_INVALID");
    expect(thrown.details.problems.join(" ")).toMatch(/너무 큽니다/);
  });
});
