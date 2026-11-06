import { describe, expect, it } from "vitest";
import {
  avoidMapFor,
  avoidViolations,
  decodeAvoid,
  encodeAvoid,
  normalizeAvoidPositions,
} from "../src/shared/avoid";
import {
  applyTeams,
  createDraft,
  rerollPositions,
  rngFromSeed,
  type AvoidMap,
  type Draft,
  type DraftPerson,
} from "../src/shared/draft";
import { shuffleTeamsByPriority } from "../src/shared/priority";
import { shuffleDraft, supporterKey, type RotationContext } from "../src/shared/rotation";
import { POSITIONS, TEAMS, type ParticipantView, type Position, type Snapshot, type Team } from "../src/shared/types";
import { api, login, requestId, setupGroup, snapshot, type TestGroup } from "./helpers";

// 기피 라인(migrations/0013_avoid_positions.sql, src/shared/avoid.ts, draft.ts assignTeamPositions).

const now = "2026-11-06T00:00:00.000Z";
const people: DraftPerson[] = Array.from({ length: 10 }, (_, i) => ({
  key: `p:id${i}`,
  name: `참가자${i}`,
  participantId: `id${i}`,
}));
const teamOf: Record<string, Team> = Object.fromEntries(people.map((p, i) => [p.key, i < 5 ? "A" : "B"]));
const base = (seed: number): Draft => createDraft(people, { groupId: "g", baseLiveVersion: 0, seed, now, teamOf });
const slot = (d: Draft, key: string) => d.slots.find((s) => s.key === key)!;
const none: RotationContext = { enabled: true, cycleId: "c1", usedIds: new Set(), eventCount: 0, counts: new Map() };

describe("기피 라인 값 다루기", () => {
  it("포지션만 받고 중복은 지우고 탑~서폿 순서로 정렬한다. 다섯 개·모르는 값·배열 아님은 거절", () => {
    expect(normalizeAvoidPositions(["support", "top", "support"])).toEqual(["top", "support"]);
    expect(normalizeAvoidPositions([])).toEqual([]);
    expect(normalizeAvoidPositions(["top", "jungle", "mid", "adc"])).toEqual(["top", "jungle", "mid", "adc"]);
    expect(normalizeAvoidPositions([...POSITIONS])).toBeNull();
    expect(normalizeAvoidPositions(["top", "bot"])).toBeNull();
    expect(normalizeAvoidPositions("top")).toBeNull();
    expect(normalizeAvoidPositions([1])).toBeNull();
    expect(encodeAvoid(["support", "top"])).toBe("top,support");
    expect(encodeAvoid([])).toBeNull();
    expect(decodeAvoid("top,support,zzz")).toEqual(["top", "support"]);
    expect(decodeAvoid(null)).toEqual([]);
  });

  it("초안 키 → 기피 라인 맵: 새 이름·기피 없는 사람은 넣지 않는다", () => {
    const parts: ParticipantView[] = [
      { id: "id0", name: "a", status: "active", avoidPositions: ["support"] },
      { id: "id1", name: "b", status: "active" },
    ];
    expect(
      avoidMapFor([...people.slice(0, 2), { key: "n:새", name: "새", participantId: null }], parts),
    ).toEqual({ "p:id0": ["support"] });
    expect(avoidMapFor(people, undefined)).toEqual({});
  });
});

