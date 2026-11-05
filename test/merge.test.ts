import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { mergeHooks } from "../src/server/merge";
import { mergeStandings } from "../src/shared/merge";
import { standings, titleBandsOf } from "../src/shared/titles";
import type { ParticipantView, RosterEntry, Snapshot } from "../src/shared/types";
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

// 중복 참가자 합치기와 되돌리기(src/server/merge.ts).

afterEach(() => {
  mergeHooks.midBatch = null;
});

/** 모임 + 같은 사람의 두 번째 이름(합칠 대상). */
async function groupWithDuplicate(): Promise<{ g: TestGroup; dup: ParticipantView; p: ParticipantView[] }> {
  const g = await setupGroup(12);
  const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1 부캐"] });
  const dup = added.body.participants[0] as ParticipantView;
  return { g, dup, p: g.people };
}

/** 서포터 반복 확인을 미리 넣어 같은 서포터가 여러 번 나와도 시작되게 한다(통계 테스트용). */
async function play(g: TestGroup, people: ParticipantView[], winner: "A" | "B" = "A") {
  const roster = rosterOf(people);
  return playConfirmed(g, roster, winner, "blue", { ackRepeat: roster.map((r) => r.participantId) });
}

function preview(g: TestGroup, source: string, target: string) {
  return api(g.cookie, "GET", `/api/groups/${g.gid}/merges/preview?source=${source}&target=${target}`);
}

function merge(g: TestGroup, source: string, target: string, rid = requestId()) {
  return api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
    requestId: rid,
    sourceId: source,
    targetId: target,
  });
}

