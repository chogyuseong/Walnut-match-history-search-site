import { useMemo, useState } from "react";
import { historyOf, isCompleteDraft, type Draft, type DraftPerson } from "../../shared/draft";
import { draftBalance, laneMatchups } from "../../shared/prepTools";
import { rotationContext, supportCountOf } from "../../shared/rotation";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { draftRosterText } from "../format";
import { CopyButton, ErrorNote, StickyAction } from "../ui";
import { go, useAppValue, type AppValue } from "../useApp";
import { LoginDialog } from "./Login";
import { BalanceSection } from "./prep/BalanceSection";
import { BenchSection } from "./prep/BenchSection";
import { ConstraintsSection } from "./prep/ConstraintsSection";
import { DraftImageDialog } from "./prep/DraftImage";
import { DrawSummary } from "./prep/DrawSummary";
import { RecommendDialog, ReplaceDialog } from "./prep/EditDialogs";
import { MatchupSection } from "./prep/MatchupSection";
import { SeriesSection } from "./prep/SeriesSection";
import { ShuffleSection, SideSection } from "./prep/ShuffleSection";
import { StartAskDialog } from "./prep/StartAskDialog";
import { SupportCountSection } from "./prep/SupportCountSection";
import { SelectionBar, TeamBoards } from "./prep/TeamBoards";
import { usePrepEditing } from "./prep/usePrepEditing";
import { usePrepStart, type PrepStatus } from "./prep/usePrepStart";

/**
 * 화면 3 — 다음 경기 준비. 주요 행동은 "이 팀으로 시작" 하나다. 결과 저장 버튼은 없다.
 * 구역별 화면은 ./prep/*, 편성 고치기는 usePrepEditing, 시작 흐름(검증·확인 창·저장·재시도)은 usePrepStart.
 */
export function Prep() {
  const app = useAppValue();
  if (!app.draft) {
    return (
      <div className="screen">
        <h1>다음 경기 준비</h1>
        <p>작성 중인 편성이 없어요.</p>
        <button type="button" className="primary" onClick={() => go("/pick")}>
          참가자 고르기
        </button>
      </div>
    );
  }
  return <PrepEditor app={app} draft={app.draft} />;
}

