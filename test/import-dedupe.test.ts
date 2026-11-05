import { describe, expect, it } from "vitest";
import { FUTURE_TOLERANCE_MS, winnerSideOf } from "../src/shared/backfill";
import { parseDelimited } from "../src/shared/csv";
import { parseMatchTable, toImportMatches } from "../src/shared/importTable";
import { nameKey } from "../src/shared/names";
import {
  classifyImport,
  detectMapping,
  parseSheet,
  toSheetPayload,
  type ExistingImport,
  type SheetMapping,
} from "../src/shared/sheetTable";
import { zonedTimeToUtc } from "../src/shared/stats";
import { api, requestId, rosterOf, setupGroup, snapshot, unique, type TestGroup } from "./helpers";

/*
 * 붙여 넣기 일괄 입력과 시트 가져오기가 같은 지문을 쓰는지, 예전 경기(지문 없음)·지난 경기 한 건 입력과도
 * 중복을 잡는지, 아직 오지 않은 경기를 화면·서버 모두 막는지 확인한다.
 */

const HEADER = "날짜\tA탑\tA정글\tA미드\tA원딜\tA서폿\tB탑\tB정글\tB미드\tB원딜\tB서폿\t승리팀";
const team = (from: number) => Array.from({ length: 5 }, (_, i) => `참가자${from + i}`);
const row = (date: string, winner: string, a = 1, b = 6) => [date, ...team(a), ...team(b), winner].join("\t");
/** 같은 날 같은 명단·같은 결과가 두 번(같은 바탕 글의 두 번째 경기) 들어 있는 표. */
const TABLE = [
  HEADER,
  row("2026-10-01", "A"),
  row("2026-10-01", "B"),
  row("2026-10-01", "A"), // 첫 줄과 내용이 같다
  row("2026-10-02", "B", 3, 8),
].join("\n");
const SOURCE_KEY = "sheet:1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms:0";
const TODAY = { today: "2026-11-05" };

/** 날짜·시각 열이 따로 있고 라인 열이 없는 한 줄 한 경기 표의 열 맞춤. */
function wideMapping(withTime: boolean, lanesByOrder: boolean): SheetMapping {
  const columns: Record<string, number> = { date: 0 };
  const offset = withTime ? 2 : 1;
  if (withTime) columns.time = 1;
  for (let i = 0; i < 5; i++) {
    columns[`a${i}`] = offset + i;
    columns[`b${i}`] = offset + 5 + i;
  }
  columns.winner = offset + 10;
  return { layout: "wide", headerRow: 0, skip: [], columns, lanesByOrder, year: null };
}

/* ------------------------------------------------------------------ */

