import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seriesScore } from "../src/shared/series";
import type { MatchView, RosterEntry, SeriesView, Snapshot } from "../src/shared/types";
import {
  api,
  fingerprint,
  login,
  matchAction,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
  type TestGroup,
} from "./helpers";

// 경기 메모(migrations/0016)와 시리즈 묶음(migrations/0017) — src/server/matches.ts saveMemo, src/server/series.ts.

/** 서포터 반복을 허용하고(같은 명단을 여러 번 쓰려고) 시작·결과까지 확정한다. */
async function play(
  g: TestGroup,
  roster: RosterEntry[],
  winnerTeam: "A" | "B" = "A",
  extra: Record<string, unknown> = {},
  resultExtra: Record<string, unknown> = {},
): Promise<MatchView> {
  const started = await start(g, roster, { ackRepeat: roster.map((r) => r.participantId), ...extra });
  if (started.status !== 200) throw new Error(`시작 실패: ${JSON.stringify(started.body)}`);
  const done = await matchAction(g, started.body.match, "result", { winnerTeam, winnerSide: "blue", ...resultExtra });
  if (done.status !== 200) throw new Error(`확정 실패: ${JSON.stringify(done.body)}`);
  return done.body.match;
}

/** 두 팀을 통째로 맞바꾼 명단(같은 구성, 다른 진영). */
function swapped(roster: RosterEntry[]): RosterEntry[] {
  return roster.map((r) => ({ ...r, team: r.team === "A" ? "B" : "A" }));
}

/** 팀 A의 한 명과 팀 B의 한 명을 맞바꾼 명단(다른 구성). */
function mixed(roster: RosterEntry[]): RosterEntry[] {
  return roster.map((r, i) => (i === 0 ? { ...r, team: "B" } : i === 5 ? { ...r, team: "A" } : r));
}

function memo(g: TestGroup, matchId: string, text: unknown, baseMemo: unknown = null, cookie = g.cookie) {
  return api(cookie, "POST", `/api/groups/${g.gid}/matches/${matchId}/memo`, { requestId: requestId(), memo: text, baseMemo });
}

async function viewOf(g: TestGroup): Promise<Snapshot> {
  const token = (await snapshot(g)).group.viewToken!;
  return (await api<Snapshot>(null, "GET", `/api/view/${token}`)).body;
}

async function addCo(g: TestGroup): Promise<string> {
  const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
  const co = await login();
  expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
  return co;
}

function createSeries(g: TestGroup, matchIds: string[], extra: Record<string, unknown> = {}, cookie = g.cookie) {
  return api(cookie, "POST", `/api/groups/${g.gid}/series`, {
    requestId: requestId(),
    format: "bo3",
    matchIds,
    ...extra,
  });
}

