import { useLayoutEffect, useRef } from "react";
import type { Draft } from "../../../shared/draft";
import { avoids } from "../../../shared/avoid";
import { drawStatus, supportCountOf, type RotationContext } from "../../../shared/rotation";
import { POSITIONS, TEAMS } from "../../../shared/types";
import { TEAM_MARK, teamBoxClass } from "../../format";
import { PosLabel } from "../../ui";
import { prepTeamName } from "./common";
import type { PrepEditing } from "./usePrepEditing";

/**
 * 두 팀 명단(왼쪽 블루팀·오른쪽 레드팀). 사람을 누르면 고르기·자리 바꾸기·조건 걸기(usePrepEditing.onTapPerson).
 * 손으로 배치를 고치는 두 가지 길(2026-11-08):
 * - 끌어다 놓기: 사람을 끌어 다른 사람 자리에 놓으면 둘이 바뀐다(대기자와도). PC 마우스용. 터치에서는 누르기 방식을 쓴다.
 * - 두 사람 차례로 누르기: 첫 사람을 고르면 나머지 자리에 "바꾸기" 표시가 뜬다.
 */
export function TeamBoards(props: { draft: Draft; ctx: RotationContext; edit: PrepEditing }) {
  const { draft, ctx, edit } = props;
  const { selectedKey, nameOf, dragKey, setDragKey, dropPerson } = edit;
  useSlideOnReorder(draft.slots.map((s) => `${s.team}:${s.position}:${s.key}`).join("|"));
  const rowClass = (key: string) =>
    [
      "row",
      selectedKey === key ? "picked" : "",
      dragKey === key ? "dragging" : "",
      dragKey && dragKey !== key ? "drop-target" : "",
      selectedKey && selectedKey !== key && !dragKey ? "swap-target" : "",
    ]
      .filter(Boolean)
      .join(" ");
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
                  <li key={slot.key} data-flip-key={slot.key}>
                    <button
                      type="button"
                      className={rowClass(slot.key)}
                      aria-pressed={selectedKey === slot.key}
                      title={
                        selectedKey && selectedKey !== slot.key
                          ? `${nameOf(selectedKey)} 님과 자리 바꾸기`
                          : "끌어서 다른 자리에 놓거나, 누른 뒤 바꿀 사람을 누르세요"
                      }
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", slot.key);
                        e.dataTransfer.effectAllowed = "move";
                        setDragKey(slot.key);
                      }}
                      onDragEnd={() => setDragKey(null)}
                      onDragOver={(e) => {
                        if (dragKey && dragKey !== slot.key) {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const source = e.dataTransfer.getData("text/plain") || dragKey;
                        if (source) dropPerson(source, slot.key);
                      }}
                      onClick={() => edit.onTapPerson(slot.key)}
                    >
                      <svg className="grip" viewBox="0 0 10 16" aria-hidden="true" focusable="false">
                        <circle cx="3" cy="3" r="1.4" />
                        <circle cx="7" cy="3" r="1.4" />
                        <circle cx="3" cy="8" r="1.4" />
                        <circle cx="7" cy="8" r="1.4" />
                        <circle cx="3" cy="13" r="1.4" />
                        <circle cx="7" cy="13" r="1.4" />
                      </svg>
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
                      {selectedKey && selectedKey !== slot.key && !dragKey && (
                        <span className="tag swap-hint" aria-hidden="true">
                          바꾸기
                        </span>
                      )}
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

/**
 * 자리 바뀜 애니메이션(FLIP, 2026-11-08). 섞기·자리 바꾸기·끌어다 놓기 뒤 각 사람의 줄이 예전 자리에서 새 자리로
 * 0.22초 미끄러져 "누가 어디로 갔는지" 보인다. data-flip-key로 줄을 찾고 Web Animations API만 쓴다(의존성 없음).
 * 움직임 줄이기 설정이면 건너뛴다. 기능과 무관한 꾸밈이라 실패해도 조용히 넘어간다.
 */
function useSlideOnReorder(signature: string) {
  const previous = useRef<Map<string, DOMRect>>(new Map());
  const previousWidth = useRef<number>(0);
  useLayoutEffect(() => {
    const nodes = document.querySelectorAll<HTMLElement>(".teams [data-flip-key]");
    const current = new Map<string, DOMRect>();
    for (const node of nodes) current.set(node.dataset.flipKey!, node.getBoundingClientRect());
    const width = document.querySelector<HTMLElement>(".teams")?.getBoundingClientRect().width ?? 0;
    const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 화면 폭이 바뀌었으면 이전 좌표가 낡은 것이라(다른 배치) 미끄러뜨리지 않는다.
    const sameLayout = previousWidth.current === width;
    previousWidth.current = width;
    if (!reduce && sameLayout && previous.current.size > 0) {
      for (const node of nodes) {
        const before = previous.current.get(node.dataset.flipKey!);
        const after = current.get(node.dataset.flipKey!);
        if (!before || !after) continue;
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        if (Math.abs(dx) > 800 || Math.abs(dy) > 1200) continue;
        try {
          node.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
            { duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)" },
          );
        } catch {
          // 애니메이션을 지원하지 않는 환경이면 그냥 둔다.
        }
      }
    }
    previous.current = current;
  }, [signature]);
}

/** 사람을 골랐을 때의 행동 줄(조건 걸기·고정·교체·취소). 고르지 않았으면 안내 한 줄. */
export function SelectionBar(props: { draft: Draft; edit: PrepEditing; canReplace: boolean }) {
  const { draft, edit } = props;
  const { selectedKey, pairMode, setPairMode, nameOf } = edit;
  if (!selectedKey) {
    return (
      <p className="hint">
        두 사람을 차례로 누르면 자리가 바뀝니다. PC에서는 사람을 끌어다 다른 자리나 대기자에 놓아도 돼요.
      </p>
    );
  }
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
