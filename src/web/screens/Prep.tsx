import { useMemo, useRef, useState } from "react";
import {
  addConstraint,
  applyTeams,
  draftFromMatch,
  isCompleteDraft,
  removeConstraint,
  replacePerson,
  rerollPositions,
  swapPeople,
  toggleLock,
  undoDraft,
  violatedConstraints,
  type Draft,
  type DraftPerson,
} from "../../shared/draft";
import { recommendTeams, type TeamCandidate } from "../../shared/recommend";
import {
  drawStatus,
  drawSupport,
  hasUsedTurn,
  repeatSupporterIds,
  rotationContext,
  type DrawResult,
} from "../../shared/rotation";
import { POSITIONS, TEAMS, type MatchView, type Snapshot, type Team } from "../../shared/types";
import { ApiFailure, call, mutate, newRequestId } from "../api";
import { draftRosterText, POSITION_LABEL, TEAM_MARK } from "../format";
import { CopyButton, Dialog, ErrorNote, PosLabel, StickyAction } from "../ui";
import { go, useAppValue } from "../useApp";
import { LoginDialog } from "./Login";

const SESSION_GAP_MS = 12 * 60 * 60 * 1000;

interface StartAsk {
  requestId: string;
  snapshot: Snapshot;
  inProgress: MatchView | null;
  repeatIds: string[];
  askSession: boolean;
}

