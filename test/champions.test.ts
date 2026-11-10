import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHAMPIONS, championName, championUsage, isChampionKey, searchChampions } from "../src/shared/champions";
import type { MatchView, ParticipantView, RosterEntry, Snapshot } from "../src/shared/types";
import {
  api,
  login,
  matchAction,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
  type TestGroup,
} from "./helpers";

// 챔피언 기록(migrations/0025): 검색(src/shared/champions.ts)과 저장(src/server/matches.ts saveChampions·confirmResult).

const names = (query: string, options?: Parameters<typeof searchChampions>[1]) =>
  searchChampions(query, options).map((o) => o.champion.name);

describe("챔피언 검색", () => {
  it("목록: 키가 겹치지 않고, 한글 이름 순이다", () => {
    expect(new Set(CHAMPIONS.map((c) => c.key)).size).toBe(CHAMPIONS.length);
    expect(new Set(CHAMPIONS.map((c) => c.name)).size).toBe(CHAMPIONS.length);
    const sorted = [...CHAMPIONS].sort((a, b) => a.name.localeCompare(b.name, "ko"));
    expect(CHAMPIONS.map((c) => c.key)).toEqual(sorted.map((c) => c.key));
    expect(isChampionKey("Ahri")).toBe(true);
    expect(isChampionKey("ahri")).toBe(false);
    expect(championName("MonkeyKing")).toBe("오공");
    expect(championName("Unknown")).toBe("Unknown");
  });

  it("초성으로 찾고, 앞부분 일치가 중간 일치보다 먼저 온다", () => {
    const found = names("ㅇㄹ");
    expect(found[0]).toBe("아리");
    expect(found).toEqual(expect.arrayContaining(["오로라", "요릭", "알리스타"]));
    // 피오라(ㅍㅇㄹ)는 중간 일치라 앞부분 일치(요릭 등) 뒤에 온다.
    expect(found.indexOf("피오라")).toBeGreaterThan(found.indexOf("요릭"));
    expect(names("미르")).toEqual(["블라디미르"]);
    const prefixFirst = names("리");
    expect(prefixFirst.slice(0, 3).sort()).toEqual(["리 신", "리븐", "리산드라"].sort());
    expect(prefixFirst.indexOf("아리")).toBeGreaterThan(2);
  });

  it("글자와 초성을 섞어 치거나, 입력 도중(받침에 걸린 글자)이어도 찾는다", () => {
    expect(names("아ㄹ")[0]).toBe("아리");
    // "아리"를 치는 도중 화면에는 "알"이 보인다.
    expect(names("알")).toContain("아리");
    expect(names("알")).toContain("알리스타");
  });

  it("영문 키(대소문자 무시)·띄어쓰기 무시·별칭으로 찾는다", () => {
    expect(names("ahri")[0]).toBe("아리");
    expect(names("LEESIN")).toEqual(["리 신"]);
    expect(names("리신")).toEqual(["리 신"]);
    expect(names("자르반4")).toEqual(["자르반 4세"]);
    expect(names("미포")).toEqual(["미스 포츈"]);
    expect(names("wukong")).toEqual(["오공"]);
    expect(names("트페")).toEqual(["트위스티드 페이트"]);
    expect(names("없는챔피언")).toEqual([]);
  });

  it("빈 검색어: 그 사람이 자주 쓴 순이 맨 앞, 다른 사람이 고른 챔피언은 맨 뒤(빼지는 않는다)", () => {
    const usage = new Map([
      ["Zed", 1],
      ["Yasuo", 3],
    ]);
    const list = searchChampions("", { usage, taken: new Set(["Ahri"]) });
    expect(list).toHaveLength(CHAMPIONS.length);
    expect(list.slice(0, 2).map((o) => o.champion.key)).toEqual(["Yasuo", "Zed"]);
    expect(list[0]!.used).toBe(3);
    expect(list[list.length - 1]!.champion.key).toBe("Ahri");
    expect(list[list.length - 1]!.taken).toBe(true);
    // 검색어가 있어도 고른 챔피언은 앞부분 일치라도 뒤로 간다.
    const searched = searchChampions("ㅇㄹ", { taken: new Set(["Ahri"]) });
    expect(searched[searched.length - 1]!.champion.key).toBe("Ahri");
  });

  it("자주 쓴 챔피언은 확정 경기만 센다", () => {
    const roster = (champion?: string) => [{ participantId: "p1", ...(champion ? { champion } : {}) }];
    const usage = championUsage(
      [
        { state: "confirmed", roster: roster("Ahri") },
        { state: "confirmed", roster: roster("Ahri") },
        { state: "excluded", roster: roster("Zed") },
        { state: "confirmed", roster: roster() },
      ],
      "p1",
    );
    expect([...usage]).toEqual([["Ahri", 2]]);
  });
});

