import { describe, expect, it } from "vitest";
import { parseMatchTable, toImportMatches } from "../src/shared/importTable";
import { nameKey } from "../src/shared/names";
import { personRecords, placements, sideTotals } from "../src/shared/stats";
import { api, fingerprint, requestId, rosterOf, setupGroup, snapshot, start } from "./helpers";

const HEADER = "날짜\tA탑\tA정글\tA미드\tA원딜\tA서폿\tB탑\tB정글\tB미드\tB원딜\tB서폿\t승리팀";
const names = (prefix: string, from: number) =>
  Array.from({ length: 5 }, (_, i) => `${prefix}${from + i}`).join("\t");
const row = (date: string, winner: string) =>
  `${date}\t${names("참가자", 1)}\t${names("참가자", 6)}\t${winner}`;

describe("표 읽기", () => {
  it("제목 줄을 건너뛰고 경기를 읽는다", () => {
    const parsed = parseMatchTable([HEADER, row("2026-10-01", "A"), "", row("2026.10.2", "b팀")].join("\n"));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ line: 2, date: "2026-10-01", winner: "A" });
    expect(parsed.rows[0]!.teamA).toEqual(["참가자1", "참가자2", "참가자3", "참가자4", "참가자5"]);
    expect(parsed.rows[1]).toMatchObject({ line: 4, date: "2026-10-02", winner: "B" });
    expect(parsed.names).toHaveLength(10);
  });

  it("쉼표로 나눈 표도 읽는다", () => {
    const parsed = parseMatchTable(row("2026-10-01", "A").replaceAll("\t", ","));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
  });

  it("틀린 줄은 줄 번호와 이유를 알려준다", () => {
    const text = [
      HEADER,
      row("2026-10-01", "A"),
      row("2026-02-31", "A"), // 없는 날짜
      row("2026-10-03", "무승부"), // 승리팀 읽을 수 없음
      `2026-10-04\t${names("참가자", 1)}\t${names("참가자", 6)}`, // 열 부족
      `2026-10-05\t${names("참가자", 1)}\t${names("참가자", 2)}\tA`, // 같은 사람이 두 번
      `2026-10-06\t참가자1\t\t참가자3\t참가자4\t참가자5\t${names("참가자", 6)}\tB`, // 빈 칸
    ].join("\n");
    const parsed = parseMatchTable(text);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(parsed.errors[0]!.message).toContain("날짜");
    expect(parsed.errors[1]!.message).toContain("승리팀");
    expect(parsed.errors[2]!.message).toContain("열이 11개");
    expect(parsed.errors[3]!.message).toContain("두 번");
    expect(parsed.errors[4]!.message).toContain("A정글 칸이 비어");
  });

  it("진영을 고른 대로 넣는다", () => {
    const parsed = parseMatchTable([row("2026-10-01", "A"), row("2026-10-01", "B")].join("\n"));
    const unknown = toImportMatches(parsed.rows, (n) => n, "unknown");
    expect(unknown.map((m) => m.winnerSide)).toEqual(["unknown", "unknown"]);
    // 팀 A=블루로 넣으면 A가 이긴 경기는 승리 진영이 블루, B가 이긴 경기는 레드다.
    const aBlue = toImportMatches(parsed.rows, (n) => n, "a-blue");
    expect(aBlue.map((m) => m.winnerSide)).toEqual(["blue", "red"]);
    expect(aBlue[0]!.roster[0]).toEqual({ participantId: "참가자1", team: "A", position: "top" });
    expect(aBlue[0]!.roster[9]).toEqual({ participantId: "참가자10", team: "B", position: "support" });
    // 같은 날의 경기는 표의 순서가 유지된다.
    expect(aBlue[0]!.playedAt < aBlue[1]!.playedAt).toBe(true);
    // 한국 시간 정오는 UTC 03시다.
    expect(aBlue[0]!.playedAt).toBe("2026-10-01T03:00:00.000Z");
  });
});

