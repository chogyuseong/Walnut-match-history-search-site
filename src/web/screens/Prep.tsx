import { useMemo, useState } from "react";
import { historyOf, isCompleteDraft, type DraftPerson } from "../../shared/draft";
import { draftForecast } from "../../shared/forecast";
import type { NightDraft } from "../../shared/nightPool";
import { draftDelta, type DeltaLine } from "../../shared/prepDelta";
import { draftBalance, draftSplitRanks } from "../../shared/prepTools";
import { computeRatings, ratingOptionsOf } from "../../shared/rating";
import { diversityFor } from "../../shared/recommend";
import { resetCountsReady, rotationContext, supportCountOf } from "../../shared/rotation";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { draftRosterText, josa, POSITION_LABEL } from "../format";
import { BackLink, StickyAction, useMediaQuery } from "../screenKit";
import { CopyButton, ErrorNote } from "../ui";
import { go, useAppValue, type AppValue } from "../useApp";
import { LoginDialog } from "./Login";
import { BenchSection } from "./prep/BenchSection";
import { ConstraintsSection } from "./prep/ConstraintsSection";
import { DraftImageDialog } from "./prep/DraftImage";
import { DeltaNote } from "./prep/DeltaNote";
import { DrawSummary } from "./prep/DrawSummary";
import { ForecastSection } from "./prep/ForecastSection";
import { LateDialog, RecommendDialog, ReplaceDialog } from "./prep/EditDialogs";
import { SeriesSection } from "./prep/SeriesSection";
import { ShuffleSection, SideSection } from "./prep/ShuffleSection";
import { StartAskDialog } from "./prep/StartAskDialog";
import { supportCountLabel, SupportCountSection } from "./prep/SupportCountSection";
import { SelectionBar, TeamBoards } from "./prep/TeamBoards";
import { useNightPool } from "./prep/useNightPool";
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
        <header className="screen-head">
          <BackLink label="← 오늘" fallback={() => go("/")} />
          <h1>다음 경기 준비</h1>
        </header>
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
function PrepEditor(props: { app: AppValue; draft: NightDraft }) {
  const { app, draft } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [imageOpen, setImageOpen] = useState(false);
  // 서포터 횟수 판: 버튼(섞기 기준 줄)으로 여닫는다. 기본은 접어 둔다(펼치면 폰에서 섞기 버튼이 편성 판에서 멀어진다).
  // 한 팀이 모두 배정받아 초기화가 필요하면 접힌 버튼에 "초기화 필요" 배지로 알린다(2026-11-08 화면 점검).
  const [supportOpen, setSupportOpen] = useState(false);
  const [lateOpen, setLateOpen] = useState(false);
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
  const night = useNightPool(app, draft, update);

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

  // 쉬던 사람을 넣어 만든 초안의 원래 경기("같은 10명으로"가 다시 만들 10명).
  const rotatedFrom = app.snapshot?.matches.find((m) => m.id === draft.sourceMatchId) ?? null;

  // 다른 사람으로 교체 목록: 편성과 대기자에 없는 활성 참가자(대기자는 아래 "대기자" 구역에서 바로 바꾼다).
  const others: DraftPerson[] = (app.snapshot?.participants ?? [])
    .filter(
      (p) =>
        p.status === "active" &&
        !draft.people.some((d) => d.participantId === p.id) &&
        !bench.some((b) => b.participantId === p.id),
    )
    .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));

  // 티어 점수(예상 승률 판 아래 접힘): 티어는 운영자만 보는 정보라 로그인했고 모임 참가자 정보(운영자 응답)가 있을 때만 보여 준다.
  const showBalance =
    !!app.me?.accountId &&
    app.snapshot !== null &&
    app.snapshot.role === "operator" &&
    app.snapshot.participants.length > 0 &&
    draft.people.some((p) => p.participantId !== null);
  const groupWeights = app.snapshot?.group.settings.groupWeights ?? DEFAULT_SETTINGS.groupWeights;
  const balance = showBalance ? draftBalance(draft, edit.priorityMap(), groupWeights) : null;
  // 직전 자리의 티어 점수: 예상 승률 판의 접힌 "티어 점수 보기" 안에만 쓴다(직전 편성 대비 줄에는 넣지 않는다).
  const previousBalance =
    // 되돌린 직후에는 previousSlots가 두 단계 전 자리라 "직전"이 아니다(DeltaNote도 이때는 줄을 숨긴다).
    balance && draft.previousSlots && !draft.redoSlots
      ? draftBalance({ ...draft, slots: draft.previousSlots }, edit.priorityMap(), groupWeights)
      : null;
  // 예상 승률 판: MMR은 스냅숏이 바뀔 때만 다시 계산하고(경기 전체를 훑는다), 편성 쪽은 매번 가볍게 계산한다.
  // MMR·라인 전적·맞대결은 공개 전적에서 나오므로 조회자에게도 보이고, 티어(balance)만 위 조건으로 숨긴다.
  const ratingOptions = ratingOptionsOf(app.snapshot?.group.settings ?? {});
  const ratings = useMemo(
    () => (app.snapshot ? computeRatings(app.snapshot.matches, ratingOptionsOf(app.snapshot.group.settings)) : null),
    [app.snapshot],
  );
  const forecast = app.snapshot && ratings ? draftForecast(draft, ratings, app.snapshot.matches, ratingOptions) : null;
  // 균형 순위(126가지 중 몇 위): 자리를 바꿀 때마다 다시 센다(126번 × 10명이라 가볍다). 티어 쪽은 티어 점수와 같은 조건.
  const splitRanks = ratings
    ? draftSplitRanks(draft, ratings, ratingOptions.start, balance ? { priorityOf: edit.priorityMap(), groupWeights } : null)
    : null;
  // 직전 편성 대비 줄의 "같은 팀 반복": 추천 창과 같은 최근 경기 수·같은 설정(꺼져 있으면 항목이 없다).
  const diversity = useMemo(
    () =>
      app.snapshot
        ? diversityFor({ matches: app.snapshot.matches, settings: app.snapshot.group.settings }, draft.people)
        : undefined,
    [app.snapshot, draft.people],
  );
  let delta: DeltaLine[] = [];
  try {
    // 되돌린 직후(redoSlots 있음)에는 그리지 않는다. 그때 previousSlots는 한 단계 더 앞의 자리라 "방금 변경"이 아니다.
    if (!draft.redoSlots) delta = draftDelta(draft, { avoid: edit.avoidMap, ctx, diversity, ratings, ratingOptions });
  } catch {
    // 참고용 한 줄이라 계산이 실패해도 편성 조작과 시작 버튼을 막지 않는다(설계 5절 실패 처리). 줄만 그리지 않는다.
  }
  const undoSteps = historyOf(draft).length;
  const complete = isCompleteDraft(draft);
  const needsReset = resetCountsReady(draft, ctx);
  // styles.css의 .prep-layout 두 단 기준과 같은 값이어야 한다.
  const twoColumns = useMediaQuery("(min-width: 1200px)");
  const shuffle = (
    <ShuffleSection
      ctx={ctx}
      edit={edit}
      support={
        ctx.enabled
          ? {
              label: supportCountLabel(app, ctx),
              open: supportOpen,
              needsReset,
              onToggle: () => setSupportOpen(!supportOpen),
              panel: (
                <SupportCountSection
                  app={app}
                  draft={draft}
                  ctx={ctx}
                  status={status}
                  clearDrawNote={() => edit.setDrawNote(null)}
                  open={supportOpen}
                />
              ),
            }
          : undefined
      }
    />
  );

  return (
    <div className="screen prep-screen">
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
      {draft.night && draft.night.swaps.length > 0 && rotatedFrom ? (
        <p className="note" role="status">
          {nightLine(draft.night, night.pool?.people.length)}
          {nightExtra(draft)}{" "}
          <button type="button" className="link" onClick={() => night.sameTen(rotatedFrom)}>
            같은 10명으로
          </button>{" "}
          <button type="button" className="link" onClick={edit.showRecommendations}>
            팀 다시 짜기
          </button>
        </p>
      ) : (
        draft.origin === "same-teams" &&
        sourceMatch && (
          <p className="note" role="status">
            지난 경기와 같은 팀이에요. 포지션은 새로 뽑았어요.{nightExtra(draft)}{" "}
            <button type="button" className="link" onClick={() => edit.keepPositions(sourceMatch)}>
              포지션 유지
            </button>{" "}
            <button type="button" className="link" onClick={edit.showRecommendations}>
              팀 다시 짜기
            </button>
          </p>
        )
      )}

      {/* 섞기 버튼의 자리는 폭에 따라 DOM에서 옮긴다(CSS order로 바꾸면 키보드·읽기 순서가 화면과 어긋난다).
          - 1200px 미만(한 단): 두 팀 상자 바로 아래, 쉬는 사람보다 앞. 쉬는 사람 명단 뒤에 두었을 때 5명이 쉬면
            폰(390×844)에서 섞기 버튼이 보이는 위치에 두 팀 10명 중 6명만 보여, 누른 결과를 보려고 위로 올라가야 했다.
          - 1200px 이상(두 단): 오른쪽 단 맨 위, 두 팀 상자 옆. 왼쪽 단(두 팀·쉬는 사람)은 따라 내려와(sticky) 두 팀에서
            쉬는 사람으로 끌어다 놓을 수 있어야 하므로, 섞기를 왼쪽에 넣어 단을 화면보다 길게 만들지 않는다.
          섞은 결과 줄(DeltaNote·DrawSummary)은 두 경우 모두 쉬는 사람보다 앞에 둔다. */}
      <div className="prep-layout">
        <div className="prep-boards">
          <TeamBoards draft={draft} ctx={ctx} edit={edit} />
          <SelectionBar draft={draft} edit={edit} canReplace={others.length > 0} />
          {!twoColumns && shuffle}
          <DeltaNote lines={delta} onUndo={() => edit.stepHistory("undo")} />
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
          <BenchSection edit={edit} night={night} onAddLate={() => setLateOpen(true)} />
        </div>
        <div className="prep-tools-col">
          {twoColumns && shuffle}
          <SideSection edit={edit} />
          {forecast && (
            <ForecastSection
              forecast={forecast}
              nameOf={nameOf}
              balance={balance}
              previousBalance={previousBalance}
              placementGames={ratingOptions.placementGames}
              start={ratingOptions.start}
              splitRanks={splitRanks}
            />
          )}
          <ConstraintsSection draft={draft} edit={edit} />
          <SeriesSection draft={draft} snapshot={app.snapshot} update={update} />
        </div>
      </div>

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
      {lateOpen && (
        <LateDialog
          others={others}
          onClose={() => setLateOpen(false)}
          onPick={(person) => {
            night.addLate(person);
            setLateOpen(false);
            app.setNotice(`${person.name} 님을 쉬는 사람 끝에 넣었어요. 다음 판에 들어와요.`);
          }}
        />
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

/** 쉬던 사람이 들어간 초안의 안내 줄 첫 문장. "3경기 · 오늘 온 12명 중 10명이에요. 쉬던 호두알·잣송이가 도토리(블루 미드)·… 자리에 들어갔어요." */
function nightLine(note: NonNullable<NightDraft["night"]>, poolSize: number | undefined): string {
  const ins = note.swaps.map((s) => s.inName).join("·");
  const outs = note.swaps
    .map((s) => `${s.outName}(${s.team === "A" ? "블루" : "레드"} ${POSITION_LABEL[s.position]})`)
    .join("·");
  const last = note.swaps[note.swaps.length - 1]!.inName;
  return `${note.matchNo}경기 · 오늘 온 ${poolSize ?? note.poolSize}명 중 10명이에요. 쉬던 ${ins}${josa(last, ["이", "가"])} ${outs} 자리에 들어갔어요.`;
}

/** 안내 줄 끝에 붙는 문장: 다른 기기에서 넣은 사람을 명단에 더한 것, 지난 경기의 팀 조건을 이어 온 것. */
function nightExtra(draft: NightDraft): string {
  const note = draft.night;
  if (!note) return "";
  let text = "";
  if (note.addedNames.length > 0) text += ` 다른 기기에서 넣은 ${note.addedNames.join("·")} 님을 오늘 명단에 더했어요.`;
  if (note.carried > 0) text += ` 지난 경기의 팀 조건 ${note.carried}개를 이어 왔어요.`;
  return text;
}
