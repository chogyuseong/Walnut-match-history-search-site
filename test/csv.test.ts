import { describe, expect, it } from "vitest";
import { csvCell, parseDelimited, toCsv, UTF8_BOM } from "../src/shared/csv";
import type { MatchView, Snapshot } from "../src/shared/types";

// CSV 내보내기(src/shared/csv.ts의 csvCell·toCsv)와 기록·랭킹 CSV 줄 만들기(src/web/csvExport.ts).

/**
 * 줄 만들기 함수는 화면 코드(src/web/csvExport.ts → format.ts, DOM 타입을 쓴다)에 있다. 서버 타입 검사(tsconfig.json)가
 * 화면 파일까지 끌어오지 않도록 실행 시점에 불러오고 필요한 모양만 적는다(rate-heat-titles.test.ts와 같은 방식).
 */
interface CsvExportModule {
  MATCH_CSV_HEADER: readonly string[];
  matchesCsv(snapshot: Snapshot, matches: readonly MatchView[]): string;
  personMatchesCsv(snapshot: Snapshot, participantId: string, matches: readonly MatchView[]): string;
  rankingCsv(
    rows: readonly { participantId: string; games: number; wins: number; losses: number; rank: number; name: string }[],
    standing: ReadonlyMap<string, { done: boolean; title: string | null }>,
  ): string;
  csvFileName(prefix: string, snapshot: Snapshot, parts?: readonly string[], now?: Date): string;
  csvDateTime(iso: string, timeZone: string): string;
}
const loadExport = (): Promise<CsvExportModule> => {
  const path = "../src/web/csvExport";
  return import(/* @vite-ignore */ path) as Promise<CsvExportModule>;
};

describe("CSV 칸", () => {
  it("평범한 글·숫자·빈 값", () => {
    expect(csvCell("김선우")).toBe("김선우");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
  });

  it("쉼표·큰따옴표·줄바꿈은 큰따옴표로 감싸고 안의 따옴표는 두 번(RFC 4180)", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('그는 "MVP"')).toBe('"그는 ""MVP"""');
    expect(csvCell("한 줄\n두 줄")).toBe('"한 줄\n두 줄"');
    expect(csvCell("CR\r끝")).toBe('"CR\r끝"');
  });

  it("수식 주입 방지: =, +, -, @, 탭, CR로 시작하는 글 앞에 '", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+82")).toBe("'+82");
    expect(csvCell("-5")).toBe("'-5");
    expect(csvCell("@sum(A1)")).toBe("'@sum(A1)");
    expect(csvCell("\t탭")).toBe("'\t탭");
    expect(csvCell("\r줄")).toBe("\"'\r줄\"");
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    // 가운데에 있는 기호는 그대로.
    expect(csvCell("a=b")).toBe("a=b");
  });
});

describe("CSV 글", () => {
  it("BOM으로 시작하고 줄 끝은 CRLF", () => {
    const text = toCsv([
      ["이름", "승"],
      ["김선우", 3],
    ]);
    expect(text.startsWith(UTF8_BOM)).toBe(true);
    expect(text).toBe(`${UTF8_BOM}이름,승\r\n김선우,3\r\n`);
    expect(toCsv([["a"]], { bom: false })).toBe("a\r\n");
  });

  it("다시 읽으면(parseDelimited) 같은 표", () => {
    const rows = [
      ["경기", "메모"],
      ["1", '결승, "역전"\n다음 줄'],
      ["2", ""],
    ];
    expect(parseDelimited(toCsv(rows), ",")).toEqual(rows);
  });
});

/** 테스트용 경기. */
function match(overrides: Partial<MatchView> & Pick<MatchView, "id" | "matchNo">): MatchView {
  const roster: MatchView["roster"] = [];
  const positions = ["top", "jungle", "mid", "adc", "support"] as const;
  positions.forEach((position, i) => {
    roster.push({ participantId: `a${i}`, team: "A", position });
    roster.push({ participantId: `b${i}`, team: "B", position });
  });
  return {
    sessionId: null,
    state: "confirmed",
    source: "live",
    startedAt: null,
    endedAt: null,
    playedAt: "2026-11-07T12:30:00.000Z",
    confirmedAt: null,
    winnerTeam: "A",
    teamASide: "blue",
    version: 1,
    roster,
    ...overrides,
  };
}

function snapshot(matches: MatchView[]): Snapshot {
  const participants = ["a0", "a1", "a2", "a3", "a4", "b0", "b1", "b2", "b3", "b4"].map((id) => ({
    id,
    name: `선수_${id}`,
    status: "active",
  }));
  return {
    role: "viewer",
    serverTime: "2026-11-08T00:00:00.000Z",
    group: { id: "g1", name: "호두/모임", timezone: "Asia/Seoul" },
    participants,
    matches,
  } as unknown as Snapshot;
}