/** 작성 중인 편성이 있을 때의 준비 화면. draft가 늘 있으므로 안쪽에서 null 확인을 반복하지 않는다. */
function PrepEditor(props: { app: AppValue; draft: Draft }) {
  const { app, draft } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const status: PrepStatus = { busy, setBusy, error, setError };

  const ctx = useMemo(
    () =>
      rotationContext(
        app.snapshot?.group.settings.rotationEnabled ?? true,
        app.snapshot?.rotation ?? null,
      ),
    [app.snapshot],
  );
  const edit = usePrepEditing(app, draft, ctx, setError);
  const start = usePrepStart(app, draft, status);
  const { update, nameOf, bench } = edit;

  const baseChanged =
    draft.baseLiveVersion !== null &&
    app.snapshot !== null &&
    draft.groupId === app.snapshot.group.id &&
    draft.baseLiveVersion !== app.snapshot.group.liveVersion;

  const sourceMatch =
    draft.origin === "same-teams"
      ? ([...(app.snapshot?.matches ?? [])]
          .filter((m) => m.state !== "canceled" && m.source === "live")
          .sort((a, b) => b.matchNo - a.matchNo)[0] ?? null)
      : null;

  // 다른 사람으로 교체 목록: 편성과 대기자에 없는 활성 참가자(대기자는 아래 "대기자" 구역에서 바로 바꾼다).
  const others: DraftPerson[] = (app.snapshot?.participants ?? [])
    .filter(
      (p) =>
        p.status === "active" &&
        !draft.people.some((d) => d.participantId === p.id) &&
        !bench.some((b) => b.participantId === p.id),
    )
    .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));

  // 편성 균형: 티어는 운영자만 보는 정보라 로그인했고 모임 참가자 정보(운영자 응답)가 있을 때만 보여 준다.
  const showBalance =
    !!app.me?.accountId &&
    app.snapshot !== null &&
    app.snapshot.role === "operator" &&
    app.snapshot.participants.length > 0 &&
    draft.people.some((p) => p.participantId !== null);
  const balance =
    showBalance && app.snapshot
      ? draftBalance(draft, edit.priorityMap(), app.snapshot.group.settings.groupWeights ?? DEFAULT_SETTINGS.groupWeights)
      : null;
  // 라인 맞대결: 지난 확정 경기에서 같은 라인의 두 사람이 서로 다른 팀으로 만난 전적(왼쪽 = 블루팀 사람 기준).
  const matchups = app.snapshot ? laneMatchups(draft, app.snapshot.matches) : null;
  const undoSteps = historyOf(draft).length;
  const complete = isCompleteDraft(draft);

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/")}>
          ← 오늘
        </button>
        <h1>다음 경기 준비</h1>
        <span className="badge">이 기기에만 있어요</span>
      </header>

      {!app.storageOk && (
        <p className="note warn" role="alert">
          이 기기에 편성을 보관할 수 없어요. 창을 닫으면 사라집니다.
        </p>
      )}
      {baseChanged && app.snapshot && (
        <p className="note warn" role="status">
          다른 기기에서 경기 상태가 바뀌었어요. 작성 내용은 그대로 두었습니다.{" "}
          <button type="button" className="link" onClick={() => go("/")}>
            현재 상태 보기
          </button>{" "}
          <button
            type="button"
            className="link"
            onClick={() => update({ ...draft, baseLiveVersion: app.snapshot!.group.liveVersion })}
          >
            확인했어요
          </button>
        </p>
      )}
      {draft.origin === "same-teams" && sourceMatch && (
        <p className="note" role="status">
          지난 경기와 같은 팀이에요. 포지션은 새로 뽑았어요.{" "}
          <button type="button" className="link" onClick={() => edit.keepPositions(sourceMatch)}>
            포지션 유지
          </button>{" "}
          <button type="button" className="link" onClick={edit.showRecommendations}>
            팀 다시 짜기
          </button>
        </p>
      )}

      <TeamBoards draft={draft} ctx={ctx} edit={edit} />
      <SelectionBar draft={draft} edit={edit} canReplace={others.length > 0} />
      <BenchSection edit={edit} />
      {matchups && <MatchupSection matchups={matchups} nameOf={nameOf} />}
      {balance && <BalanceSection balance={balance} />}
      <ShuffleSection ctx={ctx} edit={edit} />
      <SideSection edit={edit} />

      {edit.drawNote && (
        <DrawSummary
          result={edit.drawNote}
          nameOf={nameOf}
          supporterIsNew={(team) => {
            const key = draft.slots.find((s) => s.team === team && s.position === "support")?.key;
            return key !== undefined && supportCountOf(draft, key, ctx) === 0;
          }}
        />
      )}

      <ConstraintsSection draft={draft} edit={edit} />
      <SupportCountSection app={app} draft={draft} ctx={ctx} status={status} clearDrawNote={() => edit.setDrawNote(null)} />
      <SeriesSection draft={draft} snapshot={app.snapshot} update={update} />

      <div className="button-row">
        <CopyButton label="명단 텍스트 복사" text={() => draftRosterText(draft)} />
        <button
          type="button"
          className="secondary"
          title="블루팀·레드팀 명단을 이미지로 만들어 공유하거나 내려받아요. 티어·서포터 횟수는 넣지 않아요."
          onClick={() => setImageOpen(true)}
        >
          편성 이미지
        </button>
        {undoSteps > 0 && (
          <button
            type="button"
            className="link"
            title={`최근 ${undoSteps}단계까지 되돌릴 수 있어요.`}
            onClick={() => edit.stepHistory("undo")}
          >
            직전 편성으로 ({undoSteps})
          </button>
        )}
        {draft.redoSlots && (
          <button
            type="button"
            className="link"
            title="방금 되돌린 편성으로 다시 가요."
            onClick={() => edit.stepHistory("redo")}
          >
            다시 앞으로
          </button>
        )}
        <button type="button" className="link" onClick={() => go("/pick")}>
          참가자 다시 고르기
        </button>
      </div>

      <ErrorNote error={error} onCheck={start.retryLast} />

      <StickyAction>
        <button
          type="button"
          className="primary wide"
          disabled={busy || !complete}
          onClick={() => void start.beginStart()}
        >
          {busy ? "저장 중" : "이 팀으로 시작"}
        </button>
      </StickyAction>

      {edit.candidates && <RecommendDialog draft={draft} candidates={edit.candidates} edit={edit} />}
      {edit.replacing && edit.selectedKey && (
        <ReplaceDialog selectedKey={edit.selectedKey} others={others} edit={edit} />
      )}
      {imageOpen && <DraftImageDialog draft={draft} snapshot={app.snapshot} onClose={() => setImageOpen(false)} />}

      {start.needLogin && (
        <LoginDialog
          reason="경기를 저장하려면 로그인이 필요해요. 지금 짠 편성은 그대로 있어요."
          onClose={() => start.setNeedLogin(false)}
          onDone={() => {
            start.setNeedLogin(false);
            void start.beginStart(true);
          }}
        />
      )}

      {start.ask && <StartAskDialog draft={draft} ask={start.ask} start={start} busy={busy} error={error} />}
    </div>
  );
}
