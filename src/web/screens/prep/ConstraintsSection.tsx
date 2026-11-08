import { violatedConstraints, type Draft } from "../../../shared/draft";
import type { PrepEditing } from "./usePrepEditing";

/** 팀 조건(같은 팀·다른 팀) 목록. 조건이 없으면 그리지 않는다. */
export function ConstraintsSection(props: { draft: Draft; edit: PrepEditing }) {
  const { draft, edit } = props;
  const constraints = draft.constraints ?? [];
  if (constraints.length === 0) return null;
  return (
    <details open>
      <summary>팀 조건 {constraints.length}개</summary>
      <ul className="list">
        {constraints.map((constraint, index) => {
          const broken = violatedConstraints(draft).includes(constraint);
          return (
            <li key={`${constraint.a}|${constraint.b}`} className="list-row static">
              <span>
                {edit.nameOf(constraint.a)} · {edit.nameOf(constraint.b)}{" "}
                {constraint.kind === "same" ? "같은 팀" : "다른 팀"}
                {broken && <span className="tag">지금 편성과 다름</span>}
              </span>
              <button type="button" className="link" onClick={() => edit.dropConstraint(index)}>
                조건 지우기
              </button>
            </li>
          );
        })}
      </ul>
      <p className="hint">
        조건은 팀 추천과 팀·라인 모두 섞기에 적용됩니다(팀·라인 모두 섞기는 티어 균형이 먼저예요). 손으로 자리를 바꾸는 것은
        막지 않습니다.
      </p>
    </details>
  );
}
