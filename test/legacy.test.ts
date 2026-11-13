import { describe, expect, it } from "vitest";
import { parseDelimited } from "../src/shared/csv";
import {
  convertLegacy,
  legacyPayloadProblem,
  legacyRowKey,
  legacySkippedText,
  legacySummary,
  parseLegacyUrl,
  yearEarlier,
  type LegacyMatch,
} from "../src/shared/legacy";
import {
  acrossDate,
  crowdedDays,
  detectMapping,
  isAcrossLayout,
  parseSheet,
  toSheetPayload,
  type SheetMapping,
} from "../src/shared/sheetTable";
import { findTab, parseTabList } from "../src/shared/sheetUrl";

// 기존 사이트(v1) 기록 가져오기: v1 형식 검증, v2 경기로 바꾸기(라인·진영·날짜·지문·순서), 가로로 긴 표 읽기.
// 이름은 모두 합성 이름이다.

const NAMES = Array.from({ length: 12 }, (_, i) => `옛선수${String(i + 1).padStart(2, "0")}`);
const ID = "AKfycbTestDeploymentIdForUnitTests0000000000000";
const kstNoon = (date: string) => Date.parse(`${date}T12:00:00+09:00`);

/** n번째 경기: 12명 중 10명, 블루(위 5명) 라인 0~4, 홀수 경기는 블루 승. */
function v1Match(no: number, date: string, extra: Partial<LegacyMatch> = {}): LegacyMatch {
  const ten = Array.from({ length: 10 }, (_, k) => NAMES[(no + k) % 12]!);
  return {
    id: `m-${no}`,
    time: kstNoon(date),
    blue: ten.slice(0, 5).map((name, lane) => ({ name, lane })),
    red: ten.slice(5).map((name, lane) => ({ name, lane })),
    winner: no % 2 === 1 ? "blue" : "red",
    sidesKnown: true,
    ...extra,
  };
}

function payload(matches: unknown[], extra: Record<string, unknown> = {}) {
  return { matches, resetAt: null, schemaVersion: 2, auditLog: [], featureOptions: { elite: ["옛선수01"] }, ...extra };
}

describe("기존 사이트 주소", () => {
  it("Apps Script /exec 주소에서 배포 ID만 뽑는다", () => {
    expect(parseLegacyUrl(`https://script.google.com/macros/s/${ID}/exec`)).toEqual({ ok: true, deploymentId: ID });
    expect(parseLegacyUrl(`  script.google.com/macros/s/${ID}/exec?x=1#y `)).toEqual({ ok: true, deploymentId: ID });
    expect(parseLegacyUrl(`https://script.google.com/a/macros/example.com/s/${ID}/exec`)).toEqual({ ok: true, deploymentId: ID });
  });

  it("다른 호스트·http·/dev·짧은 ID·시트 주소는 받지 않는다", () => {
    for (const url of [
      `http://script.google.com/macros/s/${ID}/exec`,
      `https://script.google.com.evil.example/macros/s/${ID}/exec`,
      `https://script.googleusercontent.com/macros/s/${ID}/exec`,
      `https://script.google.com/macros/s/${ID}/dev`,
      `https://script.google.com/macros/s/short/exec`,
      `https://script.google.com:8443/macros/s/${ID}/exec`,
      `https://user@script.google.com/macros/s/${ID}/exec`,
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    ]) {
      expect(parseLegacyUrl(url).ok, url).toBe(false);
    }
    expect(parseLegacyUrl("")).toEqual({ ok: false, problem: "empty" });
  });
});