function undo(g: TestGroup, mergeId: string, rid = requestId()) {
  return api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${mergeId}/undo`, { requestId: rid });
}

/** 저장 상태 전체(합치기 기록 포함) 비교용. */
async function state(g: TestGroup): Promise<string> {
  const snap = await snapshot(g);
  const merges = await env.DB.prepare("SELECT COUNT(*) AS n FROM participant_merges WHERE group_id = ?1")
    .bind(g.gid)
    .first<{ n: number }>();
  const events = await env.DB.prepare(
    "SELECT id, participant_id, kind, voided FROM rotation_events WHERE group_id = ?1 ORDER BY id",
  )
    .bind(g.gid)
    .all();
  return JSON.stringify([fingerprint(snap), snap.revisions.length, merges?.n, events.results]);
}

const rosterIds = (snap: Snapshot, matchId: string) =>
  snap.matches.find((m) => m.id === matchId)!.roster.map((r) => r.participantId);

describe("중복 참가자 합치기", () => {
  it("모든 경기 명단을 남길 대상으로 옮기고, 합칠 대상은 보관하며, 이력을 남긴다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    // 부캐로 3경기, 본캐로 2경기(서로 겹치지 않음).
    const withDup = [p[1]!, p[2]!, p[3]!, p[4]!, dup, p[5]!, p[6]!, p[7]!, p[8]!, p[9]!];
    const m1 = await play(g, withDup, "A");
    const m2 = await play(g, withDup, "A");
    const m3 = await play(g, withDup, "B");
    const withMain = [p[0]!, ...p.slice(2, 11)];
    await play(g, withMain, "A");
    await play(g, withMain, "B");

    const pv = await preview(g, dup.id, p[0]!.id);
    expect(pv.status).toBe(200);
    expect(pv.body.ok).toBe(true);
    expect(pv.body.movedMatches).toBe(3);
    expect(pv.body.byState).toEqual({ confirmed: 3 });
    expect(pv.body.overlaps).toEqual([]);
    expect(pv.body.standings.source).toMatchObject({ games: 3, wins: 2, losses: 1 });
    expect(pv.body.standings.target).toMatchObject({ games: 2, wins: 1, losses: 1 });
    expect(pv.body.standings.merged).toMatchObject({ games: 5, wins: 3, losses: 2, done: false, title: null });

    const before = await snapshot(g);
    const res = await merge(g, dup.id, p[0]!.id);
    expect(res.status).toBe(200);
    expect(res.body.matchCount).toBe(3);

    const after = await snapshot(g);
    for (const m of [m1, m2, m3]) {
      expect(rosterIds(after, m.id)).toContain(p[0]!.id);
      expect(rosterIds(after, m.id)).not.toContain(dup.id);
      // 경기 버전이 올라 오래된 결과 창·정정 창은 충돌로 막힌다.
      expect(after.matches.find((x) => x.id === m.id)!.version).toBe(
        before.matches.find((x) => x.id === m.id)!.version + 1,
      );
    }
    const merged = after.participants.find((x) => x.id === dup.id)!;
    expect(merged.status).toBe("archived");
    expect(merged.mergedInto).toBe(p[0]!.id);
    // 변경 이력 원본: 옮긴 경기마다 "정정 · 참가자" 한 줄(지우지 않는다).
    const rows = await env.DB.prepare(
      "SELECT changes FROM match_revisions WHERE group_id = ?1 AND kind = 'correction'",
    )
      .bind(g.gid)
      .all<{ changes: string }>();
    expect(rows.results).toHaveLength(3);
    expect(JSON.parse(rows.results[0]!.changes)).toEqual({ participant: { from: dup.id, to: p[0]!.id } });
    // 스냅숏에는 합치기 한 번이 한 줄로 묶여 나간다.
    expect(after.revisions.filter((r) => r.kind === "correction")).toHaveLength(0);
    const grouped = after.revisions.filter((r) => r.kind === "merge");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.merge).toEqual({ sourceId: dup.id, targetId: p[0]!.id, matchCount: 3 });
    expect(after.merges).toHaveLength(1);
    expect(after.merges![0]).toMatchObject({ sourceId: dup.id, targetId: p[0]!.id, matchCount: 3, undoneAt: null });
    // 합친 뒤 통계는 미리보기와 같다.
    const now = standings(after.matches, titleBandsOf(after.group.settings)).get(p[0]!.id);
    expect(now).toEqual(pv.body.standings.merged);
    // 합칠 대상으로는 새 경기를 시작할 수 없다(보관 상태).
    const denied = await start(g, rosterOf(withDup));
    expect(denied.status).toBe(400);
    expect(denied.body.error.code).toBe("INVALID_PARTICIPANT");
  });

  it("합친 뒤 배치 판수와 칭호가 함께 계산된다(4판 + 6판 = 배치 완료)", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const withDup = [dup, ...p.slice(1, 10)];
    const withMain = [p[0]!, ...p.slice(1, 10)];
    for (let i = 0; i < 4; i++) await play(g, withDup, "A");
    for (let i = 0; i < 6; i++) await play(g, withMain, i < 4 ? "A" : "B");
    const pv = await preview(g, dup.id, p[0]!.id);
    expect(pv.body.standings.target).toMatchObject({ games: 6, done: false, title: null });
    // 8승 2패 = 80% → 기본 칭호 맨 위 구간.
    expect(pv.body.standings.merged).toMatchObject({ games: 10, wins: 8, losses: 2, done: true, title: "전장의 지배자" });
    expect((await merge(g, dup.id, p[0]!.id)).status).toBe(200);
    const after = await snapshot(g);
    expect(standings(after.matches, titleBandsOf(after.group.settings)).get(p[0]!.id)).toMatchObject({
      games: 10,
      done: true,
      title: "전장의 지배자",
    });
  });

  it("두 사람이 같은 경기에 함께 나왔으면 합치지 않고 어느 경기인지 알려준다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const both = [p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, dup, p[5]!, p[6]!, p[7]!, p[8]!];
    const m = await play(g, both);
    const pv = await preview(g, dup.id, p[0]!.id);
    expect(pv.body.ok).toBe(false);
    expect(pv.body.overlaps).toEqual([{ matchId: m.id, matchNo: m.matchNo }]);
    expect(pv.body.problems.join(" ")).toContain(`${m.matchNo}경기`);

    const before = await state(g);
    const res = await merge(g, dup.id, p[0]!.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MERGE_OVERLAP");
    expect(res.body.error.details.matchNos).toEqual([m.matchNo]);
    expect(await state(g)).toBe(before);
  });

  it("batch 중간에서 실패하면 아무것도 바뀌지 않는다(원자성)", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    const before = await state(g);
    // 명단을 옮긴 문장 바로 뒤에서 실패시킨다.
    mergeHooks.midBatch = (e: Env) => e.DB.prepare("INSERT INTO guard (state_conflict) VALUES (1)");
    const res = await merge(g, dup.id, p[0]!.id);
    expect(res.status).toBe(409);
    expect(await state(g)).toBe(before);
    const snap = await snapshot(g);
    expect(snap.participants.find((x) => x.id === dup.id)!.status).toBe("active");
    expect(snap.matches[0]!.roster.some((r) => r.participantId === dup.id)).toBe(true);
  });

  it("같은 요청 ID로 다시 보내면 한 번만 합치고 같은 결과를 돌려준다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    const rid = requestId();
    const first = await merge(g, dup.id, p[0]!.id, rid);
    const second = await merge(g, dup.id, p[0]!.id, rid);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM participant_merges WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ n: number }>();
    expect(rows!.n).toBe(1);
    // 같은 요청 ID로 다른 내용을 보내면 거절한다.
    const other = await merge(g, p[2]!.id, p[3]!.id, rid);
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("REQUEST_ID_REUSED");
  });

  it("다른 모임의 참가자, 운영자가 아닌 사람, 조회 토큰, 로그인 없음은 모두 거절하고 아무것도 바꾸지 않는다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    const other = await setupGroup(10);
    const before = await state(g);
    const otherBefore = await state(other);

    const cross = await merge(g, other.people[0]!.id, p[0]!.id);
    expect(cross.status).toBe(404);
    const cross2 = await merge(g, dup.id, other.people[0]!.id);
    expect(cross2.status).toBe(404);
    expect((await preview(g, dup.id, other.people[0]!.id)).status).toBe(404);

    const stranger = await login();
    const body = { requestId: requestId(), sourceId: dup.id, targetId: p[0]!.id };
    expect((await api(stranger, "POST", `/api/groups/${g.gid}/merges`, body)).status).toBe(404);
    expect(
      (await api(stranger, "GET", `/api/groups/${g.gid}/merges/preview?source=${dup.id}&target=${p[0]!.id}`))
        .status,
    ).toBe(404);
    expect((await api(null, "POST", `/api/groups/${g.gid}/merges`, body)).status).toBe(401);
    const token = (await snapshot(g)).group.viewToken!;
    expect((await api(null, "POST", `/api/view/${token}/merges`, body)).status).toBe(404);

    expect(await state(g)).toBe(before);
    expect(await state(other)).toBe(otherBefore);
  });

  it("합칠 대상이 진행 중 경기에 있으면 거절한다(대기 경기는 옮긴다)", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const roster = rosterOf([dup, ...p.slice(1, 10)]);
    const started = await start(g, roster);
    expect(started.status).toBe(200);
    const res = await merge(g, dup.id, p[0]!.id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MATCH_IN_PROGRESS");

    // "결과는 나중에"로 돌리면 합칠 수 있고, 대기 경기의 명단도 옮겨진다.
    expect((await matchAction(g, started.body.match, "end-later")).status).toBe(200);
    const ok = await merge(g, dup.id, p[0]!.id);
    expect(ok.status).toBe(200);
    const snap = await snapshot(g);
    const m = snap.matches.find((x) => x.id === started.body.match.id)!;
    expect(m.state).toBe("awaiting_result");
    expect(m.roster.map((r) => r.participantId)).toContain(p[0]!.id);
    // 대기 경기의 결과를 저장하면 남은 사람의 기록으로 들어간다.
    expect((await matchAction(g, m, "result", { winnerTeam: "A", winnerSide: "red" })).status).toBe(200);
  });

  it("같은 순환 주기에 두 사람이 각각 서포터를 했으면 늦은 쪽을 '반복 허용'으로 바꾼다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    // 1경기: 부캐가 팀 A 서포터(5번째 자리). 2경기: 본캐가 팀 A 서포터. 같은 내전(세션)·같은 주기.
    await playConfirmed(g, rosterOf([p[1]!, p[2]!, p[3]!, p[4]!, dup, p[5]!, p[6]!, p[7]!, p[8]!, p[9]!]));
    await playConfirmed(g, rosterOf([p[10]!, p[11]!, p[2]!, p[3]!, p[0]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!]));
    const before = await snapshot(g);
    expect(before.rotation!.events.filter((e) => e.kind === "used")).toHaveLength(4);

    const pv = await preview(g, dup.id, p[0]!.id);
    expect(pv.body.rotation).toEqual({ moved: 1, converted: 1 });
    expect((await merge(g, dup.id, p[0]!.id)).status).toBe(200);

    const after = await snapshot(g);
    const mine = after.rotation!.events.filter((e) => e.participantId === p[0]!.id);
    // 먼저 쓴 기록(부캐 시절)이 "사용", 나중 기록이 "반복 허용". 주기의 사용 인원은 4 → 3.
    expect(mine.map((e) => e.kind)).toEqual(["used", "repeat"]);
    expect(after.rotation!.events.filter((e) => e.kind === "used")).toHaveLength(3);
    // 차례 기록이 바뀌었으므로 진행 상태 버전이 오른다(초안의 후보 목록 갱신).
    expect(after.group.liveVersion).toBe(before.group.liveVersion + 1);
    // 다음 경기에서 본캐가 서포터면 이미 차례를 쓴 사람이라 확인을 요구한다.
    const next = await start(g, rosterOf([p[2]!, p[3]!, p[5]!, p[6]!, p[0]!, p[7]!, p[8]!, p[9]!, p[10]!, p[11]!]));
    expect(next.status).toBe(409);
    expect(next.body.error.code).toBe("SUPPORT_REPEAT");
    expect(next.body.error.details.participantIds).toEqual([p[0]!.id]);

    // 되돌리면 차례 기록도 원래 사람·종류로 돌아간다.
    expect((await undo(g, after.merges![0]!.id)).status).toBe(200);
    const restored = await snapshot(g);
    expect(restored.rotation!.events).toEqual(before.rotation!.events);
  });

  it("되돌리기는 옮긴 행만 원래대로 돌리고, 합친 뒤 새로 뛴 경기는 남긴다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const withDup = [dup, ...p.slice(1, 10)];
    const m1 = await play(g, withDup, "A");
    const m2 = await play(g, withDup, "B");
    const beforeMerge = await snapshot(g);
    const res = await merge(g, dup.id, p[0]!.id);
    const mergeId = res.body.mergeId as string;
    // 합친 뒤 본캐 이름으로 새 경기.
    const m3 = await play(g, [p[0]!, ...p.slice(1, 10)], "A");

    const done = await undo(g, mergeId);
    expect(done.status).toBe(200);
    expect(done.body.matchCount).toBe(2);
    const after = await snapshot(g);
    expect(rosterIds(after, m1.id)).toContain(dup.id);
    expect(rosterIds(after, m2.id)).toContain(dup.id);
    expect(rosterIds(after, m3.id)).toContain(p[0]!.id);
    const restored = after.participants.find((x) => x.id === dup.id)!;
    expect(restored.status).toBe("active");
    expect(restored.mergedInto).toBeUndefined();
    expect(after.merges![0]!.undoneAt).not.toBeNull();
    // 부캐의 통계는 합치기 전과 같다.
    const bands = titleBandsOf(after.group.settings);
    expect(standings(after.matches, bands).get(dup.id)).toEqual(standings(beforeMerge.matches, bands).get(dup.id));
    // 되돌린 경기에도 이력 원본이 한 줄씩 남는다(합치기 2줄 + 되돌리기 2줄).
    const rows = await env.DB.prepare(
      "SELECT changes FROM match_revisions WHERE match_id = ?1 AND kind = 'correction' ORDER BY id DESC",
    )
      .bind(m1.id)
      .all<{ changes: string }>();
    expect(rows.results.map((r) => JSON.parse(r.changes).participant)).toEqual([
      { from: p[0]!.id, to: dup.id },
      { from: dup.id, to: p[0]!.id },
    ]);
    // 스냅숏에는 합치기 한 줄과 되돌리기 한 줄로 묶여 나간다.
    expect(after.revisions.filter((r) => r.kind === "merge").map((r) => r.merge!.matchCount)).toEqual([2]);
    expect(after.revisions.filter((r) => r.kind === "merge_undo").map((r) => r.merge!.matchCount)).toEqual([2]);
    // 이미 되돌린 합치기는 다시 되돌릴 수 없다.
    expect((await undo(g, mergeId)).body.error.code).toBe("ALREADY_UNDONE");
  });

  it("합쳐진 사람은 '보관 해제'로 되살릴 수 없고, 되돌리기 순서와 이름 중복을 지킨다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    const first = await merge(g, dup.id, p[0]!.id);
    expect(first.status).toBe(200);
    const revive = await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${dup.id}`, { status: "active" });
    expect(revive.status).toBe(409);
    expect(revive.body.error.code).toBe("MERGED_PARTICIPANT");
    // 합쳐진 사람은 다시 합치거나 남길 대상이 될 수 없다.
    expect((await merge(g, dup.id, p[11]!.id)).body.error.code).toBe("ALREADY_MERGED");
    expect((await merge(g, p[11]!.id, dup.id)).body.error.code).toBe("ALREADY_MERGED");

    // 본캐를 또 다른 이름에 합치면, 먼저 그쪽을 되돌려야 앞의 합치기를 되돌릴 수 있다.
    const second = await merge(g, p[0]!.id, p[11]!.id);
    expect(second.status).toBe(200);
    const blocked = await undo(g, first.body.mergeId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("MERGE_ORDER");
    expect((await undo(g, second.body.mergeId)).status).toBe(200);

    // 합쳐진 사람의 이름을 그 사이 다른 사람이 쓰고 있으면 되돌리지 않는다.
    await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1 부캐"] });
    const clash = await undo(g, first.body.mergeId);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("NAME_TAKEN");
  });

  it("조회 응답에는 합쳐진 표시만 있고 실력 그룹은 여전히 없다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await api(g.cookie, "PATCH", `/api/groups/${g.gid}/participants/${p[0]!.id}`, { skillGroup: 1 });
    await play(g, [dup, ...p.slice(1, 10)]);
    await merge(g, dup.id, p[0]!.id);
    const token = (await snapshot(g)).group.viewToken!;
    const view = await api<Snapshot>(null, "GET", `/api/view/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.participants.find((x) => x.id === dup.id)!.mergedInto).toBe(p[0]!.id);
    expect(view.body.merges).toBeUndefined();
    const text = JSON.stringify(view.body);
    expect(text).not.toContain("skillGroup");
    expect(text).not.toContain(token);
  });
});

describe("변경 이력 상한과 합치기 묶음", () => {
  it("많이 뛴 사람을 합쳐도 실제 정정이 스냅숏의 이력 상한에 밀려나지 않는다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const first = await play(g, p.slice(0, 10), "A");
    const corrected = await matchAction(g, first, "correct", {
      field: "side",
      winnerSide: "red",
    });
    expect(corrected.status).toBe(200);
    const m = await play(g, [dup, ...p.slice(1, 10)], "B");
    await merge(g, dup.id, p[0]!.id);
    // 합치기가 경기 300개를 옮긴 것과 같은 이력을 넣는다(원본 행 형식 그대로, 같은 시각).
    const mergeRow = await env.DB.prepare("SELECT created_at FROM participant_merges WHERE group_id = ?1")
      .bind(g.gid)
      .first<{ created_at: string }>();
    const changes = JSON.stringify({ participant: { from: dup.id, to: p[0]!.id } });
    const extra = Array.from({ length: 300 }, () =>
      env.DB.prepare(
        "INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at) VALUES (?1, ?2, 'correction', ?3, ?4)",
      ).bind(g.gid, m.id, changes, mergeRow!.created_at),
    );
    await env.DB.batch(extra);

    const snap = await snapshot(g);
    const grouped = snap.revisions.filter((r) => r.kind === "merge");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.merge!.matchCount).toBe(301);
    // 진영 정정은 그대로 남아 있다.
    const sideFix = snap.revisions.filter((r) => r.kind === "correction" && "teamASide" in r.changes);
    expect(sideFix).toHaveLength(1);
    expect(snap.revisions.length).toBeLessThanOrEqual(200 + 200 + 50);

    // 되돌리면 되돌리기도 한 줄로 묶인다.
    await undo(g, snap.merges![0]!.id);
    const after = await snapshot(g);
    const undone = after.revisions.filter((r) => r.kind === "merge_undo");
    expect(undone).toHaveLength(1);
    expect(undone[0]!.merge).toMatchObject({ sourceId: dup.id, targetId: p[0]!.id });
    expect(after.revisions.filter((r) => r.kind === "correction" && "participant" in r.changes)).toHaveLength(0);
  });

  it("조회 응답에도 묶음 줄만 나가고 그룹·토큰은 없다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    await merge(g, dup.id, p[0]!.id);
    const op = await snapshot(g);
    const view = await api(null, "GET", `/api/view/${op.group.viewToken}`);
    expect(view.status).toBe(200);
    const grouped = (view.body as Snapshot).revisions.filter((r) => r.kind === "merge");
    expect(grouped).toHaveLength(1);
    expect(JSON.stringify(view.body)).not.toContain(op.group.viewToken!);
    expect(JSON.stringify(view.body)).not.toContain("skillGroup");
  });
});

describe("합치기와 백업·복원", () => {
  async function exportOf(g: TestGroup) {
    const res = await api(g.cookie, "GET", `/api/groups/${g.gid}/export`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it("합친 뒤 백업 → 다른 변경 → 복원하면 합치기 상태로 돌아오고, 복원 뒤에도 되돌릴 수 있다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    const m1 = await play(g, [dup, ...p.slice(1, 10)]);
    const mergeId = (await merge(g, dup.id, p[0]!.id)).body.mergeId as string;
    const backup = await exportOf(g);
    expect(backup.formatVersion).toBe(4);
    expect(backup.participantMerges).toHaveLength(1);
    expect(backup.participantMerges[0]).toMatchObject({ id: mergeId, movedMatches: [m1.id] });

    // 백업 뒤에 되돌림 → 복원하면 다시 합쳐진 상태.
    expect((await undo(g, mergeId)).status).toBe(200);
    const snap = await snapshot(g);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
    expect(res.status).toBe(200);
    const after = await snapshot(g);
    expect(after.participants.find((x) => x.id === dup.id)!.mergedInto).toBe(p[0]!.id);
    expect(rosterIds(after, m1.id)).toContain(p[0]!.id);
    // 복원한 합치기 기록으로 되돌리기가 그대로 된다.
    expect((await undo(g, mergeId)).status).toBe(200);
    expect(rosterIds(await snapshot(g), m1.id)).toContain(dup.id);
  });

  it("새 모임으로 가져오면 합치기 기록 안의 ID도 새 ID로 바뀌고 되돌리기가 된다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    await merge(g, dup.id, p[0]!.id);
    const backup = await exportOf(g);
    const other = await login();
    const imported = await api(other, "POST", "/api/restore/new-group", {
      requestId: requestId(),
      confirm: "복원",
      backup,
    });
    expect(imported.status).toBe(200);
    const ng: TestGroup = { cookie: other, gid: imported.body.groupId, people: [] };
    const snap = await snapshot(ng);
    const mergeRow = snap.merges![0]!;
    expect(mergeRow.sourceId).not.toBe(dup.id);
    const source = snap.participants.find((x) => x.id === mergeRow.sourceId)!;
    expect(source.name).toBe("참가자1 부캐");
    expect(source.mergedInto).toBe(mergeRow.targetId);
    // 변경 이력 안의 참가자 ID도 새 ID로 바뀌어 합치기 줄로 묶인다.
    const grouped = snap.revisions.filter((r) => r.kind === "merge");
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.merge).toMatchObject({ sourceId: mergeRow.sourceId, targetId: mergeRow.targetId, matchCount: 1 });
    expect((await undo(ng, mergeRow.id)).status).toBe(200);
    const after = await snapshot(ng);
    expect(after.matches[0]!.roster.map((r) => r.participantId)).toContain(mergeRow.sourceId);
  });

  it("합치기 기록이 파일에 없는 경기·참가자를 가리키면 복원하지 않는다", async () => {
    const { g, dup, p } = await groupWithDuplicate();
    await play(g, [dup, ...p.slice(1, 10)]);
    await merge(g, dup.id, p[0]!.id);
    const backup = await exportOf(g);
    backup.participantMerges[0].movedMatches = ["no-such-match"];
    const pv = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore/preview`, { backup });
    expect(pv.body.ok).toBe(false);
    expect(pv.body.problems.join(" ")).toContain("합치기");
  });
});

describe("합치기 계산(순수 함수)", () => {
  it("합친 뒤 경기 목록으로 계산한 값이 서버 미리보기와 같은 규칙이다", () => {
    const roster = (ids: string[]): RosterEntry[] =>
      ids.map((id, i) => ({ participantId: id, team: i < 5 ? "A" : "B", position: null }));
    const match = (no: number, ids: string[], winner: "A" | "B") => ({
      id: `m${no}`,
      matchNo: no,
      sessionId: null,
      state: "confirmed" as const,
      source: "backfill" as const,
      startedAt: null,
      endedAt: null,
      playedAt: `2026-01-0${no}T00:00:00.000Z`,
      confirmedAt: null,
      winnerTeam: winner,
      teamASide: "unknown" as const,
      version: 1,
      roster: roster(ids),
    });
    const others = ["b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const matches = [match(1, ["s", ...others], "A"), match(2, ["t", ...others], "B")];
    const result = mergeStandings(matches, "s", "t", []);
    expect(result.source).toMatchObject({ games: 1, wins: 1 });
    expect(result.target).toMatchObject({ games: 1, wins: 0 });
    expect(result.merged).toMatchObject({ games: 2, wins: 1, losses: 1 });
  });
});
