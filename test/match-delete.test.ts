import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { computeRatings, ratingValues } from "../src/shared/rating";
import { seriesScore } from "../src/shared/series";
import { personRecords } from "../src/shared/stats";
import type { MatchView, RosterEntry, Snapshot } from "../src/shared/types";
import {
  api,
  login,
  matchAction,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
  unique,
  type TestGroup,
} from "./helpers";

// 경기 삭제·되살리기(migrations/0026, src/server/matches.ts deleteMatch·undeleteMatch).
// 지운 경기는 DB에 남지만 스냅숏·조회 링크·계산·가져오기 중복 판정에서 빠지고, 변경 내역의 삭제 줄로 되살린다.

/** 같은 명단을 여러 번 쓰려고 서포터 반복을 허용하고 시작·결과까지 확정한다. */
async function play(g: TestGroup, roster: RosterEntry[], winnerTeam: "A" | "B" = "A"): Promise<MatchView> {
  const started = await start(g, roster, { ackRepeat: roster.map((r) => r.participantId) });
  if (started.status !== 200) throw new Error(`시작 실패: ${JSON.stringify(started.body)}`);
  const done = await matchAction(g, started.body.match, "result", { winnerTeam, winnerSide: "blue" });
  if (done.status !== 200) throw new Error(`확정 실패: ${JSON.stringify(done.body)}`);
  return done.body.match;
}

const remove = (g: TestGroup, m: { id: string; version: number }, cookie = g.cookie) =>
  api(cookie, "POST", `/api/groups/${g.gid}/matches/${m.id}/delete`, { requestId: requestId(), baseMatchVersion: m.version });

/** 변경 내역의 삭제 줄에 실린 버전으로 되살린다(화면과 같은 경로). */
async function undelete(g: TestGroup, matchId: string, cookie = g.cookie) {
  const line = (await snapshot(g)).revisions.find((r) => r.matchId === matchId && r.deletedMatch);
  expect(line, "되살리기 줄").toBeDefined();
  return api(cookie, "POST", `/api/groups/${g.gid}/matches/${matchId}/undelete`, {
    requestId: requestId(),
    baseMatchVersion: line!.deletedMatch!.version,
  });
}

async function viewOf(g: TestGroup): Promise<{ status: number; body: Snapshot; text: string }> {
  const token = (await snapshot(g)).group.viewToken!;
  const res = await api<Snapshot>(null, "GET", `/api/view/${token}`);
  return { status: res.status, body: res.body, text: JSON.stringify(res.body) };
}

async function addCo(g: TestGroup): Promise<string> {
  const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
  const co = await login();
  expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
  return co;
}

/** 서로 다른 결과의 두 경기. 둘째를 지우면 승률·MMR이 첫째 경기만으로 계산돼야 한다. */
async function twoGames(): Promise<{ g: TestGroup; first: MatchView; second: MatchView }> {
  const g = await setupGroup(12);
  const roster = rosterOf(g.people);
  const first = await play(g, roster, "A");
  const second = await play(g, roster, "B");
  return { g, first, second };
}

