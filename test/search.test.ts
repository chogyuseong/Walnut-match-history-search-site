import { describe, expect, it } from "vitest";
import {
  chosungOf,
  matchesName,
  matchRank,
  NO_MATCH,
  normalizeForSearch,
  parseDateQuery,
  searchPeople,
  textContains,
} from "../src/shared/search";
import { searchByName } from "../src/shared/stats";

// 이름 검색 엔진(src/shared/search.ts): 정규화, 초성, 등급, 날짜 해석.

const names = (items: { name: string }[]) => items.map((p) => p.name);

describe("정규화", () => {
  it("공백·밑줄·점·하이픈·가운뎃점을 지우고 소문자로", () => {
    expect(normalizeForSearch("  Hide on_Bush.KR-1 · 김 ")).toBe("hideonbushkr1김");
  });

  it("전각 영숫자·전각 공백을 반각으로", () => {
    expect(normalizeForSearch("ＦＡＫＥＲ　１２３")).toBe("faker123");
  });

  it("NFD(풀어 쓴 한글)도 NFC로 묶어 같은 이름으로 본다", () => {
    expect(normalizeForSearch("김선우".normalize("NFD"))).toBe("김선우");
  });

  it("초성열: 음절은 초성, 영문·숫자는 그대로", () => {
    expect(chosungOf("김 선우")).toBe("ㄱㅅㅇ");
    expect(chosungOf("홍진호2")).toBe("ㅎㅈㅎ2");
    expect(chosungOf("까치")).toBe("ㄲㅊ");
  });
});

describe("초성 검색", () => {
  it("자음만 넣으면 초성으로 찾는다", () => {
    expect(matchesName("김선우", "ㄱㅅ")).toBe(true);
    expect(matchesName("홍진호", "ㅎㅈ")).toBe(true);
    expect(matchesName("홍진호", "ㅎㅈㅎ")).toBe(true);
    expect(matchesName("홍진호", "ㅈㅎ")).toBe(true);
    expect(matchesName("홍진호", "ㄱㅅ")).toBe(false);
  });

  it("쌍자음은 쌍자음 초성에만 맞는다", () => {
    expect(matchesName("까치", "ㄲㅊ")).toBe(true);
    expect(matchesName("가치", "ㄲㅊ")).toBe(false);
    expect(matchesName("까치", "ㄱㅊ")).toBe(false);
    expect(matchesName("빠름쓰", "ㅃㄹㅆ")).toBe(true);
  });

  it("완성형과 자음을 섞으면: 완성형은 그 글자, 자음은 초성", () => {
    expect(matchesName("김선우", "김ㅅ")).toBe(true);
    expect(matchesName("김선우", "김ㅅㅇ")).toBe(true);
    expect(matchesName("김선우", "ㄱ선")).toBe(true);
    expect(matchesName("박선우", "김ㅅ")).toBe(false);
  });

  it("공백이 있는 이름도 초성으로", () => {
    expect(matchesName("김 선우", "ㄱㅅㅇ")).toBe(true);
    expect(matchesName("김선우", "ㄱ ㅅ")).toBe(true);
  });

  it("입력 중(마지막 글자 받침 없음)이면 초성·중성만 같아도 맞는다", () => {
    expect(matchesName("김선우", "김서")).toBe(true);
    // 받침까지 친 글자는 그 받침이어야 한다.
    expect(matchesName("김선우", "김섭")).toBe(false);
    // 마지막 글자가 아니면 완성형 그대로 맞아야 한다.
    expect(matchesName("김선우", "기선")).toBe(false);
  });
});

describe("등급과 순서", () => {
  it("0 완전 → 1 앞부분 → 2 포함 → 3 초성 앞부분 → 4 초성 포함 → 5 불일치", () => {
    expect(matchRank("김선우", "김선우")).toBe(0);
    expect(matchRank("김선우", "김선")).toBe(1);
    expect(matchRank("김선우", "선우")).toBe(2);
    expect(matchRank("김선우", "ㄱㅅ")).toBe(3);
    expect(matchRank("김선우", "ㅅㅇ")).toBe(4);
    expect(matchRank("김선우", "ㅎ")).toBe(NO_MATCH);
  });

  it("검색 결과는 등급 순, 같은 등급은 이름 순", () => {
    const people = [{ name: "선우김" }, { name: "김선우" }, { name: "고성훈" }, { name: "김세아" }, { name: "강서" }];
    expect(names(searchPeople(people, "ㄱㅅ"))).toEqual(["강서", "고성훈", "김선우", "김세아"]);
    expect(names(searchPeople(people, "김"))).toEqual(["김선우", "김세아", "선우김"]);
  });

  it("글자 일치가 초성 일치보다 앞선다", () => {
    const people = [{ name: "ㄱㅅ팬" }, { name: "가수" }];
    expect(names(searchPeople(people, "ㄱㅅ"))).toEqual(["ㄱㅅ팬", "가수"]);
  });

  it("공백·대소문자 무시", () => {
    const people = [{ name: "Hide On Bush" }, { name: "hideonbush2" }, { name: "Faker" }];
    expect(names(searchPeople(people, "hideon"))).toEqual(["Hide On Bush", "hideonbush2"]);
    expect(names(searchPeople(people, "FAKER"))).toEqual(["Faker"]);
    expect(names(searchPeople(people, "ｆａｋｅｒ"))).toEqual(["Faker"]);
  });

  it("영문·숫자 이름", () => {
    const people = [{ name: "선수01" }, { name: "선수10" }, { name: "Player1" }];
    expect(names(searchPeople(people, "01"))).toEqual(["선수01"]);
    // 같은 등급(포함)이면 한국어 정렬 순서: 한글이 영문보다 앞이다.
    expect(names(searchPeople(people, "1"))).toEqual(["선수01", "선수10", "Player1"]);
    expect(names(searchPeople(people, "ㅅㅅ1"))).toEqual(["선수10"]);
    expect(names(searchPeople(people, "ㅅㅅ0"))).toEqual(["선수01"]);
  });
});