describe("기록 CSV", () => {
  it("머리 줄: 팀1·팀2 다섯 칸씩, 승리 팀, 비고, 메모", async () => {
    const { MATCH_CSV_HEADER } = await loadExport();
    expect(MATCH_CSV_HEADER).toEqual([
      "경기 번호",
      "날짜·시각",
      "상태",
      "팀1_탑",
      "팀1_정글",
      "팀1_미드",
      "팀1_원딜",
      "팀1_서폿",
      "팀2_탑",
      "팀2_정글",
      "팀2_미드",
      "팀2_원딜",
      "팀2_서폿",
      "승리 팀",
      "비고",
      "메모",
    ]);
  });

  it("진영이 정해지면 팀1이 블루팀(팀 A가 레드여도), 진영 미상은 비고에 적는다", async () => {
    const { matchesCsv } = await loadExport();
    const blueA = match({ id: "m1", matchNo: 1, memo: "=위험" });
    const redA = match({ id: "m2", matchNo: 2, teamASide: "red", winnerTeam: "A" });
    const unknown = match({ id: "m3", matchNo: 3, teamASide: null, state: "awaiting_result", winnerTeam: null });
    const rows = parseDelimited(matchesCsv(snapshot([blueA, redA, unknown]), [blueA, redA, unknown]), ",");
    expect(rows).toHaveLength(4);
    // 서울 시간대(UTC+9)로 사람이 읽는 꼴.
    expect(rows[1]!.slice(0, 4)).toEqual(["1", "2026-11-07 21:30", "결과 확정", "선수_a0"]);
    expect(rows[1]!.slice(13)).toEqual(["블루팀", "", "'=위험"]);
    // 팀 A가 레드: 팀1(블루)은 팀 B 사람들, 승리 팀은 레드팀.
    expect(rows[2]![3]).toBe("선수_b0");
    expect(rows[2]![8]).toBe("선수_a0");
    expect(rows[2]![13]).toBe("레드팀");
    // 진영 미상·결과 미입력.
    expect(rows[3]![2]).toBe("결과 미입력");
    expect(rows[3]![3]).toBe("선수_a0");
    expect(rows[3]![13]).toBe("");
    expect(rows[3]![14]).toBe("진영 미상");
  });

  it("포지션 기록이 없으면 명단 순서로 채우고 비고에 적는다", async () => {
    const { matchesCsv } = await loadExport();
    const base = match({ id: "m1", matchNo: 1 });
    const noPos = { ...base, roster: base.roster.map((r) => ({ ...r, position: null })) };
    const rows = parseDelimited(matchesCsv(snapshot([noPos]), [noPos]), ",");
    expect(rows[1]!.slice(3, 8)).toEqual(["선수_a0", "선수_a1", "선수_a2", "선수_a3", "선수_a4"]);
    expect(rows[1]![14]).toBe("포지션 기록 없음");
  });

  it("개인 CSV는 본인 팀·라인·결과 열이 더 있다", async () => {
    const { personMatchesCsv } = await loadExport();
    const m = match({ id: "m1", matchNo: 1, winnerTeam: "B" });
    const rows = parseDelimited(personMatchesCsv(snapshot([m]), "a2", [m]), ",");
    expect(rows[0]!.slice(3, 6)).toEqual(["본인 팀", "본인 라인", "본인 결과"]);
    expect(rows[1]!.slice(3, 6)).toEqual(["블루팀", "미드", "패"]);
  });

  it("랭킹 CSV: 승률은 정수 %, 배치·칭호", async () => {
    const { rankingCsv } = await loadExport();
    const text = rankingCsv(
      [
        { participantId: "a0", rank: 1, name: "선수_a0", games: 12, wins: 8, losses: 4 },
        { participantId: "a1", rank: 2, name: "@선수", games: 3, wins: 1, losses: 2 },
      ],
      new Map([["a0", { done: true, title: "에이스" }]]),
    );
    expect(parseDelimited(text, ",")).toEqual([
      ["순위", "이름", "경기", "승", "패", "승률(%)", "배치", "칭호"],
      ["1", "선수_a0", "12", "8", "4", "67", "배치 완료", "에이스"],
      ["2", "'@선수", "3", "1", "2", "33", "배치 중", ""],
    ]);
  });

  it("파일 이름: 내전기록-모임이름-YYYYMMDD.csv(쓸 수 없는 글자는 지움, 모임 시간대 날짜)", async () => {
    const { csvFileName } = await loadExport();
    const snap = snapshot([]);
    // UTC 11월 7일 20시 = 서울 11월 8일 5시.
    expect(csvFileName("내전기록", snap, [], new Date("2026-11-07T20:00:00Z"))).toBe("내전기록-호두모임-20261108.csv");
    expect(csvFileName("내전기록", snap, ["김:선우"], new Date("2026-11-07T20:00:00Z"))).toBe(
      "내전기록-호두모임-김선우-20261108.csv",
    );
  });
});
