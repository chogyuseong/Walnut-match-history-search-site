export const MAX_NAME_LENGTH = 20;

/**
 * 눈에 보이지 않으면서 글의 모양을 바꾸는 문자: 방향 제어(U+202A~U+202E, U+2066~U+2069)와 폭 없는 문자
 * (U+200B~U+200D, U+2060, U+FEFF). 이름에 섞으면 똑같아 보이는 다른 이름을 만들거나 글자 순서를 뒤집어 보이게 할 수 있다.
 * 이름·메모를 저장할 때 지운다(2026-11-10 보안 감사). 이미 저장된 값은 건드리지 않는다.
 * U+200D를 지우므로 여러 그림을 이어 붙인 이모지(가족·깃발 조합)는 낱개로 풀린다.
 * 눈에 보이지 않는 글자라 소스에 직접 적지 않고 코드 값으로 만든다.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200d],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
export const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join("")}]`,
  "g",
);

/** 제어 문자·보이지 않는 문자를 지우고 앞뒤 공백을 없애고 연속 공백을 하나로 줄인다. */
export function cleanName(raw: string): string {
  return raw
    .replace(INVISIBLE_CHARS, "")
    // eslint-disable-next-line no-control-regex -- 제어 문자를 일부러 찾아 공백으로 바꾼다.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 모임 안에서 같은 이름인지 비교할 때 쓰는 키. */
export function nameKey(raw: string): string {
  return cleanName(raw).toLowerCase();
}

export interface ParsedNames {
  names: string[];
  /** 한 번만 넣은 중복 이름. */
  duplicates: string[];
  /** 20자를 넘어 넣지 않은 이름. */
  tooLong: string[];
}

/** 줄바꿈·탭·쉼표로 나눈 이름 목록을 정리한다. 빈 줄은 버린다. */
export function parseNameList(text: string): ParsedNames {
  const names: string[] = [];
  const duplicates: string[] = [];
  const tooLong: string[] = [];
  const seen = new Set<string>();
  for (const piece of text.split(/[\n\r\t,]+/)) {
    const name = cleanName(piece);
    if (name === "") continue;
    if ([...name].length > MAX_NAME_LENGTH) {
      tooLong.push(name);
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      if (!duplicates.includes(name)) duplicates.push(name);
      continue;
    }
    seen.add(key);
    names.push(name);
  }
  return { names, duplicates, tooLong };
}
