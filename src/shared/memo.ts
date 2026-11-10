/** 경기 메모(migrations/0016). 서버 검증과 화면의 글자 수 표시가 같은 규칙을 쓴다. */
import { INVISIBLE_CHARS } from "./names";

/** 최대 글자 수(유니코드 코드 포인트 기준. SQLite length()와 같은 셈). */
export const MEMO_MAX = 200;

/**
 * 메모를 저장할 모양으로 정리한다.
 * - 줄바꿈은 \n 하나로 맞추고, 그 밖의 제어 문자는 공백으로 바꾼다. 보이지 않는 문자(names.ts INVISIBLE_CHARS)는 지운다.
 * - 앞뒤 공백·빈 줄을 없앤다. 비면 null(메모 삭제).
 * 글자 수 검사는 하지 않는다(memoLength로 따로 본다).
 */
export function normalizeMemo(raw: string): string | null {
  const text = raw
    .replace(INVISIBLE_CHARS, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- 제어 문자를 일부러 찾아 공백으로 바꾼다.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .trim();
  return text === "" ? null : text;
}

export function memoLength(text: string): number {
  return [...text].length;
}

/** 카드 한 줄에 쓸 모양(줄바꿈을 " · "로). */
export function memoOneLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" · ");
}
