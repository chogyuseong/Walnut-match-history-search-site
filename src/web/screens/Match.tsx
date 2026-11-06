import { useEffect, useRef, useState } from "react";
import { avoidMapFor } from "../../shared/avoid";
import { draftFromMatch } from "../../shared/draft";
import type { MatchView } from "../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../api";
import { formatTime, matchRosterText, nameMap, viewLink } from "../format";
import { CopyButton, Dialog, ErrorNote, MatchTeams, StickyAction } from "../ui";
import { go, useAppValue, type AppValue } from "../useApp";
import { ResultSheet } from "./ResultSheet";

/** 다음 판 준비(후보 A): 초안이 없으면 같은 팀으로 만들고, 있으면 그 초안을 연다. */
export function prepareNext(app: AppValue, from: MatchView): void {
  if (!app.draft && app.snapshot) {
    const nameOf = nameMap(app.snapshot);
    app.setDraft(
      draftFromMatch(from, nameOf, {
        groupId: app.snapshot.group.id,
        baseLiveVersion: app.snapshot.group.liveVersion,
        seed: (Math.random() * 0xffffffff) >>> 0,
        now: new Date().toISOString(),
        // 같은 팀으로 포지션을 새로 뽑을 때도 기피 라인을 되도록 피한다.
        avoid: avoidMapFor(
          from.roster.map((r) => ({ key: `p:${r.participantId}`, participantId: r.participantId })),
          app.snapshot.participants,
        ),
      }),
    );
  }
  go("/prep");
}

/** 화면 4 — 진행 중 경기. 주요 행동은 "결과 입력" 하나다. */
export function Match() {
  const app = useAppValue();
  // 결과를 저장하면 그 경기는 더 이상 "진행 중"이 아니므로, 창에 띄운 경기를 따로 붙잡아 둔다.
  const [sheetMatch, setSheetMatch] = useState<MatchView | null>(null);
  const [sharing, setSharing] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelAsk, setCancelAsk] = useState<null | { needsDecision: boolean }>(null);
  const requestId = useRef<string | null>(null);

  // 진행 중 화면에서는 긴 주기로 최신 상태를 확인한다.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void app.refresh();
    }, 60000);
    return () => clearInterval(timer);
  }, [app.refresh]);

  const snapshot = app.snapshot;
  const match = snapshot?.matches.find((m) => m.state === "in_progress") ?? null;

  const nameOf = nameMap(snapshot);

  // key를 고정해 둔다. 저장 뒤 화면이 "진행 중 경기 없음"으로 바뀌어도
  // 같은 창이 유지돼 "저장됨" 표시와 다음 행동이 사라지지 않는다.
  const sheet = sheetMatch && (
    <ResultSheet
      key="result-sheet"
      match={sheetMatch}
      mode="result"
      nameOf={nameOf}
      onClose={() => {
        setSheetMatch(null);
        // 저장을 마쳤으면 진행 중 경기가 없으므로 홈으로 돌아간다.
        if (!match) go("/");
      }}
      afterSave={(saved) => (
        <div className="button-row">
          <button type="button" className="primary" onClick={() => prepareNext(app, saved)}>
            다음 경기 준비
          </button>
          <button type="button" className="link" onClick={() => go("/records")}>
            기록 보기
          </button>
          <button type="button" className="link" onClick={() => go(`/m/${saved.id}`)}>
            수정
          </button>
        </div>
      )}
    />
  );

  if (!snapshot || !match) {
    return (
      <div className="screen">
        <h1>현재 경기</h1>
        {!sheetMatch && (
          <>
            <p>진행 중인 경기가 없어요.</p>
            <button type="button" className="primary" onClick={() => go("/")}>
              오늘로 가기
            </button>
          </>
        )}
        {sheet}
      </div>
    );
  }

  async function run(action: "end-later" | "cancel", extra: Record<string, unknown> = {}) {
    if (!requestId.current) requestId.current = newRequestId();
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot!.group.id}/matches/${match!.id}/${action}`, {
        requestId: requestId.current,
        baseMatchVersion: match!.version,
        ...extra,
      });
      requestId.current = null;
      setCancelAsk(null);
      await app.refreshAfterOwnChange();
      go("/");
    } catch (e) {
      requestId.current = null;
      if (e instanceof ApiFailure && e.code === "ROTATION_DECISION_REQUIRED") {
        setCancelAsk({ needsDecision: true });
      } else {
        setError(e);
        void app.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/")}>
          ← 오늘
        </button>
        <h1>{match.matchNo}경기 진행 중</h1>
        <span className="badge ok">
          저장됨 · {formatTime(match.startedAt, snapshot.group.timezone)} 시작
        </span>
      </header>

      <MatchTeams match={match} nameOf={nameOf} />

      <div className="button-row">
        <button type="button" className="secondary" onClick={() => setSharing(true)}>
          명단 공유
        </button>
        <button type="button" className="secondary" onClick={() => prepareNext(app, match)}>
          {app.draft ? "다음 초안 열기" : "다음 경기 준비"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void run("end-later")}
        >
          결과는 나중에
        </button>
        <button type="button" className="link" onClick={() => setMore(!more)} aria-expanded={more}>
          ⋯ 더보기
        </button>
      </div>
      {more && (
        <div className="button-row">
          <button type="button" className="danger" onClick={() => setCancelAsk({ needsDecision: false })}>
            미진행 취소
          </button>
          <span className="hint">경기를 하지 않았을 때만 씁니다. 이 경기는 서포터 횟수에서 빠집니다.</span>
        </div>
      )}
      <ErrorNote error={error} />

      <StickyAction>
        <button type="button" className="primary wide" onClick={() => setSheetMatch(match)}>
          결과 입력
        </button>
      </StickyAction>

      {sheet}

      {sharing && snapshot.group.viewToken && (
        <Dialog title="명단 공유" onClose={() => setSharing(false)}>
          <p className="hint">
            링크는 항상 최신 상태를 보여줍니다. 텍스트는 복사한 시점의 내용입니다.
          </p>
          <div className="button-row">
            <CopyButton label="링크 복사" text={() => viewLink(snapshot.group.viewToken!)} />
            <CopyButton
              label="텍스트 복사"
              text={() => matchRosterText(snapshot, match, viewLink(snapshot.group.viewToken!))}
            />
          </div>
        </Dialog>
      )}

      {cancelAsk && (
        <Dialog title="미진행 취소" onClose={() => setCancelAsk(null)}>
          {cancelAsk.needsDecision ? (
            <>
              <p>
                이 경기의 서포터가 뒤 경기에서도 서포터를 했어요. 뒤 경기 기록을 첫 번째 기록으로
                바꿀까요? 서포터 횟수는 어느 쪽이든 같아요.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void run("cancel", { convertRepeats: true })}
                >
                  바꾸고 취소
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run("cancel", { convertRepeats: false })}
                >
                  그대로 두고 취소
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {match.matchNo}경기를 하지 않은 것으로 처리합니다. 전적에 남지 않고 이 경기는 서포터
                횟수에서 빠집니다.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void run("cancel")}
                >
                  {busy ? "저장 중" : "미진행 취소"}
                </button>
                <button type="button" className="secondary" onClick={() => setCancelAsk(null)}>
                  돌아가기
                </button>
              </div>
            </>
          )}
          <ErrorNote error={error} />
        </Dialog>
      )}
    </div>
  );
}
