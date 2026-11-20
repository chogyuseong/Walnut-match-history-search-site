// 칭호 엠블럼·칭호 표식, MMR 티어 이름표, 배치·칭호 한 줄(StandingNote). 요약·랭킹·개인 통계·검색·칭호 설정이 쓴다.
import type { ReactNode } from "react";
import { ratingTierOf } from "../shared/rating";
import type { TitleGrade } from "../shared/titles";
import type { ShownStanding } from "./format";

/**
 * 칭호 엠블럼. 등급(구간 순서)마다 직접 그린 단순한 도형이다(게임의 랭크 엠블럼을 본뜨지 않았다).
 * 1 왕관 · 2 보석 · 3 별 · 4 방패 · 5 검 · 6 깃발 · 7 새싹 · 8 고리. 꾸밈이고 뜻은 옆의 이름 글자가 전한다.
 * 등급 수(titles.ts TITLE_GRADE_COUNT)와 개수가 같아야 한다(Record 타입이 빠진 등급을 잡는다).
 */
const TITLE_EMBLEMS: Record<TitleGrade, ReactNode> = {
  1: <path d="M3 18.5H21M4 16L3 7L8.5 11L12 4.5L15.5 11L21 7L20 16H4Z" />,
  2: <path d="M7.5 4H16.5L21 9L12 20L3 9L7.5 4ZM3 9H21M9.5 4L12 9L14.5 4M12 9V20" />,
  3: <path d="M12 3.5L14.6 9L20.5 9.6L16 13.6L17.3 19.5L12 16.5L6.7 19.5L8 13.6L3.5 9.6L9.4 9L12 3.5Z" />,
  4: (
    <>
      <path d="M12 3.5L19 6.5V12C19 16 16.2 19 12 20.5C7.8 19 5 16 5 12V6.5L12 3.5Z" />
      <path d="M12 8V16" />
    </>
  ),
  5: <path d="M17.5 4H20V6.5L10.5 16L8 13.5L17.5 4ZM6 12L12 18M8.5 15.5L4.5 19.5" />,
  6: <path d="M6 20.5V4M6 4.5H18L15.5 8.5L18 12.5H6" />,
  7: <path d="M12 20.5V11M12 12.5C12 8.5 9.5 6.5 5 6.5C5 10.5 7.5 12.5 12 12.5ZM12 11C12 7.5 14.5 5 19 5C19 9 16.5 11 12 11Z" />,
  8: <path d="M12 4.5A7.5 7.5 0 1 0 12 19.5A7.5 7.5 0 1 0 12 4.5ZM12 9A3 3 0 1 0 12 15A3 3 0 1 0 12 9Z" />,
};

/** 칭호 엠블럼 하나(꾸밈, 화면 읽기에서 숨김). 색은 둘러싼 요소의 grade-N 클래스를 따른다. */
export function TitleEmblem(props: { grade: TitleGrade }) {
  return (
    <svg className="title-emblem" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {TITLE_EMBLEMS[props.grade]}
    </svg>
  );
}

/**
 * 칭호 표식: 엠블럼 + 이름, 등급 색. 칭호가 나오는 모든 화면이 이것 하나를 쓴다.
 * grade가 없으면(알 수 없는 이름 등) 예전처럼 색 없는 테두리 표식이다.
 * compact: 목록 줄(홈 상위 5명·플레이어 랭킹·MMR 순위표·그래프 개인별·검색 결과)에서 쓰는 꼴로, 테두리 없이
 * 등급 색 글자 + 작은 엠블럼만 둔다. 테두리 배지는 개인 통계·두 사람 비교 요약·랭킹 시상대처럼 한 사람을 크게 보일 때.
 */
export function TitleBadge(props: { name: string; grade: TitleGrade | null; compact?: boolean }) {
  const { grade } = props;
  const base = props.compact ? "title-chip compact" : "title-chip";
  return (
    <span className={grade ? `${base} grade-${grade}` : base}>
      {grade && <TitleEmblem grade={grade} />}
      <span className="title-name">{props.name}</span>
    </span>
  );
}

/**
 * 최고의 콤비 표식(shared/bestCombos.ts): 서로가 서로의 잘 맞는 동료인 두 사람에게 똑같이 붙는다.
 * 개인 칭호와 다투지 않게 등급 색 없이 회색 테두리 배지(.tag)로 둔다(CLAUDE.md 5·8절). 근거(함께 n경기·승률·시너지)는
 * 붙이는 화면이 옆 글이나 title로 보여 준다. short는 팀 짜기 줄처럼 좁은 곳용 "콤비"(낭독기에는 전체 이름).
 */
export const COMBO_LABEL = "최고의 콤비";
export function ComboBadge(props: { short?: boolean; title?: string }) {
  return (
    <span className="tag combo-tag" title={props.title}>
      {props.short ? (
        <>
          <span aria-hidden="true">콤비</span>
          <span className="sr-only">{COMBO_LABEL}</span>
        </>
      ) : (
        COMBO_LABEL
      )}
    </span>
  );
}

/**
 * MMR 티어 이름표(rating.ts RATING_TIERS, S~D). 배치 중이면 그리지 않는다.
 * 칭호(TitleBadge)는 테두리형 알약이라 이것은 채움형 네모로 두어 나란히 서도 구분되게 한다.
 */
export function RatingTierBadge(props: { rating: number; placed: boolean }) {
  const tier = ratingTierOf(props.rating, props.placed);
  if (!tier) return null;
  return (
    <span className={`mmr-tier mmr-tier-${tier.key}`}>
      <span className="sr-only">MMR 티어 </span>
      {tier.name}
    </span>
  );
}

/**
 * 배치·칭호 표시. 누적 기준이며 범위 필터와 무관하다(docs/P2 P2-11).
 * 배치 중은 "배치 진행 중 7/10"(10은 모임 설정의 배치 경기 수)으로만 쓰고 낮은 실력처럼 보이게 하지 않는다.
 * 칭호는 구간 순서로 정한 등급 색·엠블럼으로 보여준다(TitleBadge). compact는 목록 줄용(TitleBadge 참고).
 */
export function StandingNote(props: {
  standing: ShownStanding | undefined;
  placementGames: number;
  compact?: boolean;
  /** 목록 머리에 "누적 기준"을 이미 한 번 적었으면 줄마다 되풀이하지 않는다(요약 화면 랭킹 상위). */
  basisInHeading?: boolean;
}) {
  const s = props.standing ?? { games: 0, wins: 0, losses: 0, done: false, title: null, grade: null };
  const basis = props.basisInHeading ? null : "누적 기준";
  if (!s.done) {
    return (
      <span className="standing">
        배치 진행 중 {s.games}/{props.placementGames}
        {basis && ` (${basis})`}
      </span>
    );
  }
  if (!s.title) return <span className="standing">배치 완료{basis && ` (${basis})`}</span>;
  return (
    <span className="standing">
      <TitleBadge name={s.title} grade={s.grade} compact={props.compact} />
      {basis && ` ${basis}`}
    </span>
  );
}