/* ------------------------------------------------------------------ */
/* 서버                                                                 */
/* ------------------------------------------------------------------ */

async function confirmWith(g: TestGroup, roster: RosterEntry[], extra: Record<string, unknown> = {}): Promise<MatchView> {
  const started = await start(g, roster, { ackRepeat: roster.map((r) => r.participantId) });
  expect(started.status).toBe(200);
  const done = await matchAction(g, started.body.match, "result", { winnerTeam: "A", winnerSide: "blue", ...extra });
  expect(done.status).toBe(200);
  return done.body.match;
}

function saveChampions(
  g: TestGroup,
  match: { id: string; version: number },
  champions: unknown,
  options: { cookie?: string | null; rid?: string } = {},
) {
  return api(options.cookie === undefined ? g.cookie : options.cookie, "POST", `/api/groups/${g.gid}/matches/${match.id}/champions`, {
    requestId: options.rid ?? requestId(),
    baseMatchVersion: match.version,
    champions,
  });
}

const championMap = (m: MatchView) => Object.fromEntries(m.roster.filter((r) => r.champion).map((r) => [r.participantId, r.champion]));

async function viewOf(g: TestGroup): Promise<Snapshot> {
  const token = (await snapshot(g)).group.viewToken!;
  return (await api<Snapshot>(null, "GET", `/api/view/${token}`)).body;
}

describe("챔피언 기록: 결과 입력", () => {
  it("결과와 함께 일부만 골라도 저장되고, 운영자·조회 응답에 나간다. 보내지 않으면 명단 모양은 예전과 같다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const [a, b] = [roster[0]!.participantId, roster[7]!.participantId];
    const m = await confirmWith(g, roster, { champions: { [a]: "Ahri", [b]: "Ahri" } });
    // 같은 챔피언을 두 사람이 골라도 막지 않는다(화면이 흐리게 알려 주기만 한다).
    expect(championMap(m)).toEqual({ [a]: "Ahri", [b]: "Ahri" });
    expect(m.roster.filter((r) => "champion" in r)).toHaveLength(2);
    expect(championMap((await snapshot(g)).matches[0]!)).toEqual({ [a]: "Ahri", [b]: "Ahri" });
    expect(championMap((await viewOf(g)).matches[0]!)).toEqual({ [a]: "Ahri", [b]: "Ahri" });

    const plain = await confirmWith(g, roster);
    expect(plain.roster.every((r) => !("champion" in r))).toBe(true);
  });

  it("목록에 없는 키·명단 밖의 사람은 거절하고 결과도 저장하지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const started = (await start(g, roster)).body.match;
    const bad = await matchAction(g, started, "result", {
      winnerTeam: "A",
      winnerSide: "blue",
      champions: { [roster[0]!.participantId]: "NotAChampion" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_CHAMPION");
    const outsider = await matchAction(g, started, "result", {
      winnerTeam: "A",
      winnerSide: "blue",
      champions: { [g.people[11]!.id]: "Ahri" },
    });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error.code).toBe("INVALID_PARTICIPANT");
    expect((await snapshot(g)).matches[0]!.state).toBe("in_progress");
  });
});

