import { useCallback, useEffect, useState } from "react";
import type { MatchView, Snapshot } from "../../shared/types";
import { ApiFailure, call } from "../api";
import { formatDate, formatTime, nameMap, resultLine } from "../format";
import { MatchTeams } from "../ui";

/** 참가자 편성 화면이 최신 상태를 다시 확인하는 간격. 조회 응답은 ETag로 바뀐 것이 없으면 본문 없이 끝난다. */
const POLL_MS = 30000;

/**
 * 참가자에게 보내는 편성 화면(#/v/토큰/live, 2026-11-07). 로그인 없이 조회 토큰으로 연다.
 * 보여 주는 것: 진행 중 경기의 블루·레드 10명과 포지션, 시작 시각. 진행 중 경기가 없으면 최근 경기 1개.
 * 보여 주지 않는 것: 티어·서포터 횟수·기피 라인(조회 응답에도 없고, 티어를 공개한 모임이어도 이 화면은 그리지 않는다).
 * 휴대폰에서 링크를 열자마자 보이도록 조회 화면(Viewer.tsx, 기록·통계 화면을 함께 씀)과 따로 작은 묶음으로 받는다
 * (src/web/lazyScreens.ts의 공개 화면).
 */
export function ViewerLive(props: { token: string }) {
  const { token } = props;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  // 조회 화면에서 고른 "내 이름"(같은 기기 저장값)이 있으면 그 줄을 강조한다.
  const [myId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`naejeon.me.${token}`);
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
    const timer = setInterval(onVisible, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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

  const tz = snapshot.group.timezone;
  const nameOf = nameMap(snapshot);
  const live = snapshot.matches.find((m) => m.state === "in_progress") ?? null;
  const recent = live ? null : latestMatch(snapshot.matches);

  return (
    <>
      <nav className="viewer-nav" aria-label="조회 메뉴">
        <strong>{snapshot.group.name}</strong>
        <span>
          <a className="link" href={`#/v/${token}/now`}>
            기록 보기
          </a>{" "}
          <a className="link" href={`#/v/${token}/ranking`}>
            랭킹
          </a>
        </span>
      </nav>
      {snapshot.group.maintenance && (
        <p className="note warn viewer-note" role="status">
          운영자가 모임 기록을 점검하는 중이에요. 잠시 뒤 새로 고쳐 주세요.
        </p>
      )}
      <div className="screen live-roster">
        {live ? (
          <>
            <header className="screen-head">
              <h1>{live.matchNo}경기 편성</h1>
              <span className="badge ok">진행 중 · {formatTime(live.startedAt, tz)} 시작</span>
            </header>
            <MatchTeams match={live} nameOf={nameOf} highlightId={myId} />
          </>
        ) : (
          <>
            <h1>편성</h1>
            <p className="note" role="status">
              지금 진행 중인 경기가 없어요.
            </p>
            {recent && (
              <section aria-label="최근 경기">
                <h2>
                  최근 경기 · {recent.matchNo}경기 · {resultLine(recent)}
                </h2>
                <p className="hint">
                  {formatDate(recent.playedAt, tz)} {formatTime(recent.playedAt, tz)}
                </p>
                <MatchTeams match={recent} nameOf={nameOf} highlightId={myId} />
              </section>
            )}
          </>
        )}
        <p className="hint">
          {loadedAt ? `${formatTime(new Date(loadedAt).toISOString())} 확인 · ` : ""}
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
    </>
  );
}

/** 최근 경기: 미진행 취소·전적 제외가 아닌 경기 중 경기 시각이 가장 늦은 것(같으면 번호가 큰 것). */
function latestMatch(matches: readonly MatchView[]): MatchView | null {
  let best: MatchView | null = null;
  for (const m of matches) {
    if (m.state === "canceled" || m.state === "excluded") continue;
    if (!best || m.playedAt > best.playedAt || (m.playedAt === best.playedAt && m.matchNo > best.matchNo)) best = m;
  }
  return best;
}
