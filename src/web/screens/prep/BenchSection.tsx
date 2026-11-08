import type { PrepEditing } from "./usePrepEditing";

/** 대기자 구역: 편성에서 한 사람을 고른 뒤 대기자를 누르면 둘이 바뀐다(usePrepEditing.onTapBench). 대기자가 없으면 그리지 않는다. */
export function BenchSection(props: { edit: PrepEditing }) {
  const { bench, selectedKey, nameOf, onTapBench } = props.edit;
  if (bench.length === 0) return null;
  return (
    <section className="prep-tools" aria-label="대기자">
      <h2>대기자 {bench.length}명</h2>
      <p className="hint">
        편성에서 한 사람을 누른 뒤 대기자를 누르면 둘이 바뀌어요. 빠진 사람은 대기자 맨 뒤로 가요. 대기자는 이 기기에만
        있고 경기 기록에는 들어가지 않아요.
      </p>
      <ul className="list" aria-label="대기자 목록">
        {bench.map((p) => (
          <li key={p.key}>
            <button
              type="button"
              className="list-row"
              aria-label={selectedKey ? `${p.name} 님과 ${nameOf(selectedKey)} 님 바꾸기` : `대기자 ${p.name}`}
              onClick={() => onTapBench(p.key)}
            >
              <span className="name">{p.name}</span>
              {selectedKey && <span className="hint">{nameOf(selectedKey)} 님과 바꾸기</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