describe("챔피언 기록: 경기 상세에서 고치기", () => {
  it("넣기·고치기·지우기. 보낸 값이 그 경기 챔피언 전체가 되고, 경기 버전이 오르며 이력에는 남지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const [a, b, c] = roster.map((r) => r.participantId);
    let m = await confirmWith(g, roster);
    const revisions = (await snapshot(g)).revisions.length;

    let res = await saveChampions(g, m, { [a!]: "Garen", [b!]: "LeeSin" });
    expect(res.status).toBe(200);
    expect(res.body.match.version).toBe(m.version + 1);
    m = res.body.match;
    expect(championMap(m)).toEqual({ [a!]: "Garen", [b!]: "LeeSin" });

    res = await saveChampions(g, m, { [b!]: "Viego", [c!]: "Ahri" });
    m = res.body.match;
    expect(championMap(m)).toEqual({ [b!]: "Viego", [c!]: "Ahri" });

    res = await saveChampions(g, m, {});
    m = res.body.match;
    expect(m.roster.every((r) => !("champion" in r))).toBe(true);
    const snap = await snapshot(g);
    expect(snap.revisions.length).toBe(revisions);
    // 승패는 그대로.
    expect(snap.matches[0]).toMatchObject({ state: "confirmed", winnerTeam: "A", teamASide: "blue" });
  });

  it("조회 링크의 ETag가 바뀐다(명단 표에는 data_version 트리거가 없어 경기 버전을 올린다)", async () => {
    const g = await setupGroup();
    const m = await confirmWith(g, rosterOf(g.people));
    const token = (await snapshot(g)).group.viewToken!;
    const first = await SELF.fetch(`https://example.test/api/view/${token}`);
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();
    expect((await saveChampions(g, m, { [m.roster[0]!.participantId]: "Ahri" })).status).toBe(200);
    const second = await SELF.fetch(`https://example.test/api/view/${token}`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(200);
    const body = (await second.json()) as Snapshot;
    expect(body.matches[0]!.roster.some((r) => r.champion === "Ahri")).toBe(true);
  });

  it("목록에 없는 키·명단 밖의 사람·잘못된 모양은 거절하고 아무것도 바꾸지 않는다", async () => {
    const g = await setupGroup();
    const m = await confirmWith(g, rosterOf(g.people));
    const pid = m.roster[0]!.participantId;
    const invalid = await saveChampions(g, m, { [pid]: "Teemo2" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_CHAMPION");
    expect((await saveChampions(g, m, { [pid]: null })).status).toBe(400);
    expect((await saveChampions(g, m, [["x", "Ahri"]])).status).toBe(400);
    const outsider = await saveChampions(g, m, { [g.people[10]!.id]: "Ahri" });
    expect(outsider.status).toBe(400);
    expect(outsider.body.error.code).toBe("INVALID_PARTICIPANT");
    expect((await snapshot(g)).matches[0]!.version).toBe(m.version);
  });

  it("확정 경기만 고칠 수 있다(진행 중·전적 제외는 거절)", async () => {
    const g = await setupGroup();
    const started = (await start(g, rosterOf(g.people))).body.match;
    const live = await saveChampions(g, started, { [started.roster[0]!.participantId]: "Ahri" });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe("STATE_CONFLICT");
    const done = (await matchAction(g, started, "result", { winnerTeam: "B", winnerSide: "red" })).body.match;
    const excluded = (await matchAction(g, done, "exclude")).body.match;
    expect((await saveChampions(g, excluded, {})).status).toBe(409);
  });

  it("오래된 경기 버전은 충돌로 거절한다(다른 기기에서 먼저 고친 값을 덮어쓰지 않는다)", async () => {
    const g = await setupGroup();
    const m = await confirmWith(g, rosterOf(g.people));
    const pid = m.roster[0]!.participantId;
    expect((await saveChampions(g, m, { [pid]: "Ahri" })).status).toBe(200);
    const stale = await saveChampions(g, m, { [pid]: "Zed" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("VERSION_CONFLICT");
    expect(championMap((await snapshot(g)).matches[0]!)).toEqual({ [pid]: "Ahri" });
  });

  it("같은 요청 ID 재시도는 한 번만 반영하고, 같은 ID로 다른 내용을 보내면 거절한다", async () => {
    const g = await setupGroup();
    const m = await confirmWith(g, rosterOf(g.people));
    const pid = m.roster[0]!.participantId;
    const rid = requestId();
    const first = await saveChampions(g, m, { [pid]: "Ahri" }, { rid });
    const again = await saveChampions(g, m, { [pid]: "Ahri" }, { rid });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.match.version).toBe(m.version + 1);
    const reused = await saveChampions(g, m, { [pid]: "Zed" }, { rid });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("REQUEST_ID_REUSED");
  });

  it("권한: 공동 운영자는 고칠 수 있고, 다른 계정·로그인 없음·다른 모임은 막힌다", async () => {
    const g = await setupGroup();
    let m = await confirmWith(g, rosterOf(g.people));
    const pid = m.roster[0]!.participantId;
    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const co = await login();
    expect((await api(co, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    const byCo = await saveChampions(g, m, { [pid]: "Ahri" }, { cookie: co });
    expect(byCo.status).toBe(200);
    m = byCo.body.match;
    expect((await saveChampions(g, m, { [pid]: "Zed" }, { cookie: await login() })).status).toBe(404);
    expect((await saveChampions(g, m, { [pid]: "Zed" }, { cookie: null })).status).toBe(401);
    const other = await setupGroup();
    expect((await saveChampions(other, m, { [pid]: "Zed" })).status).toBe(404);
    expect(championMap((await snapshot(g)).matches[0]!)).toEqual({ [pid]: "Ahri" });
  });
});

describe("챔피언 기록: 백업·합치기", () => {
  it("백업 → 같은 모임 복구·새 모임 가져오기에 남고, 챔피언 항목이 없는 예전 백업도 복원된다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    const pid = roster[3]!.participantId;
    await confirmWith(g, roster, { champions: { [pid]: "Thresh" } });
    const exported = await api(g.cookie, "GET", `/api/groups/${g.gid}/export`);
    const backup = exported.body;
    expect(backup.matches[0].roster.find((r: RosterEntry) => r.participantId === pid).champion).toBe("Thresh");

    const restoreSame = async (file: unknown) => {
      const snap = await snapshot(g);
      return api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
        requestId: requestId(),
        confirm: "복원",
        baseGeneration: snap.group.generation,
        backup: file,
      });
    };
    const m = (await snapshot(g)).matches[0]!;
    expect((await saveChampions(g, m, {})).status).toBe(200);
    expect((await restoreSame(backup)).status).toBe(200);
    expect(championMap((await snapshot(g)).matches[0]!)).toEqual({ [pid]: "Thresh" });

    const newcomer = await login();
    const imported = await api(newcomer, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(imported.status).toBe(200);
    const copy = await api<Snapshot>(newcomer, "GET", `/api/groups/${imported.body.groupId}/snapshot`);
    // 새 모임은 참가자 ID가 바뀌므로 이름으로 맞춘다.
    const copied = copy.body.matches[0]!.roster.find((r) => r.champion)!;
    const nameOfCopy = copy.body.participants.find((p) => p.id === copied.participantId)!.name;
    expect(nameOfCopy).toBe(g.people.find((p) => p.id === pid)!.name);
    expect(copied.champion).toBe("Thresh");

    const old = structuredClone(backup);
    for (const match of old.matches) for (const entry of match.roster) delete entry.champion;
    expect((await restoreSame(old)).status).toBe(200);
    expect((await snapshot(g)).matches[0]!.roster.every((r) => !("champion" in r))).toBe(true);

    const bad = structuredClone(backup);
    bad.matches[0].roster[0].champion = "<script>";
    const rejected = await restoreSame(bad);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.problems.join(" ")).toContain("챔피언");
  });

  it("사람 합치기와 되돌리기에서 명단 행이 옮겨져도 챔피언이 따라간다", async () => {
    const g = await setupGroup(12);
    const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1 부캐"] });
    const dup = added.body.participants[0] as ParticipantView;
    const p = g.people;
    const roster = rosterOf([p[1]!, p[2]!, p[3]!, p[4]!, dup, p[5]!, p[6]!, p[7]!, p[8]!, p[9]!]);
    const m = await confirmWith(g, roster, { champions: { [dup.id]: "Nami", [p[1]!.id]: "Darius" } });

    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: dup.id,
      targetId: p[0]!.id,
    });
    expect(merged.status).toBe(200);
    let after = (await snapshot(g)).matches.find((x) => x.id === m.id)!;
    expect(championMap(after)).toEqual({ [p[0]!.id]: "Nami", [p[1]!.id]: "Darius" });

    const undone = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges/${merged.body.mergeId}/undo`, {
      requestId: requestId(),
    });
    expect(undone.status).toBe(200);
    after = (await snapshot(g)).matches.find((x) => x.id === m.id)!;
    expect(championMap(after)).toEqual({ [dup.id]: "Nami", [p[1]!.id]: "Darius" });
  });
});
