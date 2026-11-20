import { ratePercent, type Tally } from "./stats";
import { josa, roJosa } from "./names";
import type { Position } from "./types";
import { SURE_GAMES, CHANCE_LIMIT, PLAYER_COMPARISON_RULES } from "./commentaryRules";

/**
 * 그래프 분석의 "분석 코멘트" 공용 부품: 문장 타입과 규칙 파일들이 함께 쓰는 판정·글 다듬기.
 * 이미 계산한 기록 수치를 정해 둔 규칙으로 읽어 판단형 한국어 문장을 만든다(외부 AI 없음).
 * 문장 규칙은 playerCommentary.ts(고른 플레이어)·playerCoaching.ts(개인 코칭)·groupCommentary.ts(모임 전체),
 * 문턱 값은 commentaryRules.ts에 있다. 쓰는 곳: src/web/screens/Graphs.tsx.
 * 데이터는 범위가 적용된 경기(matchesInScope)와 모임 전체 누적으로 만든 MMR(rating.ts)·경기 전 예상(upset.ts)·참석(attendance.ts)이다.
 */

export type RemarkTone = "good" | "warn" | "neutral";

export interface Remark {
  /** 근거 수치를 괄호로 붙인 문장. */
  text: string;
  tone: RemarkTone;
  /** 어느 수치를 읽었는지. 화면은 문장 아래 작은 글씨로 보인다(터치 화면에서는 title 풍선이 뜨지 않아 2026-11-10에 바꿈). */
  basis?: string;
  /**
   * 문장이 센 경기 목록(화면의 "근거 경기" 펼침). 문장의 경기 수와 같은 조건으로 고른 것이라 개수가 늘 같다
   * (test/commentary.test.ts가 확인). 아직 라인 강약·동료·상대·편성 균형 문장에만 있다. 다른 문장에 붙일 때도
   * 문장 숫자를 낸 집계와 같은 조건으로 골라야 한다.
   */
  evidence?: EvidenceGroup[];
}

/** 근거 경기 한 줄. note는 그 경기에서 문장이 본 값(이 사람의 "승"·"패", 편성 균형은 "MMR 차 120점"). */
export interface EvidenceMatch {
  matchId: string;
  note: string;
}

/** 근거 경기 묶음(예: 강한 라인·약한 라인). 묶음 안 순서는 화면에 보일 순서다. */
export interface EvidenceGroup {
  label: string;
  matches: EvidenceMatch[];
}

export interface Commentary {
  /** 한 줄 총평. 경기가 없으면 빈 문자열. */
  summary: string;
  /** 우선순위 순 문장. */
  remarks: Remark[];
  /**
   * 코칭: 위 수치에서 "다음에 해 볼 것"을 우선순위대로 COACHING_MAX개까지 고른다(2026-11-12 사용자 요청, 외부 AI 없이 규칙으로).
   * 근거 수치는 문장 괄호와 basis에 둔다. 경기가 없으면 없다.
   */
  coaching?: Remark[];
}

/** 우연으로 보기 어려운지. candidates: 그 규칙이 극단을 고른 후보 수. rules: 같은 코멘트 안의 비교 규칙 수. */
export function beyondChance(chance: number, candidates = 1, rules = PLAYER_COMPARISON_RULES): boolean {
  return chance < CHANCE_LIMIT / (rules * Math.max(1, candidates));
}

/** 근거 줄 꼬리: "우연 가능성 3%". 1% 미만은 0%로 보이지 않게 따로 쓴다. */
export function chanceNote(chance: number): string {
  const percent = Math.round(chance * 100);
  return percent < 1 ? " · 우연 가능성 1% 미만" : ` · 우연 가능성 ${percent}%`;
}

/** 전체에서 한 묶음을 뺀 나머지(예: 이 동료와 함께가 아닌 경기). */
export function without(total: Tally, part: Tally): Tally {
  return { games: total.games - part.games, wins: total.wins - part.wins };
}

/** 라인 이름. 웹의 POSITION_LABEL과 같다(shared는 web을 import하지 않는다). */
export const LANE_NAME: Record<Position, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

/** 낱말 + 받침에 맞춘 조사. 규칙은 names.ts finalSound 하나다. */
export function withJosa(word: string, withCoda: string, withoutCoda: string): string {
  return word + josa(word, [withCoda, withoutCoda]);
}

export function withRo(word: string): string {
  return word + roJosa(word);
}

export function rateOf(tally: Tally): number {
  return ratePercent(tally.wins, tally.games);
}

/** 표본이 SURE_GAMES 이상이면 단정, 아니면 "~로 보여요". */
export function judged(games: number, sure: string, hedged: string): string {
  return games >= SURE_GAMES ? sure : hedged;
}
