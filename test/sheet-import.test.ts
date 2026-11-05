import { describe, expect, it } from "vitest";
import { parseDelimited } from "../src/shared/csv";
import { linkNames, looseKey, similarWithinTable } from "../src/shared/importLink";
import { parseMatchTable } from "../src/shared/importTable";
import {
  classifyImport,
  detectMapping,
  parseDateCell,
  parseLane,
  parseResult,
  parseSheet,
  parseTeamLabel,
  parseTime,
  toSheetPayload,
  type ExistingImport,
  type SheetMapping,
} from "../src/shared/sheetTable";
import { exportUrlOf, isAllowedRedirectHost, parseSheetUrl, sourceKeyOf } from "../src/shared/sheetUrl";

const TODAY = { today: "2026-11-05" };
const DOC = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

/* ------------------------------------------------------------------ */

describe("CSV·TSV 읽기", () => {
  it("따옴표, 칸 안의 쉼표·줄바꿈, 두 번 쓴 따옴표를 읽는다", () => {
    const rows = parseDelimited('a,"b,1","줄\n바꿈","말한 ""따옴표"""\r\nx,y,z,w\r\n');
    expect(rows).toEqual([
      ["a", "b,1", "줄\n바꿈", '말한 "따옴표"'],
      ["x", "y", "z", "w"],
    ]);
  });

  it("BOM을 버리고 CRLF·CR·LF를 모두 줄 끝으로 본다", () => {
    expect(parseDelimited("﻿날짜,이름\r\n1,2\r3,4\n5,6")).toEqual([
      ["날짜", "이름"],
      ["1", "2"],
      ["3", "4"],
      ["5", "6"],
    ]);
  });

  it("빈 줄도 한 줄로 세서 시트의 행 번호와 맞춘다(끝의 줄바꿈은 세지 않음)", () => {
    const rows = parseDelimited("a,b\n\n,\nc,d\n");
    expect(rows).toHaveLength(4);
    expect(rows[1]).toEqual([""]);
    expect(rows[2]).toEqual(["", ""]);
  });

  it("탭으로 나눈 붙여넣기(TSV)는 탭으로 나눈다. 쉼표는 칸의 일부다", () => {
    expect(parseDelimited("이름\t메모\n홍길동\t탑, 정글")).toEqual([
      ["이름", "메모"],
      ["홍길동", "탑, 정글"],
    ]);
  });

  it("빈 따옴표 칸과 닫히지 않은 따옴표도 멈추지 않고 읽는다", () => {
    expect(parseDelimited('a,"",b')).toEqual([["a", "", "b"]]);
    expect(parseDelimited('a,"끝나지 않음')).toEqual([["a", "끝나지 않음"]]);
  });
});

/* ------------------------------------------------------------------ */