describe("경기 삭제", () => {
  it("지우면 스냅숏·조회 링크에서 빠지고 승률·MMR이 그 경기 없이 계산된다. 번호는 비워 둔다", async () => {
    const { g, first, second } = await twoGames();
    const res = await remove(g, second);
    expect(res.status).toBe(200);
    expect(res.body.match.deletedAt).toEqual(expect.any(String));
    expect(res.body.match.state).toBe("confirmed");

    const snap = await snapshot(g);
    expect(snap.matches.map((m) => m.id)).toEqual([first.id]);
    // 계산은 화면과 같은 함수로: 첫 경기만 남은 것과 같다.
    const onlyFirst = [snap.matches[0]!];
    expect(personRecords(snap.matches)).toEqual(personRecords(onlyFirst));
    const ratings = ratingValues(computeRatings(snap.matches));
    expect(ratings).toEqual(ratingValues(computeRatings(onlyFirst)));
    const winner = g.people[0]!.id;
    expect(personRecords(snap.matches).get(winner)).toMatchObject({ games: 1, wins: 1 });

    // 조회 링크: 지운 경기의 ID·명단이 응답 어디에도 없다. 변경 내역의 삭제 줄(번호·누가·언제)만 있다.
    const view = await viewOf(g);
    expect(view.status).toBe(200);
    expect(view.body.matches.map((m) => m.id)).toEqual([first.id]);
    const deletionLines = view.body.revisions.filter((r) => r.matchId === second.id);
    expect(deletionLines.map((r) => r.changes)).toEqual([{ deleted: { from: false, to: true }, by: { from: null, to: "owner" } }]);
    expect(deletionLines[0]!.matchNo).toBe(2);
    expect(view.text).not.toContain('"winnerTeam":"B"');

    // 다음 경기 번호는 이어진다(2번을 비워 두고 3번).
    const next = await play(g, rosterOf(g.people));
    expect(next.matchNo).toBe(3);
    // DB 행은 그대로 남아 있다.
    const row = await env.DB.prepare("SELECT state, deleted_at FROM matches WHERE id = ?1").bind(second.id).first();
    expect(row).toMatchObject({ state: "confirmed", deleted_at: expect.any(String) });
  });

  it("되살리면 지우기 전 상태(확정·전적 제외·결과 미입력)로 돌아오고 계산에 다시 들어간다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    const confirmed = await play(g, roster, "A");
    const toExclude = await play(g, roster, "B");
    const excluded = (await matchAction(g, toExclude, "exclude")).body.match as MatchView;
    const started = await start(g, roster, { ackRepeat: roster.map((r) => r.participantId) });
    const awaiting = (await matchAction(g, started.body.match, "end-later")).body.match as MatchView;
    expect(awaiting.state).toBe("awaiting_result");
    const before = await snapshot(g);

    for (const m of [confirmed, excluded, awaiting]) expect((await remove(g, m)).status).toBe(200);
    expect((await snapshot(g)).matches).toEqual([]);

    for (const m of [confirmed, excluded, awaiting]) {
      const res = await undelete(g, m.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.match.deletedAt).toBeUndefined();
    }
    const after = await snapshot(g);
    const strip = (s: Snapshot) => s.matches.map(({ version: _v, ...m }) => m);
    expect(strip(after)).toEqual(strip(before));
    expect(after.matches.map((m) => m.state)).toEqual(["confirmed", "excluded", "awaiting_result"]);
    expect(personRecords(after.matches)).toEqual(personRecords(before.matches));
    // 되살린 줄도 변경 내역에 남고, 되살린 경기에는 되살리기 버튼 정보가 없다.
    const lines = after.revisions.filter((r) => r.changes.deleted);
    expect(lines.filter((r) => r.changes.deleted!.to === false)).toHaveLength(3);
    expect(lines.some((r) => r.deletedMatch)).toBe(false);
    // 되살린 결과 미입력 경기에 결과를 넣을 수 있다.
    const awaitingNow = after.matches.find((m) => m.id === awaiting.id)!;
    expect((await matchAction(g, awaitingNow, "result", { winnerTeam: "A", winnerSide: "red" })).status).toBe(200);
  });

  it("진행 중·취소 경기는 지울 수 없고, 지운 경기를 또 지우거나 살아 있는 경기를 되살리면 거절한다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    const live = (await start(g, roster)).body.match as MatchView;
    const inProgress = await remove(g, live);
    expect(inProgress.status).toBe(409);
    expect(inProgress.body.error.code).toBe("STATE_CONFLICT");
    const canceled = (await matchAction(g, live, "cancel")).body.match as MatchView;
    expect(canceled.state).toBe("canceled");
    expect((await remove(g, canceled)).body.error.code).toBe("STATE_CONFLICT");

    const m = await play(g, roster, "A");
    const alive = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${m.id}/undelete`, {
      requestId: requestId(),
      baseMatchVersion: m.version,
    });
    expect(alive.status).toBe(409);
    expect(alive.body.error.code).toBe("STATE_CONFLICT");

    const deleted = (await remove(g, m)).body.match as MatchView;
    // 지운 경기는 없는 경기로 다룬다: 다시 지우기·정정·전적 제외·메모 모두 404.
    expect((await remove(g, deleted)).status).toBe(404);
    expect((await matchAction(g, deleted, "exclude")).status).toBe(404);
    expect((await matchAction(g, deleted, "correct", { field: "winner", winnerTeam: "B", winnerSide: "red" })).status).toBe(404);
    const memo = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${m.id}/memo`, {
      requestId: requestId(),
      memo: "몰래",
      baseMemo: null,
    });
    expect(memo.status).toBe(404);
  });

  it("조회자·참가자 본인·로그인 안 한 요청은 거절하고, 공동 운영자는 지우고 되살릴 수 있다", async () => {
    const { g, second } = await twoGames();
    expect((await remove(g, second, "")).status).toBe(401);
    expect((await remove(g, second, await login())).status).toBe(404);
    // 참가자 본인 연결 계정도 운영자 경로는 쓸 수 없다.
    const claim = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[0]!.id}/claim-link`);
    const member = await login();
    expect((await api(member, "POST", `/api/claim/${claim.body.token}/accept`)).status).toBe(200);
    expect((await remove(g, second, member)).status).toBe(404);
    expect((await snapshot(g)).matches).toHaveLength(2);

    const co = await addCo(g);
    expect((await remove(g, second, co)).status).toBe(200);
    const line = (await snapshot(g)).revisions.find((r) => r.matchId === second.id)!;
    expect(line.changes.by).toEqual({ from: null, to: "co" });
    expect((await undelete(g, second.id, member)).status).toBe(404);
    expect((await undelete(g, second.id, co)).status).toBe(200);
  });

  it("같은 요청 ID 재전송은 같은 응답이고, 옛 버전이면 409다", async () => {
    const { g, first, second } = await twoGames();
    const body = { requestId: requestId(), baseMatchVersion: second.version };
    const path = `/api/groups/${g.gid}/matches/${second.id}/delete`;
    const a = await api(g.cookie, "POST", path, body);
    const b = await api(g.cookie, "POST", path, body);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect((await snapshot(g)).revisions.filter((r) => r.changes.deleted)).toHaveLength(1);

    const stale = await remove(g, { id: first.id, version: first.version - 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    const staleUndelete = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/${second.id}/undelete`, {
      requestId: requestId(),
      baseMatchVersion: second.version,
    });
    expect(staleUndelete.status).toBe(409);
    expect(staleUndelete.body.error.code).toBe("VERSION_CONFLICT");
  });
});

