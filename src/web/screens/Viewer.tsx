import { Suspense, useCallback, useEffect, useState } from "react";
import { resolveMerged } from "../../shared/merge";
import type { Snapshot } from "../../shared/types";
import { ApiFailure, call } from "../api";
import { formatTime, nameMap, POSITION_LABEL, STATE_LABEL, teamName } from "../format";
import { ChampionTier } from "../lazyScreens";
import { KpiStrip, MatchTeams, ScreenHead } from "../screenKit";
import { Dialog, LineIcon, type LineIconName } from "../ui";
import { go } from "../useApp";
import { Compare } from "./Compare";
import { Dashboard } from "./Dashboard";
import { Graphs } from "./Graphs";
import { Person } from "./Person";
import { Privacy } from "./Privacy";
import { Ranking } from "./Ranking";
import { MatchDetail, Records } from "./Records";
import { Search } from "./Search";
import { SeasonSummaryScreen, seasonRoutePart, seasonScopeFromRoute } from "./SeasonSummary";

/**
 * 화면 7 — 조회 화면(링크). 로그인이 없고 읽기만 한다.
 * 주소: #/v/토큰/now(현재 경기) · #/v/토큰/m/경기번호 · #/v/토큰/records · #/v/토큰/search(?q=질의, App이 떼어 낸다)
 *       · #/v/토큰/home(모임 요약) · #/v/토큰/ranking(MMR 랭킹) · #/v/토큰/compare/A/B(두 사람 비교)
 *       · #/v/토큰/champions(챔피언 티어)
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
          <>
            <h1>{error.status === 404 ? "링크를 열 수 없어요" : "불러오지 못했어요"}</h1>
            <p className="note error" role="alert">
              {error.status === 404
                ? "이 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요."
                : "잠시 뒤 다시 시도해 주세요."}{" "}
              {error.status !== 404 && (
                <button type="button" className="link" onClick={() => void load()}>
                  다시 불러오기
                </button>
              )}
            </p>
          </>
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
      <div className="bleed-body">
        {snapshot.group.maintenance && <MaintenanceNote />}
        {body}
      </div>
    </>
  );

  const shared = viewerPage(snapshot, base, rest);
  if (shared) return shell(shared.tab, shared.body);

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
      <div className="bleed-body">
      {snapshot.group.maintenance && <MaintenanceNote />}
      <div className={match ? "screen" : "screen page-wide home-screen"}>
        {!match ? (
          <>
            {/* 조회 홈: 화면 제목이 없던 자리(2026-11-08 화면 점검). 모임 이름을 화면 제목으로 둔다. */}
            <ScreenHead title={snapshot.group.name} desc="아직 시작한 경기가 없어요." />
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
                  <strong>{nameOf(mySeat.participantId)}</strong> 님 · {teamName(mySeat.team, match.teamASide)} ·{" "}
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
      </div>
    </>
  );
}

export type ViewerTab = "now" | "home" | "search" | "records" | "ranking" | "champions";

/** 조회·예시 메뉴 칸의 아이콘. 좁은 화면 하단 메뉴에서만 보인다(운영자 주 메뉴와 같은 모양). */
export const VIEWER_TAB_ICON: Record<ViewerTab | "me", LineIconName> = {
  me: "me",
  now: "now",
  home: "summary",
  search: "search",
  records: "records",
  ranking: "ranking",
  champions: "champions",
};

/**
 * 조회 링크와 예시 모임(#/demo, src/web/screens/Demo.tsx)이 같이 쓰는 읽기 전용 화면들.
 * 주소의 나머지(rest)에 맞는 화면이 없으면 null(조회 링크의 "현재 경기"처럼 각자 그린다).
 */
