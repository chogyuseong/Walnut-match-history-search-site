import type { Draft } from "../../../shared/draft";
import { avoids } from "../../../shared/avoid";
import { drawStatus, supportCountOf, type RotationContext } from "../../../shared/rotation";
import { POSITIONS, TEAMS } from "../../../shared/types";
import { TEAM_MARK, teamBoxClass } from "../../format";
import { PosLabel } from "../../ui";
import { prepTeamName } from "./common";
import type { PrepEditing } from "./usePrepEditing";

/** 두 팀 명단(왼쪽 블루팀·오른쪽 레드팀). 사람을 누르면 고르기·자리 바꾸기·조건 걸기(usePrepEditing.onTapPerson). */
export function TeamBoards(props: { draft: Draft; ctx: RotationContext; edit: PrepEditing }) {
  const { draft, ctx, edit } = props;
  const { selectedKey, nameOf } = edit;
  return (
    <div className="teams">
      {TEAMS.map((team) => {
        const status = drawStatus(draft, team, ctx);
        return (
          <section key={team} className={teamBoxClass(team, "blue")} aria-label={prepTeamName(team)}>
            <h3>
              <span aria-hidden="true">{TEAM_MARK[team]}</span> {prepTeamName(team)}
            </h3>
            <ul>
              {POSITIONS.map((position) => {
                const slot = draft.slots.find((s) => s.team === team && s.position === position);
                if (!slot) {
                  return (
                    <li key={position} className="row empty">
                      <PosLabel position={position} />
                      <span className="name">(비어 있음)</span>
                    </li>
                  );
                }
                const supportCount = ctx.enabled ? supportCountOf(draft, slot.key, ctx) : 0;
                return (
                  <li key={slot.key}>
                    <button
                      type="button"
                      className={selectedKey === slot.key ? "row picked" : "row"}
                      aria-pressed={selectedKey === slot.key}
                      onClick={() => edit.onTapPerson(slot.key)}
                    >
                      <PosLabel position={position} />
                      <span className="name" title={nameOf(slot.key)}>
                        {nameOf(slot.key)}
                      </span>
                      {slot.locked && <span className="tag">고정</span>}
                      {avoids(edit.avoidMap, slot.key, position) && (
                        <span className="tag avoid-tag" title="기피 라인에 서 있어요">
                          기피
                        </span>
                      )}
                      {supportCount > 0 && <span className="tag">서폿 {supportCount}회</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {status === "stale" && <p className="hint warn-text">서포터 바꾸기 다시 확인 필요</p>}
            {status === "applied" && <p className="hint">서포터 바꾸기 적용됨</p>}
          </section>
        );
      })}
    </div>
  );
}

/** 사람을 골랐을 때의 행동 줄(조건 걸기·고정·교체·취소). 고르지 않았으면 안내 한 줄. */
export function SelectionBar(props: { draft: Draft; edit: PrepEditing; canReplace: boolean }) {
  const { draft, edit } = props;
  const { selectedKey, pairMode, setPairMode, nameOf } = edit;
  if (!selectedKey) return <p className="hint">두 사람을 차례로 누르면 자리가 바뀝니다.</p>;
  return (
    <div className="button-row" role="group" aria-label={`${nameOf(selectedKey)} 선택됨`}>
      <span className="hint">
        {nameOf(selectedKey)} 선택됨.{" "}
        {pairMode === "same"
          ? "같은 팀으로 묶을 사람을 누르세요."
          : pairMode === "different"
            ? "다른 팀으로 나눌 사람을 누르세요."
            : edit.bench.length > 0
              ? "바꿀 사람이나 대기자를 누르세요."
              : "바꿀 사람을 누르세요."}
      </span>
      <button
        type="button"
        className="secondary"
        aria-pressed={pairMode === "same"}
        onClick={() => setPairMode(pairMode === "same" ? null : "same")}
      >
        같은 팀으로 묶기
      </button>
      <button
        type="button"
        className="secondary"
        aria-pressed={pairMode === "different"}
        onClick={() => setPairMode(pairMode === "different" ? null : "different")}
      >
        다른 팀으로 나누기
      </button>
      <button type="button" className="secondary" onClick={edit.toggleSelectedLock}>
        {draft.slots.find((s) => s.key === selectedKey)?.locked ? "고정 해제" : "포지션 고정"}
      </button>
      {props.canReplace && (
        <button type="button" className="secondary" onClick={() => edit.setReplacing(true)}>
          다른 사람으로 교체
        </button>
      )}
      <button type="button" className="link" onClick={edit.clearSelection}>
        선택 취소
      </button>
    </div>
  );
}
