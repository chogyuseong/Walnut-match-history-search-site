import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDraft, isCompleteDraft, type Draft, type DraftPerson } from "../src/shared/draft";
import { lastMatchPeople } from "../src/shared/lastPick";
import { remapDraft, remapPeople, resolveMerged } from "../src/shared/merge";
import {
  DIVERSITY_RECENT_MATCHES,
  diversityFor,
  recentTeammateCounts,
  recommendTeams,
  satisfies,
  type RecommendPerson,
  type TeamCandidate,
  type TeamConstraint,
} from "../src/shared/recommend";
import { drawStatus, drawSupport, type RotationContext } from "../src/shared/rotation";
import type { MatchView, ParticipantView, RevisionView, Snapshot, Team } from "../src/shared/types";
import {
  api,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  type TestGroup,
} from "./helpers";

// 팀 추천의 조합 다양성, 그리고 P4-5 검증 시나리오 12·15·21·30 보강. 괄호 안 번호는 시나리오 번호.

/**
 * 명단 텍스트 함수는 화면 코드(src/web/format.ts, DOM 타입을 쓴다)에 있다. 서버 타입 검사(tsconfig.json)가
 * 화면 파일까지 끌어오지 않도록 실행 시점에 불러오고 필요한 모양만 적는다.
 */
interface FormatModule {
  matchRosterText(snapshot: Snapshot, match: MatchView, link: string | null): string;
  draftRosterText(draft: Draft): string;
}
const loadFormat = (): Promise<FormatModule> => {
  const path = "../src/web/format";
  return import(/* @vite-ignore */ path) as Promise<FormatModule>;
};

const weights: [number, number, number, number] = [4, 3, 2, 1];
const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
const rec = (groups: (number | null)[]): RecommendPerson[] =>
  groups.map((skillGroup, i) => ({ key: keys[i]!, skillGroup }));

/** 추천 키 k0~k9가 참가자 ID id0~id9인 사람들. */
const recPeople = keys.map((key, i) => ({ key, participantId: `id${i}` }));

let matchNo = 0;
function match(teamA: number[], teamB: number[], state: MatchView["state"] = "confirmed", playedAt?: string): MatchView {
  matchNo += 1;
  const roster = [
    ...teamA.map((i) => ({ participantId: `id${i}`, team: "A" as Team, position: null })),
    ...teamB.map((i) => ({ participantId: `id${i}`, team: "B" as Team, position: null })),
  ];
  return {
    id: `m${matchNo}`,
    matchNo,
    sessionId: null,
    state,
    source: "live",
    startedAt: null,
    endedAt: null,
    playedAt: playedAt ?? new Date(Date.UTC(2026, 0, 1, 0, matchNo)).toISOString(),
    confirmedAt: null,
    winnerTeam: state === "confirmed" ? "A" : null,
    teamASide: state === "confirmed" ? "unknown" : null,
    version: 1,
    roster,
  };
}

const balanceKey = (c: TeamCandidate) => [
  c.sumDiff,
  Math.abs(c.topCount[0] - c.topCount[1]),
  Math.abs(c.bottomCount[0] - c.bottomCount[1]),
  Math.abs(c.unassignedCount[0] - c.unassignedCount[1]),
];
const lexLE = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return true;
};
const splitOf = (c: TeamCandidate) => [...c.teamA].sort().join(",");