describe("기피 라인 배정", () => {
  it("기피 맵이 비어 있거나 없으면 예전과 똑같은 결과다(같은 시드 = 같은 편성)", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const d = base(seed);
      expect(createDraft(people, { groupId: "g", baseLiveVersion: 0, seed, now, teamOf, avoid: {} })).toEqual(d);
      expect(rerollPositions(d, {})).toEqual(rerollPositions(d));
      expect(applyTeams(d, people.slice(3, 8).map((p) => p.key), {})).toEqual(
        applyTeams(d, people.slice(3, 8).map((p) => p.key)),
      );
      expect(shuffleDraft(d, { fairSupport: true, avoid: {} }, none)).toEqual(shuffleDraft(d, { fairSupport: true }, none));
      expect(shuffleTeamsByPriority(d, {}, [5, 4, 3, 2, 1], {})).toEqual(shuffleTeamsByPriority(d, {}, [5, 4, 3, 2, 1]));
    }
  });

  it("피할 수 있으면 어김 0을 보장한다(초안 생성·팀 확정 올랜덤·팀 추천 적용·팀까지 올랜덤)", () => {
    // 팀마다 여러 사람이 여러 라인을 피하지만 모두 피하는 배정이 있다.
    const avoid: AvoidMap = {
      "p:id0": ["top", "jungle", "mid", "adc"], // 서폿만 가능
      "p:id1": ["support", "top"],
      "p:id2": ["support"],
      "p:id5": ["mid", "adc"],
      "p:id6": ["mid"],
      "p:id7": ["top", "jungle"],
    };
    for (let seed = 1; seed <= 400; seed++) {
      const created = createDraft(people, { groupId: "g", baseLiveVersion: 0, seed, now, teamOf, avoid });
      expect(avoidViolations(created, avoid)).toEqual([]);
      const d = base(seed);
      expect(avoidViolations(rerollPositions(d, avoid), avoid)).toEqual([]);
      expect(avoidViolations(shuffleDraft(d, { fairSupport: false, avoid }, none), avoid)).toEqual([]);
      const keys = rngFromSeed(seed)() < 0.5 ? people.slice(0, 5) : people.slice(2, 7);
      expect(avoidViolations(applyTeams(d, keys.map((p) => p.key), avoid), avoid)).toEqual([]);
      const team = shuffleTeamsByPriority(d, {}, [5, 4, 3, 2, 1], avoid).draft;
      // 팀까지 올랜덤은 팀을 새로 나눈다. 같은 팀에 서폿만 되는 id0와 서폿 기피 둘이 함께여도 피할 수 있는 조합이다.
      expect(avoidViolations(team, avoid)).toEqual([]);
      expect(slot(created, "p:id0").position).toBe("support");
    }
  });

  it("모두 피할 수 없으면 어기는 수가 가장 적은 배정이다", () => {
    // 팀 A 다섯 명이 모두 서폿만 갈 수 있다 → 최소 4명 어김. 팀 B는 두 명이 탑만 가능 → 최소 1명 어김.
    const onlySupport: Position[] = ["top", "jungle", "mid", "adc"];
    const avoid: AvoidMap = {
      ...Object.fromEntries(people.slice(0, 5).map((p) => [p.key, onlySupport])),
      "p:id5": ["jungle", "mid", "adc", "support"],
      "p:id6": ["jungle", "mid", "adc", "support"],
    };
    for (let seed = 1; seed <= 200; seed++) {
      const next = rerollPositions(base(seed), avoid);
      const misses = avoidViolations(next, avoid);
      expect(misses.filter((m) => slot(next, m.key).team === "A")).toHaveLength(4);
      expect(misses.filter((m) => slot(next, m.key).team === "B")).toHaveLength(1);
    }
  });

  it("고정이 기피보다 먼저다: 고정한 사람은 기피 라인이어도 그 자리를 지키고, 나머지는 남은 자리에서 피한다", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const d0 = base(seed);
      const supporter = supporterKey(d0, "A")!;
      const d: Draft = { ...d0, slots: d0.slots.map((s) => (s.key === supporter ? { ...s, locked: true } : s)) };
      const top = d.slots.find((s) => s.team === "A" && s.position === "top")!.key;
      const avoid: AvoidMap = { [supporter]: ["support"], [top]: ["top", "jungle"] };
      const next = rerollPositions(d, avoid);
      expect(slot(next, supporter).position).toBe("support");
      expect(slot(next, supporter).locked).toBe(true);
      expect(["mid", "adc"]).toContain(slot(next, top).position);
      // 화면 알림은 고정한 사람을 빼고 센다.
      expect(avoidViolations(next, avoid, { includeLocked: false })).toEqual([]);
      expect(avoidViolations(next, avoid)).toEqual([{ key: supporter, position: "support" }]);
    }
  });

  it("어김 0인 배정 사이에서 고르게 뽑는다(치우침 점검)", () => {
    // 팀 A 첫 사람이 서폿을 피하면 그 사람은 탑·정글·미드·원딜에 각 25%, 다른 사람의 서폿 비율은 25%.
    const avoid: AvoidMap = { "p:id0": ["support"] };
    const N = 8000;
    const count = new Map<string, number>();
    for (let seed = 1; seed <= N; seed++) {
      const next = rerollPositions(base(seed), avoid);
      for (const s of next.slots) count.set(`${s.key}|${s.position}`, (count.get(`${s.key}|${s.position}`) ?? 0) + 1);
    }
    for (const p of ["top", "jungle", "mid", "adc"]) {
      expect(Math.abs((count.get(`p:id0|${p}`) ?? 0) / N - 0.25)).toBeLessThan(0.025);
    }
    expect(count.get("p:id0|support") ?? 0).toBe(0);
    for (let i = 1; i < 5; i++) expect(Math.abs((count.get(`p:id${i}|support`) ?? 0) / N - 0.25)).toBeLessThan(0.025);
    // 기피가 없는 팀 B는 예전처럼 20%씩.
    for (let i = 5; i < 10; i++) {
      for (const p of POSITIONS) expect(Math.abs((count.get(`p:id${i}|${p}`) ?? 0) / N - 0.2)).toBeLessThan(0.025);
    }
  });

  it("팀 확정 올랜덤은 기피가 있어도 팀원을 바꾸지 않고, 서포터 공평하게는 서포터 횟수 규칙이 먼저다", () => {
    // 팀 A에서 아직 서포터를 안 간 사람은 id0뿐이고 id0은 서폿을 피한다 → 그래도 서포터는 id0.
    const ctx: RotationContext = {
      enabled: true,
      cycleId: "c1",
      usedIds: new Set(["id1", "id2", "id3", "id4"]),
      eventCount: 4,
      counts: new Map([
        ["id1", 1],
        ["id2", 1],
        ["id3", 1],
        ["id4", 1],
      ]),
    };
    const avoid: AvoidMap = { "p:id0": ["support"] };
    for (let seed = 1; seed <= 100; seed++) {
      const d = base(seed);
      const plain = shuffleDraft(d, { fairSupport: false, avoid }, ctx);
      const fair = shuffleDraft(d, { fairSupport: true, avoid }, ctx);
      for (const next of [plain, fair]) {
        for (const team of TEAMS) {
          expect(next.slots.filter((s) => s.team === team).map((s) => s.key).sort()).toEqual(
            d.slots.filter((s) => s.team === team).map((s) => s.key).sort(),
          );
        }
      }
      expect(slot(plain, "p:id0").position).not.toBe("support");
      expect(supporterKey(fair, "A")).toBe("p:id0");
    }
  });
});

