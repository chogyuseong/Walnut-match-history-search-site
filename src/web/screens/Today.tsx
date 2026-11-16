import { useMemo, useRef, useState } from "react";
import { sessionSummary, sessionSummaryText } from "../../shared/sessionSummary";
import { isCounted, personRecords, searchByName, todayMatches, placementGamesOf } from "../../shared/stats";
import { mutate, newRequestId } from "../api";
import { formatDate, formatTime, nameMap, rateHueText, rateText, standingsOf } from "../format";
import { MatchCard, useExpectations } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import { drawDayImage, drawSessionSummaryImage, fileDate, ShareImageDialog } from "../shareImage";
import { ScreenHead, StandingNote } from "../screenKit";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { Dashboard } from "./Dashboard";
import { go, useAppValue } from "../useApp";
import { Intro, isFirstVisit } from "./Intro";
import { LoginDialog } from "./Login";
import { ResultSheet } from "./ResultSheet";
import type { MatchView, Snapshot } from "../../shared/types";

/** 화면 1 — 오늘(홈). 상태 카드는 한 번에 하나의 주요 버튼만 낸다. */
export function Today() {
  const app = useAppValue();
  const [resultFor, setResultFor] = useState<MatchView | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const closeRequest = useRef<string | null>(null);
  // "버리기" 직후에만 쓰는 되돌리기.
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // 처음 온 방문자(로그인 안 함, 기기에 기억한 모임·조회 링크·편성 없음)에게만 소개를 맨 위에 붙인다.
  // 이 화면이 열릴 때 한 번만 정한다(소개가 중간에 사라지거나 생겨 화면이 밀리지 않게).
  const [firstVisit] = useState(() => !app.draft && isFirstVisit());
  // 소개가 보이면 그것이 화면 전체다. 기록이 없는 사람에게 "아직 경기가 없어요"·빈 검색·빈 요약 같은 빈 안내를
  // 겹쳐 보여 주지 않는다(CLAUDE.md 8절). 소개의 "로그인 없이 팀 짜기"가 같은 일을 한다.
  const introOnly = app.ready && !app.me?.accountId && firstVisit;

  const snapshot = app.snapshot;
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const expectation = useExpectations(snapshot);
  const current = snapshot?.matches.find((m) => m.state === "in_progress") ?? null;
  const awaiting = (snapshot?.matches ?? [])
    .filter((m) => m.state === "awaiting_result")
    .sort((a, b) => b.matchNo - a.matchNo);
  const today = useMemo(() => (snapshot ? todayMatches(snapshot) : []), [snapshot]);
  const todayIds = useMemo(() => new Set(today.map((m) => m.id)), [today]);
  const confirmedToday = today.filter((m) => m.state === "confirmed");
  const nextFrom = awaiting.find((m) => todayIds.has(m.id)) ?? null;
  const hasAnyMatch = (snapshot?.matches.length ?? 0) > 0;
  // 결과를 저장한 경기(통계에 드는 경기)가 하나라도 있는지. 없으면 전적 검색·요약 대신 "지금 할 일" 안내 하나만 둔다
  // (CLAUDE.md 8절: 빈 통계 패널 여러 개를 보여 주지 않는다). 그래프·기록 화면의 빈 안내와 같은 모양(.empty-state)이다.
  const hasRecord = (snapshot?.matches ?? []).some(isCounted);
  const nothingYet = !current && !app.draft && !hasAnyMatch;
  // 전적 검색은 범위 없이 전체 누적 기록에서 찾는다.
  const [query, setQuery] = useState("");
  const allTime = useMemo(() => personRecords(snapshot?.matches ?? []), [snapshot]);
  const standing = useMemo(() => (snapshot ? standingsOf(snapshot) : null), [snapshot]);
  const placementGames = placementGamesOf(snapshot?.group.settings ?? {});
  const found = searchByName(
    [...allTime.values()].map((r) => ({ ...r, name: nameOf(r.participantId) })),
    query,
  );

  async function closeSession() {
    if (!snapshot) return;
    if (!closeRequest.current) closeRequest.current = newRequestId();
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/session/close`, {
        requestId: closeRequest.current,
        baseLiveVersion: snapshot.group.liveVersion,
      } as { requestId: string });
      closeRequest.current = null;
      await app.refreshAfterOwnChange();
      app.setNotice("오늘 내전을 마쳤어요.");
    } catch (e) {
      closeRequest.current = null;
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen page-wide home-screen">
      {introOnly ? (
        <Intro />
      ) : (
        <ScreenHead
          title={snapshot?.group.name ?? "내전로그"}
          badge={
            snapshot &&
            app.loadedAt && (
              <span className="badge ok">
                저장됨 · {formatTime(new Date(app.loadedAt).toISOString())} 확인
              </span>
            )
          }
          desc="오늘 팀을 짜고 결과를 남기는 곳이에요"
        />
      )}

      {app.loadError && app.loadError.status !== 401 && (
        <p className="note warn" role="alert">
          최신 상태를 불러오지 못했어요. 아래는 마지막으로 받은 내용입니다.{" "}
          <button type="button" className="link" onClick={() => void app.refresh()}>
            다시 불러오기
          </button>
        </p>
      )}

      {!introOnly &&
        (nothingYet ? (
          <section className="empty-state" aria-label="지금 할 일">
            <p>아직 경기가 없어요. 경기 결과를 저장하면 오늘의 결과, 전적 검색, 최근 경기와 랭킹이 여기에 쌓여요.</p>
            <button type="button" className="primary wide" onClick={() => go("/pick")}>
              이름 넣고 팀 짜기
            </button>
          </section>
        ) : (
          // 상태 우선순위: 진행 중 → 작성하던 편성 → 결과 미입력 → 오늘 확정. 제목(h2)이 그 상태의 대표 수치 줄이고
          // 주 버튼은 하나다. 결과 미입력 경기는 상태와 상관없이 카드 아래쪽 줄에 모은다(전적 검색 아래에 두었을 때
          // 미룬 경기를 첫 화면에서 놓쳤다). 결과 입력을 주 버튼으로 올리지 않는 것은 "결과는 나중에"가 일부러 미루는 길이라서다.
          <section className="card now-card" aria-label="지금 할 일">
            <div className="now-head">
              {current ? (
                <div className="now-status">
                  <h2>
                    <span className="now-figure">{current.matchNo}</span>경기 진행 중
                  </h2>
                  <p className="hint">{formatTime(current.startedAt, snapshot?.group.timezone)} 시작</p>
                </div>
              ) : app.draft ? (
                <div className="now-status">
                  <h2>작성하던 편성이 있어요</h2>
                  <p className="hint">이 기기에만 있어요</p>
                </div>
              ) : awaiting.length > 0 ? (
                <div className="now-status">
                  <h2>
                    결과 미입력 <span className="now-figure">{awaiting.length}</span>경기
                  </h2>
                  <p className="hint">결과를 넣기 전까지는 통계와 배치 판수에 들어가지 않습니다.</p>
                </div>
              ) : (
                <div className="now-status">
                  {confirmedToday.length === 0 ? (
                    <h2>오늘은 아직 경기가 없어요</h2>
                  ) : (
                    <h2>
                      오늘 <span className="now-figure">{confirmedToday.length}</span>경기 확정
                    </h2>
                  )}
                </div>
              )}
              <div className="now-actions">
                {current ? (
                  <button type="button" className="primary wide" onClick={() => go("/match")}>
                    현재 경기 보기
                  </button>
                ) : app.draft ? (
                  <>
                    <button type="button" className="primary wide" onClick={() => go("/prep")}>
                      이어서 편성
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        const kept = app.draft;
                        app.setDraft(null);
                        // 확인 창 대신 실행 뒤 되돌리기를 준다.
                        setUndo(() => () => app.setDraft(kept));
                      }}
                    >
                      버리기
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="primary wide" onClick={() => go("/pick")}>
                      참가자 고르기
                    </button>
                    {/* "결과는 나중에"로 넘긴 오늘 경기가 있으면 그 경기에서 이어 짜는 길(같은 팀·오늘 명단의 쉬는 사람)을 남긴다.
                        이 줄이 없으면 결과를 미룬 뒤에는 처음부터 고르기만 남았다.
                        prepareNext는 운영자 화면 묶음(Match.tsx)에 있어 누를 때 불러온다(첫 화면 묶음을 키우지 않게). */}
                    {nextFrom && (
                      <button
                        type="button"
                        className="secondary wide"
                        onClick={() => void import("./Match").then((m) => m.prepareNext(app, nextFrom))}
                      >
                        {nextFrom.matchNo}경기에서 이어 다음 경기 준비
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {awaiting.length > 0 && (
              <div className="now-awaiting">
                {/* 결과 미입력이 대표 수치인 상태에서는 제목이 이미 그 말이라 다시 쓰지 않는다. */}
                {(current || app.draft) && <h3>결과 미입력 {awaiting.length}경기</h3>}
                <ul className="list">
                  {awaiting.map((m) => (
                    <li key={m.id} className="list-row static">
                      <span>
                        {m.matchNo}경기 · {formatTime(m.startedAt, snapshot?.group.timezone)}
                      </span>
                      <button type="button" className="secondary" onClick={() => setResultFor(m)}>
                        결과 입력
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        ))}

      {undo && (
        <p className="note" role="status">
          편성을 버렸어요.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              undo();
              setUndo(null);
            }}
          >
            되돌리기
          </button>
        </p>
      )}

      {today.length > 0 && (
        <section aria-label="오늘의 결과">
          <div className="section-head">
            <h2>오늘의 결과 · {confirmedToday.length}경기 확정</h2>
            {confirmedToday.length > 0 && (
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => setSummaryOpen(true)}>
                  오늘 요약 공유
                </button>
                <button type="button" className="secondary" onClick={() => setImageOpen(true)}>
                  결과 이미지
                </button>
              </div>
            )}
          </div>
          <ul className="list match-cards">
            {[...today].reverse().map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={snapshot?.group.timezone ?? "Asia/Seoul"}
                onOpen={() => go(`/m/${m.id}`)}
                seriesBadge={seriesBadge(m.id)}
                upset={expectation.get(m.id)?.upset}
                onPerson={(id) => go(`/p/${id}`)}
              />
            ))}
          </ul>
        </section>
      )}

      {snapshot?.session && !current && (
        <p>
          <button type="button" className="link" disabled={busy} onClick={() => void closeSession()}>
            오늘 내전 마치기
          </button>
        </p>
      )}
      <ErrorNote error={error} />

      {/* 운영 중에는 덜 쓰는 기능이라 오늘의 결과 아래에 둔다. */}
      {!introOnly && allTime.size > 0 && (
        <section aria-label="전적 검색">
          <h2>전적 검색</h2>
          <input
            type="search"
            aria-label="플레이어 이름으로 전적 검색"
            placeholder="플레이어 이름"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query.trim() !== "" &&
            (found.length === 0 ? (
              <p className="hint">일치하는 이름이 없어요.</p>
            ) : (
              <ul className="list list-card">
                {found.slice(0, 8).map((r) => (
                  <li key={r.participantId}>
                    <button type="button" className="list-row" onClick={() => go(`/p/${r.participantId}`)}>
                      <span className="name">{r.name}</span>
                      <span className="stat">
                        <span className={rateHueText(r.wins, r.games)}>{rateText(r.wins, r.games)}</span> · {r.wins}승{" "}
                        {r.losses}패 ({r.games}경기)
                        <br />
                        <span className="hint">
                          <StandingNote
                            standing={standing?.get(r.participantId)}
                            placementGames={placementGames}
                            compact
                          />
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      {summaryOpen && snapshot && confirmedToday.length > 0 && (
        <SessionSummaryDialog
          snapshot={snapshot}
          today={today}
          nameOf={nameOf}
          onClose={() => setSummaryOpen(false)}
        />
      )}
      {imageOpen && snapshot && confirmedToday.length > 0 && (
        <ShareImageDialog
          title="오늘의 결과 이미지"
          fileName={`오늘의결과-${fileDate(confirmedToday[0]!.playedAt, snapshot.group.timezone)}.png`}
          make={() => drawDayImage(snapshot, today)}
          onClose={() => setImageOpen(false)}
        />
      )}

      {snapshot && hasRecord && (
        <Dashboard
          snapshot={snapshot}
          skipIds={todayIds}
          openMatch={(id) => go(`/m/${id}`)}
          openPerson={(id) => go(`/p/${id}`)}
          openRanking={() => go("/records")}
        />
      )}

      {app.ready && !app.me?.accountId && !introOnly && (
        <p className="hint">
          팀 짜기와 명단 복사는 로그인 없이 됩니다. 경기를 저장하거나 지난 기록을 가져올 때 로그인합니다.
          이미 쓰고 있다면 맨 위 [로그인]을 누르거나{" "}
          <button type="button" className="link" onClick={() => setLoginOpen(true)}>
            여기서 로그인
          </button>
          하세요.
        </p>
      )}

      {loginOpen && (
        <LoginDialog
          reason="저장된 모임과 기록을 불러옵니다."
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      )}

      {resultFor && (
        <ResultSheet
          match={resultFor}
          mode="result"
          nameOf={nameOf}
          onClose={() => setResultFor(null)}
          // 닫기는 창 머리에 이미 있어 여기에 두지 않는다(같은 이름 버튼 둘).
          afterSave={(saved) => (
            <div className="button-row">
              <button type="button" className="link" onClick={() => go(`/m/${saved.id}`)}>
                수정
              </button>
            </div>
          )}
        />
      )}
    </div>
  );
}

/**
 * 오늘 요약 공유 창(2026-11-07). 집계는 src/shared/sessionSummary.ts.
 * 카톡에 붙일 글(복사)과 이미지(결과 이미지 창 재사용)를 함께 준다. 티어 같은 비공개 정보는 넣지 않는다.
 */
function SessionSummaryDialog(props: {
  snapshot: Snapshot;
  today: readonly MatchView[];
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const { snapshot, today, nameOf } = props;
  const [imageOpen, setImageOpen] = useState(false);
  const summary = useMemo(() => sessionSummary(today, snapshot.matches, nameOf), [today, snapshot, nameOf]);
  const tz = snapshot.group.timezone;
  const first = today.find((m) => m.state === "confirmed") ?? today[0];
  const dateLabel = first ? formatDate(first.playedAt, tz) : "";
  const text = sessionSummaryText(summary, snapshot.group.name, dateLabel);
  if (imageOpen) {
    return (
      <ShareImageDialog
        title="오늘 요약 이미지"
        fileName={`오늘요약-${first ? fileDate(first.playedAt, tz) : "내전"}.png`}
        make={() => drawSessionSummaryImage(snapshot, summary, dateLabel)}
        onClose={props.onClose}
      />
    );
  }
  return (
    <Dialog title="오늘 요약 공유" onClose={props.onClose}>
      <p className="hint">확정 경기만 셉니다. 티어 같은 비공개 정보는 넣지 않았어요.</p>
      <pre className="summary-text" aria-label="붙여 넣을 글">
        {text}
      </pre>
      <div className="button-row">
        <CopyButton label="글 복사" text={() => text} />
        <button type="button" className="secondary" onClick={() => setImageOpen(true)}>
          이미지로 만들기
        </button>
      </div>
    </Dialog>
  );
}