describe("팀 추천의 조합 다양성", () => {
  const last = match([0, 1, 2, 3, 4], [5, 6, 7, 8, 9]);

  it("끄면(또는 최근 경기가 없으면) 예전 추천과 똑같은 결과다", () => {
    const input = rec([1, 1, 2, 2, 3, 3, 4, 4, 2, 3]);
    const off = diversityFor({ matches: [last], settings: { teamDiversity: false } }, recPeople);
    expect(off).toBeUndefined();
    expect(recommendTeams(input, weights, 11, 126, [], off)).toEqual(recommendTeams(input, weights, 11, 126));
    const empty = diversityFor({ matches: [], settings: {} }, recPeople);
    expect(empty!.recentMatches).toBe(0);
    expect(recommendTeams(input, weights, 11, 126, [], empty)).toEqual(recommendTeams(input, weights, 11, 126));
  });

  it("저장한 적이 없으면 켜짐이다", () => {
    expect(diversityFor({ matches: [last], settings: {} }, recPeople)).toBeDefined();
    expect(diversityFor({ matches: [last], settings: { teamDiversity: true } }, recPeople)).toBeDefined();
  });

  it("균형 기준(합계 차·최상위·최하위·미지정)이 다양성보다 먼저다: 순서가 균형 기준으로 어긋나지 않는다", () => {
    for (const groups of [
      [1, 1, 2, 2, 3, 3, 4, 4, 2, 3],
      [1, 1, 1, 2, 2, 3, 3, 4, 4, null],
      [1, 2, 3, 4, 1, 2, 3, 4, null, null],
    ]) {
      const input = rec(groups);
      const recent = [last, match([0, 2, 4, 6, 8], [1, 3, 5, 7, 9]), match([0, 1, 5, 6, 7], [2, 3, 4, 8, 9])];
      const diversity = diversityFor({ matches: recent, settings: {} }, recPeople)!;
      const on = recommendTeams(input, weights, 3, 126, [], diversity);
      const off = recommendTeams(input, weights, 3, 126);
      expect(balanceKey(on[0]!)).toEqual(balanceKey(off[0]!));
      for (let i = 1; i < on.length; i++) expect(lexLE(balanceKey(on[i - 1]!), balanceKey(on[i]!))).toBe(true);
      // 같은 균형 묶음 안에서는 반복 수가 늘지 않는 순서다.
      for (let i = 1; i < on.length; i++) {
        if (balanceKey(on[i - 1]!).join() === balanceKey(on[i]!).join()) {
          expect(on[i - 1]!.repeatPairs!).toBeLessThanOrEqual(on[i]!.repeatPairs!);
        }
      }
      // 같은 126개 분할을 순서만 바꾼다.
      expect(new Set(on.map(splitOf))).toEqual(new Set(off.map(splitOf)));
    }
  });

  it("같은 팀·다른 팀 조건을 어기는 분할은 다양성이 켜져도 나오지 않는다", () => {
    const constraints: TeamConstraint[] = [
      { kind: "same", a: "k0", b: "k1" },
      { kind: "different", a: "k2", b: "k3" },
    ];
    const diversity = diversityFor({ matches: [last], settings: {} }, recPeople)!;
    const on = recommendTeams(rec([1, 1, 2, 2, 3, 3, 4, 4, 2, 3]), weights, 5, 200, constraints, diversity);
    expect(on.length).toBeGreaterThan(0);
    for (const c of on) {
      const inA = new Set(c.teamA);
      expect(constraints.every((x) => satisfies(inA, x))).toBe(true);
    }
    // 모순 조건이면 다양성과 상관없이 빈 목록이다.
    const contradictory: TeamConstraint[] = [
      { kind: "same", a: "k0", b: "k1" },
      { kind: "different", a: "k0", b: "k1" },
    ];
    expect(recommendTeams(rec(Array(10).fill(null)), weights, 5, 3, contradictory, diversity)).toEqual([]);
  });

  it("같은 조건(같은 사람·시드·최근 경기)이면 같은 결과다", () => {
    const input = rec(Array(10).fill(null));
    const make = () => diversityFor({ matches: [last, match([0, 5, 1, 6, 2], [7, 3, 8, 4, 9])], settings: {} }, recPeople);
    expect(recommendTeams(input, weights, 9, 10, [], make())).toEqual(recommendTeams(input, weights, 9, 10, [], make()));
  });

  it("실력 그룹이 없으면 직전 경기와 가장 덜 겹치는 조합을 고르고 이유에 적는다", () => {
    const input = rec(Array(10).fill(null));
    const diversity = diversityFor({ matches: [last], settings: {} }, recPeople)!;
    const [best] = recommendTeams(input, weights, 4, 1, [], diversity);
    // 직전 팀 5명 중 3명·2명으로 섞는 것이 최소(같은 팀 반복 쌍 3+1, 두 팀 합계 8). 그대로면 20.
    expect(best!.repeatPairs).toBe(8);
    expect(splitOf(best!)).not.toBe("k0,k1,k2,k3,k4");
    expect(best!.reason).toBe("티어를 정한 사람이 없어 최근 조합을 피해 나눴어요. · 최근 1경기 같은 팀 반복 8번");
    const all = recommendTeams(input, weights, 4, 126, [], diversity);
    expect(all.find((c) => splitOf(c) === "k0,k1,k2,k3,k4")!.repeatPairs).toBe(20);
    expect(all[all.length - 1]!.repeatPairs).toBe(20);
  });

  it("최근 경기는 취소·제외를 빼고 최근 순으로 정해진 수만 센다", () => {
    const old = match([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "confirmed", "2025-01-01T00:00:00.000Z");
    const recent = Array.from({ length: DIVERSITY_RECENT_MATCHES }, () => match([0, 5, 2, 6, 4], [1, 7, 3, 8, 9]));
    const canceled = match([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "canceled");
    const excluded = match([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "excluded");
    const { counts, used } = recentTeammateCounts([old, ...recent, canceled, excluded]);
    expect(used).toBe(DIVERSITY_RECENT_MATCHES);
    expect(counts.get("id0|id1")).toBeUndefined(); // 오래된 경기와 취소·제외 경기에서만 같은 팀
    expect(counts.get("id0|id5")).toBe(DIVERSITY_RECENT_MATCHES);
    const inProgress = match([0, 1, 2, 3, 4], [5, 6, 7, 8, 9], "in_progress");
    expect(recentTeammateCounts([inProgress], 1).counts.get("id0|id1")).toBe(1);
  });
});

describe("다양성 설정 저장(설정 버전 규칙)", () => {
  async function saveSettings(g: TestGroup, patch: Record<string, unknown>) {
    const snap = await snapshot(g);
    return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: snap.group.settingsVersionId,
      settings: { ...snap.group.settings, ...patch },
    });
  }

  it("저장하지 않은 상태 → 끔 → 켬이 새 설정 버전으로 남고, 조회 응답에는 나가지 않는다", async () => {
    const g = await setupGroup(10);
    const first = await snapshot(g);
    expect(first.group.settings.teamDiversity).toBeUndefined();
    expect((await saveSettings(g, { teamDiversity: false })).status).toBe(200);
    const off = await snapshot(g);
    expect(off.group.settings.teamDiversity).toBe(false);
    expect(off.group.settingsVersionId).not.toBe(first.group.settingsVersionId);
    expect((await saveSettings(g, { teamDiversity: "yes" })).status).toBe(400);
    expect((await saveSettings(g, { teamDiversity: true })).status).toBe(200);
    expect((await snapshot(g)).group.settings.teamDiversity).toBe(true);
    const view = await api<Snapshot>(null, "GET", `/api/view/${off.group.viewToken}`);
    expect(Object.keys(view.body.group.settings).sort()).toEqual(["groupWeights", "groupsPublic", "rotationEnabled"]);
  });
});

describe("조회 응답(허용 목록)과 점검 표시", () => {
  it("칭호 구간은 허용 목록으로 나가고 그룹·가중치·토큰은 나가지 않는다. 점검 중이면 조회 응답에 표시된다", async () => {
    const g = await setupGroup(10);
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[0]!.id}`, { skillGroup: 1 });
    const snap = await snapshot(g);
    const bands = [{ minRate: 50, name: "반타작" }];
    await api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
      requestId: requestId(),
      baseSettingsVersionId: snap.group.settingsVersionId,
      settings: { ...snap.group.settings, groupWeights: [9, 7, 5, 3], titleBands: bands, teamDiversity: false },
    });
    const token = snap.group.viewToken!;
    const view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.body.group.settings).toEqual({
      rotationEnabled: true,
      groupsPublic: false,
      groupWeights: [0, 0, 0, 0],
      titleBands: bands,
    });
    expect(view.body.group.maintenance).toBe(false);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain("skillGroup");
    expect(text).not.toContain(token);
    expect(text).not.toContain("9,7,5,3");
    expect(view.body.group.generation).toBeUndefined();

    await env.DB.prepare("UPDATE groups SET maintenance = 1 WHERE id = ?1").bind(g.gid).run();
    const during = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(during.status).toBe(200);
    expect(during.body.group.maintenance).toBe(true);
    await env.DB.prepare("UPDATE groups SET maintenance = 0 WHERE id = ?1").bind(g.gid).run();
  });
});

describe("명단 텍스트에 실력 그룹이 들어가지 않는다 (12)", () => {
  it("조회 응답으로 만든 경기 명단 텍스트와 초안 텍스트에 그룹·가중치·합계가 없다(공개 모임이어도)", async () => {
    const { matchRosterText, draftRosterText } = await loadFormat();
    const g = await setupGroup(10);
    for (const [i, p] of g.people.entries()) {
      await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${p.id}`, { skillGroup: (i % 4) + 1 });
    }
    const m = await playConfirmed(g, rosterOf(g.people), "A", "red");
    const token = (await snapshot(g)).group.viewToken!;
    for (const groupsPublic of [false, true]) {
      const snap = await snapshot(g);
      await api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
        requestId: requestId(),
        baseSettingsVersionId: snap.group.settingsVersionId,
        settings: { ...snap.group.settings, groupsPublic },
      });
      const view = (await api<Snapshot>(null, "GET", `/api/view/${token}`)).body;
      const text = matchRosterText(view, view.matches.find((x) => x.id === m.id)!, "https://example.test/#/v/x/now");
      expect(text).toContain("참가자1");
      expect(text).toContain("레드");
      for (const banned of ["그룹", "가중치", "합계", "skill", "실력"]) expect(text).not.toContain(banned);
      // 운영자 스냅숏(그룹 포함)으로 만들어도 텍스트에는 그룹이 없다.
      const operatorText = matchRosterText(snap, snap.matches[0]!, null);
      expect(operatorText).not.toContain("그룹");
    }
    const draftPeople: DraftPerson[] = g.people.map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));
    const draft = createDraft(draftPeople, { groupId: g.gid, baseLiveVersion: 0, seed: 3, now: new Date().toISOString() });
    const draftText = draftRosterText(draft);
    expect(draftText).toContain("아직 시작 전");
    expect(draftText).not.toContain("그룹");
  });
});