describe("지난 기록 한꺼번에 넣기 (서버)", () => {
  async function payloadFor(
    g: Awaited<ReturnType<typeof setupGroup>>,
    lines: string[],
    mode: "unknown" | "a-blue",
  ) {
    const parsed = parseMatchTable(lines.join("\n"));
    const idOf = new Map(g.people.map((p) => [nameKey(p.name), p.id]));
    return toImportMatches(parsed.rows, (name) => idOf.get(nameKey(name))!, mode);
  }

  it("확정 경기로 들어가고 현재 경기·순환·진행 상태를 건드리지 않는다", async () => {
    const g = await setupGroup();
    await start(g, rosterOf(g.people));
    const before = await snapshot(g);
    const matches = await payloadFor(
      g,
      [row("2026-09-01", "A"), row("2026-09-01", "B"), row("2026-09-02", "A")],
      "unknown",
    );
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches,
    });
    expect(res.status).toBe(200);
    expect(res.body.matchIds).toHaveLength(3);
    const after = await snapshot(g);
    const imported = after.matches.filter((m) => m.source === "import");
    expect(imported).toHaveLength(3);
    expect(imported.every((m) => m.state === "confirmed" && m.sessionId === null)).toBe(true);
    expect(imported.every((m) => m.teamASide === "unknown")).toBe(true);
    expect(imported.map((m) => m.matchNo).sort()).toEqual([2, 3, 4]);
    expect(after.group.liveVersion).toBe(before.group.liveVersion);
    expect(after.rotation).toEqual(before.rotation);
    expect(after.matches.filter((m) => m.state === "in_progress")).toHaveLength(1);
    // 진영 미상이어도 개인 승패와 배치 판수에는 들어간다.
    expect(personRecords(after.matches).get(g.people[0]!.id)).toMatchObject({ games: 3, wins: 2 });
    expect(placements(after.matches).get(g.people[0]!.id)).toEqual({ games: 3, done: false });
    expect(sideTotals(after.matches)).toMatchObject({ known: 0, unknown: 3 });
  });

  it("팀 A=블루로 넣으면 진영 통계에 들어간다", async () => {
    const g = await setupGroup();
    const matches = await payloadFor(
      g,
      [row("2026-09-01", "A"), row("2026-09-02", "B"), row("2026-09-03", "A")],
      "a-blue",
    );
    await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches,
    });
    const snap = await snapshot(g);
    expect(snap.matches.every((m) => m.teamASide === "blue")).toBe(true);
    expect(sideTotals(snap.matches)).toEqual({ known: 3, blueWins: 2, redWins: 1, unknown: 0 });
  });

  it("한 경기라도 틀리면 아무것도 저장하지 않고 몇 번째인지 알려준다", async () => {
    const g = await setupGroup();
    const matches = await payloadFor(g, [row("2026-09-01", "A"), row("2026-09-02", "B")], "unknown");
    matches[1]!.roster[0] = { ...matches[1]!.roster[0]!, participantId: "없는-참가자" };
    const before = fingerprint(await snapshot(g));
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PARTICIPANT");
    expect(res.body.error.details.index).toBe(1);
    expect(fingerprint(await snapshot(g))).toBe(before);
  });

  it("같은 요청 ID로 다시 보내도 경기가 두 번 들어가지 않는다", async () => {
    const g = await setupGroup();
    const body = {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches: await payloadFor(g, [row("2026-09-01", "A"), row("2026-09-02", "B")], "unknown"),
    };
    const first = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, body);
    const second = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, body);
    expect(second.status).toBe(200);
    expect(second.body.matchIds).toEqual(first.body.matchIds);
    expect((await snapshot(g)).matches).toHaveLength(2);
  });

  it("한 번에 50경기를 넣을 수 있고 51경기는 거절한다", async () => {
    const g = await setupGroup();
    const lines = Array.from({ length: 51 }, (_, i) =>
      row(`2026-08-${String(1 + (i % 28)).padStart(2, "0")}`, i % 2 === 0 ? "A" : "B"),
    );
    const all = await payloadFor(g, lines, "unknown");
    const tooMany = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches: all,
    });
    expect(tooMany.status).toBe(400);
    const fifty = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches: all.slice(0, 50),
    });
    expect(fifty.status).toBe(200);
    const snap = await snapshot(g);
    expect(snap.matches).toHaveLength(50);
    expect(new Set(snap.matches.map((m) => m.matchNo)).size).toBe(50);
    expect(snap.matches.every((m) => m.roster.length === 10)).toBe(true);
  });

  it("운영자가 아니면 넣을 수 없다", async () => {
    const g = await setupGroup();
    const other = await setupGroup(1);
    const matches = await payloadFor(g, [row("2026-09-01", "A")], "unknown");
    const res = await api(other.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: "batch-test-0001",
      matches,
    });
    expect(res.status).toBe(404);
    expect((await snapshot(g)).matches).toHaveLength(0);
  });
});
