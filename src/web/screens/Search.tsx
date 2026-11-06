import { useMemo, useState } from "react";
import { personRecords, searchByName } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { rateTier, standingsOf } from "../format";
import { RateBar, StandingNote } from "../ui";

/**
 * 전적 검색. 운영자와 조회 링크가 같은 화면을 쓴다.
 * 범위 없이 모임 전체 누적 기록에서 찾고, 이름 일치도 순으로 보여준다(배치 여부로 순서를 바꾸지 않는다).
 * 승률·경기 수·배치·칭호는 기록·개인 통계·그래프와 같은 누적 값이다.
 * "두 사람 비교"를 켜면 결과를 눌러 두 사람을 고르고 비교 화면으로 간다.
 */
export function Search(props: {
  snapshot: Snapshot;
  openPerson: (id: string) => void;
  openCompare?: (a: string, b: string) => void;
}) {
  const { snapshot } = props;
  const [query, setQuery] = useState("");
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const records = useMemo(() => personRecords(snapshot.matches), [snapshot]);
  const standing = useMemo(() => standingsOf(snapshot), [snapshot]);
  // 확정된 경기가 있는 사람과, 아직 경기가 없는 활성 참가자를 모두 찾을 수 있다.
  const people = useMemo(
    () =>
      snapshot.participants
        .filter((p) => p.status === "active" || records.has(p.id))
        .map((p) => {
          const r = records.get(p.id);
          return { id: p.id, name: p.name, games: r?.games ?? 0, wins: r?.wins ?? 0, losses: r?.losses ?? 0 };
        }),
    [snapshot, records],
  );
  const found = query.trim() === "" ? [] : searchByName(people, query);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "";

  function choose(id: string) {
    if (!comparing) {
      props.openPerson(id);
      return;
    }
    if (picked.includes(id)) {
      setPicked(picked.filter((p) => p !== id));
      return;
    }
    const next = [...picked, id];
    if (next.length === 2 && props.openCompare) {
      props.openCompare(next[0]!, next[1]!);
      return;
    }
    setPicked(next);
    setQuery("");
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>전적 검색</h1>
        {props.openCompare && (
          <button
            type="button"
            className="secondary"
            aria-pressed={comparing}
            onClick={() => {
              setComparing(!comparing);
              setPicked([]);
            }}
          >
            {comparing ? "비교 그만두기" : "두 사람 비교"}
          </button>
        )}
      </header>
      {comparing && (
        <p className="note" role="status">
          {picked.length === 0
            ? "비교할 첫 번째 사람을 찾아 누르세요."
            : `${nameOf(picked[0]!)} 님과 비교할 두 번째 사람을 찾아 누르세요.`}
        </p>
      )}
      <form
        role="search"
        aria-label="전적 검색"
        onSubmit={(event) => {
          event.preventDefault();
          // 이름이 하나만 맞으면 바로 개인 통계로(비교 중이면 그 사람을 고른다).
          if (found.length === 1) choose(found[0]!.id);
        }}
      >
        <label>
          플레이어 이름
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder="이름 일부만 넣어도 찾아요"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </form>
      <p className="hint">
        모임의 전체 누적 기록에서 찾습니다. 배치와 칭호는 누적 기준이며, 결과 미입력·제외 경기는
        세지 않습니다.
      </p>

      {people.length === 0 ? (
        <p className="hint">아직 참가자가 없어요. 경기를 저장하면 이름으로 전적을 찾을 수 있어요.</p>
      ) : query.trim() === "" ? (
        <p className="hint">참가자 {people.length}명 중에서 찾습니다.</p>
      ) : found.length === 0 ? (
        <p className="hint">일치하는 이름이 없어요.</p>
      ) : (
        <section aria-label="검색 결과">
          <h2>검색 결과 {found.length}명</h2>
          <ul className="list">
            {found.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={picked.includes(r.id) ? "list-row has-bar selected" : "list-row has-bar"}
                  aria-pressed={comparing ? picked.includes(r.id) : undefined}
                  onClick={() => choose(r.id)}
                >
                  <span className="name">{r.name}</span>
                  <span className="stat">
                    {r.games === 0 ? (
                      "확정된 경기 없음"
                    ) : (
                      <>
                        <span className={rateTier(r.wins, r.games)}>
                          {Math.round((r.wins / r.games) * 100)}%
                        </span>{" "}
                        · {r.wins}승 {r.losses}패 ({r.games}경기)
                      </>
                    )}
                    <br />
                    <span className="hint">
                      <StandingNote standing={standing.get(r.id)} />
                    </span>
                  </span>
                  {r.games > 0 && <RateBar wins={r.wins} games={r.games} small />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
