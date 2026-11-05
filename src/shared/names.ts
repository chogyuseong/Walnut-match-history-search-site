export const MAX_NAME_LENGTH = 20;

/** 제어 문자를 지우고 앞뒤 공백을 없애고 연속 공백을 하나로 줄인다. */
export function cleanName(raw: string): string {
  return raw
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