describe("시리즈에 든 경기", () => {
  async function seriesOfTwo() {
    const { g, first, second } = await twoGames();
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/series`, {
      requestId: requestId(),
      format: "bo3",
      matchIds: [first.id, second.id],
    });
    expect(created.status).toBe(200);
    return { g, first, second, seriesId: created.body.series.id as string };
  }

  it("지우면 시리즈 점수·판 수에서 빠지고, 되살리면 돌아온다. 모든 판을 지우면 시리즈가 보이지 않는다", async () => {
    const { g, first, second, seriesId } = await seriesOfTwo();
    expect((await remove(g, second)).status).toBe(200);
    let snap = await snapshot(g);
    let series = snap.series!.find((s) => s.id === seriesId)!;
    expect(series.matchIds).toEqual([first.id]);
    expect(seriesScore(series, snap.matches).wins).toEqual([1, 0]);

    // 남은 판 수 기준으로 넣기 검사를 한다(지운 판 때문에 동시 수정으로 오인하지 않는다).
    const third = await play(g, rosterOf(g.people), "A");
    expect(
      (await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/add`, { requestId: requestId(), matchId: third.id }))
        .status,
    ).toBe(200);

    snap = await snapshot(g);
    for (const m of snap.matches) expect((await remove(g, m)).status).toBe(200);
    snap = await snapshot(g);
    expect(snap.series!.some((s) => s.id === seriesId)).toBe(false);
    expect((await viewOf(g)).body.series).toEqual([]);

    expect((await undelete(g, second.id)).status).toBe(200);
    snap = await snapshot(g);
    series = snap.series!.find((s) => s.id === seriesId)!;
    expect(series.matchIds).toEqual([second.id]);
    expect(seriesScore(series, snap.matches).wins).toEqual([0, 1]);
  });

  it("보이는 마지막 판을 빼도 지운 판이 남아 있으면 시리즈 행을 지우지 않아, 되살리면 시리즈째 돌아온다", async () => {
    const { g, first, second, seriesId } = await seriesOfTwo();
    expect((await remove(g, second)).status).toBe(200);
    const out = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/remove`, {
      requestId: requestId(),
      matchId: first.id,
    });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.series).toBeNull();
    expect((await snapshot(g)).series).toEqual([]);
    expect((await undelete(g, second.id)).status).toBe(200);
    expect((await snapshot(g)).series!.map((s) => [s.id, s.matchIds])).toEqual([[seriesId, [second.id]]]);
  });
});

describe("백업과 복원", () => {
  async function exportOf(g: TestGroup): Promise<{ matches: MatchView[]; matchCount: number }> {
    const res = await api(g.cookie, "GET", `/api/groups/${g.gid}/export`);
    expect(res.status).toBe(200);
    return res.body;
  }

  async function restoreSame(g: TestGroup, backup: unknown) {
    const snap = await snapshot(g);
    return api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
  }

  it("백업에 삭제 표시가 들어가고, 복원한 뒤에도 지운 채로 남아 되살릴 수 있다", async () => {
    const { g, first, second } = await twoGames();
    expect((await remove(g, second)).status).toBe(200);
    const backup = await exportOf(g);
    expect(backup.matches).toHaveLength(2);
    expect(backup.matchCount).toBe(2);
    expect(backup.matches.find((m) => m.id === second.id)!.deletedAt).toEqual(expect.any(String));
    expect(backup.matches.find((m) => m.id === first.id)!.deletedAt).toBeUndefined();

    // 백업 뒤에 되살렸어도 복원하면 파일대로 지운 상태다.
    expect((await undelete(g, second.id)).status).toBe(200);
    const preview = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore/preview`, { backup });
    expect(preview.body.file.matches).toBe(1);
    const res = await restoreSame(g, backup);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await snapshot(g);
    expect(after.matches.map((m) => m.id)).toEqual([first.id]);
    expect((await undelete(g, second.id)).status).toBe(200);
    expect((await snapshot(g)).matches).toHaveLength(2);
  });

  it("삭제 칸이 없는 예전 백업도 복원되고 모든 경기가 살아 있다", async () => {
    const { g } = await twoGames();
    const backup = await exportOf(g);
    for (const m of backup.matches) delete m.deletedAt;
    expect((await restoreSame(g, backup)).status).toBe(200);
    expect((await snapshot(g)).matches).toHaveLength(2);
  });
});

