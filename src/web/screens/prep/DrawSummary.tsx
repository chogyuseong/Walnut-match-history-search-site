import type { DrawResult } from "../../../shared/rotation";
import type { Team } from "../../../shared/types";
import { POSITION_LABEL } from "../../format";
import { allAssignedText, prepTeamName } from "./common";

/** 서포터만 바꾸기 결과를 명단 바로 아래에 이름과 함께 보여준다. 바꿀 수 있는 팀은 이미 바뀌어 있다. */
export function DrawSummary(props: {
  result: DrawResult;
  nameOf: (key: string) => string;
  /** 지금 그 팀 서포터가 아직 서포터를 안 간 사람(0회)인지. 바꾸지 못한 이유 문구를 고른다. */
  supporterIsNew: (team: Team) => boolean;
}) {
  const { result, nameOf } = props;
  return (
    <div className="note" role="status">
      {result.outcomes.map((outcome) =>
        outcome.kind === "blocked" ? (
          outcome.block === "all-assigned" ? null : (
            <p key={outcome.team}>
              {prepTeamName(outcome.team)}:{" "}
              {outcome.block === "supporter-locked"
                ? "서포터 자리가 고정돼 있어요. 고정을 풀거나 직접 자리를 바꿔 주세요."
                : props.supporterIsNew(outcome.team)
                  ? "지금 서포터가 아직 안 간 유일한 사람이라 그대로 두었어요."
                  : "아직 안 간 사람은 포지션이 고정돼 있어 그대로 두었어요. 고정을 풀면 바꿀 수 있어요."}
            </p>
          )
        ) : (
          <p key={outcome.team}>
            {prepTeamName(outcome.team)}: {nameOf(outcome.record!.inKey)}{" "}
            {POSITION_LABEL[outcome.record!.fromPosition]}→서포터, {nameOf(outcome.record!.outKey)}{" "}
            서포터→{POSITION_LABEL[outcome.record!.fromPosition]}, 나머지 유지

          </p>
        ),
      )}
      {result.allAssigned.length > 0 && <p>{allAssignedText(result.allAssigned)}</p>}
    </div>
  );
}