describe("빈 질의·특수문자 질의", () => {
  it("빈 질의(공백만)는 받은 순서 그대로 모두", () => {
    const people = [{ name: "나" }, { name: "가" }];
    expect(names(searchPeople(people, ""))).toEqual(["나", "가"]);
    expect(names(searchPeople(people, "   "))).toEqual(["나", "가"]);
    expect(matchesName("아무나", "")).toBe(true);
  });

  it("구분 기호만 있는 질의는 아무것도 맞지 않는다", () => {
    const people = [{ name: "a.b" }, { name: "김선우" }];
    expect(searchPeople(people, "...")).toEqual([]);
    expect(searchPeople(people, " - _ ")).toEqual([]);
    expect(matchesName("김선우", "·")).toBe(false);
  });

  it("정규식 특수문자가 든 질의도 글자로 비교한다", () => {
    expect(matchesName("a+b(c)", "+b(")).toBe(true);
    expect(matchesName("abc", "a*")).toBe(false);
  });

  it("기존 searchByName은 새 규칙을 따른다(예전 결과 그대로 + 초성)", () => {
    const people = [{ name: "김용호의친구" }, { name: "용호" }, { name: "김용호" }, { name: "조규성" }];
    expect(names(searchByName(people, "용호"))).toEqual(["용호", "김용호", "김용호의친구"]);
    expect(names(searchByName(people, "ㅈㄱ"))).toEqual(["조규성"]);
  });
});

describe("메모 검색", () => {
  it("공백·대소문자를 무시하고 포함 여부", () => {
    expect(textContains("결승 1세트 MVP", "결승1")).toBe(true);
    expect(textContains("결승 1세트 MVP", "mvp")).toBe(true);
    expect(textContains("결승", "준결승")).toBe(false);
    expect(textContains(undefined, "결승")).toBe(false);
    expect(textContains("결승", "  ")).toBe(false);
  });
});

describe("날짜 질의", () => {
  const today = "2026-11-08";

  it("받는 꼴", () => {
    expect(parseDateQuery("11/7", today)).toBe("2026-11-07");
    expect(parseDateQuery("11.7", today)).toBe("2026-11-07");
    expect(parseDateQuery("11.7.", today)).toBe("2026-11-07");
    expect(parseDateQuery("11-7", today)).toBe("2026-11-07");
    expect(parseDateQuery("11월 7일", today)).toBe("2026-11-07");
    expect(parseDateQuery("11월7일", today)).toBe("2026-11-07");
    expect(parseDateQuery("2026-11-07", today)).toBe("2026-11-07");
    expect(parseDateQuery("2025.3.1", today)).toBe("2025-03-01");
    expect(parseDateQuery("2025년 3월 1일", today)).toBe("2025-03-01");
    expect(parseDateQuery("20261107", today)).toBe("2026-11-07");
    expect(parseDateQuery("１１/７", today)).toBe("2026-11-07");
  });

  it("연도를 생략하면 오늘 이전(오늘 포함)의 가장 최근 그 날짜", () => {
    expect(parseDateQuery("11/8", today)).toBe("2026-11-08");
    expect(parseDateQuery("11/9", today)).toBe("2025-11-09");
    expect(parseDateQuery("12/31", today)).toBe("2025-12-31");
    expect(parseDateQuery("1/1", today)).toBe("2026-01-01");
  });

  it("2월 29일은 가장 최근 윤년", () => {
    expect(parseDateQuery("2/29", today)).toBe("2024-02-29");
    expect(parseDateQuery("2/29", "2024-02-28")).toBe("2020-02-29");
  });

  it("잘못된 날짜·날짜가 아닌 글은 null", () => {
    expect(parseDateQuery("13/1", today)).toBeNull();
    expect(parseDateQuery("2/30", today)).toBeNull();
    expect(parseDateQuery("4/31", today)).toBeNull();
    expect(parseDateQuery("0/5", today)).toBeNull();
    expect(parseDateQuery("2026-02-29", today)).toBeNull();
    expect(parseDateQuery("20261340", today)).toBeNull();
    expect(parseDateQuery("1107", today)).toBeNull();
    expect(parseDateQuery("김선우", today)).toBeNull();
    expect(parseDateQuery("", today)).toBeNull();
    expect(parseDateQuery("11/7/3", today)).toBeNull();
  });
});