describe("v1 형식 검증(rules.js validPayload)", () => {
  const good = () => payload([v1Match(1, "2026-10-01"), v1Match(2, "2026-10-01")]);

  it("정상 형식은 통과하고, 가져오지 않는 값은 한 줄로 알린다", () => {
    const p = good();
    expect(legacyPayloadProblem(p)).toBeNull();
    const withTrash = { ...p, trash: [v1Match(9, "2026-09-01")], cycleUsed: { a: [0] } };
    expect(legacyPayloadProblem(withTrash)).toBeNull();
    const summary = legacySummary(withTrash);
    expect(summary).toMatchObject({ matches: 2, trash: 1, elite: 1, auditLog: 0, progress: true });
    expect(legacySkippedText(summary)).toBe(
      "경기 기록만 가져와요. 가져오지 않는 것: 휴지통의 1경기, 상위권 이름 1개, 진행 상태(순환·서포터 차례).",
    );
  });

  it("lane null(포지션 없음)은 경기에서 받는다", () => {
    const m = v1Match(1, "2026-10-01");
    m.blue[2]!.lane = null;
    m.red[0]!.lane = null;
    expect(legacyPayloadProblem(payload([m]))).toBeNull();
  });

  it("깨진 형식은 어디가 틀렸는지 알려 주고 통과시키지 않는다", () => {
    const broken: [string, unknown][] = [
      ["경기 목록 없음", { resetAt: null }],
      ["resetAt 없음", { matches: [] }],
      ["형식 버전 3", payload([], { schemaVersion: 3 })],
      ["4명", payload([{ ...v1Match(1, "2026-10-01"), blue: v1Match(1, "2026-10-01").blue.slice(0, 4) }])],
      ["라인 5", payload([{ ...v1Match(1, "2026-10-01"), red: v1Match(1, "2026-10-01").red.map((p, i) => ({ ...p, lane: i === 0 ? 5 : p.lane })) }])],
      ["같은 팀 같은 라인", payload([{ ...v1Match(1, "2026-10-01"), blue: v1Match(1, "2026-10-01").blue.map((p) => ({ ...p, lane: 0 })) }])],
      ["한 경기에 같은 이름(대소문자)", payload([{ ...v1Match(1, "2026-10-01"), red: v1Match(1, "2026-10-01").red.map((p, i) => (i === 0 ? { ...p, name: " 옛선수02 " } : p)) }])],
      ["이름 41자", payload([{ ...v1Match(1, "2026-10-01"), red: v1Match(1, "2026-10-01").red.map((p, i) => (i === 0 ? { ...p, name: "가".repeat(41) } : p)) }])],
      ["이긴 쪽 없음", payload([{ ...v1Match(1, "2026-10-01"), winner: "A" }])],
      ["시각 없음", payload([{ ...v1Match(1, "2026-10-01"), time: "2026-10-01" }])],
      ["id 겹침", payload([v1Match(1, "2026-10-01"), v1Match(1, "2026-10-02")])],
      ["휴지통 형식", payload([], { trash: [{ id: "x" }] })],
      ["변경 기록 형식", payload([], { auditLog: [{ time: 1, kind: "add", before: 0 }] })],
      ["상위권 이름 겹침", payload([], { featureOptions: { elite: ["a", "A"] } })],
      ["진행 중 팀에 포지션 없음", payload([], { cyclePending: { blue: v1Match(1, "x").blue.map((p) => ({ ...p, lane: null })), red: v1Match(1, "x").red } })],
    ];
    for (const [label, value] of broken) expect(legacyPayloadProblem(value), label).not.toBeNull();
    expect(legacyPayloadProblem(payload([v1Match(1, "2026-10-01"), v1Match(1, "2026-10-02")]))).toContain("2번째 경기");
  });
});

