import { useCallback, useEffect, useState } from "react";
import type { Snapshot } from "../../shared/types";
import { ApiFailure, call } from "../api";
import { formatTime, nameMap, POSITION_LABEL, STATE_LABEL } from "../format";
import { Dialog, MatchTeams } from "../ui";
import { go } from "../useApp";
import { Graphs } from "./Graphs";
import { Person } from "./Person";
import { MatchDetail, Records } from "./Records";

/**
 * 화면 7 — 조회 화면(링크). 로그인이 없고 읽기만 한다.
 * 주소: #/v/토큰/now(현재 경기) · #/v/토큰/m/경기번호 · #/v/토큰/records
 */
export function Viewer(props: { token: string; rest: string[] }) {
  const { token, rest } = props;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [choosing, setChoosing] = useState(false);
  const meKey = `naejeon.me.${token}`;
  const [myId, setMyId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(meKey);
    } catch {
      return null;
    }
  });

  const load = useCallback(async () => {
    try {
      setSnapshot(await call<Snapshot>("GET", `/api/view/${token}`));
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      if (e instanceof ApiFailure) setError(e);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  if (!snapshot) {
    return (
      <div className="screen">
        {error ? (
          <p className="note warn" role="alert">
            {error.status === 404
              ? "이 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요."
              : "불러오지 못했어요."}{" "}
            {error.status !== 404 && (
              <button type="button" className="link" onClick={() => void load()}>
                다시 불러오기
              </button>
            )}
          </p>
        ) : (
          <p>불러오는 중…</p>
        )}
      </div>
    );
  }

  const base = `/v/${token}`;
  const nameOf = nameMap(snapshot);

  if (rest[0] === "records") {
    return (
      <>
        <ViewerNav base={base} group={snapshot.group.name} />
        <Records
          snapshot={snapshot}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openGraphs={() => go(`${base}/graphs`)}
        />
      </>
    );
  }
  if (rest[0] === "graphs") {
    return (
      <Graphs
        snapshot={snapshot}
        openPerson={(id) => go(`${base}/p/${id}`)}
        back={() => go(`${base}/records`)}
      />
    );
  }
  if (rest[0] === "p" && rest[1]) {
    return (
      <Person
        snapshot={snapshot}
        participantId={rest[1]}
        back={() => go(`${base}/records`)}
        openMatch={(id) => go(`${base}/d/${id}`)}
        openPerson={(id) => go(`${base}/p/${id}`)}
      />
    );
  }
  if (rest[0] === "d" && rest[1]) {
    return (
      <MatchDetail
        snapshot={snapshot}
        matchId={rest[1]}
        app={null}
        back={() => go(`${base}/records`)}
      />
    );
  }

  const current =
    snapshot.matches.find((m) => m.state === "in_progress") ??
    [...snapshot.matches]
      .filter((m) => m.state !== "canceled" && m.source === "live")
      .sort((a, b) => b.matchNo - a.matchNo)[0] ??
    null;
  // 특정 경기 링크: 경기 번호로 찾는다.
  const requested =
    rest[0] === "m" && rest[1]
      ? (snapshot.matches.find((m) => String(m.matchNo) === rest[1]) ?? null)
      : null;
  const match = requested ?? current;
  const mySeat = match?.roster.find((r) => r.participantId === myId) ?? null;

  return (
    <>
      <ViewerNav base={base} group={snapshot.group.name} />
      <div className="screen">
        {!match ? (
          <p>아직 시작한 경기가 없어요.</p>
        ) : (
          <>
            <header className="screen-head">
              <h1>
                {match.matchNo}경기 · {STATE_LABEL[match.state]}
              </h1>
              <span className="badge">확정 명단</span>
            </header>

            {requested && current && requested.id !== current.id && (
              <p className="note" role="status">
                지금 진행 중인 경기가 아니에요.{" "}
                <button type="button" className="link" onClick={() => go(`${base}/now`)}>
                  현재 경기 보기
                </button>
              </p>
            )}

            <section className="card">
              {mySeat ? (
                <p>
                  <strong>{nameOf(mySeat.participantId)}</strong> 님 · 팀 {mySeat.team} ·{" "}
                  {mySeat.position ? POSITION_LABEL[mySeat.position] : "포지션 없음"}
                </p>
              ) : myId ? (
                <p>{nameOf(myId)} 님은 이 경기에 없어요.</p>
              ) : (
                <p>내 이름을 고르면 내 자리를 먼저 보여드려요.</p>
              )}
              <button type="button" className={myId ? "link" : "primary"} onClick={() => setChoosing(true)}>
                {myId ? "이름 바꾸기" : "내 이름 고르기"}
              </button>
            </section>

            <MatchTeams match={match} nameOf={nameOf} highlightId={myId} />
            <p className="hint">팀 편성 기준은 운영자가 정합니다.</p>
          </>
        )}

        <p className="hint">
          {loadedAt ? `${formatTime(new Date(loadedAt).toISOString())} 확인` : ""}{" "}
          <button type="button" className="link" onClick={() => void load()}>
            새로 고침
          </button>
        </p>
        {error && (
          <p className="note warn" role="alert">
            최신 상태를 불러오지 못했어요. 위는 마지막으로 받은 내용입니다.
          </p>
        )}
      </div>

      {choosing && (
        <Dialog title="내 이름 고르기" onClose={() => setChoosing(false)}>
          <p className="hint">
            이 기기에서 내 자리를 먼저 보여주기 위한 설정입니다. 언제든 바꿀 수 있어요.
          </p>
          <ul className="list">
            {(match?.roster ?? []).map((r) => (
              <li key={r.participantId}>
                <button
                  type="button"
                  className="list-row"
                  onClick={() => {
                    setMyId(r.participantId);
                    try {
                      localStorage.setItem(meKey, r.participantId);
                    } catch {
                      // 보관하지 못하면 이번 방문에만 적용된다.
                    }
                    setChoosing(false);
                  }}
                >
                  {nameOf(r.participantId)}
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </>
  );
}

function ViewerNav(props: { base: string; group: string }) {
  return (
    <nav className="viewer-nav" aria-label="조회 메뉴">
      <strong>{props.group}</strong>
      <span>
        <button type="button" className="link" onClick={() => go(`${props.base}/now`)}>
          현재 경기
        </button>{" "}
        <button type="button" className="link" onClick={() => go(`${props.base}/records`)}>
          기록
        </button>
      </span>
    </nav>
  );
}
