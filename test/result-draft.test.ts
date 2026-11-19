import { describe, expect, it } from "vitest";

// 결과 입력 창의 기기 임시 보관(src/web/resultDraft.ts) 읽기 경계.
// 깨지거나 모양이 다른 초안이 와도 결과 창이 열리고, 이긴 팀처럼 승패를 정하는 값은 믿지 않는지 본다.

interface LoadedResultDraft {
  draft: {
    matchVersion: number;
    winner: string | null;
    side: string | null;
    memo: string;
    champions: Record<string, string>;
    savedAt: number;
  };
  winnerReset: boolean;
}
interface ResultDraftModule {
  parseResultDraft(text: string, now: number): LoadedResultDraft | null;
}
/** 화면 코드는 서버 타입 검사 밖이라 실행 시점에 불러온다(csv.test.ts와 같은 방식). */
const loadModule = (): Promise<ResultDraftModule> => {
  const path = "../src/web/resultDraft";
  return import(/* @vite-ignore */ path) as Promise<ResultDraftModule>;
};

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 60 * 60 * 1000;

const intact = {
  matchVersion: 3,
  winner: "A",
  side: "blue",
  memo: "바론 한타 역전",
  champions: { p1: "Ahri", p2: "LeeSin" },
  savedAt: NOW - HOUR,
};

describe("parseResultDraft", () => {
  it("정상 초안은 그대로 되살린다", async () => {
    const { parseResultDraft } = await loadModule();
    expect(parseResultDraft(JSON.stringify(intact), NOW)).toEqual({ draft: intact, winnerReset: false });
  });

  it("3일이 지났거나 저장 시각을 모르면 버린다", async () => {
    const { parseResultDraft } = await loadModule();
    const expired = { ...intact, savedAt: NOW - 72 * HOUR - 1 };
    expect(parseResultDraft(JSON.stringify(expired), NOW)).toBeNull();
    expect(parseResultDraft(JSON.stringify({ ...intact, savedAt: "어제" }), NOW)).toBeNull();
  });

  it("JSON이 아니거나 객체가 아니면 버린다", async () => {
    const { parseResultDraft } = await loadModule();
    for (const text of ["{", "null", "[]", '"글"', "42"]) {
      expect(parseResultDraft(text, NOW)).toBeNull();
    }
  });

  it("챔피언 칸이 빠졌거나 모양이 달라도 메모와 승리 팀은 살린다", async () => {
    const { parseResultDraft } = await loadModule();
    const { champions: _dropped, ...noChampions } = intact;
    const loaded = parseResultDraft(JSON.stringify(noChampions), NOW);
    expect(loaded?.draft.champions).toEqual({});
    expect(loaded?.draft.memo).toBe("바론 한타 역전");
    expect(loaded?.draft.winner).toBe("A");

    for (const champions of [null, ["Ahri"], "Ahri"]) {
      expect(parseResultDraft(JSON.stringify({ ...intact, champions }), NOW)?.draft.champions).toEqual({});
    }
    // 글자가 아닌 챔피언 값만 빠지고 나머지 사람은 남는다.
    const mixed = parseResultDraft(JSON.stringify({ ...intact, champions: { p1: "Ahri", p2: 7, p3: "" } }), NOW);
    expect(mixed?.draft.champions).toEqual({ p1: "Ahri" });
  });

  it("허용값이 아닌 이긴 팀·진영은 둘 다 비우고 다시 고르게 한다", async () => {
    const { parseResultDraft } = await loadModule();
    for (const broken of [{ winner: "C" }, { winner: 1 }, { side: "purple" }]) {
      const loaded = parseResultDraft(JSON.stringify({ ...intact, ...broken }), NOW);
      expect(loaded?.winnerReset).toBe(true);
      expect(loaded?.draft.winner).toBeNull();
      expect(loaded?.draft.side).toBeNull();
      expect(loaded?.draft.memo).toBe("바론 한타 역전");
    }
  });

  it("이긴 팀을 아직 안 골랐던 초안은 다시 고를 일이 없으니 알리지 않는다", async () => {
    const { parseResultDraft } = await loadModule();
    const loaded = parseResultDraft(JSON.stringify({ ...intact, winner: null, side: null }), NOW);
    expect(loaded?.winnerReset).toBe(false);
    expect(loaded?.draft.winner).toBeNull();
  });

  it("메모가 글자가 아니면 빈 메모, 경기 버전을 모르면 어떤 버전과도 다르게 둔다", async () => {
    const { parseResultDraft } = await loadModule();
    const loaded = parseResultDraft(JSON.stringify({ ...intact, memo: { text: "x" }, matchVersion: "3" }), NOW);
    expect(loaded?.draft.memo).toBe("");
    expect(loaded?.draft.matchVersion).toBe(-1);
  });
});