describe("v2 경기로 바꾸기", () => {
  const now = Date.parse("2026-11-05T05:00:00Z"); // 한국 시간 14:00
  const opts = { timeZone: "Asia/Seoul", now, futureMode: null, from: null } as const;

  it("라인 0~4 → 탑·정글·미드·원딜·서폿, null → 포지션 없음, blue = 팀 A, 진영은 고르기에 따라", () => {
    const m = v1Match(1, "2026-10-01");
    m.red[4]!.lane = null;
    const second = v1Match(2, "2026-10-01", { sidesKnown: false });
    const conv = convertLegacy([m, second], opts);
    expect(conv.errors).toEqual([]);
    const [a, b] = conv.matches;
    expect(a!.teamA.map((p) => p.position)).toEqual(["top", "jungle", "mid", "adc", "support"]);
    expect(a!.teamB.map((p) => p.position)).toEqual(["top", "jungle", "mid", "adc", null]);
    expect(a!.teamA.map((p) => p.name)).toEqual(m.blue.map((p) => p.name));
    expect([a!.winner, b!.winner]).toEqual(["A", "B"]);
    expect([a!.sideA, b!.sideA]).toEqual(["blue", null]);
    expect(a!.rowKey).toBe(legacyRowKey("m-1"));
    expect(a!.rowKey).toMatch(/^v1id:[0-9a-f]{16}$/);
    // "그대로": 블루 승이면 블루, v1에서 진영을 모르던 경기는 미상. "미상": 모두 미상.
    const asIs = toSheetPayload(conv.matches, (n) => n, "column", "Asia/Seoul");
    expect(asIs.map((p) => p.winnerSide)).toEqual(["blue", "unknown"]);
    expect(toSheetPayload(conv.matches, (n) => n, "unknown", "Asia/Seoul").map((p) => p.winnerSide)).toEqual(["unknown", "unknown"]);
  });

  it("한국 시간 정오(표로 넣은 경기)는 날짜만 쓰고, 같은 날은 v1 순서대로 정오 + 1초씩", () => {
    // 같은 날 세 경기. v1 배열 순서를 지킨다(시각이 같아도).
    const ms = [v1Match(1, "2026-10-02"), v1Match(2, "2026-10-01"), v1Match(3, "2026-10-02"), v1Match(4, "2026-10-02")];
    const conv = convertLegacy(ms, opts);
    expect(conv.matches.map((m) => m.id)).toEqual(["m-2", "m-1", "m-3", "m-4"]);
    expect(conv.matches.map((m) => [m.date, m.time, m.orderInDay])).toEqual([
      ["2026-10-01", null, 1],
      ["2026-10-02", null, 1],
      ["2026-10-02", null, 2],
      ["2026-10-02", null, 3],
    ]);
    const sent = toSheetPayload(conv.matches, (n) => n, "unknown", "Asia/Seoul");
    expect(sent.map((p) => p.playedAt)).toEqual([
      "2026-10-01T03:00:00.000Z",
      "2026-10-02T03:00:00.000Z",
      "2026-10-02T03:00:01.000Z",
      "2026-10-02T03:00:02.000Z",
    ]);
  });

  it("정오가 아닌 시각(v1에서 바로 기록한 경기)은 모임 시간대의 날짜·시각으로 읽는다", () => {
    const m = v1Match(1, "2026-10-01", { time: Date.parse("2026-10-01T13:30:00Z") }); // 한국 22:30
    expect(convertLegacy([m], opts).matches[0]).toMatchObject({ date: "2026-10-01", time: "22:30" });
    expect(convertLegacy([m], { ...opts, timeZone: "UTC" }).matches[0]).toMatchObject({ date: "2026-10-01", time: "13:30" });
  });

  it("지문은 시트·붙여 넣기와 같은 함수: 같은 경기를 가로로 긴 표로 읽어도 같은 지문이다", () => {
    const ms = [v1Match(1, "2026-10-01"), v1Match(2, "2026-10-01"), v1Match(1 + 12, "2026-10-01", { id: "m-13" })];
    // 세 번째는 첫 경기와 명단·결과가 같은 같은 날의 두 번째 판(같은 내용이어도 지문이 달라야 한다).
    const conv = convertLegacy(ms, opts);
    expect(new Set(conv.matches.map((m) => m.fingerprint)).size).toBe(3);
    const rows = acrossGrid([{ date: "10월 1일", matches: ms }]);
    const sheet = parseSheet(parseDelimited(rows, "\t"), { ...detectMapping(parseDelimited(rows, "\t")), year: 2026 }, { today: "2026-11-05" });
    expect(sheet.errors).toEqual([]);
    expect(sheet.matches.map((m) => m.fingerprint)).toEqual(conv.matches.map((m) => m.fingerprint));
  });

  it("아직 오지 않은 경기: 고르기 전에는 넣을 수 없고, 옮기면 한 해 앞으로, 빼면 그만큼 빠진다", () => {
    const ms = [
      v1Match(1, "2026-11-01"),
      v1Match(2, "2026-11-05"), // 오늘 정오: 이미 지났다
      v1Match(3, "2026-11-11"),
      v1Match(4, "2026-12-25"),
      v1Match(5, "2026-12-26"),
    ];
    const undecided = convertLegacy(ms, opts);
    expect(undecided.needsChoice).toBe(true);
    expect(undecided.future).toEqual({ count: 3, first: "2026-11-11", last: "2026-12-26" });

    const shift = convertLegacy(ms, { ...opts, futureMode: "shift" });
    expect(shift.needsChoice).toBe(false);
    expect(shift.errors).toEqual([]);
    expect(shift.matches.map((m) => [m.id, m.date, m.shifted])).toEqual([
      ["m-3", "2025-11-11", true],
      ["m-4", "2025-12-25", true],
      ["m-5", "2025-12-26", true],
      ["m-1", "2026-11-01", false],
      ["m-2", "2026-11-05", false],
    ]);
    expect(shift.shiftedRange).toEqual({ first: "2025-11-11", last: "2025-12-26" });
    const drop = convertLegacy(ms, { ...opts, futureMode: "drop" });
    expect([drop.matches.length, drop.dropped]).toEqual([2, 3]);

    // 기준 날짜를 앞당기면 그날부터의 경기도 옮긴다.
    const earlier = convertLegacy(ms, { ...opts, futureMode: "shift", from: "2026-11-01" });
    expect(earlier.affected).toEqual({ count: 5, first: "2026-11-01", last: "2026-12-26" });
    expect(earlier.matches.every((m) => m.shifted)).toBe(true);

    // 같은 선택이면 지문이 같다(다시 가져오기 0건의 바탕). 옮긴 경기의 지문은 옮긴 날짜 기준이다.
    const again = convertLegacy(ms, { ...opts, futureMode: "shift", from: "2026-11-11" });
    expect(again.matches.map((m) => m.fingerprint)).toEqual(shift.matches.map((m) => m.fingerprint));
    const direct = convertLegacy([v1Match(3, "2025-11-11")], opts);
    expect(direct.matches[0]!.fingerprint).toBe(shift.matches[0]!.fingerprint);
  });

  it("옮긴 뒤에도 미래거나 없는 날짜(2월 29일)가 되면 틀린 경기로 알린다", () => {
    const ms = [v1Match(1, "2028-02-29"), v1Match(2, "2027-12-01"), v1Match(3, "2026-10-01")];
    const conv = convertLegacy(ms, { ...opts, futureMode: "shift" });
    expect(conv.matches.map((m) => m.id)).toEqual(["m-3"]);
    expect(conv.errors.map((e) => e.line)).toEqual([1, 2]);
    expect(conv.errors[0]!.message).toContain("2월 29일");
    expect(conv.errors[1]!.message).toContain("아직 오지 않은");
    expect(yearEarlier("2026-03-01")).toBe("2025-03-01");
    expect(yearEarlier("2028-02-29")).toBeNull();
  });

  it("v2 이름 규칙(20자)을 넘거나 띄어쓰기만 다른 같은 이름이면 그 경기만 틀린 경기다", () => {
    const long = v1Match(1, "2026-10-01");
    long.blue[0]!.name = "가".repeat(21);
    const spaced = v1Match(2, "2026-10-01");
    spaced.blue[0]!.name = "옛 선수";
    spaced.red[0]!.name = "옛  선수";
    const conv = convertLegacy([long, spaced, v1Match(3, "2026-10-01")], opts);
    expect(conv.matches.map((m) => m.id)).toEqual(["m-3"]);
    expect(conv.errors).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* 가로로 긴 표(v1 parseSheet)                                           */
/* ------------------------------------------------------------------ */

/** v1 "RAW DATA기입" 모양: A열 팀 표시, B열 라인, 그 뒤로 경기마다 이름·승패 두 열. 날짜는 묶음 첫 칸에만. */
function acrossGrid(days: { date: string; matches: LegacyMatch[] }[], extraRows: string[][] = []): string {
  const total = days.reduce((n, d) => n + d.matches.length, 0);
  const width = 2 + total * 2;
  const rows: string[][] = Array.from({ length: 12 }, () => Array<string>(width).fill(""));
  rows[0]![0] = "raw data";
  const laneLabel = ["Top", "Jungle", "Mid", "AD", "Suport"];
  for (let k = 0; k < 10; k++) {
    rows[k + 2]![0] = k === 0 ? "1 team" : k === 5 ? "2 team" : "";
    rows[k + 2]![1] = laneLabel[k % 5]!;
  }
  let col = 2;
  for (const day of days) {
    rows[1]![col] = day.date;
    for (const m of day.matches) {
      const ten = [...m.blue, ...m.red];
      ten.forEach((p, k) => {
        rows[k + 2]![col] = p.name;
        rows[k + 2]![col + 1] = (k < 5) === (m.winner === "blue") ? "승" : "패";
      });
      col += 2;
    }
  }
  return [...rows, ...extraRows].map((r) => r.join("\t")).join("\n");
}

const acrossMappingOf = (text: string, year: number | null = 2026): SheetMapping => ({
  ...detectMapping(parseDelimited(text, "\t")),
  year,
});

describe("가로로 긴 표(기존 사이트 RAW DATA 모양)", () => {
  it("자동으로 알아보고, 경기마다 위 5명 = 팀 A, 줄 순서 = 라인, 날짜는 왼쪽 날짜를 이어받는다(v1 parseSheet와 같은 결과)", () => {
    const days = [
      { date: "10월 1일", matches: [v1Match(1, "x"), v1Match(2, "x")] },
      { date: "10/3", matches: [v1Match(3, "x")] },
    ];
    const text = acrossGrid(days);
    const rows = parseDelimited(text, "\t");
    expect(isAcrossLayout(rows)).toBe(true);
    const mapping = acrossMappingOf(text);
    expect(mapping).toMatchObject({ layout: "across", lanesByOrder: true });
    const parsed = parseSheet(rows, mapping, { today: "2026-11-05" });
    expect(parsed.errors).toEqual([]);
    // v1 parseSheet 결과(같은 입력, 연도 2026, 라인 순서): 열 순서대로, 위 5명 블루(팀 A), 블루 승이면 A.
    expect(parsed.matches.map((m) => [m.date, m.where, m.winner])).toEqual([
      ["2026-10-01", "C~D열 3행", "A"],
      ["2026-10-01", "E~F열 3행", "B"],
      ["2026-10-03", "G~H열 3행", "A"],
    ]);
    expect(parsed.matches[0]!.teamA).toEqual(days[0]!.matches[0]!.blue.map((p, i) => ({ name: p.name, position: ["top", "jungle", "mid", "adc", "support"][i] })));
    expect(parsed.matches[0]!.lines).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("한 열에 날짜 줄과 10명을 아래로 이어 붙인 경우, 날짜가 결과 칸에 있는 경우도 읽는다", () => {
    // v1 안내: "아래에 다음 날짜와 10명을 이어 붙이면 된다".
    const a = v1Match(1, "x");
    const b = v1Match(2, "x");
    const ten = (m: LegacyMatch) => [...m.blue, ...m.red].map((p, k) => [p.name, (k < 5) === (m.winner === "blue") ? "승" : "패"]);
    const text = [["10월 1일", ""], ...ten(a), ["", "10월 2일"], ...ten(b), [".", "."]].map((r) => r.join("\t")).join("\n");
    const parsed = parseSheet(parseDelimited(text, "\t"), { ...acrossMappingOf(text), layout: "across", lanesByOrder: false }, { today: "2026-11-05" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches.map((m) => [m.date, m.teamA[0]!.position])).toEqual([
      ["2026-10-01", null],
      ["2026-10-02", null],
    ]);
  });

  it("틀린 묶음(9명, 한 팀 안의 승패가 다름, 날짜 없음, 읽을 수 없는 칸)은 위치와 함께 알리고 나머지는 읽는다", () => {
    const good = v1Match(1, "x");
    const ten = (m: LegacyMatch) => [...m.blue, ...m.red].map((p, k) => [p.name, (k < 5) === (m.winner === "blue") ? "승" : "패"]);
    const nine = ten(v1Match(2, "x")).slice(0, 9);
    const mixed = ten(v1Match(3, "x"));
    mixed[1]![1] = "패";
    const unreadable = ten(v1Match(4, "x"));
    unreadable[3]![1] = "무";
    const text = [
      ["", ""],
      ...ten(v1Match(5, "x")), // 날짜 없음
      ["10월 1일", ""],
      ...ten(good),
      ["", ""],
      ...nine,
      ["", ""],
      ...mixed,
      ["", ""],
      ...unreadable,
    ]
      .map((r) => r.join("\t"))
      .join("\n");
    const parsed = parseSheet(parseDelimited(text, "\t"), { ...acrossMappingOf(text), layout: "across", lanesByOrder: true }, { today: "2026-11-05" });
    expect(parsed.matches).toHaveLength(1);
    const messages = parsed.errors.map((e) => `${e.where}: ${e.message}`);
    expect(messages.some((m) => m.startsWith("A~B열 2행") && m.includes("날짜가 없어요"))).toBe(true);
    expect(messages.some((m) => m.includes("9명이에요"))).toBe(true);
    expect(messages.some((m) => m.includes("같은 결과여야"))).toBe(true);
    expect(messages.some((m) => m.includes("승패를 읽지 못했어요"))).toBe(true);
  });

  it("연도: '25년 12월 28일'처럼 적힌 연도를 기준으로 줄 순서대로 해를 넘긴다(v1은 한 연도를 모두 붙였다)", () => {
    const text = acrossGrid([
      { date: "12월 22일", matches: [v1Match(1, "x")] },
      { date: "25년 12월 28일", matches: [v1Match(2, "x")] },
      { date: "1월 11일", matches: [v1Match(3, "x")] },
    ]);
    const parsed = parseSheet(parseDelimited(text, "\t"), acrossMappingOf(text, null), { today: "2026-11-05" });
    expect(parsed.matches.map((m) => m.date)).toEqual(["2025-12-22", "2025-12-28", "2026-01-11"]);
    expect(acrossDate("9월30일")).toEqual({ year: null, month: 9, day: 30, time: null });
    expect(acrossDate("2026-02-30")).toBe("invalid");
    expect(acrossDate("가람")).toBeNull();
  });

  it("날짜 칸이 빈 경기들이 왼쪽 날짜를 이어받아 하루에 몰리면 crowdedDays가 그 날짜와 첫 경기의 열·행을 알린다", () => {
    // 날짜는 22경기 묶음의 첫 칸에만 있고, 나머지 21경기는 날짜 칸이 비어 10/1을 이어받는다(의도된 동작). 10/3은 평범한 날.
    const text = acrossGrid([
      { date: "10월 1일", matches: Array.from({ length: 22 }, (_, i) => v1Match(i + 1, "x")) },
      { date: "10/3", matches: [v1Match(30, "x")] },
    ]);
    const parsed = parseSheet(parseDelimited(text, "\t"), acrossMappingOf(text), { today: "2026-11-05" });
    expect(parsed.errors).toEqual([]);
    expect(crowdedDays(parsed.matches)).toEqual([
      { date: "2026-10-01", count: 22, first: expect.objectContaining({ where: "C~D열 3행" }) },
    ]);
    expect(crowdedDays(parsed.matches)[0]!.first.where).toMatch(/^[A-Z]+~[A-Z]+열 \d+행$/);
  });

  it("다른 표 모양(한 줄에 선수 한 명)과 승패가 섞인 요약 표는 가로로 긴 표로 보지 않는다", () => {
    const player = ["경기,날짜,팀,닉네임,라인,승패"];
    for (let i = 0; i < 20; i++) player.push(`1,10/1,${i < 5 ? "A" : "B"},이름${i},TOP,${i < 5 ? "승" : "패"}`);
    expect(isAcrossLayout(parseDelimited(player.join("\n")))).toBe(false);
    // 사람마다 한 줄, 날짜마다 승/패 칸이 두 열 간격으로 있는 요약 표(실제 시트의 첫 탭 모양): 10명 묶음이 아니다.
    const summary = ["이름,,1/1,,1/2,,1/3"];
    for (let i = 0; i < 12; i++) summary.push(`이름${i},,x${i},${i % 3 ? "승" : "패"},y${i},${i % 2 ? "승" : "패"},z${i},${i % 4 ? "승" : ""}`);
    expect(isAcrossLayout(parseDelimited(summary.join("\n")))).toBe(false);
  });
});

describe("탭 이름으로 읽기", () => {
  it("공개 시트 보기 페이지에서 탭 이름과 gid를 뽑고, 이름이 정확히 같은 탭만 고른다", () => {
    const html =
      'var x; items.push({name: "26\\ub144", pageUrl: "https:\\/\\/docs.google.com\\/x?headers\\x3dtrue&gid=111", gid: "111",initialSheet: ("111" == gid)});' +
      'items.push({name: "RAW DATA\\uae30\\uc785", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=0", gid: "0",initialSheet: ("0" == gid)});' +
      '{name: "26\\ub144", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=111", gid: "111",initialSheet: ("111" == gid)}';
    const tabs = parseTabList(html);
    expect(tabs).toEqual([
      { name: "26년", gid: "111" },
      { name: "RAW DATA기입", gid: "0" },
    ]);
    expect(findTab(tabs, " raw data기입 ")).toEqual({ name: "RAW DATA기입", gid: "0" });
    expect(findTab(tabs, "RAW DATA")).toBeNull();
    expect(parseTabList("<html>로그인</html>")).toEqual([]);
  });
});
