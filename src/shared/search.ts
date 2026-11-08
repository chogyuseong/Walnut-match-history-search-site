/**
 * 이름·경기 검색 엔진(순수 함수: DOM·DB 없음). 전적 검색·랭킹 이름 검색·고르기·참가 신청·교체 창이 함께 쓴다.
 *
 * - 정규화: NFC, 전각 영숫자 → 반각, 소문자, 공백·`_`·`.`·`-`·`·` 같은 구분 기호를 지운다.
 * - 초성 검색: 질의의 한글 자음(ㄱ~ㅎ, 쌍자음 포함)은 이름 음절의 초성과 맞춘다("ㄱㅅ" → "김선우").
 *   완성형 글자와 섞어도 된다("김ㅅ" → "김선우"): 완성형은 그 글자와 같아야 하고, 자음은 초성만 같으면 된다.
 * - 입력 중(IME) 배려: 질의의 마지막 글자가 받침 없는 음절이면 초성·중성만 같아도 맞는다
 *   ("김서" → "김선우"). 한 글자를 다 치기 전에 결과가 깜빡 사라지지 않게 하려는 것이다. 이 일치는 초성 일치와 같은 등급이다.
 * - 등급: 0 완전 일치 → 1 앞부분 일치 → 2 포함 → 3 초성 일치(앞부분) → 4 초성 포함 → 5 불일치.
 *   같은 등급은 이름의 한국어 순서(localeCompare "ko").
 */

/** 불일치 등급. */
export const NO_MATCH = 5;

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
/** 음절 하나에 딸린 (중성 × 종성) 조합 수. */
const PER_INITIAL = 21 * 28;

/** 초성 19자(한글 호환 자모). 순서는 유니코드 음절의 초성 순서와 같다. */
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const INITIAL_SET = new Set(INITIALS);

/** 지우는 구분 기호: 공백 전부, 밑줄, 점, 하이픈, 가운뎃점(·ㆍ・), 작은따옴표류. */
const SEPARATORS = /[\s_.\-·ㆍ・'’`]+/gu;

function isSyllable(code: number): boolean {
  return code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST;
}

/** 첫가끝 초성(U+1100~U+1112)을 호환 자모로 바꾼다. NFC가 묶지 못한 낱자 초성이 들어와도 같은 글자로 본다. */
function toCompatInitial(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (code >= 0x1100 && code <= 0x1112) return INITIALS[code - 0x1100]!;
  return ch;
}

/** 검색용 정규화. 이름과 질의 모두 이 함수를 거친 뒤 비교한다. */
export function normalizeForSearch(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    // 전각 기호·영숫자(！~～) → 반각, 전각 공백 → 공백.
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else if (code === 0x3000) out += " ";
    else out += toCompatInitial(ch);
  }
  return out.toLowerCase().replace(SEPARATORS, "");
}

/** 한 글자의 초성. 음절이 아니면 그 글자 그대로. */
function initialOf(ch: string): string {
  const code = ch.codePointAt(0)!;
  if (!isSyllable(code)) return ch;
  return INITIALS[Math.floor((code - SYLLABLE_FIRST) / PER_INITIAL)]!;
}

/** 정규화한 글의 초성열. 음절이 아닌 글자(영문·숫자)는 그대로 둔다. 예: "김 선우" → "ㄱㅅㅇ". */
export function chosungOf(s: string): string {
  return Array.from(normalizeForSearch(s), initialOf).join("");
}

/** 질의 글자(한 글자)가 이름 글자(한 글자)에 맞는지. last면 받침 없는 음절의 입력 중 일치를 허용한다. */
function charMatches(q: string, n: string, last: boolean): boolean {
  if (q === n) return true;
  if (INITIAL_SET.has(q)) return initialOf(n) === q;
  if (!last) return false;
  const qc = q.codePointAt(0)!;
  const nc = n.codePointAt(0)!;
  if (!isSyllable(qc) || !isSyllable(nc)) return false;
  const qi = qc - SYLLABLE_FIRST;
  const ni = nc - SYLLABLE_FIRST;
  // 질의 음절에 받침이 없고, 초성·중성이 같으면(이름 음절의 받침은 무엇이든) 입력 중으로 본다.
  return qi % 28 === 0 && Math.floor(qi / 28) === Math.floor(ni / 28);
}