/** 화면 3 — 다음 경기 준비. 주요 행동은 "이 팀으로 시작" 하나다. 결과 저장 버튼은 없다. */
export function Prep() {
  const app = useAppValue();
  const draft = app.draft;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TeamCandidate[] | null>(null);
  const [drawNote, setDrawNote] = useState<DrawResult | null>(null);
  const [replacing, setReplacing] = useState(false);
  // 조건을 거는 중이면 다음에 누른 사람과 자리를 바꾸지 않고 조건을 만든다.
  const [pairMode, setPairMode] = useState<null | "same" | "different">(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [ask, setAsk] = useState<StartAsk | null>(null);
  const [newSession, setNewSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const lastAttempt = useRef<(() => Promise<void>) | null>(null);

  const ctx = useMemo(
    () =>
      rotationContext(
        app.snapshot?.group.settings.rotationEnabled ?? true,
        app.snapshot?.rotation ?? null,
      ),
    [app.snapshot],
  );

  if (!draft) {
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

  const nameOf = (key: string) => draft.people.find((p) => p.key === key)?.name ?? "";
  const update = (next: Draft) => {
    app.setDraft(next);
    setError(null);
  };

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

  function onTapPerson(key: string) {
    if (selectedKey === null) {
      setSelectedKey(key);
    } else if (selectedKey === key) {
      setSelectedKey(null);
      setPairMode(null);
    } else if (pairMode) {
      update(addConstraint(draft!, { kind: pairMode, a: selectedKey, b: key }));
      setSelectedKey(null);
      setPairMode(null);
    } else {
      update(swapPeople(draft!, selectedKey, key));
      setSelectedKey(null);
      setDrawNote(null);
    }
  }

  function showRecommendations() {
    const groupOf = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.skillGroup]));
    const people = draft!.people.map((p) => ({
      key: p.key,
      skillGroup: (p.participantId ? groupOf.get(p.participantId) : null) ?? null,
    }));
    const weights = app.snapshot?.group.settings.groupWeights ?? [4, 3, 2, 1];
    setCandidates(recommendTeams(people, weights, draft!.seed, 3, draft!.constraints ?? []));
  }

  function runDraw(teams: readonly Team[]) {
    const result = drawSupport(draft!, teams, ctx);
    if (result.draft !== draft) update(result.draft);
    setDrawNote(result);
  }

  /** 시작 전 준비: 로그인, 모임, 참가자 ID, 최신 상태 확인. 물어볼 것이 없으면 바로 보낸다. */
  async function beginStart(justLoggedIn = false) {
    setError(null);
    // 로그인 직후에는 이 함수가 로그인 전 상태를 붙잡고 있으므로 다시 묻지 않는다.
    if (!justLoggedIn && !app.me?.accountId) {
      setNeedLogin(true);
      return;
    }
    setBusy(true);
    try {
      const gid = await app.ensureGroup();
      let current = draft!;
      const unnamed = current.people.filter((p) => p.participantId === null);
      if (unnamed.length > 0) {
        const ensured = await call<{ participants: { id: string; name: string }[] }>(
          "POST",
          `/api/groups/${gid}/participants`,
          { names: unnamed.map((p) => p.name) },
        );
        const idOf = new Map(unnamed.map((p, i) => [p.key, ensured.participants[i]!.id]));
        current = {
          ...current,
          groupId: gid,
          people: current.people.map((p) =>
            idOf.has(p.key) ? { ...p, participantId: idOf.get(p.key)! } : p,
          ),
        };
        app.setDraft(current);
      }
      const snapshot = await app.refresh();
      if (!snapshot) throw new ApiFailure("unknown", "최신 상태를 확인하지 못했어요.");
      const inProgress = snapshot.matches.find((m) => m.state === "in_progress") ?? null;
      const repeatIds = repeatSupporterIds(
        current,
        rotationContext(snapshot.group.settings.rotationEnabled, snapshot.rotation),
      );
      const askSession =
        snapshot.session !== null &&
        Date.now() - Date.parse(snapshot.session.lastActivityAt) > SESSION_GAP_MS;
      const next: StartAsk = {
        requestId: newRequestId(),
        snapshot,
        inProgress,
        repeatIds,
        askSession,
      };
      if (inProgress || repeatIds.length > 0 || askSession) {
        setNewSession(true);
        setAsk(next);
      } else {
        await sendStart(current, next, false);
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function sendStart(current: Draft, plan: StartAsk, wantNewSession: boolean) {
    const attempt = async () => {
      setBusy(true);
      setError(null);
      try {
        await mutate(`/api/groups/${plan.snapshot.group.id}/matches/start`, {
          requestId: plan.requestId,
          baseLiveVersion: plan.snapshot.group.liveVersion,
          roster: current.slots.map((s) => ({
            participantId: current.people.find((p) => p.key === s.key)!.participantId,
            team: s.team,
            position: s.position,
          })),
          ackRepeat: plan.repeatIds,
          moveCurrentToAwaiting: plan.inProgress?.id ?? null,
          newSession: plan.askSession && wantNewSession,
        } as { requestId: string });
        setAsk(null);
        app.setDraft(null);
        await app.refreshAfterOwnChange();
        go("/match");
      } catch (e) {
        if (
          e instanceof ApiFailure &&
          (e.code === "SUPPORT_REPEAT" ||
            e.code === "MATCH_IN_PROGRESS" ||
            e.code === "VERSION_CONFLICT")
        ) {
          // 그 사이 상태가 바뀌었다. 입력은 그대로 두고 최신 상태로 다시 묻는다.
          setAsk(null);
          await app.refresh();
        }
        setError(e);
      } finally {
        setBusy(false);
      }
    };
    lastAttempt.current = attempt;
    await attempt();
  }

  const others: DraftPerson[] = (app.snapshot?.participants ?? [])
    .filter((p) => p.status === "active" && !draft.people.some((d) => d.participantId === p.id))
    .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }));

  const usedCount = ctx.usedIds.size;
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
      {baseChanged && (
        <p className="note warn" role="status">
          다른 기기에서 경기 상태가 바뀌었어요. 작성 내용은 그대로 두었습니다.{" "}
          <button type="button" className="link" onClick={() => go("/")}>
            현재 상태 보기
          </button>{" "}
          <button
            type="button"
            className="link"
            onClick={() =>
              update({ ...draft, baseLiveVersion: app.snapshot!.group.liveVersion })
            }
          >
            확인했어요
          </button>
        </p>
      )}
      {draft.origin === "same-teams" && sourceMatch && (
        <p className="note" role="status">
          지난 경기와 같은 팀이에요. 포지션은 새로 뽑았어요.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              const names = new Map(app.snapshot!.participants.map((p) => [p.id, p.name]));
              update(
                draftFromMatch(sourceMatch, (id) => names.get(id) ?? "", {
                  groupId: draft.groupId,
                  baseLiveVersion: draft.baseLiveVersion,
                  seed: draft.seed,
                  now: new Date().toISOString(),
                  keepPositions: true,
                }),
              );
              setDrawNote(null);
            }}
          >
            포지션 유지
          </button>{" "}
          <button type="button" className="link" onClick={showRecommendations}>
            팀 다시 짜기
          </button>
        </p>
      )}

      <div className="teams">
        {TEAMS.map((team) => {
          const status = drawStatus(draft, team, ctx);
          return (
            <section key={team} className="team" aria-label={`팀 ${team}`}>
              <h3>
                <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team}
              </h3>
              <ul>
                {POSITIONS.map((position) => {
                  const slot = draft.slots.find((s) => s.team === team && s.position === position);
                  if (!slot) {
                    return (
                      <li key={position} className="row empty">
                        <PosLabel position={position} />
                        <span className="name">(비어 있음)</span>
                      </li>
                    );
                  }
                  const used = ctx.enabled && hasUsedTurn(draft, slot.key, ctx);
                  return (
                    <li key={slot.key}>
                      <button
                        type="button"
                        className={selectedKey === slot.key ? "row picked" : "row"}
                        aria-pressed={selectedKey === slot.key}
                        onClick={() => onTapPerson(slot.key)}
                      >
                        <PosLabel position={position} />
                        <span className="name" title={nameOf(slot.key)}>
                          {nameOf(slot.key)}
                        </span>
                        {slot.locked && <span className="tag">고정</span>}
                        {used && <span className="tag">◆차례 씀</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {status === "stale" && <p className="hint warn-text">서포터 추첨 다시 확인 필요</p>}
            </section>
          );
        })}
      </div>

      {selectedKey ? (
        <div className="button-row" role="group" aria-label={`${nameOf(selectedKey)} 선택됨`}>
          <span className="hint">
            {nameOf(selectedKey)} 선택됨.{" "}
            {pairMode === "same"
              ? "같은 팀으로 묶을 사람을 누르세요."
              : pairMode === "different"
                ? "다른 팀으로 나눌 사람을 누르세요."
                : "바꿀 사람을 누르세요."}
          </span>
          <button
            type="button"
            className="secondary"
            aria-pressed={pairMode === "same"}
            onClick={() => setPairMode(pairMode === "same" ? null : "same")}
          >
            같은 팀으로 묶기
          </button>
          <button
            type="button"
            className="secondary"
            aria-pressed={pairMode === "different"}
            onClick={() => setPairMode(pairMode === "different" ? null : "different")}
          >
            다른 팀으로 나누기
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              update(toggleLock(draft, selectedKey));
              setSelectedKey(null);
            }}
          >
            {draft.slots.find((s) => s.key === selectedKey)?.locked ? "고정 해제" : "포지션 고정"}
          </button>
          {others.length > 0 && (
            <button type="button" className="secondary" onClick={() => setReplacing(true)}>
              다른 사람으로 교체
            </button>
          )}
          <button
            type="button"
            className="link"
            onClick={() => {
              setSelectedKey(null);
              setPairMode(null);
            }}
          >
            선택 취소
          </button>
        </div>
      ) : (
        <p className="hint">두 사람을 차례로 누르면 자리가 바뀝니다.</p>
      )}

      <div className="button-row">
        <button type="button" className="secondary" onClick={showRecommendations}>
          팀 추천
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            update(rerollPositions(draft));
            setDrawNote(null);
          }}
        >
          포지션 다시 뽑기
        </button>
        {ctx.enabled && (
          <button type="button" className="secondary" onClick={() => runDraw(TEAMS)}>
            서포터 추첨
          </button>
        )}
      </div>

      {drawNote && <DrawSummary result={drawNote} nameOf={nameOf} onOnly={(team) => runDraw([team])} />}

      {(draft.constraints ?? []).length > 0 && (
        <details open>
          <summary>팀 조건 {(draft.constraints ?? []).length}개</summary>
          <ul className="list">
            {(draft.constraints ?? []).map((constraint, index) => {
              const broken = violatedConstraints(draft).includes(constraint);
              return (
                <li key={`${constraint.a}|${constraint.b}`} className="list-row static">
                  <span>
                    {nameOf(constraint.a)} · {nameOf(constraint.b)}{" "}
                    {constraint.kind === "same" ? "같은 팀" : "다른 팀"}
                    {broken && <span className="tag">지금 편성과 다름</span>}
                  </span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => update(removeConstraint(draft, index))}
                  >
                    조건 지우기
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="hint">
            조건은 팀 추천에 적용됩니다. 손으로 자리를 바꾸는 것은 막지 않습니다.
          </p>
        </details>
      )}

      {ctx.enabled && (
        <details>
          <summary>서포터 차례: 이번 순환에서 {usedCount}명 씀</summary>
          <p className="hint">
            한 순환 안에서 같은 사람이 서포터를 반복하지 않도록 차례를 나눕니다. 차례는 "이 팀으로
            시작"을 누를 때 쓰이고, 추첨만으로는 쓰이지 않습니다.
          </p>
        </details>
      )}

      <div className="button-row">
        <CopyButton label="명단 텍스트 복사" text={() => draftRosterText(draft)} />
        {draft.previousSlots && (
          <button
            type="button"
            className="link"
            onClick={() => {
              update(undoDraft(draft));
              setDrawNote(null);
            }}
          >
            직전 편성으로
          </button>
        )}
        <button type="button" className="link" onClick={() => go("/pick")}>
          참가자 다시 고르기
        </button>
      </div>

      <ErrorNote error={error} onCheck={() => void lastAttempt.current?.()} />

      <StickyAction>
        <button
          type="button"
          className="primary wide"
          disabled={busy || !complete}
          onClick={() => void beginStart()}
        >
          {busy ? "저장 중" : "이 팀으로 시작"}
        </button>
      </StickyAction>

      {candidates && (
        <Dialog title="팀 추천" onClose={() => setCandidates(null)}>
          {candidates.length === 0 ? (
            <>
              <p className="note warn" role="alert">
                조건을 모두 만족하는 편성이 없어요. 서로 충돌하는 조건을 지워 주세요.
              </p>
              <ul className="list">
                {(draft.constraints ?? []).map((constraint, index) => (
                  <li key={`${constraint.a}|${constraint.b}`} className="list-row static">
                    <span>
                      {nameOf(constraint.a)} · {nameOf(constraint.b)}{" "}
                      {constraint.kind === "same" ? "같은 팀" : "다른 팀"}
                    </span>
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        update(removeConstraint(draft, index));
                        setCandidates(null);
                      }}
                    >
                      조건 지우기
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">
              미리보기입니다. 적용을 눌러야 편성이 바뀌고, 포지션은 새로 뽑습니다.
            </p>
          )}
          {candidates.map((candidate, index) => (
            <section key={candidate.teamA.join(",")} className="candidate">
              <h3>{index === 0 ? "기본 추천" : `다른 후보 ${index}`}</h3>
              <p className="hint">{candidate.reason}</p>
              <p>
                <span aria-hidden="true">{TEAM_MARK.A}</span> 팀 A: {candidate.teamA.map(nameOf).join(", ")}
              </p>
              <p>
                <span aria-hidden="true">{TEAM_MARK.B}</span> 팀 B: {candidate.teamB.map(nameOf).join(", ")}
              </p>
              <button
                type="button"
                className={index === 0 ? "primary" : "secondary"}
                onClick={() => {
                  update(applyTeams(draft, candidate.teamA));
                  setCandidates(null);
                  setDrawNote(null);
                }}
              >
                적용
              </button>
            </section>
          ))}
        </Dialog>
      )}

      {replacing && selectedKey && (
        <Dialog title={`${nameOf(selectedKey)} 대신 넣을 사람`} onClose={() => setReplacing(false)}>
          <ul className="list">
            {others.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  className="list-row"
                  onClick={() => {
                    update(replacePerson(draft, selectedKey, p));
                    setReplacing(false);
                    setSelectedKey(null);
                    setDrawNote(null);
                  }}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}

      {needLogin && (
        <LoginDialog
          reason="경기를 저장하려면 로그인이 필요해요. 지금 짠 편성은 그대로 있어요."
          onClose={() => setNeedLogin(false)}
          onDone={() => {
            setNeedLogin(false);
            void beginStart(true);
          }}
        />
      )}

      {ask && (
        <Dialog title="시작 전에 확인해 주세요" onClose={() => setAsk(null)}>
          {ask.inProgress && (
            <p>
              {ask.inProgress.matchNo}경기가 아직 진행 중이에요. 시작하면 그 경기는 "결과
              미입력"으로 넘어가고 결과는 나중에 넣을 수 있어요.{" "}
              <button
                type="button"
                className="link"
                onClick={() => {
                  setAsk(null);
                  go("/match");
                }}
              >
                먼저 결과 입력하기
              </button>
            </p>
          )}
          {ask.repeatIds.length > 0 && (
            <p>
              이번 순환에서 이미 서포터를 한 사람이 서포터 자리에 있어요:{" "}
              <strong>
                {ask.repeatIds
                  .map((id) => draft.people.find((p) => p.participantId === id)?.name ?? "")
                  .join(", ")}
              </strong>
              . 그대로 시작하면 이번 경기만 반복으로 기록합니다.
            </p>
          )}
          {ask.askSession && (
            <fieldset>
              <legend>마지막 경기 뒤로 12시간이 넘었어요.</legend>
              <label>
                <input
                  type="radio"
                  name="session"
                  checked={newSession}
                  onChange={() => setNewSession(true)}
                />{" "}
                새 내전으로 시작 (서포터 차례도 새로 시작)
              </label>
              <label>
                <input
                  type="radio"
                  name="session"
                  checked={!newSession}
                  onChange={() => setNewSession(false)}
                />{" "}
                지난 내전에 이어서
              </label>
            </fieldset>
          )}
          <ErrorNote error={error} onCheck={() => void lastAttempt.current?.()} />
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void sendStart(draft, ask, newSession)}
            >
              {busy
                ? "저장 중"
                : ask.inProgress
                  ? "결과는 나중에 입력하고 시작"
                  : "이대로 시작"}
            </button>
            <button type="button" className="secondary" onClick={() => setAsk(null)}>
              편성으로 돌아가기
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

const BLOCK_TEXT = {
  "no-candidates": "남은 차례가 없어요",
  "supporter-locked": "서포터 자리가 고정돼 있어요",
} as const;

/** 추첨 결과를 명단 바로 아래에 이름과 함께 보여준다. */
function DrawSummary(props: {
  result: DrawResult;
  nameOf: (key: string) => string;
  onOnly: (team: Team) => void;
}) {
  const { result, nameOf } = props;
  const blocked = result.outcomes.filter((o) => o.kind === "blocked");
  return (
    <div className="note" role="status">
      {result.needsChoice ? (
        <p>
          {blocked.map((o) => `팀 ${o.team}는 ${BLOCK_TEXT[o.block ?? "no-candidates"]}`).join(". ")}
          . 아직 아무것도 바꾸지 않았어요.{" "}
          <button type="button" className="link" onClick={() => props.onOnly(result.needsChoice!)}>
            팀 {result.needsChoice}만 적용
          </button>
        </p>
      ) : (
        result.outcomes.map((outcome) =>
          outcome.kind === "blocked" ? (
            <p key={outcome.team}>
              팀 {outcome.team}: {BLOCK_TEXT[outcome.block ?? "no-candidates"]}.{" "}
              {outcome.block === "supporter-locked"
                ? "고정을 풀거나 직접 자리를 바꿔 주세요."
                : "팀을 조정하거나, 그대로 시작해 이번 경기만 반복을 허용하거나, 모임 탭에서 새 순환을 시작할 수 있어요."}
            </p>
          ) : (
            <p key={outcome.team}>
              팀 {outcome.team}: {nameOf(outcome.record!.inKey)}{" "}
              {POSITION_LABEL[outcome.record!.fromPosition]}→서포터, {nameOf(outcome.record!.outKey)}{" "}
              서포터→{POSITION_LABEL[outcome.record!.fromPosition]}, 나머지 유지
              {outcome.kind === "kept" ? " (같은 조건이라 결과를 유지했어요)" : ""}
            </p>
          ),
        )
      )}
    </div>
  );
}