describe("붙여 넣기와 시트 가져오기의 지문", () => {
  it("같은 내용이면 지문과 경기 시각이 정확히 같다(시각 없는 날짜, 같은 날 같은 경기 두 번)", () => {
    const paste = parseMatchTable(TABLE);
    const rows = parseDelimited(TABLE);
    const mapping = detectMapping(rows);
    const sheet = parseSheet(rows, mapping, TODAY);
    expect(paste.errors).toEqual([]);
    expect(sheet.errors).toEqual([]);
    // 기존 임시 형식은 라인 열이 없어도 이름 칸 순서로 라인을 정한다(붙여 넣기와 같다).
    expect(mapping.lanesByOrder).toBe(true);
    expect(paste.rows.map((r) => r.fingerprint)).toEqual(sheet.matches.map((m) => m.fingerprint));
    // 같은 내용의 두 경기는 서로 다른 지문이다.
    expect(new Set(paste.rows.map((r) => r.fingerprint)).size).toBe(4);
    expect(paste.rows[0]!.fingerprint).toMatch(/^v1-[0-9a-f]{16}$/);

    // 시각 배정도 같다: 모임 시간대 정오, 같은 날은 표 순서대로 1초씩.
    for (const tz of ["Asia/Seoul", "America/Los_Angeles"]) {
      const a = toImportMatches(paste.rows, (n) => n, "unknown", tz);
      const b = toSheetPayload(sheet.matches, (n) => n, "unknown", tz);
      expect(a.map((m) => [m.playedAt, m.fingerprint])).toEqual(b.map((m) => [m.playedAt, m.fingerprint]));
    }
    expect(toImportMatches(paste.rows, (n) => n, "unknown").map((m) => m.playedAt).slice(0, 3)).toEqual([
      "2026-10-01T03:00:00.000Z",
      "2026-10-01T03:00:01.000Z",
      "2026-10-01T03:00:02.000Z",
    ]);
  });

  it("열 순서·이름 표기(대소문자·공백)가 달라도 같은 지문이고, 시각·라인·결과가 다르면 다른 지문이다", () => {
    const base = parseMatchTable(row("2026-10-01", "A")).rows[0]!.fingerprint;
    // 시트에서 팀 안 이름 순서를 바꾸면 라인이 바뀌므로 다른 경기다.
    const swapped = ["2026-10-01", "참가자2", "참가자1", ...team(3).slice(0, 3), ...team(6), "A"].join("\t");
    expect(parseMatchTable(swapped).rows[0]!.fingerprint).not.toBe(base);
    // 승리팀이 다르면 다른 경기다.
    expect(parseMatchTable(row("2026-10-01", "B")).rows[0]!.fingerprint).not.toBe(base);

    // 시각 열이 있는 시트는 시각까지 지문에 들어가므로 붙여 넣기(시각 없음)와 다르다.
    const timed = parseSheet([["2026-10-01", "20:30", ...team(1), ...team(6), "A"]], wideMapping(true, true), TODAY);
    expect(timed.matches[0]!.fingerprint).not.toBe(base);
    // 시각 칸이 비어 있으면 시각 없음으로 보아 같다.
    const blankTime = parseSheet([["2026-10-01", "", ...team(1), ...team(6), "A"]], wideMapping(true, true), TODAY);
    expect(blankTime.matches[0]!.fingerprint).toBe(base);
    // 라인을 정하지 않은 시트(라인 없음 "-")는 라인이 있는 붙여 넣기와 다르다.
    const noLanes = parseSheet([["2026-10-01", ...team(1), ...team(6), "A"]], wideMapping(false, false), TODAY);
    expect(noLanes.matches[0]!.teamA.every((p) => p.position === null)).toBe(true);
    expect(noLanes.matches[0]!.fingerprint).not.toBe(base);
  });
});

/* ------------------------------------------------------------------ */