describe("시트 주소 읽기", () => {
  it("편집 주소에서 문서 ID와 gid(해시·쿼리)를 뽑는다", () => {
    const cases: [string, string | null][] = [
      [`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`, "0"],
      [`https://docs.google.com/spreadsheets/d/${DOC}/edit?gid=1234567#gid=1234567`, "1234567"],
      [`https://docs.google.com/spreadsheets/d/${DOC}/edit?usp=sharing`, null],
      [`https://docs.google.com/spreadsheets/u/1/d/${DOC}/htmlview`, null],
      [`docs.google.com/spreadsheets/d/${DOC}`, null],
      [`  https://docs.google.com/spreadsheets/d/${DOC}/edit?gid=5#gid=7  `, "7"],
    ];
    for (const [url, gid] of cases) {
      const parsed = parseSheetUrl(url);
      expect(parsed, url).toEqual({ ok: true, ref: { kind: "doc", docId: DOC, gid } });
    }
  });

  it("웹에 게시한 주소를 읽는다", () => {
    const pub = "2PACX-1vRB4E_6RnpLP1wWMjqcwsUvotNATB8Np3OntlXb7066ULcAHI9oqqRhucltFifPTYNd7DRNRE56oTdt";
    const parsed = parseSheetUrl(`https://docs.google.com/spreadsheets/d/e/${pub}/pubhtml?gid=42&single=true`);
    expect(parsed).toEqual({ ok: true, ref: { kind: "pub", pubId: pub, gid: "42" } });
    if (parsed.ok) {
      expect(exportUrlOf(parsed.ref)).toBe(
        `https://docs.google.com/spreadsheets/d/e/${pub}/pub?gid=42&single=true&output=csv`,
      );
      expect(sourceKeyOf(parsed.ref)).toBe(`pub:${pub}:42`);
    }
  });

  it("서버가 요청할 주소는 검증한 ID로 직접 조립한다", () => {
    const parsed = parseSheetUrl(`https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=99`);
    expect(parsed.ok && exportUrlOf(parsed.ref)).toBe(
      `https://docs.google.com/spreadsheets/d/${DOC}/export?format=csv&gid=99`,
    );
    expect(() => exportUrlOf({ kind: "doc", docId: "../../evil", gid: null })).toThrow();
  });

  it("구글 시트가 아니거나 악의적인 주소는 거절한다", () => {
    const bad: [string, string][] = [
      ["", "empty"],
      ["http://docs.google.com/spreadsheets/d/" + DOC, "not-google-sheet"],
      ["https://docs.google.com.evil.com/spreadsheets/d/" + DOC, "not-google-sheet"],
      ["https://evil.com/docs.google.com/spreadsheets/d/" + DOC, "not-google-sheet"],
      ["https://user:pw@docs.google.com/spreadsheets/d/" + DOC, "not-google-sheet"],
      ["https://docs.google.com:8443/spreadsheets/d/" + DOC, "not-google-sheet"],
      ["https://docs.google.com/document/d/" + DOC, "not-google-sheet"],
      ["https://docs.google.com/spreadsheets/d/abc/edit", "bad-id"],
      ["https://docs.google.com/spreadsheets/d/" + DOC + "%2F..%2F/edit", "bad-id"],
      ["https://docs.google.com/spreadsheets/d/" + DOC + "/edit#gid=1;drop", "bad-gid"],
      ["https://docs.google.com/spreadsheets/d/" + DOC + "/edit?gid=-1", "bad-gid"],
      ["javascript:alert(1)", "not-google-sheet"],
      ["file:///etc/passwd", "not-google-sheet"],
      ["https://docs.google.com/spreadsheets/d/ " + DOC, "not-url"],
      ["https://169.254.169.254/spreadsheets/d/" + DOC, "not-google-sheet"],
    ];
    for (const [url, problem] of bad) expect(parseSheetUrl(url), url).toEqual({ ok: false, problem });
  });

  it("리디렉션은 구글 도메인만 허용한다", () => {
    expect(isAllowedRedirectHost("doc-08-4o-sheets.googleusercontent.com")).toBe(true);
    expect(isAllowedRedirectHost("docs.google.com")).toBe(true);
    expect(isAllowedRedirectHost("evilgoogle.com")).toBe(false);
    expect(isAllowedRedirectHost("google.com.evil.com")).toBe(false);
    expect(isAllowedRedirectHost("googleusercontent.com.evil.net")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("값 읽기", () => {
  it("라인의 흔한 표기", () => {
    const cases: [string, string][] = [
      ["TOP", "top"], ["탑", "top"], ["JG", "jungle"], ["JUG", "jungle"], ["정글", "jungle"],
      ["MID", "mid"], ["미드", "mid"], ["ADC", "adc"], ["BOT", "adc"], ["원딜", "adc"], ["바텀", "adc"],
      ["SUP", "support"], ["서폿", "support"], ["서포터", "support"], ["Support", "support"], ["ＳＵＰ", "support"],
    ];
    for (const [cell, lane] of cases) expect(parseLane(cell), cell).toBe(lane);
    expect(parseLane("원거리 딜러")).toBe("adc");
    expect(parseLane("포지션")).toBeNull();
  });

  it("승패와 이긴 팀 표기", () => {
    for (const w of ["승", "승리", "W", "WIN", "o", "O", "1", "○"]) expect(parseResult(w), w).toBe(true);
    for (const l of ["패", "패배", "L", "LOSE", "x", "X", "0"]) expect(parseResult(l), l).toBe(false);
    expect(parseResult("무")).toBeNull();
    for (const a of ["A", "a팀", "팀A", "1팀", "블루", "BLUE", "A승", "블루팀 승리"]) expect(parseTeamLabel(a), a).toBe("A");
    for (const b of ["B", "B팀", "2팀", "레드", "red", "Red Team"]) expect(parseTeamLabel(b), b).toBe("B");
    expect(parseTeamLabel("무승부")).toBeNull();
  });

  it("날짜 여러 형식", () => {
    const cases: [string, number | null, number, number, string | null][] = [
      ["2026-11-05", 2026, 11, 5, null],
      ["2026.11.5", 2026, 11, 5, null],
      ["2026. 11. 5", 2026, 11, 5, null],
      ["2026. 11. 5.", 2026, 11, 5, null],
      ["2026/11/05", 2026, 11, 5, null],
      ["2026년 11월 5일", 2026, 11, 5, null],
      ["11/5/2026", 2026, 11, 5, null],
      ["26.11.05", 2026, 11, 5, null],
      ["11/5", null, 11, 5, null],
      ["11.5", null, 11, 5, null],
      ["11월 5일", null, 11, 5, null],
      ["11/5(목)", null, 11, 5, null],
      ["2026. 11. 5 오후 8:30:00", 2026, 11, 5, "20:30"],
      ["2026-11-05 20:30", 2026, 11, 5, "20:30"],
      ["2026-11-05T09:05", 2026, 11, 5, "09:05"],
    ];
    for (const [cell, year, month, day, time] of cases) {
      expect(parseDateCell(cell), cell).toEqual({ year, month, day, time });
    }
    for (const bad of ["", "어제", "13/40", "2026-13-01", "2026-11-05 25:00"]) expect(parseDateCell(bad), bad).toBeNull();
  });

  it("시각 여러 형식", () => {
    expect(parseTime("20:30")).toBe("20:30");
    expect(parseTime("오후 8:30")).toBe("20:30");
    expect(parseTime("8:30 PM")).toBe("20:30");
    expect(parseTime("오전 12:10")).toBe("00:10");
    expect(parseTime("20시 30분")).toBe("20:30");
    expect(parseTime("21시")).toBe("21:00");
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("오후 13:00")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

const A = ["가람", "나래", "다온", "라온", "마루"];
const B = ["바다", "사랑", "아라", "자람", "차오"];
const LANES = ["TOP", "JG", "MID", "ADC", "SUP"];

function csv(rows: string[][]): string[][] {
  return parseDelimited(rows.map((r) => r.join(",")).join("\n"));
}

describe("세 가지 표 모양", () => {
  it("(a) 한 줄 = 한 경기: 머리글과 열을 자동으로 맞추고 열 순서로 라인을 정한다", () => {
    const rows = csv([
      ["날짜", "블루 탑", "블루 정글", "블루 미드", "블루 원딜", "블루 서폿", "레드 탑", "레드 정글", "레드 미드", "레드 원딜", "레드 서폿", "승리"],
      ["2026-10-01", ...A, ...B, "블루"],
      ["2026-10-01", ...B, ...A, "레드"],
    ]);
    const mapping = detectMapping(rows);
    expect(mapping.layout).toBe("wide");
    expect(mapping.headerRow).toBe(1);
    expect(mapping.columns.date).toBe(0);
    expect(mapping.columns.a0).toBe(1);
    expect(mapping.columns.b4).toBe(10);
    expect(mapping.columns.winner).toBe(11);
    const parsed = parseSheet(rows, mapping, TODAY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0]!.teamA.map((p) => p.position)).toEqual(["top", "jungle", "mid", "adc", "support"]);
    expect(parsed.matches[0]!.winner).toBe("A");
    expect(parsed.matches[1]!.winner).toBe("B");
    expect(parsed.matches[1]!.orderInDay).toBe(2);
  });

  it("(a) 머리글의 라인 순서가 섞여 있어도 머리글 라인으로 맞춘다", () => {
    const rows = csv([
      ["날짜", "A서폿", "A탑", "A정글", "A미드", "A원딜", "B탑", "B정글", "B미드", "B원딜", "B서폿", "승리팀"],
      ["2026-10-01", "마루", "가람", "나래", "다온", "라온", ...B, "A"],
    ]);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.errors).toEqual([]);
    const sup = parsed.matches[0]!.teamA.find((p) => p.position === "support");
    expect(sup?.name).toBe("마루");
  });

  it("(a) 이름 옆에 라인 열이 있는 표", () => {
    const header = ["날짜", ...A.flatMap((_, i) => [`A${i + 1}`, `A${i + 1} 라인`]), ...B.flatMap((_, i) => [`B${i + 1}`, `B${i + 1} 라인`]), "결과"];
    const lanesA = ["SUP", "TOP", "JG", "MID", "ADC"];
    const row = ["2026-10-02", ...A.flatMap((n, i) => [n, lanesA[i]!]), ...B.flatMap((n, i) => [n, LANES[i]!]), "패"];
    const rows = csv([header, row]);
    const mapping = detectMapping(rows);
    expect(mapping.layout).toBe("wide");
    expect(mapping.columns.aLane0).toBe(2);
    expect(mapping.columns.result).toBe(21);
    const parsed = parseSheet(rows, mapping, TODAY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches[0]!.teamA[0]).toEqual({ name: "가람", position: "support" });
    // 결과 열은 팀 A의 승패다. 패 → B 승.
    expect(parsed.matches[0]!.winner).toBe("B");
  });

  it("(b) 한 경기 = 두 줄: 위 줄이 팀 A, 병합된 날짜 칸(아래 줄이 빈 칸)은 위 값을 이어 쓴다", () => {
    const rows = csv([
      ["날짜", "탑", "정글", "미드", "원딜", "서폿", "결과"],
      ["2026-10-03", ...A, "승"],
      ["", ...B, "패"],
      ["2026-10-04", ...B, "패"],
      ["", ...A, "승"],
    ]);
    const mapping = detectMapping(rows);
    expect(mapping.layout).toBe("pair");
    const parsed = parseSheet(rows, mapping, TODAY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0]!.teamA.map((p) => p.name)).toEqual(A);
    expect(parsed.matches[0]!.winner).toBe("A");
    expect(parsed.matches[1]!.teamA.map((p) => p.name)).toEqual(B);
    expect(parsed.matches[1]!.winner).toBe("B");
    expect(parsed.matches[1]!.lines).toEqual([4, 5]);
  });

  it("(b) 팀 열이 있으면 그 값으로 팀을 정한다", () => {
    const rows = csv([
      ["날짜", "팀", "탑", "정글", "미드", "원딜", "서폿", "승패"],
      ["2026-10-03", "레드", ...B, "L"],
      ["2026-10-03", "블루", ...A, "W"],
    ]);
    const mapping = detectMapping(rows);
    expect(mapping.columns.team).toBe(1);
    const parsed = parseSheet(rows, mapping, TODAY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches[0]!.teamA.map((p) => p.name)).toEqual(A);
    expect(parsed.matches[0]!.winner).toBe("A");
  });

  it("(c) 한 줄 = 선수 한 명: 경기 번호로 묶고 팀·라인·승패 열을 읽는다", () => {
    const lines: string[][] = [["경기", "날짜", "팀", "닉네임", "라인", "승패"]];
    const add = (no: string, date: string, winA: boolean) => {
      A.forEach((n, i) => lines.push([no, date, "A", n, LANES[i]!, winA ? "승" : "패"]));
      B.forEach((n, i) => lines.push([no, date, "B", n, LANES[4 - i]!, winA ? "패" : "승"]));
    };
    add("1", "2026-10-05", true);
    add("2", "2026-10-05", false);
    const rows = csv(lines);
    const mapping = detectMapping(rows);
    expect(mapping.layout).toBe("player");
    expect(mapping.columns).toMatchObject({ match: 0, date: 1, team: 2, name: 3, lane: 4, result: 5 });
    const parsed = parseSheet(rows, mapping, TODAY);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0]!.winner).toBe("A");
    expect(parsed.matches[1]!.winner).toBe("B");
    expect(parsed.matches[0]!.teamB.find((p) => p.name === "바다")?.position).toBe("support");
  });

  it("기존 임시 형식(날짜, A 5명, B 5명, 승리팀)은 자동으로 맞춰지고 parseMatchTable과 같은 결과를 낸다", () => {
    const text = [
      "날짜\tA탑\tA정글\tA미드\tA원딜\tA서폿\tB탑\tB정글\tB미드\tB원딜\tB서폿\t승리팀",
      ["2026-10-01", ...A, ...B, "A"].join("\t"),
      ["2026.10.2", ...B, ...A, "b팀"].join("\t"),
    ].join("\n");
    const rows = parseDelimited(text);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    const legacy = parseMatchTable(text);
    expect(parsed.errors).toEqual([]);
    expect(parsed.matches.map((m) => [m.line, m.date, m.winner, m.teamA.map((p) => p.name)])).toEqual(
      legacy.rows.map((r) => [r.line, r.date, r.winner, r.teamA]),
    );
  });
});

describe("틀린 줄", () => {
  it("줄 번호와 이유를 알려주고 나머지 줄은 읽는다", () => {
    const rows = csv([
      ["날짜", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리"],
      ["2026-10-01", ...A, ...B, "A"],
      ["어제", ...A, ...B, "A"],
      ["2026-10-02", ...A, ...B, "무"],
      ["2026-10-03", ...A, ...A, "B"],
      ["2026-10-04", "가람", "", "다온", "라온", "마루", ...B, "B"],
      ["2026-02-30", ...A, ...B, "A"],
    ]);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7]);
    expect(parsed.errors[0]!.message).toContain("날짜 '어제'");
    expect(parsed.errors[1]!.message).toContain("이긴 팀 '무'");
    expect(parsed.errors[2]!.message).toContain("두 번");
    expect(parsed.errors[3]!.message).toContain("비어 있어요");
    expect(parsed.errors[4]!.message).toContain("없는 날짜");
  });

  it("라인 중복·못 읽는 라인·인원 수", () => {
    const lines: string[][] = [["경기", "날짜", "팀", "이름", "라인", "승패"]];
    A.forEach((n, i) => lines.push(["1", "2026-10-05", "A", n, i === 1 ? "TOP" : LANES[i]!, "승"]));
    B.forEach((n, i) => lines.push(["1", "2026-10-05", "B", n, LANES[i]!, "패"]));
    A.forEach((n, i) => lines.push(["2", "2026-10-05", "A", n, i === 0 ? "로밍" : LANES[i]!, "승"]));
    B.forEach((n, i) => lines.push(["2", "2026-10-05", "B", n, LANES[i]!, "패"]));
    A.slice(0, 4).forEach((n, i) => lines.push(["3", "2026-10-05", "A", n, LANES[i]!, "승"]));
    B.forEach((n, i) => lines.push(["3", "2026-10-05", "B", n, LANES[i]!, "패"]));
    const rows = csv(lines);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.matches).toHaveLength(0);
    expect(parsed.errors.map((e) => e.line)).toEqual([2, 12, 22]);
    expect(parsed.errors[0]!.message).toContain("탑 라인이 두 번");
    expect(parsed.errors[1]!.message).toContain("라인 '로밍'");
    expect(parsed.errors[2]!.message).toContain("9명");
  });

  it("두 팀이 모두 이겼다고 적힌 경기", () => {
    const rows = csv([
      ["날짜", "탑", "정글", "미드", "원딜", "서폿", "결과"],
      ["2026-10-03", ...A, "승"],
      ["2026-10-03", ...B, "승"],
    ]);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.errors[0]!.message).toContain("두 팀이 모두 이긴");
  });

  it("건너뛸 줄과 머리글 줄을 고를 수 있다", () => {
    const rows = csv([
      ["2026 시즌 내전 기록"],
      ["날짜", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리"],
      ["2026-10-01", ...A, ...B, "A"],
      ["합계", "", "", "", "", "", "", "", "", "", "", ""],
    ]);
    const mapping = detectMapping(rows);
    expect(mapping.headerRow).toBe(2);
    const withSkip = parseSheet(rows, { ...mapping, skip: [4] }, TODAY);
    expect(withSkip.errors).toEqual([]);
    expect(withSkip.matches).toHaveLength(1);
  });
});

describe("연도 없는 날짜와 시간대", () => {
  const rowsOf = (dates: string[]) =>
    csv([["날짜", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리"], ...dates.map((d) => [d, ...A, ...B, "A"])]);

  it("추정: 마지막 경기를 오늘 이전으로 보고 줄 순서대로 해를 넘긴다(추정한 수와 범위를 알려준다)", () => {
    const rows = rowsOf(["11/20", "12/30", "1/3", "10/30"]);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.matches.map((m) => m.date)).toEqual(["2025-11-20", "2025-12-30", "2026-01-03", "2026-10-30"]);
    expect(parsed.yearGuess).toEqual({ count: 4, from: 2025, to: 2026, basis: "guess" });
    expect(parsed.matches.every((m) => m.yearGuessed)).toBe(true);
  });

  it("추정: 마지막 날짜가 오늘보다 뒤면 작년으로 본다", () => {
    const rows = rowsOf(["12/24"]);
    expect(parseSheet(rows, detectMapping(rows), TODAY).matches[0]!.date).toBe("2025-12-24");
  });

  it("사용자가 시작 연도를 고르면 그 해부터 줄 순서대로 센다", () => {
    const rows = rowsOf(["11/20", "12/30", "1/3"]);
    const parsed = parseSheet(rows, { ...detectMapping(rows), year: 2024 }, TODAY);
    expect(parsed.matches.map((m) => m.date)).toEqual(["2024-11-20", "2024-12-30", "2025-01-03"]);
    expect(parsed.yearGuess?.basis).toBe("user");
  });

  it("연도가 적힌 줄이 있으면 그 해를 기준으로 이어 간다", () => {
    const rows = rowsOf(["2024-12-30", "1/3"]);
    const parsed = parseSheet(rows, detectMapping(rows), TODAY);
    expect(parsed.matches.map((m) => m.date)).toEqual(["2024-12-30", "2025-01-03"]);
  });

  it("2/29는 윤년이 아니면 틀린 줄이다", () => {
    const rows = rowsOf(["2/29"]);
    const parsed = parseSheet(rows, { ...detectMapping(rows), year: 2026 }, TODAY);
    expect(parsed.errors[0]!.message).toContain("없는 날짜");
  });

  it("시각이 없으면 모임 시간대의 정오 + 같은 날 순서로 표 순서를 지킨다. 시각이 있으면 그 시각", () => {
    const rows = csv([
      ["날짜", "시간", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리"],
      ["2026-10-01", "", ...A, ...B, "A"],
      ["2026-10-01", "", ...B, ...A, "A"],
      ["2026-10-01", "오후 9:15", ...A, ...B, "B"],
    ]);
    const mapping = detectMapping(rows);
    expect(mapping.columns.time).toBe(1);
    const parsed = parseSheet(rows, mapping, TODAY);
    const seoul = toSheetPayload(parsed.matches, (n) => n, "unknown", "Asia/Seoul");
    expect(seoul.map((p) => p.playedAt)).toEqual([
      "2026-10-01T03:00:00.000Z",
      "2026-10-01T03:00:01.000Z",
      "2026-10-01T12:15:00.000Z",
    ]);
    const la = toSheetPayload(parsed.matches, (n) => n, "unknown", "America/Los_Angeles");
    expect(la[0]!.playedAt).toBe("2026-10-01T19:00:00.000Z");
  });
});

describe("진영", () => {
  const rows = csv([
    ["날짜", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리", "A 진영"],
    ["2026-10-01", ...A, ...B, "A", "레드"],
    ["2026-10-02", ...A, ...B, "B", ""],
  ]);
  const mapping = detectMapping(rows);
  const parsed = parseSheet(rows, mapping, TODAY);

  it("진영 열을 읽고, 고른 방식대로 승리 진영을 정한다", () => {
    expect(mapping.columns.side).toBe(12);
    expect(parsed.matches.map((m) => m.sideA)).toEqual(["red", null]);
    expect(toSheetPayload(parsed.matches, (n) => n, "column", "Asia/Seoul").map((p) => p.winnerSide)).toEqual(["red", "unknown"]);
    expect(toSheetPayload(parsed.matches, (n) => n, "a-blue", "Asia/Seoul").map((p) => p.winnerSide)).toEqual(["blue", "red"]);
    expect(toSheetPayload(parsed.matches, (n) => n, "unknown", "Asia/Seoul").map((p) => p.winnerSide)).toEqual(["unknown", "unknown"]);
  });
});

/* ------------------------------------------------------------------ */

describe("이름 연결", () => {
  const people = [
    { id: "p1", name: "가람", status: "active" as const },
    { id: "p2", name: "Faker", status: "active" as const },
    { id: "p3", name: "다 온", status: "active" as const },
    { id: "p4", name: "옛이름", status: "archived" as const, mergedInto: "p1" },
    { id: "p5", name: "떠난사람", status: "archived" as const },
  ];

  it("정확히 같으면 자동, 비슷하면 후보, 합쳐진 사람은 남은 사람으로", () => {
    const links = linkNames(["가람", "faker", "FAKER", "다온", "ＦＡＫＥＲ ", "옛이름", "떠난사람", "새사람"], people);
    expect(links.map((l) => [l.name, l.kind, l.participantId ?? null])).toEqual([
      ["가람", "exact", "p1"],
      ["faker", "exact", "p2"],
      ["FAKER", "exact", "p2"],
      ["다온", "similar", null],
      ["ＦＡＫＥＲ ", "similar", null],
      ["옛이름", "merged", "p1"],
      ["떠난사람", "new", null],
      ["새사람", "new", null],
    ]);
    expect(links[3]!.candidates).toEqual([{ id: "p3", name: "다 온" }]);
    expect(links[5]!.mergedFrom).toBe("옛이름");
    expect(links[6]!.archivedSameName).toBe(true);
  });

  it("비슷한 이름 비교는 전각·공백·대소문자를 무시한다", () => {
    expect(looseKey("Ｈｏｎｇ Gil　Dong")).toBe("honggildong");
    expect(similarWithinTable(["홍길동", "홍 길동", "다른사람"])).toEqual([["홍길동", "홍 길동"]]);
  });
});

/* ------------------------------------------------------------------ */

describe("지문과 다시 가져오기", () => {
  const header = ["날짜", "A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "승리"];
  const base = [
    ["2026-10-01", ...A, ...B, "A"],
    ["2026-10-01", ...B, ...A, "B"],
    ["2026-10-02", ...A, ...B, "B"],
  ];
  const read = (rows: string[][], m?: SheetMapping) => {
    const table = csv([header, ...rows]);
    return parseSheet(table, m ?? detectMapping(table), TODAY);
  };
  const existingOf = (matches: { fingerprint: string; rowKey: string }[], state = "confirmed", sourceKey = "sheet:x"): ExistingImport[] =>
    matches.map((m, i) => ({ fingerprint: m.fingerprint, rowKey: m.rowKey, sourceKey, state, matchNo: i + 1 }));

  it("같은 내용이면 같은 지문, 열 순서·이름 대소문자가 달라도 같다", () => {
    const first = read(base);
    const again = read(base);
    expect(again.matches.map((m) => m.fingerprint)).toEqual(first.matches.map((m) => m.fingerprint));
    const upper = read([["2026-10-01", ...A.map((n) => ` ${n} `), ...B, "A"]]);
    expect(upper.matches[0]!.fingerprint).toBe(first.matches[0]!.fingerprint);
  });

  it("같은 날 같은 명단·결과의 경기가 두 번 있으면 서로 다른 지문이다", () => {
    const twice = read([base[0]!, base[0]!]);
    expect(twice.matches[0]!.fingerprint).not.toBe(twice.matches[1]!.fingerprint);
  });

  it("다시 가져오면 0경기, 줄을 추가하면 추가분만, 과거 줄을 고치면 '바뀐 줄'", () => {
    const first = read(base);
    const existing = existingOf(first.matches);
    const same = classifyImport(read(base).matches, existing, "sheet:x");
    expect([same.fresh.length, same.already.length, same.changed.length]).toEqual([0, 3, 0]);

    // 중간 날짜에 줄을 끼워 넣어도(같은 날 순서가 밀려도) 기존 경기는 건너뛴다.
    const added = read([base[0]!, ["2026-10-01", ...A, ...B, "B"], base[1]!, base[2]!, ["2026-10-03", ...A, ...B, "A"]]);
    const add = classifyImport(added.matches, existing, "sheet:x");
    expect(add.fresh.map((m) => m.line)).toEqual([3, 6]);
    expect(add.already).toHaveLength(3);
    expect(add.changed).toHaveLength(0);

    // 과거 줄(10/02 경기)의 이긴 팀을 고쳤다.
    const edited = read([base[0]!, base[1]!, ["2026-10-02", ...A, ...B, "A"]]);
    const edit = classifyImport(edited.matches, existing, "sheet:x");
    expect(edit.fresh).toHaveLength(0);
    expect(edit.changed).toHaveLength(1);
    expect(edit.changed[0]!.match.line).toBe(4);
    expect(edit.changed[0]!.previous.matchNo).toBe(3);
    expect(edit.missing).toBe(0);
  });

  it("전적 제외한 경기와 같은 내용은 새로 넣고, 다른 출처의 경기라도 같은 지문이면 건너뛴다", () => {
    const first = read(base);
    const excluded = classifyImport(read(base).matches, existingOf(first.matches, "excluded"), "sheet:x");
    expect(excluded.fresh).toHaveLength(3);
    expect(excluded.wasExcluded).toBe(3);
    const pasted = classifyImport(read(base).matches, existingOf(first.matches, "confirmed", "paste"), "sheet:x");
    expect(pasted.already).toHaveLength(3);
  });

  it("시트에서 줄을 지우면 사라진 경기 수를 센다", () => {
    const first = read(base);
    const removed = classifyImport(read(base.slice(0, 2)).matches, existingOf(first.matches), "sheet:x");
    expect(removed.missing).toBe(1);
  });

  it("서버로 보낼 경기에 라인·지문·줄 위치가 들어간다", () => {
    const parsed = read(base);
    const payload = toSheetPayload(parsed.matches, (n) => `id-${n}`, "a-blue", "Asia/Seoul");
    expect(payload[0]!.roster[0]).toEqual({ participantId: "id-가람", team: "A", position: "top" });
    expect(payload[0]!.roster[9]).toEqual({ participantId: "id-차오", team: "B", position: "support" });
    expect(payload[0]!.fingerprint).toMatch(/^v1-[0-9a-f]{16}$/);
    expect(payload[1]!.rowKey).toBe("2026-10-01#2");
  });
});
