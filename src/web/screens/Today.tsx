import { useMemo, useRef, useState } from "react";
import { sessionSummary, sessionSummaryText } from "../../shared/sessionSummary";
import { personRecords, searchByName, todayMatches } from "../../shared/stats";
import { mutate, newRequestId } from "../api";
import { formatDate, formatTime, nameMap, rateTier, standingsOf } from "../format";
import { MatchCard } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import { drawDayImage, drawSessionSummaryImage, fileDate, ShareImageDialog } from "../shareImage";
import { CopyButton, Dialog, ErrorNote, KpiStrip, StandingNote } from "../ui";
import { Dashboard, DashboardEmpty } from "./Dashboard";
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

  const snapshot = app.snapshot;
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const current = snapshot?.matches.find((m) => m.state === "in_progress") ?? null;
  const awaiting = (snapshot?.matches ?? [])
    .filter((m) => m.state === "awaiting_result")
    .sort((a, b) => b.matchNo - a.matchNo);
  const today = useMemo(() => (snapshot ? todayMatches(snapshot) : []), [snapshot]);
  const todayIds = useMemo(() => new Set(today.map((m) => m.id)), [today]);
  const confirmedToday = today.filter((m) => m.state === "confirmed");
  const hasAnyMatch = (snapshot?.matches.length ?? 0) > 0;
  // 전적 검색은 범위 없이 전체 누적 기록에서 찾는다.
  const [query, setQuery] = useState("");
  const allTime = useMemo(() => personRecords(snapshot?.matches ?? []), [snapshot]);
  const standing = useMemo(() => (snapshot ? standingsOf(snapshot) : null), [snapshot]);
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
    <div className="screen home-screen">
      <header className="screen-head">
        <h1>{snapshot?.group.name ?? "내전 운영"}</h1>
        {snapshot && app.loadedAt && (
          <span className="badge ok">
            저장됨 · {formatTime(new Date(app.loadedAt).toISOString())} 확인
          </span>
        )}
      </header>

      {app.ready && !app.me?.accountId && firstVisit && <Intro />}

      {snapshot && <KpiStrip snapshot={snapshot} />}

      {app.loadError && app.loadError.status !== 401 && (
        <p className="note warn" role="alert">
          최신 상태를 불러오지 못했어요. 아래는 마지막으로 받은 내용입니다.{" "}
          <button type="button" className="link" onClick={() => void app.refresh()}>
            다시 불러오기
          </button>
        </p>
      )}

      <section className="card" aria-label="지금 할 일">
        {current ? (
          <>
            <p>
              <strong>{current.matchNo}경기 진행 중</strong> ·{" "}
              {formatTime(current.startedAt, snapshot?.group.timezone)} 시작
            </p>
            <button type="button" className="primary wide" onClick={() => go("/match")}>
              현재 경기 보기
            </button>
          </>
        ) : app.draft ? (
          <>
            <p>
              <strong>작성하던 편성이 있어요</strong> · 이 기기에만 있어요
            </p>
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
        ) : hasAnyMatch ? (
          <>
            <p>
              <strong>오늘 {confirmedToday.length}경기 확정</strong>
            </p>
            <button type="button" className="primary wide" onClick={() => go("/pick")}>
              참가자 고르기
            </button>
          </>
        ) : (
          <>
            <p>아직 경기가 없어요.</p>
            <button type="button" className="primary wide" onClick={() => go("/pick")}>
              이름 넣고 팀 짜기
            </button>
          </>
        )}
      </section>

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

      <section aria-label="전적 검색">
        <h2>전적 검색</h2>
        {allTime.size === 0 ? (
          <p className="hint">경기를 저장하면 이름으로 전적을 찾을 수 있어요.</p>
        ) : (
          <>
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
                <ul className="list">
                  {found.slice(0, 8).map((r) => (
                    <li key={r.participantId}>
                      <button
                        type="button"
                        className="list-row"
                        onClick={() => go(`/p/${r.participantId}`)}
                      >
                        <span className="name">{r.name}</span>
                        <span className="stat">
                          <span className={rateTier(r.wins, r.games)}>
                            {Math.round((r.wins / r.games) * 100)}%
                          </span>{" "}
                          · {r.wins}승 {r.losses}패 (
                          {r.games}경기)
                          <br />
                          <span className="hint">
                            <StandingNote standing={standing?.get(r.participantId)} />
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}
      </section>

      {awaiting.length > 0 && (
        <section aria-label="결과 미입력 경기">
          <h2>결과 미입력 {awaiting.length}경기</h2>
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
          <p className="hint">결과를 넣기 전까지는 통계와 배치 판수에 들어가지 않습니다.</p>
        </section>
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
                onPerson={(id) => go(`/p/${id}`)}
              />
            ))}
          </ul>
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

      {snapshot?.session && !current && (
        <p>
          <button type="button" className="link" disabled={busy} onClick={() => void closeSession()}>
            오늘 내전 마치기
          </button>
        </p>
      )}
      <ErrorNote error={error} />

      {snapshot ? (
        <Dashboard
          snapshot={snapshot}
          skipIds={todayIds}
          openMatch={(id) => go(`/m/${id}`)}
          openPerson={(id) => go(`/p/${id}`)}
          openRanking={() => go("/records")}
        />
      ) : (
        app.ready && <DashboardEmpty />
      )}

      {app.ready && !app.me?.accountId && (
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
          afterSave={(saved) => (
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => setResultFor(null)}>
                닫기
              </button>
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
