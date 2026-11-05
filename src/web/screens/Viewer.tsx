import { useCallback, useEffect, useState } from "react";
import { resolveMerged } from "../../shared/merge";
import type { Snapshot } from "../../shared/types";
import { ApiFailure, call } from "../api";
import { formatTime, nameMap, POSITION_LABEL, STATE_LABEL } from "../format";
import { Dialog, KpiStrip, MatchTeams } from "../ui";
import { go } from "../useApp";
import { Compare } from "./Compare";
import { Dashboard } from "./Dashboard";
import { Graphs } from "./Graphs";
import { Person } from "./Person";
import { Privacy } from "./Privacy";
import { MatchDetail, Records } from "./Records";
import { Search } from "./Search";

/**
 * 화면 7 — 조회 화면(링크). 로그인이 없고 읽기만 한다.
 * 주소: #/v/토큰/now(현재 경기) · #/v/토큰/m/경기번호 · #/v/토큰/records · #/v/토큰/search
 *       · #/v/토큰/home(모임 요약) · #/v/토큰/compare/A/B(두 사람 비교)
 * 첫 화면(now)은 경기 중 자기 자리를 확인하는 화면이라 그대로 두고, 요약은 메뉴의 "요약"으로 연다.
 * 시작한 경기가 하나도 없으면 첫 화면에 요약을 함께 보여준다.
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

  // 처리방침은 모임을 불러오지 못해도(링크가 만료돼도) 열린다.
  if (rest[0] === "privacy") {
    return <Privacy back={() => go(`/v/${token}/now`)} backLabel="← 조회 화면" />;
  }

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
  // 고른 "내 이름"이 그 뒤 다른 이름에 합쳐졌으면 남은 이름으로 본다(기기 저장값은 그대로 둔다).
  const meId = myId ? resolveMerged(snapshot.participants, myId) : null;
  // 조회 링크의 모든 화면 위에 같은 메뉴와 점검 안내를 둔다.
  const shell = (current: ViewerTab, body: React.ReactNode) => (
    <>
      <ViewerNav base={base} group={snapshot.group.name} current={current} />
      {snapshot.group.maintenance && <MaintenanceNote />}
      {body}
    </>
  );

  if (rest[0] === "records") {
    return shell(
      "records",
        <Records
          snapshot={snapshot}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openGraphs={() => go(`${base}/graphs`)}
        />,
    );
  }
  if (rest[0] === "search") {
    return shell(
      "search",
        <Search
          snapshot={snapshot}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openCompare={(a, b) => go(`${base}/compare/${a}/${b}`)}
        />,
    );
  }
  if (rest[0] === "home") {
    return shell(
      "home",
        <div className="screen">
          <header className="screen-head">
            <h1>{snapshot.group.name} 요약</h1>
          </header>
          <KpiStrip snapshot={snapshot} />
          <Dashboard
            snapshot={snapshot}
            openMatch={(id) => go(`${base}/d/${id}`)}
            openPerson={(id) => go(`${base}/p/${id}`)}
            openRanking={() => go(`${base}/records`)}
          />
        </div>,
    );
  }
  if (rest[0] === "compare") {
    return shell(
      "records",
        <Compare
          snapshot={snapshot}
          a={rest[1] ?? null}
          b={rest[2] ?? null}
          choose={(a, b) => go(`${base}/compare/${a ?? "-"}/${b ?? "-"}`)}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          back={() => go(`${base}/records`)}
        />,
    );
  }
  if (rest[0] === "graphs") {
    return shell(
      "records",
      <Graphs
        snapshot={snapshot}
        openPerson={(id) => go(`${base}/p/${id}`)}
        back={() => go(`${base}/records`)}
      />,
    );
  }
  if (rest[0] === "p" && rest[1]) {
    return shell(
      "records",
      <Person
        snapshot={snapshot}
        participantId={rest[1]}
        back={() => go(`${base}/records`)}
        openMatch={(id) => go(`${base}/d/${id}`)}
        openPerson={(id) => go(`${base}/p/${id}`)}
        openCompare={(id) => go(`${base}/compare/${id}/-`)}
      />,
    );
  }
  if (rest[0] === "d" && rest[1]) {
    return shell(
      "records",
      <MatchDetail
        snapshot={snapshot}
        matchId={rest[1]}
        app={null}
        back={() => go(`${base}/records`)}
      />,
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
  const mySeat = match?.roster.find((r) => r.participantId === meId) ?? null;

  return (
    <>
      <ViewerNav base={base} group={snapshot.group.name} current="now" />
      {snapshot.group.maintenance && <MaintenanceNote />}
      <div className="screen">
        {!match ? (
          <>
            <p>아직 시작한 경기가 없어요.</p>
            <Dashboard
              snapshot={snapshot}
              openMatch={(id) => go(`${base}/d/${id}`)}
              openPerson={(id) => go(`${base}/p/${id}`)}
              openRanking={() => go(`${base}/records`)}
            />
          </>
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
              ) : meId ? (
                <p>{nameOf(meId)} 님은 이 경기에 없어요.</p>
              ) : (
                <p>내 이름을 고르면 내 자리를 먼저 보여드려요.</p>
              )}
              <button type="button" className={myId ? "link" : "primary"} onClick={() => setChoosing(true)}>
                {myId ? "이름 바꾸기" : "내 이름 고르기"}
              </button>
            </section>

            <MatchTeams match={match} nameOf={nameOf} highlightId={meId} />
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

type ViewerTab = "now" | "home" | "search" | "records";

/** 점검 중(백업 복원·모임 삭제 진행 중) 안내. 조회 링크의 모든 화면 맨 위에 둔다. */
function MaintenanceNote() {
  return (
    <p className="note warn viewer-note" role="status">
      운영자가 모임 기록을 점검하는 중이에요(백업 복원 등). 잠시 뒤 새로 고쳐 주세요. 그동안 보이는 내용은
      바뀔 수 있어요.
    </p>
  );
}

function ViewerNav(props: { base: string; group: string; current: ViewerTab }) {
  const item = (tab: ViewerTab, label: string) => (
    <button
      type="button"
      className="link"
      aria-current={props.current === tab ? "page" : undefined}
      onClick={() => go(`${props.base}/${tab}`)}
    >
      {label}
    </button>
  );
  return (
    <nav className="viewer-nav" aria-label="조회 메뉴">
      <strong>{props.group}</strong>
      <span>
        {item("now", "현재 경기")} {item("home", "요약")} {item("search", "검색")} {item("records", "기록")}
      </span>
    </nav>
  );
}