describe("가져오기 중복 판정", () => {
  const FINGERPRINT = "v1-0123456789abcdef";

  async function importOne(g: TestGroup) {
    return api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      source: { kind: "paste" },
      matches: [
        {
          playedAt: "2026-10-01T03:00:00.000Z",
          roster: rosterOf(g.people),
          winnerTeam: "A",
          winnerSide: "unknown",
          fingerprint: FINGERPRINT,
        },
      ],
    });
  }

  it("지운 경기는 이미 들어간 경기로 치지 않아 다시 가져올 수 있고, 그때 지운 쪽은 두 번 세지 않게 되살리기를 거절한다", async () => {
    const g = await setupGroup(12);
    const original = (await importOne(g)).body.matchIds[0] as string;
    expect((await importOne(g)).body.error.code).toBe("ALREADY_IMPORTED");

    const row = (await snapshot(g)).matches[0]!;
    expect((await remove(g, row)).status).toBe(200);
    const listed = await api(g.cookie, "GET", `/api/groups/${g.gid}/imports/fingerprints`);
    expect(listed.body.imports).toEqual([]);
    const again = await importOne(g);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const copy = again.body.matchIds[0] as string;

    const blocked = await undelete(g, original);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("RESTORE_DUPLICATE");

    // 새로 넣은 쪽을 지우면 원래 경기를 되살릴 수 있다.
    const copyRow = (await snapshot(g)).matches.find((m) => m.id === copy)!;
    expect((await remove(g, copyRow)).status).toBe(200);
    expect((await undelete(g, original)).status).toBe(200);
    expect((await snapshot(g)).matches.map((m) => m.id)).toEqual([original]);
  });
});