describe("지난 참가자 불러오기 (15)", () => {
  it("지난 실시간 경기의 활성 참가자를 불러오고, 2명을 바꿔 10명으로 팀을 짠다. 요청은 보내지 않는다", async () => {
    const g = await setupGroup(12);
    await playConfirmed(g, rosterOf(g.people), "A", "blue");
    // 더 나중 번호의 지난 경기 입력은 "지난 참가자"가 아니다.
    const backfill = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, {
      requestId: requestId(),
      playedAt: "2026-01-01T12:00:00.000Z",
      roster: rosterOf([...g.people.slice(2), ...g.people.slice(0, 2)]).map((r) => ({ ...r, position: null })),
      winnerTeam: "A",
      winnerSide: "unknown",
    });
    expect(backfill.status).toBe(200);
    const snap = await snapshot(g);
    const loaded = lastMatchPeople(snap.matches, snap.participants)!;
    expect(loaded.match.source).toBe("live");
    expect(loaded.people).toHaveLength(10);
    expect(loaded.missing).toBe(0);
    expect(new Set(loaded.people.map((p) => p.participantId))).toEqual(new Set(g.people.slice(0, 10).map((p) => p.id)));

    // 2명 교체: 참가자1·2를 빼고 참가자11·12를 넣는다.
    const out = new Set([g.people[0]!.id, g.people[1]!.id]);
    const selected: DraftPerson[] = [
      ...loaded.people.filter((p) => !out.has(p.participantId!)),
      ...g.people.slice(10, 12).map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id })),
    ];
    expect(selected).toHaveLength(10);
    const draft = createDraft(selected, { groupId: g.gid, baseLiveVersion: snap.group.liveVersion, seed: 1, now: snap.serverTime });
    expect(isCompleteDraft(draft)).toBe(true);
    const ids = draft.people.map((p) => p.participantId);
    expect(ids).toContain(g.people[10]!.id);
    expect(ids).not.toContain(g.people[0]!.id);
    // 아무 요청도 보내지 않았으므로 서버 상태는 그대로다.
    expect((await snapshot(g)).group.liveVersion).toBe(snap.group.liveVersion);
  });

  it("보관된 사람은 빼고 불러오며 몇 명이 빠졌는지 알려준다. 합쳐진 사람은 남은 사람으로 불러온다", async () => {
    const g = await setupGroup(12);
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["부캐"] });
    const dup = added.body.participants[0] as ParticipantView;
    await playConfirmed(g, rosterOf([dup, ...g.people.slice(1, 10)]), "A", "blue");
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${g.people[9]!.id}`, { status: "archived" });
    await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: dup.id,
      targetId: g.people[0]!.id,
    });
    const snap = await snapshot(g);
    const loaded = lastMatchPeople(snap.matches, snap.participants)!;
    expect(loaded.people).toHaveLength(9);
    expect(loaded.missing).toBe(1);
    expect(loaded.people.map((p) => p.participantId)).toContain(g.people[0]!.id);
    expect(loaded.people.map((p) => p.participantId)).not.toContain(dup.id);
  });
});

describe("기기에 남은 초안의 합쳐진 ID 처리", () => {
  const parts: ParticipantView[] = [
    ...Array.from({ length: 11 }, (_, i) => ({ id: `id${i}`, name: `사람${i}`, status: "active" as const })),
    { id: "dup", name: "부캐", status: "archived", mergedInto: "id10" },
    { id: "dup2", name: "부캐2", status: "archived", mergedInto: "dup" },
  ];
  const person = (id: string): DraftPerson => ({
    key: `p:${id}`,
    name: parts.find((p) => p.id === id)!.name,
    participantId: id,
  });

  it("이어진 합치기도 끝까지 따라가고, 초안의 키·조건을 남은 사람으로 바꾸며 바뀐 팀의 추첨 기록은 버린다", () => {
    expect(resolveMerged(parts, "dup2")).toBe("id10");
    expect(resolveMerged(parts, "id3")).toBe("id3");
    const people = ["id0", "id1", "id2", "id3", "dup2", "id5", "id6", "id7", "id8", "id9"].map(person);
    const teamOf: Record<string, Team> = {};
    people.forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
    let draft: Draft = createDraft(people, { groupId: "g", baseLiveVersion: 0, seed: 2, now: "2026-11-05T00:00:00.000Z", teamOf });
    draft = { ...draft, constraints: [{ kind: "same", a: "p:dup2", b: "p:id0" }] };
    const ctx: RotationContext = { enabled: true, cycleId: "c", usedIds: new Set(), eventCount: 0 };
    draft = drawSupport(draft, ["A", "B"], ctx).draft;
    expect(draft.draws.A && draft.draws.B).toBeTruthy();

    const result = remapDraft(draft, parts);
    expect(result.changed).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.draft.people.map((p) => p.participantId)).toContain("id10");
    expect(result.draft.people.map((p) => p.participantId)).not.toContain("dup2");
    expect(result.draft.slots.map((s) => s.key)).toContain("p:id10");
    expect(result.draft.constraints).toEqual([{ kind: "same", a: "p:id10", b: "p:id0" }]);
    expect(result.draft.draws.A).toBeUndefined();
    expect(result.draft.draws.B).toBeDefined();
    expect(drawStatus(result.draft, "B", ctx)).toBe(drawStatus(draft, "B", ctx));
    // 바꿀 것이 없으면 같은 초안 그대로.
    expect(remapDraft(result.draft, parts).draft).toBe(result.draft);
  });

  it("남은 사람이 이미 초안에 있으면 자동으로 고치지 않고 알린다. 고른 목록에서는 한 명으로 줄인다", () => {
    const people = ["id0", "id1", "id2", "id3", "dup", "id5", "id6", "id7", "id8", "id10"].map(person);
    const draft = createDraft(people, { groupId: "g", baseLiveVersion: 0, seed: 2, now: "2026-11-05T00:00:00.000Z" });
    const result = remapDraft(draft, parts);
    expect(result.changed).toBe(false);
    expect(result.conflicts).toEqual(["부캐"]);
    const picked = remapPeople([person("dup"), person("id10"), person("id1")], parts);
    expect(picked.changed).toBe(true);
    expect(picked.people.map((p) => p.participantId)).toEqual(["id10", "id1"]);
  });
});

describe("한 팀만 바꿀 수 있으면 그 팀만 바로 바꾼다 (21)", () => {
  // 이전에는 "팀 A만 적용 / 취소"를 물었다. 이제 두 팀을 따로 판단해 가능한 팀만 묻지 않고 바꾼다.
  const people10: DraftPerson[] = Array.from({ length: 10 }, (_, i) => ({ key: `p:id${i}`, name: `p${i}`, participantId: `id${i}` }));
  function draftAB(): Draft {
    const teamOf: Record<string, Team> = {};
    people10.forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
    return createDraft(people10, { groupId: "g", baseLiveVersion: 0, seed: 21, now: "2026-11-05T00:00:00.000Z", teamOf });
  }

  it("팀 B는 안 간 사람이 지금 서포터뿐이라 그대로, 팀 A만 바로 바뀐다. 팀 B 자리는 하나도 건드리지 않는다", () => {
    const draft = draftAB();
    const usedB = draft.slots.filter((s) => s.team === "B" && s.position !== "support").map((s) => s.key.slice(2));
    const ctx: RotationContext = { enabled: true, cycleId: "c", usedIds: new Set(usedB), eventCount: usedB.length };
    const both = drawSupport(draft, ["A", "B"], ctx);
    expect(both.outcomes.find((o) => o.team === "B")).toMatchObject({ kind: "blocked", block: "only-current" });
    expect(both.allAssigned).toEqual([]);
    const plannedA = both.outcomes.find((o) => o.team === "A")!;
    expect(plannedA.kind).toBe("drawn");
    expect(both.draft.draws.A).toEqual(plannedA.record);
    expect(both.draft.slots.filter((s) => s.team === "B")).toEqual(draft.slots.filter((s) => s.team === "B"));
    expect(both.draft.previousSlots).toEqual(draft.slots);
    expect(drawStatus(both.draft, "A", ctx)).toBe("applied");

    // 다시 누르면: A는 같은 결과를 유지, B는 여전히 그대로. 초안은 바뀌지 않는다.
    const again = drawSupport(both.draft, ["A", "B"], ctx);
    expect(again.draft).toBe(both.draft);
    expect(again.outcomes.find((o) => o.team === "A")!.kind).toBe("kept");
  });

  it("반대로 팀 A가 막히면 팀 B만 바로 바뀐다", () => {
    const draft = draftAB();
    const usedA = draft.slots.filter((s) => s.team === "A" && s.position !== "support").map((s) => s.key.slice(2));
    const ctx: RotationContext = { enabled: true, cycleId: "c", usedIds: new Set(usedA), eventCount: usedA.length };
    const both = drawSupport(draft, ["A", "B"], ctx);
    expect(both.draft.slots.filter((s) => s.team === "A")).toEqual(draft.slots.filter((s) => s.team === "A"));
    expect(both.draft.draws.B).toBeDefined();
    expect(both.draft.draws.A).toBeUndefined();
  });
});

describe("변경 내역에 정정·전적 제외·복구가 남는다 (30)", () => {
  it("항목마다 경기 번호·시각·종류·바뀐 값이 있고 변경한 사람 정보는 없다(조회 응답도 같다)", async () => {
    const g = await setupGroup(10);
    const m = await playConfirmed(g, rosterOf(g.people), "A", "unknown");
    const corrected = await matchAction(g, m, "correct", { field: "side", winnerSide: "red" });
    expect(corrected.status).toBe(200);
    const excluded = await matchAction(g, corrected.body.match, "exclude");
    expect(excluded.status).toBe(200);
    const restored = await matchAction(g, excluded.body.match, "restore");
    expect(restored.status).toBe(200);

    const snap = await snapshot(g);
    const history = snap.revisions.filter((r) => ["correction", "exclude", "restore"].includes(r.kind));
    // 최근 것부터: 복구 → 제외 → 정정.
    expect(history.map((r) => r.kind)).toEqual(["restore", "exclude", "correction"]);
    expect(history[0]!.changes).toEqual({ state: { from: "excluded", to: "confirmed" } });
    expect(history[1]!.changes).toEqual({ state: { from: "confirmed", to: "excluded" } });
    expect(history[2]!.changes).toEqual({ teamASide: { from: "unknown", to: "red" } });
    for (const r of history) {
      expect(r.matchNo).toBe(m.matchNo);
      expect(r.matchId).toBe(m.id);
      expect(Number.isNaN(Date.parse(r.createdAt))).toBe(false);
      expect(Object.keys(r).sort()).toEqual(["changes", "createdAt", "id", "kind", "matchId", "matchNo"] satisfies (keyof RevisionView)[]);
    }
    // 현재 결과는 복구된 확정 상태다.
    expect(snap.matches.find((x) => x.id === m.id)!.state).toBe("confirmed");

    const view = await api<Snapshot>(null, "GET", `/api/view/${snap.group.viewToken}`);
    const viewHistory = view.body.revisions.filter((r) => ["correction", "exclude", "restore"].includes(r.kind));
    expect(viewHistory).toEqual(history);
    const text = JSON.stringify(view.body.revisions);
    expect(text).not.toMatch(/account|operator|subject/);
  });
});