function seriesAction(g: TestGroup, seriesId: string, action: string, body: Record<string, unknown>, cookie = g.cookie) {
  return api(cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/${action}`, { requestId: requestId(), ...body });
}

async function exportOf(g: TestGroup): Promise<Record<string, any>> {
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

/* ------------------------------------------------------------------ */
/* 메모                                                                 */
/* ------------------------------------------------------------------ */

describe("경기 메모", () => {
  it("결과 입력에 메모를 함께 저장하고, 운영자·조회 응답 모두에 글 그대로 나간다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people), "A", {}, { memo: "  바론 스틸로 역전\r\n<b>굿</b>  " });
    expect(m.memo).toBe("바론 스틸로 역전\n<b>굿</b>");
    const op = (await snapshot(g)).matches[0]!;
    expect(op.memo).toBe("바론 스틸로 역전\n<b>굿</b>");
    const view = await viewOf(g);
    expect(view.matches[0]!.memo).toBe("바론 스틸로 역전\n<b>굿</b>");
    // 조회 응답에 새로 나가는 것은 메모·시리즈뿐: 비공개 모임의 티어는 여전히 없다.
    expect(view.participants.every((p) => !("skillGroup" in p) && !("avoidPositions" in p))).toBe(true);
    expect(view.rotation?.adjustments).toBeUndefined();
  });

  it("메모가 없는 경기는 응답에 memo 항목이 없다(예전 모양 그대로)", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    expect("memo" in m).toBe(false);
    expect("memo" in (await snapshot(g)).matches[0]!).toBe(false);
  });

  it("200자까지 되고 201자는 거절한다. 공백만이면 지운다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    const ok = await memo(g, m.id, "가".repeat(200));
    expect(ok.status).toBe(200);
    expect(ok.body.match.memo).toHaveLength(200);
    const before = fingerprint(await snapshot(g));
    const tooLong = await memo(g, m.id, "가".repeat(201), "가".repeat(200));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("MEMO_TOO_LONG");
    // 그림 문자(대리 쌍)도 한 글자로 센다.
    expect((await memo(g, m.id, "🎉".repeat(200), "가".repeat(200))).status).toBe(200);
    expect(fingerprint(await snapshot(g))).toBe(before);
    const cleared = await memo(g, m.id, "  \n ", "🎉".repeat(200));
    expect(cleared.status).toBe(200);
    expect("memo" in cleared.body.match).toBe(false);
    // 결과 입력의 메모도 같은 한도.
    const g2 = await setupGroup();
    const started = await start(g2, rosterOf(g2.people));
    const res = await matchAction(g2, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue", memo: "나".repeat(201) });
    expect(res.status).toBe(400);
    expect((await snapshot(g2)).matches[0]!.state).toBe("in_progress");
  });

  it("진행 중·결과 대기·확정 경기에 쓸 수 있고, 미진행 취소·전적 제외 경기는 거절한다", async () => {
    const g = await setupGroup();
    const started = (await start(g, rosterOf(g.people))).body.match;
    expect((await memo(g, started.id, "진행 중 메모")).status).toBe(200);
    const later = await matchAction(g, started, "end-later");
    expect(later.status).toBe(200);
    expect((await memo(g, started.id, "대기 메모", "진행 중 메모")).status).toBe(200);
    // 메모만 고친 것은 경기 버전을 올리지 않는다(열린 결과 창이 충돌하지 않게).
    expect((await snapshot(g)).matches[0]!.version).toBe(later.body.match.version);
    // 결과 입력에서 메모를 보내지 않으면 그대로 남는다.
    const done = await matchAction(g, later.body.match, "result", { winnerTeam: "B", winnerSide: "red" });
    expect(done.status).toBe(200);
    expect(done.body.match.memo).toBe("대기 메모");
    const excluded = await matchAction(g, done.body.match, "exclude");
    const res = await memo(g, started.id, "제외 메모", "대기 메모");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("STATE_CONFLICT");

    const second = (await start(g, rosterOf([...g.people.slice(2), ...g.people.slice(0, 2)]))).body.match;
    expect((await matchAction(g, second, "cancel")).status).toBe(200);
    expect((await memo(g, second.id, "취소 메모")).status).toBe(409);
    expect(excluded.status).toBe(200);
  });

  it("메모 수정은 변경 이력에 남지 않고, 다른 기기가 먼저 고친 메모는 덮어쓰지 않는다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    const revisions = (await snapshot(g)).revisions.length;
    expect((await memo(g, m.id, "첫 메모", null)).status).toBe(200);
    const stale = await memo(g, m.id, "늦은 메모", null);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect(stale.body.error.details.memo).toBe("첫 메모");
    const snap = await snapshot(g);
    expect(snap.matches[0]!.memo).toBe("첫 메모");
    expect(snap.revisions.length).toBe(revisions);
  });

  it("권한: 공동 운영자는 쓸 수 있고, 다른 계정·로그인 없음은 막힌다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    const co = await addCo(g);
    expect((await memo(g, m.id, "공동 운영자 메모", null, co)).status).toBe(200);
    expect((await memo(g, m.id, "남의 메모", "공동 운영자 메모", await login())).status).toBe(404);
    const anon = await api(null, "POST", `/api/groups/${g.gid}/matches/${m.id}/memo`, {
      requestId: requestId(),
      memo: "x",
      baseMemo: "공동 운영자 메모",
    });
    expect(anon.status).toBe(401);
    // 다른 모임의 경기 ID로는 찾지 못한다.
    const other = await setupGroup();
    expect((await memo(other, m.id, "x")).status).toBe(404);
    expect((await snapshot(g)).matches[0]!.memo).toBe("공동 운영자 메모");
  });

  it("백업 왕복: 같은 모임 복구·새 모임 가져오기에 메모가 남고, 메모 항목이 없는 예전 백업도 복원된다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people), "A", {}, { memo: "첫 줄\n둘째 줄" });
    const backup = await exportOf(g);
    expect(backup.matches[0].memo).toBe("첫 줄\n둘째 줄");
    expect(backup.formatVersion).toBe(4);

    expect((await memo(g, m.id, null, "첫 줄\n둘째 줄")).status).toBe(200);
    expect((await restoreSame(g, backup)).status).toBe(200);
    expect((await snapshot(g)).matches[0]!.memo).toBe("첫 줄\n둘째 줄");

    const newcomer = await login();
    const imported = await api(newcomer, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(imported.status).toBe(200);
    const copy = await api<Snapshot>(newcomer, "GET", `/api/groups/${imported.body.groupId}/snapshot`);
    expect(copy.body.matches[0]!.memo).toBe("첫 줄\n둘째 줄");

    // 예전 백업(메모·시리즈 항목 없음).
    const old = structuredClone(backup);
    for (const match of old.matches) delete match.memo;
    delete old.series;
    expect((await restoreSame(g, old)).status).toBe(200);
    expect("memo" in (await snapshot(g)).matches[0]!).toBe(false);

    // 한도를 넘는 메모가 든 파일은 검사에서 거절한다.
    const bad = structuredClone(backup);
    bad.matches[0].memo = "다".repeat(201);
    const rejected = await restoreSame(g, bad);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.problems.join(" ")).toContain("메모");
  });
});

/* ------------------------------------------------------------------ */
/* 시리즈                                                               */
/* ------------------------------------------------------------------ */

describe("시리즈로 이어가기(경기 시작)", () => {
  it("첫 이어가기는 시리즈를 새로 만들고, 다음 판은 같은 시리즈에 들어간다. 점수는 사람 기준이다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster, "A");
    // 2판: 진영을 바꿔(팀 A/B 맞바꿈) 같은 사람들끼리. 1판의 팀 A였던 사람들이 이번엔 팀 B로 이긴다.
    const m2 = await play(g, swapped(roster), "B", { series: { fromMatchId: m1.id, format: "bo3", name: "결승" } });
    let snap = await snapshot(g);
    expect(snap.series).toHaveLength(1);
    const series = snap.series![0]!;
    expect(series).toMatchObject({ name: "결승", format: "bo3", matchIds: [m1.id, m2.id] });
    let score = seriesScore(series, snap.matches);
    expect(score.wins).toEqual([2, 0]);
    expect(score.winner).toBe(0);
    expect(score.overflow).toBe(false);

    // 3판: 형식 승수를 채운 뒤에도 넣을 수 있다(막지 않고 화면에 경고). 형식·이름은 기존 시리즈 것을 쓴다.
    const m3 = await play(g, roster, "B", { series: { fromMatchId: m2.id, format: "free" } });
    snap = await snapshot(g);
    expect(snap.series).toHaveLength(1);
    expect(snap.series![0]!.format).toBe("bo3");
    expect(snap.series![0]!.matchIds).toEqual([m1.id, m2.id, m3.id]);
    score = seriesScore(snap.series![0]!, snap.matches);
    expect(score.wins).toEqual([2, 1]);
    expect(score.overflow).toBe(true);
    // 시리즈는 묶어서 보여 주는 것뿐: 경기 버전·이력은 다른 경기와 같다.
    expect(snap.matches.every((m) => m.state === "confirmed")).toBe(true);
  });

  it("팀 구성이 다르면 시작 자체를 거절하고 아무것도 저장하지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster);
    const before = fingerprint(await snapshot(g));
    const res = await start(g, mixed(roster), {
      ackRepeat: roster.map((r) => r.participantId),
      series: { fromMatchId: m1.id, format: "bo3" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SERIES_TEAMS_DIFFER");
    expect(res.body.error.message).toContain("5명 구성");
    expect(fingerprint(await snapshot(g))).toBe(before);
    expect((await snapshot(g)).series).toEqual([]);
    // 시리즈 없이 보내면 그대로 시작된다(예전 요청과 같다).
    expect((await start(g, mixed(roster), { ackRepeat: roster.map((r) => r.participantId) })).status).toBe(200);
  });

  it("다른 모임의 경기에서 이어갈 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const theirs = await play(other, rosterOf(other.people));
    const res = await start(g, rosterOf(g.people), { series: { fromMatchId: theirs.id, format: "bo3" } });
    expect(res.status).toBe(404);
    expect((await snapshot(g)).matches).toHaveLength(0);
  });
});

describe("시리즈 만들기·넣기·빼기", () => {
  it("확정 경기로 만들고, 진영이 바뀐 같은 구성은 넣을 수 있고 다른 구성은 이유와 함께 거절한다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster, "A");
    const m2 = await play(g, swapped(roster), "A");
    const other = await play(g, mixed(roster), "A");
    const created = await createSeries(g, [m1.id], { name: " 4강 ", format: "bo5" });
    expect(created.status).toBe(200);
    const series: SeriesView = created.body.series;
    expect(series).toMatchObject({ name: "4강", format: "bo5", matchIds: [m1.id] });

    const added = await seriesAction(g, series.id, "add", { matchId: m2.id });
    expect(added.status).toBe(200);
    expect(added.body.series.matchIds).toEqual([m1.id, m2.id]);
    const score = seriesScore(added.body.series, (await snapshot(g)).matches);
    // 1판은 팀 A(1판의 A쪽 사람들) 승, 2판은 팀 A(= 1판의 B쪽 사람들) 승.
    expect(score.wins).toEqual([1, 1]);

    const before = fingerprint(await snapshot(g));
    const rejected = await seriesAction(g, series.id, "add", { matchId: other.id });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error.code).toBe("SERIES_TEAMS_DIFFER");
    const createMixed = await createSeries(g, [m1.id, other.id]);
    expect(createMixed.status).toBe(409);
    expect(fingerprint(await snapshot(g))).toBe(before);
    expect((await snapshot(g)).series).toHaveLength(1);

    // 이미 다른 시리즈에 있는 경기, 확정이 아닌 경기는 넣을 수 없다.
    const again = await createSeries(g, [m2.id]);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_IN_SERIES");
    const pending = (await start(g, roster, { ackRepeat: roster.map((r) => r.participantId) })).body.match;
    const notConfirmed = await seriesAction(g, series.id, "add", { matchId: pending.id });
    expect(notConfirmed.status).toBe(409);
    expect(notConfirmed.body.error.code).toBe("STATE_CONFLICT");

    // 이름·형식 고치기.
    const updated = await seriesAction(g, series.id, "update", { name: "결승", format: "bo3" });
    expect(updated.status).toBe(200);
    expect(updated.body.series).toMatchObject({ name: "결승", format: "bo3" });

    // 빼기: 마지막 판을 빼면 시리즈도 사라진다. 경기 기록은 그대로다.
    const removed = await seriesAction(g, series.id, "remove", { matchId: m1.id });
    expect(removed.status).toBe(200);
    expect(removed.body.series.matchIds).toEqual([m2.id]);
    const last = await seriesAction(g, series.id, "remove", { matchId: m2.id });
    expect(last.status).toBe(200);
    expect(last.body.series).toBeNull();
    const snap = await snapshot(g);
    expect(snap.series).toEqual([]);
    expect(snap.matches.filter((m) => m.state === "confirmed")).toHaveLength(3);
    expect((await seriesAction(g, series.id, "add", { matchId: m1.id })).status).toBe(404);
  });

  it("전적 제외·미진행 취소된 판은 점수에서 빠지고, 복구하면 다시 센다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster, "A");
    const m2 = await play(g, roster, "B", { series: { fromMatchId: m1.id, format: "bo3" } });
    // 3판은 시작만 하고 미진행 취소.
    const m3 = (
      await start(g, roster, { ackRepeat: roster.map((r) => r.participantId), series: { fromMatchId: m2.id } })
    ).body.match;
    let snap = await snapshot(g);
    let score = seriesScore(snap.series![0]!, snap.matches);
    expect(score.games.map((x) => x.status)).toEqual(["counted", "counted", "pending"]);
    expect((await matchAction(g, m3, "cancel")).status).toBe(200);
    const excluded = await matchAction(g, (await snapshot(g)).matches.find((m) => m.id === m2.id)!, "exclude");
    expect(excluded.status).toBe(200);
    snap = await snapshot(g);
    score = seriesScore(snap.series![0]!, snap.matches);
    expect(score.wins).toEqual([1, 0]);
    expect(score.games.map((x) => x.status)).toEqual(["counted", "dropped", "dropped"]);
    expect((await matchAction(g, excluded.body.match, "restore")).status).toBe(200);
    snap = await snapshot(g);
    expect(seriesScore(snap.series![0]!, snap.matches).wins).toEqual([1, 1]);
  });

  it("다른 모임의 경기·시리즈는 찾지 못한다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    const mine = await play(g, rosterOf(g.people));
    const theirs = await play(other, rosterOf(other.people));
    expect((await createSeries(g, [theirs.id])).status).toBe(404);
    expect((await createSeries(g, [mine.id, theirs.id])).status).toBe(404);
    const theirSeries = (await createSeries(other, [theirs.id])).body.series as SeriesView;
    expect((await seriesAction(g, theirSeries.id, "add", { matchId: mine.id })).status).toBe(404);
    expect((await seriesAction(g, theirSeries.id, "remove", { matchId: theirs.id })).status).toBe(404);
    expect((await seriesAction(g, theirSeries.id, "update", { format: "free" })).status).toBe(404);
    expect((await snapshot(g)).series).toEqual([]);
    expect((await snapshot(other)).series![0]!.matchIds).toEqual([theirs.id]);
  });

  it("권한: 공동 운영자는 만들 수 있고, 다른 계정·로그인 없음은 막힌다. 조회 응답에는 시리즈가 보인다", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    expect((await createSeries(g, [m.id], {}, await login())).status).toBe(404);
    expect(
      (await api(null, "POST", `/api/groups/${g.gid}/series`, { requestId: requestId(), format: "bo3", matchIds: [m.id] }))
        .status,
    ).toBe(401);
    const co = await addCo(g);
    const created = await createSeries(g, [m.id], { name: "결승" }, co);
    expect(created.status).toBe(200);
    const view = await viewOf(g);
    expect(view.series).toEqual([{ ...created.body.series }]);
    // 같은 요청 ID로 다시 보내도 시리즈가 늘지 않는다.
    const rid = requestId();
    const g2 = await setupGroup();
    const m2 = await play(g2, rosterOf(g2.people));
    const body = { requestId: rid, format: "bo3", matchIds: [m2.id] };
    const first = await api(g2.cookie, "POST", `/api/groups/${g2.gid}/series`, body);
    const second = await api(g2.cookie, "POST", `/api/groups/${g2.gid}/series`, body);
    expect(second.body.series.id).toBe(first.body.series.id);
    expect((await snapshot(g2)).series).toHaveLength(1);
  });

  it("잘못된 입력은 거절한다(형식·이름 길이·빈 목록·같은 경기 두 번)", async () => {
    const g = await setupGroup();
    const m = await play(g, rosterOf(g.people));
    expect((await createSeries(g, [m.id], { format: "bo7" })).status).toBe(400);
    expect((await createSeries(g, [m.id], { name: "가".repeat(21) })).status).toBe(400);
    expect((await createSeries(g, [])).status).toBe(400);
    expect((await createSeries(g, [m.id, m.id])).status).toBe(400);
    expect((await snapshot(g)).series).toEqual([]);
  });
});

describe("시리즈와 백업·합치기·삭제", () => {
  it("백업 왕복: 같은 모임 복구와 새 모임 가져오기(ID를 새로 만듦) 모두 시리즈가 그대로다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster, "A");
    const m2 = await play(g, swapped(roster), "A", { series: { fromMatchId: m1.id, format: "bo5", name: "결승" } });
    const backup = await exportOf(g);
    expect(backup.series).toHaveLength(1);
    expect(backup.series[0]).toMatchObject({ name: "결승", format: "bo5", matchIds: [m1.id, m2.id] });

    const series = (await snapshot(g)).series![0]!;
    await seriesAction(g, series.id, "remove", { matchId: m2.id });
    expect((await restoreSame(g, backup)).status).toBe(200);
    const restored = await snapshot(g);
    expect(restored.series).toEqual([series]);

    const newcomer = await login();
    const imported = await api(newcomer, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(imported.status).toBe(200);
    const copy = (await api<Snapshot>(newcomer, "GET", `/api/groups/${imported.body.groupId}/snapshot`)).body;
    expect(copy.series).toHaveLength(1);
    const copied = copy.series![0]!;
    expect(copied.id).not.toBe(series.id);
    expect(copied).toMatchObject({ name: "결승", format: "bo5" });
    expect(copied.matchIds).toEqual(copy.matches.map((m) => m.id));
    expect(seriesScore(copied, copy.matches).wins).toEqual(seriesScore(series, restored.matches).wins);

    // 파일 안에서 한 경기가 두 시리즈에 있거나 없는 경기를 가리키면 거절한다.
    const bad = structuredClone(backup);
    bad.series.push({ id: "dup-series", name: null, format: "free", createdAt: backup.createdAt, matchIds: [m1.id] });
    const rejected = await restoreSame(g, bad);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.problems.join(" ")).toContain("두 시리즈");
  });

  it("합치기: 같은 사람의 두 이름이 섞인 판은 합친 뒤 같은 구성이 되어 넣을 수 있고, 판정이 깨지지 않는다", async () => {
    const g = await setupGroup();
    const dup = (await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["부캐"] })).body.participants[0];
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster, "A");
    // 2판: 1번 자리의 사람이 "부캐" 이름으로 들어왔다.
    const withDup = roster.map((r, i) => (i === 0 ? { ...r, participantId: dup.id } : r));
    const m2 = await play(g, withDup, "B");
    const series = (await createSeries(g, [m1.id])).body.series as SeriesView;
    expect((await seriesAction(g, series.id, "add", { matchId: m2.id })).status).toBe(409);

    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: dup.id,
      targetId: g.people[0]!.id,
    });
    expect(merged.status).toBe(200);
    const added = await seriesAction(g, series.id, "add", { matchId: m2.id });
    expect(added.status).toBe(200);
    const snap = await snapshot(g);
    const score = seriesScore(snap.series![0]!, snap.matches);
    expect(score.mismatched).toBe(0);
    expect(score.wins).toEqual([1, 1]);
    expect(score.teams[0]).toContain(g.people[0]!.id);
  });

  it("모임 삭제: 시리즈 표의 행도 모두 지운다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const m1 = await play(g, roster);
    await play(g, roster, "B", { series: { fromMatchId: m1.id } });
    const count = async (table: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?1`).bind(g.gid).first<{ n: number }>())!.n;
    expect(await count("match_series")).toBe(1);
    expect(await count("match_series_members")).toBe(2);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" });
    expect(res.status).toBe(200);
    expect(await count("match_series")).toBe(0);
    expect(await count("match_series_members")).toBe(0);
  });
});