/** 이름 글자열에서 질의 글자열이 처음 맞는 위치. 없으면 -1. */
function fuzzyIndex(name: readonly string[], query: readonly string[]): number {
  for (let start = 0; start + query.length <= name.length; start++) {
    let ok = true;
    for (let j = 0; j < query.length; j++) {
      if (!charMatches(query[j]!, name[start + j]!, j === query.length - 1)) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

/**
 * 이름과 질의의 일치 등급(0~5). 빈 질의(공백만)는 모두 0(전부 맞음).
 * 구분 기호만 있는 질의(예: "...")는 정규화하면 비므로 아무것도 맞지 않는다(5).
 */
export function matchRank(name: string, query: string): number {
  if (query.trim() === "") return 0;
  const q = normalizeForSearch(query);
  if (q === "") return NO_MATCH;
  const n = normalizeForSearch(name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  const at = fuzzyIndex(Array.from(n), Array.from(q));
  if (at === 0) return 3;
  if (at > 0) return 4;
  return NO_MATCH;
}

/** 이름이 질의에 맞는지(등급 0~4). 빈 질의는 모두 맞는다. */
export function matchesName(name: string, query: string): boolean {
  return matchRank(name, query) < NO_MATCH;
}

/**
 * 이름 검색: 맞는 것만 등급 순 → 이름 순으로. 빈 질의(공백만)는 받은 순서 그대로 모두 돌려준다.
 * 배치 여부 같은 다른 기준으로 순서를 바꾸지 않는다.
 */
export function searchPeople<T extends { name: string }>(items: readonly T[], query: string): T[] {
  if (query.trim() === "") return [...items];
  return items
    .map((item) => ({ item, rank: matchRank(item.name, query) }))
    .filter((x) => x.rank < NO_MATCH)
    .sort((a, b) => a.rank - b.rank || a.item.name.localeCompare(b.item.name, "ko"))
    .map((x) => x.item);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function validDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const FULL_DIGITS = /^(\d{4})(\d{2})(\d{2})$/;
const WITH_YEAR = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\s*\.?$/;
const NO_YEAR = /^(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?\s*\.?$/;

/**
 * 질의가 날짜 꼴이면 그 날짜(YYYY-MM-DD), 아니면 null.
 * 받는 꼴: `11/7`, `11.7`, `11.7.`, `11-7`, `11월 7일`, `2026-11-07`, `2026.11.7`, `2026년 11월 7일`, `20261107`.
 * 연도를 생략하면 today(모임 시간대의 오늘, YYYY-MM-DD) 이전(오늘 포함)의 가장 최근 그 날짜로 본다
 * (2월 29일은 가장 최근 윤년). 없는 날짜(13월, 2월 30일 등)는 null.
 */
export function parseDateQuery(query: string, today: string): string | null {
  const text = normalizeDigits(query.trim());
  if (text === "") return null;
  let m = FULL_DIGITS.exec(text) ?? WITH_YEAR.exec(text);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = NO_YEAR.exec(text);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  // 어느 해에도 없는 날짜(13월, 4월 31일)는 바로 거른다. 2월 29일은 윤년을 찾아 거슬러 올라간다.
  if (validDate(2000, month, day) === null) return null;
  const thisYear = Number(today.slice(0, 4));
  for (let year = thisYear; year >= thisYear - 8; year--) {
    const date = validDate(year, month, day);
    if (date !== null && date <= today) return date;
  }
  return null;
}

/** 전각 숫자·기호를 반각으로(날짜 해석용). 공백·구분 기호는 지우지 않는다. */
function normalizeDigits(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
  }
  return out;
}

/** 글(예: 경기 메모)에 질의가 들어 있는지. 정규화해서 비교한다(공백·대소문자 무시). 빈 질의는 false. */
export function textContains(text: string | null | undefined, query: string): boolean {
  if (!text) return false;
  const q = normalizeForSearch(query);
  if (q === "") return false;
  return normalizeForSearch(text).includes(q);
}