export function viewerPage(
  snapshot: Snapshot,
  base: string,
  rest: string[],
): { tab: ViewerTab; body: React.ReactNode } | null {
  if (rest[0] === "records") {
    return {
      tab: "records",
      body: (
        <Records
          snapshot={snapshot}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openGraphs={() => go(`${base}/graphs`)}
          openRanking={() => go(`${base}/ranking`)}
          openSeason={(scope) => go(`${base}/season/${seasonRoutePart(scope)}`)}
        />
      ),
    };
  }
  if (rest[0] === "ranking") {
    return {
      tab: "ranking",
      body: (
        <Ranking
          snapshot={snapshot}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openChampions={() => go(`${base}/champions`)}
        />
      ),
    };
  }
  if (rest[0] === "champions") {
    return {
      tab: "champions",
      body: (
        // 화면 코드를 받는 동안 메뉴는 그대로 두고 본문 자리만 비운다.
        <Suspense fallback={<p className="screen">불러오는 중…</p>}>
          <ChampionTier
            snapshot={snapshot}
            openMatch={(id) => go(`${base}/d/${id}`)}
            openPerson={(id) => go(`${base}/p/${id}`)}
          />
        </Suspense>
      ),
    };
  }
  if (rest[0] === "season") {
    return {
      tab: "records",
      body: (
      <SeasonSummaryScreen
        snapshot={snapshot}
        scope={seasonScopeFromRoute(rest.slice(1))}
        back={() => go(`${base}/records`)}
        choose={(scope) => go(`${base}/season/${seasonRoutePart(scope)}`)}
      />
      ),
    };
  }
  if (rest[0] === "search") {
    return {
      tab: "search",
      body: (
        <Search
          snapshot={snapshot}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openCompare={(a, b) => go(`${base}/compare/${a}/${b}`)}
          openMatch={(id) => go(`${base}/d/${id}`)}
        />
      ),
    };
  }
  if (rest[0] === "home") {
    return {
      tab: "home",
      body: (
        <div className="screen page-wide home-screen">
          <ScreenHead title={`${snapshot.group.name} 요약`} desc="최근 경기와 순위 · 확정 경기 기준" />
          <KpiStrip snapshot={snapshot} />
          <Dashboard
            snapshot={snapshot}
            headline
            openMatch={(id) => go(`${base}/d/${id}`)}
            openPerson={(id) => go(`${base}/p/${id}`)}
            openRanking={() => go(`${base}/records`)}
          />
        </div>
      ),
    };
  }
  if (rest[0] === "compare") {
    return {
      tab: "records",
      body: (
        <Compare
          snapshot={snapshot}
          a={rest[1] ?? null}
          b={rest[2] ?? null}
          choose={(a, b) => go(`${base}/compare/${a ?? "-"}/${b ?? "-"}`)}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          back={() => go(`${base}/records`)}
        />
      ),
    };
  }
  if (rest[0] === "graphs") {
    return {
      tab: "records",
      body: (
      <Graphs
        snapshot={snapshot}
        openPerson={(id) => go(`${base}/p/${id}`)}
        back={() => go(`${base}/records`)}
        openMatch={(id) => go(`${base}/d/${id}`)}
        player={rest[1] ?? ""}
        choosePlayer={(id) => go(id ? `${base}/graphs/${id}` : `${base}/graphs`)}
      />
      ),
    };
  }
  if (rest[0] === "p" && rest[1]) {
    return {
      tab: "records",
      body: (
      <Person
        snapshot={snapshot}
        participantId={rest[1]}
        back={() => go(`${base}/records`)}
        openMatch={(id) => go(`${base}/d/${id}`)}
        openPerson={(id) => go(`${base}/p/${id}`)}
        openCompare={(id, other) => go(`${base}/compare/${id}/${other ?? "-"}`)}
        openGraphs={(id) => go(`${base}/graphs/${id}`)}
      />
      ),
    };
  }
  if (rest[0] === "d" && rest[1]) {
    return {
      tab: "records",
      body: (
      <MatchDetail
        snapshot={snapshot}
        matchId={rest[1]}
        app={null}
        back={() => go(`${base}/records`)}
        openMatch={(id) => go(`${base}/d/${id}`)}
      />
      ),
    };
  }

  return null;
}

/** 점검 중(백업 복원·모임 삭제 진행 중) 안내. 조회 링크의 모든 화면 맨 위에 둔다. */
export function MaintenanceNote() {
  return (
    <p className="note warn viewer-note" role="status">
      운영자가 모임 기록을 점검하는 중이에요(백업 복원 등). 잠시 뒤 새로 고쳐 주세요. 그동안 보이는 내용은
      바뀔 수 있어요.
    </p>
  );
}

/**
 * 조회 메뉴. member면(참가자로 연결한 모임, src/web/screens/Member.tsx) 맨 앞에 "내 정보"를 둔다.
 * 좁은 화면 하단 고정 줄은 6칸이 한계라("현재 경기"가 넘친다) member일 때 "챔피언"은 넓은 화면에만 두고,
 * 좁은 화면에서는 랭킹 화면 머리의 "챔피언 티어" 링크로 간다(styles.css .nav-wide-only).
 */
export function ViewerNav(props: { base: string; group: string; current: ViewerTab | "me"; member?: boolean }) {
  const item = (tab: ViewerTab | "me", label: string, wideOnly = false) => (
    <button
      type="button"
      className={wideOnly ? "link nav-wide-only" : "link"}
      aria-current={props.current === tab ? "page" : undefined}
      onClick={() => go(`${props.base}/${tab}`)}
    >
      <LineIcon name={VIEWER_TAB_ICON[tab]} />
      {label}
    </button>
  );
  return (
    <nav className="viewer-nav" aria-label="조회 메뉴">
      <strong>{props.group}</strong>
      <span>
        {props.member && <>{item("me", "내 정보")} </>}
        {item("now", "현재 경기")} {item("home", "요약")} {item("search", "검색")} {item("records", "기록")}{" "}
        {item("ranking", "랭킹")} {item("champions", "챔피언", props.member)}
      </span>
    </nav>
  );
}
