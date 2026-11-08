import type { Draft, DraftPerson } from "../../../shared/draft";
import type { TeamCandidate } from "../../../shared/recommend";
import { TEAM_MARK } from "../../format";
import { Dialog } from "../../ui";
import { prepTeamName } from "./common";
import type { PrepEditing } from "./usePrepEditing";

/** 팀 추천 창: 미리보기 후보 3개(조건이 충돌하면 충돌 조건 목록). 적용을 눌러야 편성이 바뀐다. */
export function RecommendDialog(props: { draft: Draft; candidates: TeamCandidate[]; edit: PrepEditing }) {
  const { draft, candidates, edit } = props;
  const { nameOf } = edit;
  return (
    <Dialog title="팀 추천" onClose={() => edit.setCandidates(null)}>
      {candidates.length === 0 ? (
        <>
          <p className="note warn" role="alert">
            조건을 모두 만족하는 편성이 없어요. 서로 충돌하는 조건을 지워 주세요.
          </p>
          <ul className="list">
            {(draft.constraints ?? []).map((constraint, index) => (
              <li key={`${constraint.a}|${constraint.b}`} className="list-row static">
                <span>
                  {nameOf(constraint.a)} · {nameOf(constraint.b)}{" "}
                  {constraint.kind === "same" ? "같은 팀" : "다른 팀"}
                </span>
                <button type="button" className="link" onClick={() => edit.dropConstraint(index, true)}>
                  조건 지우기
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">
          미리보기입니다. 적용을 눌러야 편성이 바뀌고, 포지션은 새로 뽑습니다.
        </p>
      )}
      {candidates.map((candidate, index) => (
        <section key={candidate.teamA.join(",")} className="candidate">
          <h3>{index === 0 ? "기본 추천" : `다른 후보 ${index}`}</h3>
          <p className="hint">{candidate.reason}</p>
          <p>
            <span aria-hidden="true">{TEAM_MARK.A}</span> {prepTeamName("A")}: {candidate.teamA.map(nameOf).join(", ")}
          </p>
          <p>
            <span aria-hidden="true">{TEAM_MARK.B}</span> {prepTeamName("B")}: {candidate.teamB.map(nameOf).join(", ")}
          </p>
          <button
            type="button"
            className={index === 0 ? "primary" : "secondary"}
            onClick={() => edit.applyCandidate(candidate)}
          >
            적용
          </button>
        </section>
      ))}
    </Dialog>
  );
}

/** 다른 사람으로 교체 창: 편성과 대기자에 없는 활성 참가자 목록. */
export function ReplaceDialog(props: { selectedKey: string; others: DraftPerson[]; edit: PrepEditing }) {
  const { selectedKey, others, edit } = props;
  return (
    <Dialog title={`${edit.nameOf(selectedKey)} 대신 넣을 사람`} onClose={() => edit.setReplacing(false)}>
      <ul className="list">
        {others.map((p) => (
          <li key={p.key}>
            <button type="button" className="list-row" onClick={() => edit.replaceSelected(p)}>
              {p.name}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
