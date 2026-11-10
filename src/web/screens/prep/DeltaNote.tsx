// 준비 화면 "직전 편성 대비" 한 줄(2026-11-10 실험 A 축소형). 계산은 src/shared/prepDelta.ts, 자리는 Prep.tsx 편성 판 바로 아래.
// 평가 낱말("좋아졌어요")은 쓰지 않고 숫자만 쓴다. 예상 %는 MMR로 낸 추정이라 그렇게 적는다(실제 효과로 읽히지 않게).
import type { DeltaLine } from "../../../shared/prepDelta";

function itemText(line: DeltaLine): string {
  switch (line.kind) {
    case "constraint":
      return `어긴 팀 조건 ${line.from} → ${line.to}개`;
    case "avoid":
      return `기피 라인 ${line.from}명 → ${line.to}명`;
    case "support":
      return `시작 때 확인할 서포터 ${line.from}명 → ${line.to}명`;
    case "lock":
      return `옮겨져 풀린 고정 ${line.to}명`;
    case "repeat":
      return `최근 ${line.matches}경기 같은 팀 반복 ${line.from} → ${line.to}`;
    case "forecast":
      return `예상 블루 ${line.from}% → ${line.to}%(MMR 추정)`;
  }
}

/**
 * 달라진 항목이 없으면 아무것도 그리지 않는다. "방금 변경 되돌리기"는 아래 "직전 편성으로 (N)"과 같은 동작이지만
 * 이름을 다르게 둔다: e2e(prep-walkthrough)가 "직전 편성으로" 버튼 개수로 되돌리기 단계를 센다.
 */
export function DeltaNote(props: { lines: readonly DeltaLine[]; onUndo: () => void }) {
  const { lines } = props;
  if (lines.length === 0) return null;
  const warn = lines.some((l) => l.warn);
  return (
    <p className={warn ? "note warn delta-note" : "note delta-note"} role="status">
      <span className="delta-head">직전 편성 대비</span>
      {lines.map((line) => (
        <span key={line.kind} className={line.warn ? "delta-item warn" : "delta-item"}>
          {" · "}
          {itemText(line)}
        </span>
      ))}{" "}
      <button type="button" className="link" onClick={props.onUndo}>
        방금 변경 되돌리기
      </button>
    </p>
  );
}