describe("아직 오지 않은 경기(화면 검증)", () => {
  const TZ = "Asia/Seoul";
  const noonKst = (date: string) => Date.parse(zonedTimeToUtc(date, "12:00", TZ));

  it("붙여 넣기: 내일 날짜는 줄 번호와 함께 아직 오지 않은 날짜로 알린다", () => {
    const now = Date.parse("2026-11-05T11:00:00.000Z"); // 한국 20시
    const parsed = parseMatchTable(
      [HEADER, row("2026-11-04", "A"), row("2026-11-06", "B"), row("2026-11-05", "A")].join("\n"),
      { now, timeZone: TZ },
    );
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining("아직 오지 않은 날짜") }]);
    expect(parsed.errors[0]!.message).toContain("2026-11-06");
    // 검사 없이 읽어도 다른 줄의 지문은 같다(지문은 거르기 전에 매긴다).
    const all = parseMatchTable([HEADER, row("2026-11-04", "A"), row("2026-11-06", "B"), row("2026-11-05", "A")].join("\n"));
    expect(parsed.rows.map((r) => r.fingerprint)).toEqual([all.rows[0]!.fingerprint, all.rows[2]!.fingerprint]);
  });

  it("경계 시각: 오늘 날짜(시각 없음 = 정오)는 정오 - 허용 폭까지 받고 그보다 이르면 막는다", () => {
    const text = row("2026-11-05", "A");
    const at = (now: number) => parseMatchTable(text, { now, timeZone: TZ });
    const noon = noonKst("2026-11-05");
    expect(at(noon - FUTURE_TOLERANCE_MS).errors).toEqual([]);
    expect(at(noon - FUTURE_TOLERANCE_MS).rows).toHaveLength(1);
    const early = at(noon - FUTURE_TOLERANCE_MS - 1);
    expect(early.rows).toHaveLength(0);
    expect(early.errors[0]!.line).toBe(1);
    expect(early.errors[0]!.message).toContain("아직 오지 않은 시각");
    expect(early.names).toEqual([]);
  });

  it("시트: 시각이 있으면 그 시각으로, 같은 칸의 두 번째 경기는 1초 뒤로 본다", () => {
    const rows = [
      ["2026-11-05", "20:30", ...team(1), ...team(6), "A"],
      ["2026-11-05", "20:30", ...team(1), ...team(6), "B"],
    ];
    const t = Date.parse(zonedTimeToUtc("2026-11-05", "20:30", TZ));
    const at = (now: number) => parseSheet(rows, wideMapping(true, true), { ...TODAY, now, timeZone: TZ });
    expect(at(t - FUTURE_TOLERANCE_MS + 1000).errors).toEqual([]);
    const edge = at(t - FUTURE_TOLERANCE_MS);
    expect(edge.matches.map((m) => m.line)).toEqual([1]);
    expect(edge.errors).toEqual([{ line: 2, message: expect.stringContaining("아직 오지 않은 시각") }]);
    expect(at(t - FUTURE_TOLERANCE_MS - 1).errors.map((e) => e.line)).toEqual([1, 2]);
  });

  it("연도 없는 날짜: 추정은 오늘 이전으로 떨어지고, 고른 연도로 미래가 되면 알린다", () => {
    const now = Date.parse("2026-11-05T11:00:00.000Z");
    const rows = [["11/20", ...team(1), ...team(6), "A"]];
    const guessed = parseSheet(rows, wideMapping(false, true), { today: "2026-11-05", now, timeZone: TZ });
    expect(guessed.errors).toEqual([]);
    expect(guessed.matches[0]!.date).toBe("2025-11-20");
    // 오늘 날짜(연도 없음)도 올해로 본다.
    const todayRow = parseSheet([["11/5", ...team(1), ...team(6), "A"]], wideMapping(false, true), { today: "2026-11-05", now, timeZone: TZ });
    expect(todayRow.matches[0]!.date).toBe("2026-11-05");
    const chosen = parseSheet(rows, { ...wideMapping(false, true), year: 2026 }, { today: "2026-11-05", now, timeZone: TZ });
    expect(chosen.matches).toHaveLength(0);
    expect(chosen.errors[0]!.message).toContain("연도가 없어 2026년으로 본 2026-11-20는 아직 오지 않은 날짜");
    // 줄 순서가 뒤섞여 추정이 미래로 떨어지면(11/20 다음 11/3) 그 줄을 알린다.
    const shuffled = parseSheet(
      [["11/20", ...team(1), ...team(6), "A"], ["11/3", ...team(1), ...team(6), "B"]],
      wideMapping(false, true),
      { today: "2026-11-05", now, timeZone: TZ },
    );
    expect(shuffled.matches.map((m) => m.date)).toEqual(["2026-11-03"]);
    expect(shuffled.errors.map((e) => e.line)).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ */
/* 서버                                                                */
/* ------------------------------------------------------------------ */

async function existing(g: TestGroup): Promise<ExistingImport[]> {
  const res = await api(g.cookie, "GET", `/api/groups/${g.gid}/imports/fingerprints`);
  expect(res.status).toBe(200);
  return res.body.imports;
}

function idOfName(g: TestGroup): (name: string) => string {
  const ids = new Map(g.people.map((p) => [nameKey(p.name), p.id]));
  return (name) => ids.get(nameKey(name))!;
}

/** 붙여 넣기 화면이 하는 일: 읽기 → 이미 들어간 경기 빼기 → 넣기. legacy면 예전 화면처럼 지문 없이 보낸다. */
async function pasteImport(g: TestGroup, text: string, legacy = false) {
  const parsed = parseMatchTable(text, { now: Date.now(), timeZone: "Asia/Seoul" });
  expect(parsed.errors).toEqual([]);
  const result = classifyImport(parsed.rows, await existing(g), null);
  const payload = toImportMatches(result.fresh, idOfName(g), "unknown", "Asia/Seoul");
  const matches = legacy ? payload.map(({ fingerprint: _f, ...rest }) => rest) : payload;
  if (matches.length > 0) {
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      ...(legacy ? {} : { source: { kind: "paste" } }),
      matches,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { result, sent: matches.length };
}

/** 시트 가져오기 화면이 하는 일. */
async function sheetImport(g: TestGroup, rows: string[][], mapping?: SheetMapping) {
  const parsed = parseSheet(rows, mapping ?? detectMapping(rows), { ...TODAY, now: Date.now(), timeZone: "Asia/Seoul" });
  expect(parsed.errors).toEqual([]);
  const result = classifyImport(parsed.matches, await existing(g), SOURCE_KEY);
  const payload = toSheetPayload(result.fresh, idOfName(g), "unknown", "Asia/Seoul");
  if (payload.length > 0) {
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      source: { kind: "sheet", sourceKey: SOURCE_KEY },
      matches: payload,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { result, sent: payload.length };
}

const countImported = async (g: TestGroup) => (await snapshot(g)).matches.filter((m) => m.source === "import").length;

describe("붙여 넣기 ↔ 시트 가져오기 중복 (서버)", () => {
  it("붙여 넣기로 넣은 경기를 같은 내용의 시트로 가져오면 0건, 붙여 넣기를 다시 해도 0건", async () => {
    const g = await setupGroup(12);
    expect((await pasteImport(g, TABLE)).sent).toBe(4);
    const list = await existing(g);
    expect(list).toHaveLength(4);
    expect(list.every((e) => e.sourceKey === null && e.rowKey === null)).toBe(true);

    const sheet = await sheetImport(g, parseDelimited(TABLE));
    expect([sheet.result.already.length, sheet.result.fresh.length, sheet.sent]).toEqual([4, 0, 0]);
    const again = await pasteImport(g, TABLE);
    expect([again.result.already.length, again.sent]).toEqual([4, 0]);
    expect(await countImported(g)).toBe(4);
    // 묶음 출처는 붙여 넣기로 남는다.
    expect((await snapshot(g)).importBatches?.[0]).toMatchObject({ kind: "paste", count: 4 });
  });

  it("시트로 넣은 경기를 같은 내용으로 붙여 넣으면 0건이고, 그대로 보내도 서버가 거절한다", async () => {
    const g = await setupGroup(12);
    expect((await sheetImport(g, parseDelimited(TABLE))).sent).toBe(4);
    const paste = await pasteImport(g, `${TABLE}\n${row("2026-10-03", "A")}`);
    expect([paste.result.already.length, paste.sent]).toEqual([4, 1]);
    expect(await countImported(g)).toBe(5);

    // 화면 확인을 건너뛰고 보내도(다른 탭 등) 같은 지문이면 409.
    const parsed = parseMatchTable(TABLE);
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      source: { kind: "paste" },
      matches: toImportMatches(parsed.rows, idOfName(g), "unknown"),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_IMPORTED");
    expect(await countImported(g)).toBe(5);
  });

  it("지문 없이 들어간 예전 일괄 입력도 내용으로 계산해 건너뛴다(같은 날 같은 경기 두 번 포함)", async () => {
    const g = await setupGroup(12);
    expect((await pasteImport(g, TABLE, true)).sent).toBe(4);
    const list = await existing(g);
    // 저장된 지문은 없고, 계산한 지문 4개가 붙여 넣기 지문과 같다.
    expect(list.map((e) => e.fingerprint).sort()).toEqual(parseMatchTable(TABLE).rows.map((r) => r.fingerprint).sort());
    const sheet = await sheetImport(g, parseDelimited(TABLE));
    expect([sheet.result.already.length, sheet.sent]).toEqual([4, 0]);
    // 표에 같은 경기가 하나 더(세 번째) 있으면 그것만 새로 넣는다.
    const more = await pasteImport(g, `${TABLE}\n${row("2026-10-01", "A")}`);
    expect([more.result.already.length, more.sent]).toEqual([4, 1]);
    expect(await countImported(g)).toBe(5);

    // 전적 제외한 예전 경기는 이미 들어간 것으로 보지 않는다(시트와 같은 규칙).
    const batch = (await snapshot(g)).importBatches!.find((b) => b.count === 4)!;
    await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batch.id}`, { requestId: requestId(), exclude: true });
    const afterExclude = await sheetImport(g, parseDelimited(TABLE));
    expect([afterExclude.result.fresh.length, afterExclude.result.wasExcluded]).toEqual([4, 4]);
  });

  it("지난 경기 한 건 입력과도 같은 기준으로 견준다(시각 없는 시트는 날짜만, 시각 있는 시트는 시각까지)", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people).map((r) => ({ ...r, position: null }));
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, {
      requestId: requestId(),
      playedAt: zonedTimeToUtc("2026-10-01", "20:30", "Asia/Seoul"),
      roster,
      winnerTeam: "A",
      winnerSide: winnerSideOf("A", "unknown"),
    });
    expect(res.status).toBe(200);
    const line = (date: string, time: string | null, winner = "A") => [
      date,
      ...(time === null ? [] : [time]),
      ...team(1),
      ...team(6),
      winner,
    ];
    // 라인 없는 시트(포지션 없음)와 날짜만 같은 줄은 이미 들어간 경기다.
    const dateOnly = await sheetImport(g, [line("2026-10-01", null)], wideMapping(false, false));
    expect([dateOnly.result.already.length, dateOnly.sent]).toEqual([1, 0]);
    // 시각 열이 있는 시트는 시각까지 맞아야 같은 경기다.
    const sameTime = await sheetImport(g, [line("2026-10-01", "20:30")], wideMapping(true, false));
    expect(sameTime.sent).toBe(0);
    const otherTime = await sheetImport(g, [line("2026-10-01", "21:30")], wideMapping(true, false));
    expect(otherTime.sent).toBe(1);
    // 라인이 있는 붙여 넣기와는 내용(라인)이 달라 다른 경기다.
    expect((await pasteImport(g, row("2026-10-01", "A"))).sent).toBe(1);
  });
});

describe("아직 오지 않은 경기(서버)", () => {
  it("일괄 입력은 지금 + 허용 폭보다 뒤의 경기를 몇 번째인지와 함께 거절하고 아무것도 저장하지 않는다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    const match = (playedAt: string) => ({ playedAt, roster, winnerTeam: "A", winnerSide: "unknown" });
    const send = (matches: unknown[]) =>
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
        requestId: requestId(),
        batchId: unique("batch"),
        matches,
      });
    const future = new Date(Date.now() + FUTURE_TOLERANCE_MS + 60_000).toISOString();
    const rejected = await send([match("2026-10-01T03:00:00.000Z"), match(future)]);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("FUTURE_MATCH");
    expect(rejected.body.error.details.index).toBe(1);
    expect(rejected.body.error.message).toContain("아직 오지 않은");
    expect(await countImported(g)).toBe(0);

    // 시트 가져오기(지문 있음)도 같다.
    const sheetRes = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      source: { kind: "sheet", sourceKey: SOURCE_KEY },
      matches: [{ ...match(future), fingerprint: "v1-0123456789abcdef", rowKey: "2026-12-01#1" }],
    });
    expect(sheetRes.status).toBe(400);
    expect(sheetRes.body.error.code).toBe("FUTURE_MATCH");

    // 허용 폭 안(시계가 조금 빠른 기기)은 받는다.
    const soon = new Date(Date.now() + FUTURE_TOLERANCE_MS / 2).toISOString();
    expect((await send([match(soon)])).status).toBe(200);
    expect(await countImported(g)).toBe(1);
  });
});