// ------------------------------------------------------------------ 서버

function patch(g: TestGroup, pid: string, body: unknown, cookie: string | null = g.cookie) {
  return api(cookie, "PATCH", `/api/groups/${g.gid}/participants/${pid}`, body);
}
const avoidOf = (snap: Snapshot, pid: string) => snap.participants.find((p) => p.id === pid)!.avoidPositions;

describe("기피 라인 저장", () => {
  it("저장·중복 제거·정렬·지우기. 다섯 개·모르는 값·형식 오류는 거절하고 값이 바뀌지 않는다", async () => {
    const g = await setupGroup();
    const pid = g.people[0]!.id;
    expect(avoidOf(await snapshot(g), pid)).toBeUndefined();
    expect((await patch(g, pid, { avoidPositions: ["support", "top", "support"] })).status).toBe(200);
    expect(avoidOf(await snapshot(g), pid)).toEqual(["top", "support"]);

    const five = await patch(g, pid, { avoidPositions: [...POSITIONS] });
    expect(five.status).toBe(400);
    expect(five.body.error.message).toContain("4개까지");
    for (const bad of [["top", "bot"], "top", [1], { top: true }]) {
      expect((await patch(g, pid, { avoidPositions: bad })).status).toBe(400);
    }
    expect(avoidOf(await snapshot(g), pid)).toEqual(["top", "support"]);

    // 다른 필드만 바꾸면 기피 라인은 그대로.
    expect((await patch(g, pid, { skillGroup: 2 })).status).toBe(200);
    expect(avoidOf(await snapshot(g), pid)).toEqual(["top", "support"]);
    // 빈 배열·null은 지우기(응답에서 필드가 빠진다).
    expect((await patch(g, pid, { avoidPositions: [] })).status).toBe(200);
    expect(avoidOf(await snapshot(g), pid)).toBeUndefined();
    await patch(g, pid, { avoidPositions: ["mid"] });
    expect((await patch(g, pid, { avoidPositions: null })).status).toBe(200);
    expect(avoidOf(await snapshot(g), pid)).toBeUndefined();
  });

  it("공동 운영자는 정할 수 있고, 다른 모임 운영자·로그인 안 한 사람은 안 된다", async () => {
    const g = await setupGroup();
    const pid = g.people[1]!.id;
    const other = await setupGroup(2);
    expect((await patch(g, pid, { avoidPositions: ["top"] }, other.cookie)).status).toBe(404);
    expect((await patch(g, pid, { avoidPositions: ["top"] }, null)).status).toBe(401);
    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    expect((await patch(g, pid, { avoidPositions: ["adc"] }, co)).status).toBe(200);
    expect(avoidOf(await snapshot(g), pid)).toEqual(["adc"]);
  });

  it("조회 링크 응답에는 티어 공개 설정과 상관없이 기피 라인이 없다", async () => {
    const g = await setupGroup();
    await patch(g, g.people[0]!.id, { avoidPositions: ["support"], skillGroup: 1 });
    let snap = await snapshot(g);
    const token = snap.group.viewToken!;
    let view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain("avoidPositions");
    // 티어를 공개해도 기피 라인은 나가지 않는다.
    const saved = await api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: snap.group.settingsVersionId,
      settings: { ...snap.group.settings, groupsPublic: true },
    });
    expect(saved.status).toBe(200);
    snap = await snapshot(g);
    view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.body.participants.find((p) => p.id === g.people[0]!.id)!.skillGroup).toBe(1);
    expect(JSON.stringify(view.body)).not.toContain("avoidPositions");
  });

  it("백업 → 복원 왕복으로 그대로이고, 기피 항목이 없는 예전 백업·새 모임 가져오기도 된다. 잘못된 값은 복원을 거절한다", async () => {
    const g = await setupGroup();
    const [a, b] = [g.people[0]!.id, g.people[1]!.id];
    await patch(g, a, { avoidPositions: ["support"] });
    await patch(g, b, { avoidPositions: ["top", "mid"] });
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.participants.find((p: ParticipantView) => p.id === a).avoidPositions).toEqual(["support"]);

    await patch(g, a, { avoidPositions: null });
    await patch(g, b, { avoidPositions: ["adc"] });
    const restore = async (file: unknown) => {
      const snap = await snapshot(g);
      return api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
        requestId: requestId(),
        confirm: "복원",
        baseGeneration: snap.group.generation,
        backup: file,
      });
    };
    expect((await restore(backup)).status).toBe(200);
    let snap = await snapshot(g);
    expect(avoidOf(snap, a)).toEqual(["support"]);
    expect(avoidOf(snap, b)).toEqual(["top", "mid"]);

    // 예전 백업(항목 없음): 모두 없음으로 복원된다.
    const old = {
      ...backup,
      participants: backup.participants.map(({ avoidPositions: _drop, ...rest }: ParticipantView) => rest),
    };
    expect((await restore(old)).status).toBe(200);
    snap = await snapshot(g);
    expect(snap.participants.every((p) => p.avoidPositions === undefined)).toBe(true);

    // 잘못된 값(다섯 개)은 복원하지 않는다.
    const bad = {
      ...backup,
      participants: backup.participants.map((p: ParticipantView) => (p.id === a ? { ...p, avoidPositions: [...POSITIONS] } : p)),
    };
    const refused = await restore(bad);
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("기피 라인 값 오류");

    // 새 모임으로 가져오기(ID를 새로 만든다).
    const newcomer = await login();
    const imported = await api(newcomer, "POST", "/api/restore/new-group", {
      requestId: requestId(),
      confirm: "복원",
      backup,
    });
    expect(imported.status).toBe(200);
    const fresh = (await api<Snapshot>(newcomer, "GET", `/api/groups/${imported.body.groupId}/snapshot`)).body;
    const byName = (name: string) => fresh.participants.find((p) => p.name === name)!.avoidPositions;
    expect(byName(g.people[0]!.name)).toEqual(["support"]);
    expect(byName(g.people[1]!.name)).toEqual(["top", "mid"]);
  });

  it("합치면 남는 사람의 기피 라인을 그대로 두고, 되돌려도 각자 값이 남는다", async () => {
    const g = await setupGroup();
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1 부캐"] });
    const dup = added.body.participants[0] as ParticipantView;
    const target = g.people[0]!.id;
    await patch(g, target, { avoidPositions: ["jungle"] });
    await patch(g, dup.id, { avoidPositions: ["support", "adc"] });
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: dup.id,
      targetId: target,
    });
    expect(merged.status).toBe(200);
    expect(avoidOf(await snapshot(g), target)).toEqual(["jungle"]);
    const undone = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${merged.body.mergeId}/undo`, {
      requestId: requestId(),
    });
    expect(undone.status).toBe(200);
    const snap = await snapshot(g);
    expect(avoidOf(snap, target)).toEqual(["jungle"]);
    expect(avoidOf(snap, dup.id)).toEqual(["adc", "support"]);
  });
});
