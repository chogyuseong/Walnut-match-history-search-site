import { Help } from "../../screenKit";
import { CopyButton } from "../../ui";
import type { NightPoolEditing } from "./useNightPool";
import type { PrepEditing } from "./usePrepEditing";

/**
 * 쉬는 사람 구역(2026-11-10, 예전 "대기자"). 편성 판·직전 대비 줄 바로 아래에 두어 누가 뛰고 누가 쉬는지가 한 단에 이어진다.
 * 편성에서 한 사람을 고른 뒤 이름을 누르면 둘이 바뀐다(usePrepEditing.onTapBench). 쉬는 사람도 오늘 명단도 없으면 그리지 않는다.
 * 오늘 명단이 있을 때만 판 수·빼기·늦게 온 사람·글 복사가 붙는다(예전 초안·다른 기기에서는 예전 대기자 목록 그대로).
 * 진영 색 띠는 쓰지 않는다: 어느 팀에도 속하지 않은 사람들이다.
 */
export function BenchSection(props: { edit: PrepEditing; night: NightPoolEditing; onAddLate: () => void }) {
  const { bench, selectedKey, nameOf, onTapBench, dragKey, setDragKey, dropPerson } = props.edit;
  const { pool, stats, removed } = props.night;
  if (bench.length === 0 && !pool) return null;
  return (
    <section className="prep-tools rest-section" aria-label="쉬는 사람">
      <h2>
        쉬는 사람 {bench.length}명{pool && ` · 오늘 온 ${pool.people.length}명`}
      </h2>
      {removed && (
        <p className="note" role="status">
          {removed.person.name} 님을 오늘 명단에서 뺐어요.{" "}
          <button type="button" className="link" onClick={props.night.undoDrop}>
            되돌리기
          </button>
        </p>
      )}
      {bench.length > 0 && (
        <ul className="list list-card" aria-label="쉬는 사람 목록">
          {bench.map((p) => {
            const stat = stats?.get(p.key);
            return (
              <li
                key={p.key}
                className={`list-row static rest-row${dragKey === p.key ? " dragging" : dragKey ? " drop-target" : ""}`}
              >
                <button
                  type="button"
                  className="row-main"
                  aria-label={selectedKey ? `${p.name} 님과 ${nameOf(selectedKey)} 님 바꾸기` : `쉬는 사람 ${p.name}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", p.key);
                    e.dataTransfer.effectAllowed = "move";
                    setDragKey(p.key);
                  }}
                  onDragEnd={() => setDragKey(null)}
                  onDragOver={(e) => {
                    if (dragKey && dragKey !== p.key) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const source = e.dataTransfer.getData("text/plain") || dragKey;
                    if (source) dropPerson(source, p.key);
                  }}
                  onClick={() => onTapBench(p.key)}
                >
                  <span className="name">{p.name}</span>
                  {selectedKey ? (
                    <span className="hint rest-swap">{nameOf(selectedKey)} 님과 바꾸기</span>
                  ) : (
                    stat && (
                      <>
                        <span className="rest-num">오늘 {stat.games}경기</span>
                        <span className="rest-num">{stat.playStreak > 0 ? `연속 ${stat.playStreak}판` : ""}</span>
                      </>
                    )
                  )}
                </button>
                {pool && (
                  <button
                    type="button"
                    className="link"
                    aria-label={`${p.name} 오늘 명단에서 빼기`}
                    onClick={() => props.night.drop(p.key)}
                  >
                    빼기
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint">편성에서 한 사람을 누른 뒤 여기 이름을 누르면 둘이 바뀌어요.</p>
      {pool && (
        <div className="button-row">
          <button type="button" className="secondary" onClick={props.onAddLate}>
            + 늦게 온 사람
          </button>
        </div>
      )}
      <Help label={pool ? "쉬는 순서 정하는 법" : undefined}>
        {pool ? (
          <>
            <p>
              쉬던 사람은 다음 판에 모두 들어와요. 빠지는 사람은 연속으로 가장 오래 뛴 사람 → 오늘 경기가 많은 사람 → 오늘 명단
              앞쪽 순이에요. 정해 둔 규칙일 뿐이라 손으로 바꿔도 돼요. 결과를 안 넣은 경기도 뛴 판으로 세고, 미진행 취소한 경기는
              세지 않아요.
            </p>
            <p>PC에서는 끌어다 놓아도 돼요. 빠진 사람은 쉬는 사람 맨 뒤로 가요.</p>
            <p>오늘 명단은 이 기기에만 있어요. 다른 기기에서 이어 가려면 글을 복사해 그 기기의 참가자 고르기에 붙여 넣어요.</p>
            <div className="button-row">
              <CopyButton label="오늘 명단 글 복사" text={props.night.text} />
            </div>
          </>
        ) : (
          <>
            <p>PC에서는 끌어다 놓아도 돼요. 빠진 사람은 쉬는 사람 맨 뒤로 가요.</p>
            <p>쉬는 사람은 이 기기에만 있고 경기 기록에는 들어가지 않아요.</p>
          </>
        )}
      </Help>
    </section>
  );
}
