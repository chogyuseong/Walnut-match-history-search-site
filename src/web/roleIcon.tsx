// 라인 아이콘과 "아이콘 + 라인 이름" 표시. 편성·기록·그래프·참가자 편성 화면이 함께 쓴다.
import type { ReactNode } from "react";
import type { Position } from "../shared/types";
import { POSITION_LABEL } from "./format";

/** 라인 아이콘. 디자인 키트가 직접 그린 도형이며 게임의 공식 아이콘이 아니다. */
const ROLE_SHAPES: Record<Position, ReactNode> = {
  top: (
    <>
      <path d="M4 4H19L15.5 7.5H7.5V15.5L4 19V4Z" fill="currentColor" />
      <path
        d="M9.5 9.5H19V19H9.5V9.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeOpacity="0.35"
      />
    </>
  ),
  jungle: (
    <>
      <path
        d="M12 3L16.5 9.5L12 21L7.5 9.5L12 3Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M5 8L10 13M19 8L14 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  mid: (
    <>
      <path d="M19 5L5 19" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M4 4H11L8.5 6.5H6.5V8.5L4 11V4Z" fill="currentColor" fillOpacity="0.45" />
      <path d="M20 20H13L15.5 17.5H17.5V15.5L20 13V20Z" fill="currentColor" fillOpacity="0.45" />
    </>
  ),
  adc: (
    <>
      <path d="M20 20H5L8.5 16.5H16.5V8.5L20 5V20Z" fill="currentColor" />
      <circle cx="10.5" cy="10.5" r="2.5" stroke="currentColor" strokeWidth="1.6" strokeOpacity="0.45" />
    </>
  ),
  support: (
    <>
      <path
        d="M12 4L19 7.5V12.5C19 16.5 16 19.5 12 21C8 19.5 5 16.5 5 12.5V7.5L12 4Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M12 8V16M8.5 11.5H15.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
};

/**
 * 라인 아이콘만(꾸밈). 뜻은 곁의 글자가 전해야 한다.
 * pos-{라인} 클래스로 라인별 색(styles.css의 --pos-*)이 들어간다(2026-11-09, 준비 화면에서 라인이 한눈에 보이게).
 */
export function RoleIcon(props: { position: Position }) {
  return (
    <svg className={`role-icon pos-${props.position}`} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      {ROLE_SHAPES[props.position]}
    </svg>
  );
}

/** 라인 이름과 아이콘. 아이콘은 꾸밈이고 뜻은 글자가 전한다. */
export function PosLabel(props: { position: Position | null }) {
  if (!props.position) return <span className="pos">-</span>;
  // data-pos로 글자와 아이콘에 같은 라인 색을 준다(styles.css .pos[data-pos]).
  return (
    <span className="pos" data-pos={props.position}>
      <RoleIcon position={props.position} />
      {POSITION_LABEL[props.position]}
    </span>
  );
}
