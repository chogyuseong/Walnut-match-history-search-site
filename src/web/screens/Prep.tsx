import { useMemo, useRef, useState } from "react";
import {
  addConstraint,
  applyTeams,
  isCompleteDraft,
  keepMatchPositions,
  randomDraftSide,
  removeConstraint,
  replacePerson,
  setDraftSide,
  swapPeople,
  swapSides,
  toggleLock,
  undoDraft,
  violatedConstraints,
  type Draft,
  type DraftPerson,
} from "../../shared/draft";
import { avoidMapFor, avoids, avoidViolations } from "../../shared/avoid";
import { shuffleTeamsByPriority, teamShuffleText, type PriorityMap } from "../../shared/priority";
import { diversityFor, recommendTeams, type TeamCandidate } from "../../shared/recommend";
import {
  allAssignedTeams,
  drawStatus,
  drawSupport,
  fairRepeatSupporterIds,
  repeatSupporterIds,
  resetCountsReady,
  rotationContext,
  shuffleDraft,
  supportCountOf,
  supportCounts,
  type DrawResult,
} from "../../shared/rotation";
import { POSITIONS, sideOfTeam, TEAMS, type MatchView, type Snapshot, type Team } from "../../shared/types";
import { ApiFailure, call, mutate, newRequestId } from "../api";
import { draftRosterText, POSITION_LABEL, SIDE_LABEL, TEAM_MARK } from "../format";
import { SupportCountEditor } from "../supportCountEditor";
import { CopyButton, Dialog, ErrorNote, PosLabel, StickyAction } from "../ui";
import { go, useAppValue } from "../useApp";
import { LoginDialog } from "./Login";

const SESSION_GAP_MS = 12 * 60 * 60 * 1000;

interface StartAsk {
  requestId: string;
  snapshot: Snapshot;
  inProgress: MatchView | null;
  /** 같은 팀에 더 적게 간 사람이 있는데 서포터 자리에 있는, 이미 간 사람. 확인을 묻는다. */
  repeatIds: string[];
  /** 이미 갔지만 팀에서 가장 적게 간 사람이라 공평한 반복. 묻지 않고 ackRepeat에 넣는다. */
  fairRepeatIds: string[];
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
  const [resetOpen, setResetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 팀·라인 모두 섞기을 눌렀는데 우선순위를 정한 사람이 없으면 섞기 구역에 배정 화면 링크를 남긴다(다음 조작 때 지운다).
  const [noPriorityNote, setNoPriorityNote] = useState(false);
  // 라인 섞기에서 기피 라인을 모두 피하지 못했으면 섞기 구역에 남긴다(다음 조작 때 지운다).
  const [avoidNote, setAvoidNote] = useState<string | null>(null);
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
    setNoPriorityNote(false);
    setAvoidNote(null);
  };
  // 초안 키 → 기피 라인(운영자 스냅숏의 참가자 정보). 아무도 없으면 빈 맵이라 섞기 결과가 예전과 같다.
  const avoidMap = avoidMapFor(draft.people, app.snapshot?.participants);
  const hasAvoid = Object.keys(avoidMap).length > 0;

  /** 섞은 뒤 기피 라인에 서 있는 사람(고정한 사람 제외)을 알린다. 없으면 빈 문자열. */
  function noteAvoid(next: Draft): string {
    const misses = avoidViolations(next, avoidMap, { includeLocked: false });
    if (misses.length === 0) return "";
    const text = `기피 라인을 모두 피할 수 없었어요: ${misses
      .map((m) => `${nameOf(m.key)}(${POSITION_LABEL[m.position]})`)
      .join(", ")}`;
    setAvoidNote(text);
    return ` ${text}`;
  }

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

  /** 초안 키 → 우선순위(skillGroup). 아직 참가자 ID가 없는 새 이름은 미지정. */
  function priorityMap(): PriorityMap {
    const groupOf = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.skillGroup]));
    return Object.fromEntries(
      draft!.people.map((p) => [p.key, (p.participantId ? groupOf.get(p.participantId) : null) ?? null]),
    );
  }

  function showRecommendations() {
    const priorities = priorityMap();
    const people = draft!.people.map((p) => ({ key: p.key, skillGroup: priorities[p.key] ?? null }));
    const weights = app.snapshot?.group.settings.groupWeights ?? [4, 3, 2, 1];
    // 조합 다양성(모임 설정, 기본 켜짐): 균형이 같은 후보 중 최근 경기와 덜 겹치는 조합을 먼저.
    const diversity = app.snapshot
      ? diversityFor({ matches: app.snapshot.matches, settings: app.snapshot.group.settings }, draft!.people)
      : undefined;
    setCandidates(recommendTeams(people, weights, draft!.seed, 3, draft!.constraints ?? [], diversity));
  }

  function runDraw(teams: readonly Team[]) {
    const result = drawSupport(draft!, teams, ctx);
    if (result.draft !== draft) update(result.draft);
    setDrawNote(result);
  }

  /** 팀·라인 모두 섞기: 같은 우선순위끼리 양 팀에 고르게 나누고 라인도 무작위(src/shared/priority.ts). */
  function runTeamShuffle() {
    const weights = app.snapshot?.group.settings.groupWeights ?? [4, 3, 2, 1];
    const result = shuffleTeamsByPriority(draft!, priorityMap(), weights, avoidMap);
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
    update(result.draft);
    setNoPriorityNote(result.assigned === 0);
    app.setNotice(teamShuffleText(result) + noteAvoid(result.draft));
  }

  /** 라인만 섞기: fairSupport=false 라인만, true 라인 + 서포터 공평하게(src/shared/rotation.ts shuffleDraft). 팀원은 그대로다. */
  function runShuffle(fairSupport: boolean) {
    const next = shuffleDraft(draft!, { fairSupport, avoid: avoidMap }, ctx);
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
    update(next);
    const missed = noteAvoid(next);
    if (!fairSupport) {
      app.setNotice(`팀원은 그대로 두고 라인을 섞었어요.${missed}`);
      return;
    }
    const full = allAssignedTeams(next, ctx);
    app.setNotice(
      (full.length === 0
        ? "라인을 섞고, 팀마다 서포터를 아직 안 간 사람으로 정했어요."
        : `라인을 섞었어요. ${allAssignedText(full)}`) + missed,
    );
    // 알림은 몇 초 뒤 사라지므로, 모두 배정받은 팀은 명단 아래 안내에도 남긴다(다음 조작 때 지워진다).
    if (full.length > 0) setDrawNote({ draft: next, outcomes: [], allAssigned: full });
  }

  /** 서포터 횟수 초기화(새 주기). 모임 탭의 같은 버튼과 같은 동작이다. */
  async function resetCounts() {
    if (!app.snapshot) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${app.snapshot.group.id}/rotation/new-cycle`, {
        requestId: newRequestId(),
        baseLiveVersion: app.snapshot.group.liveVersion,
      } as { requestId: string });
      await app.refreshAfterOwnChange();
      setResetOpen(false);
      setDrawNote(null);
      app.setNotice("서포터 횟수를 초기화했어요. 전적은 그대로입니다.");
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
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
      const latestCtx = rotationContext(snapshot.group.settings.rotationEnabled, snapshot.rotation);
      const repeatIds = repeatSupporterIds(current, latestCtx);
      const fairRepeatIds = fairRepeatSupporterIds(current, latestCtx);
      const askSession =
        snapshot.session !== null &&
        Date.now() - Date.parse(snapshot.session.lastActivityAt) > SESSION_GAP_MS;
      const next: StartAsk = {
        requestId: newRequestId(),
        snapshot,
        inProgress,
        repeatIds,
        fairRepeatIds,
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
          // 공평한 반복은 묻지 않고, 불공평한 반복은 확인 창에서 "이대로 시작"을 눌렀을 때만 여기에 온다.
          ackRepeat: [...plan.fairRepeatIds, ...plan.repeatIds],
          moveCurrentToAwaiting: plan.inProgress?.id ?? null,
          newSession: plan.askSession && wantNewSession,
          // 진영을 골랐으면 함께 보낸다("나중에"면 보내지 않는다).
          ...(current.teamASide ? { teamASide: current.teamASide } : {}),
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

  const complete = isCompleteDraft(draft);
  // 서포터 횟수 목록: 이번 주기에 한 번이라도 간 사람(많이 간 순). 이름은 모임 참가자 이름.
  const participantName = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.name]));
  const countRows = [...supportCounts(ctx).entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, name: participantName.get(id) ?? "(이름 없음)" }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ko"));
  const canReset = ctx.enabled && !!app.me?.accountId && app.snapshot !== null;
  // 초기화는 지금 초안의 두 팀 중 하나라도 모두 서포터를 배정받았을 때만 켠다(초안에서 바로 계산).
  // 첫 경기 전(주기 없음)에 직접 넣은 횟수로도 켜진다. 서버는 그때 미리 넣어 둔 값만 지운다.
  const resetReady = resetCountsReady(draft, ctx);
  const countPeople = draft.people
    .filter((p) => p.participantId !== null)
    .map((p) => ({ id: p.participantId!, name: p.name }));

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
              update(keepMatchPositions(draft, sourceMatch, (id) => names.get(id) ?? "", new Date().toISOString()));
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
          const side = sideOfTeam(team, draft.teamASide ?? null);
          return (
            <section
              key={team}
              className={side === "blue" || side === "red" ? `team side-${side}` : "team"}
              aria-label={`팀 ${team}`}
            >
              <h3>
                <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team}
                {(side === "blue" || side === "red") && <span className="side"> · {SIDE_LABEL[side]}</span>}
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
                  const supportCount = ctx.enabled ? supportCountOf(draft, slot.key, ctx) : 0;
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
                        {avoids(avoidMap, slot.key, position) && (
                          <span className="tag avoid-tag" title="기피 라인에 서 있어요">
                            기피
                          </span>
                        )}
                        {supportCount > 0 && <span className="tag">서폿 {supportCount}회</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {status === "stale" && <p className="hint warn-text">서포터 바꾸기 다시 확인 필요</p>}
              {status === "applied" && <p className="hint">서포터 바꾸기 적용됨</p>}
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

      <section className="prep-tools" aria-label="섞기">
        <h2>섞기</h2>
        <p className="hint">
          고정한 포지션은 어떤 섞기에서도 지켜요. 잘못 눌렀으면 "직전 편성으로"로 되돌릴 수 있어요.{" "}
          <button type="button" className="link" onClick={() => go("/priority")}>
            우선순위 배정
          </button>{" "}
          ·{" "}
          <button type="button" className="link" onClick={() => go("/priority/avoid")}>
            기피 라인
          </button>
        </p>
        {hasAvoid && (
          <p className="hint">
            기피 라인을 정한 사람은 라인을 섞을 때 그 라인을 되도록 피해요. 서폿 돌아가며·서포터만 바꾸기는 서포터 횟수 규칙이
            먼저예요.
          </p>
        )}
        {avoidNote && (
          <p className="note" role="status">
            {avoidNote}
          </p>
        )}
        {noPriorityNote && (
          <p className="note" role="status">
            우선순위를 정한 사람이 없어 무작위로 나눴어요.{" "}
            <button type="button" className="link" onClick={() => go("/priority")}>
              우선순위 배정하기
            </button>
          </p>
        )}
        <p className="hint">
          <strong>팀을 새로 짜기</strong> — 같은 우선순위끼리는 양 팀에 나뉘어요.
        </p>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            title="10명을 두 팀으로 새로 나누고 라인도 섞어요. 같은 우선순위끼리는 양 팀에 고르게 나뉘어요."
            onClick={runTeamShuffle}
          >
            팀·라인 모두 섞기
          </button>
          <button
            type="button"
            className="secondary"
            title="우선순위 합이 비슷한 편성 3개를 보여 줘요. 골라서 적용해요."
            onClick={showRecommendations}
          >
            균형 팀 추천
          </button>
        </div>
        <p className="hint">
          <strong>팀은 그대로</strong> — 팀원은 바뀌지 않아요.
          {ctx.enabled ? " '서폿 돌아가며'는 팀마다 서포터를 아직 안 간 사람으로 정해요." : ""}
        </p>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            title="팀원은 그대로 두고 팀 안에서 라인만 섞어요."
            onClick={() => runShuffle(false)}
          >
            라인만 섞기
          </button>
          {ctx.enabled && (
            <button
              type="button"
              className="secondary"
              title="라인을 섞은 뒤, 팀마다 서포터를 아직 안 간 사람으로 정해요."
              onClick={() => runShuffle(true)}
            >
              라인 섞기 + 서폿 돌아가며
            </button>
          )}
          {ctx.enabled && (
            <button
              type="button"
              className="secondary"
              title="팀마다 서포터를 아직 안 간 사람과 맞바꿔요. 나머지 8명은 그대로예요."
              onClick={() => runDraw(TEAMS)}
            >
              서포터만 바꾸기
            </button>
          )}
          <button
            type="button"
            className="secondary"
            title="두 팀의 A·B 자리를 맞바꿉니다. 팀 구성·포지션·서포터·진영은 팀을 따라갑니다."
            onClick={() => {
              update(swapSides(draft));
              setSelectedKey(null);
              setPairMode(null);
              // 서포터 바꾸기 안내 문구의 팀 이름이 바뀌므로 지운다. 바꾼 결과 자체는 그대로 유지된다.
              setDrawNote(null);
              app.setNotice("팀 A와 팀 B를 맞바꿨어요. 서포터와 진영은 팀을 따라가요.");
            }}
          >
            두 팀 자리 바꾸기
          </button>
        </div>
      </section>

      <section className="prep-tools" aria-label="진영">
        <h2>진영</h2>
        <div className="choice-row side-choices" role="radiogroup" aria-label="팀 A의 진영">
          {(
            [
              ["blue", "팀 A 블루"],
              ["red", "팀 A 레드"],
              [null, "나중에 정하기"],
            ] as const
          ).map(([value, label]) => (
            <label key={label} className={(draft.teamASide ?? null) === value ? "choice chosen" : "choice"}>
              <input
                type="radio"
                name="draft-side"
                checked={(draft.teamASide ?? null) === value}
                onChange={() => update(setDraftSide(draft, value))}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const next = randomDraftSide(draft);
              update(next);
              app.setNotice(`팀 A가 ${SIDE_LABEL[next.teamASide!]}예요.`);
            }}
          >
            진영 랜덤
          </button>
          <span className="hint">
            {draft.teamASide
              ? "결과를 입력할 때 이 진영으로 미리 골라 둬요. 바꿀 수 있어요."
              : "정하지 않으면 결과를 입력할 때 골라요."}
          </span>
        </div>
      </section>

      {drawNote && (
        <DrawSummary
          result={drawNote}
          nameOf={nameOf}
          supporterIsNew={(team) => {
            const key = draft.slots.find((s) => s.team === team && s.position === "support")?.key;
            return key !== undefined && supportCountOf(draft, key, ctx) === 0;
          }}
        />
      )}

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
            조건은 팀 추천과 팀·라인 모두 섞기에 적용됩니다(팀·라인 모두 섞기은 우선순위 균형이 먼저예요). 손으로 자리를 바꾸는 것은
            막지 않습니다.
          </p>
        </details>
      )}

      {ctx.enabled && (
        // 모두 배정받은 팀이 있으면 초기화 버튼이 보이도록 펼쳐 둔다.
        <details open={resetReady || undefined}>
          <summary>서포터 횟수: {countRows.length === 0 ? "아직 없음" : `${countRows.length}명 기록`}</summary>
          <p className="hint">
            "이 팀으로 시작"으로 실제 시작한 경기만 셉니다. 섞기·서포터만 바꾸기는 횟수를 올리지 않아요. 새 내전을
            시작하거나 초기화하면 0부터 다시 셉니다.
          </p>
          {countRows.length === 0 ? (
            <p className="hint">아직 서포터로 간 사람이 없어요.</p>
          ) : (
            <ul className="list" aria-label="서포터 횟수 목록">
              {countRows.map((row) => (
                <li key={row.id} className="list-row static">
                  <span className="name">{row.name}</span>
                  <span className="stat">서폿 {row.n}회</span>
                </li>
              ))}
            </ul>
          )}
          {canReset && app.snapshot ? (
            <>
              <h3>이번 편성 횟수 고치기</h3>
              <p className="hint">
                사이트 밖에서 이미 몇 판 했거나 횟수가 잘못 쌓였으면 여기서 바로 고쳐요. 첫 경기 전에도 넣을 수 있어요.
              </p>
              <SupportCountEditor
                groupId={app.snapshot.group.id}
                people={countPeople}
                counts={supportCounts(ctx)}
                refresh={app.refreshAfterOwnChange}
                onSaved={() => {
                  setDrawNote(null);
                  app.setNotice("서포터 횟수를 저장했어요.");
                }}
                label="이번 편성 서포터 횟수"
              />
              {countPeople.length < draft.people.length && (
                <p className="hint">새로 넣은 이름은 첫 경기를 시작한 뒤에 고칠 수 있어요.</p>
              )}
            </>
          ) : (
            <p className="hint">로그인하면 서포터 횟수를 직접 고칠 수 있어요.</p>
          )}
          {canReset && (
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={busy || !resetReady}
                aria-describedby="reset-counts-why"
                onClick={() => setResetOpen(true)}
              >
                서포터 횟수 초기화
              </button>
              <span id="reset-counts-why" className="hint">
                {resetReady
                  ? "한 팀이 모두 서포터를 배정받았어요. 초기화하면 다시 처음부터 돌아가요."
                  : "아직 서포터를 안 간 사람이 있어요. 팀 하나가 모두 배정받으면 누를 수 있어요."}
              </span>
            </div>
          )}
        </details>
      )}

      {resetOpen && (
        <Dialog title="서포터 횟수 초기화" onClose={() => setResetOpen(false)}>
          <p>모든 사람의 서포터 횟수를 0으로 되돌립니다. 경기 기록과 전적은 그대로예요.</p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void resetCounts()}>
              초기화
            </button>
            <button type="button" className="secondary" onClick={() => setResetOpen(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
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
                  const next = applyTeams(draft, candidate.teamA, avoidMap);
                  update(next);
                  setCandidates(null);
                  setDrawNote(null);
                  const missed = noteAvoid(next).trim();
                  if (missed) app.setNotice(missed);
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
          {ask.repeatIds.map((id) => {
            const latest = rotationContext(ask.snapshot.group.settings.rotationEnabled, ask.snapshot.rotation);
            return (
              <p key={id}>
                <strong>{draft.people.find((p) => p.participantId === id)?.name ?? ""}</strong>님은 이미{" "}
                {supportCounts(latest).get(id) ?? 0}번 갔고 같은 팀에 더 적게 간 사람이 있어요. 그대로 시작할까요?
              </p>
            );
          })}
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
                새 내전으로 시작 (서포터 횟수도 새로 시작)
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

/** "팀 B는 모두 서포터를 배정받았어요." · 두 팀이면 한 문장으로. 다음 행동(초기화)을 함께 안내한다. */
function allAssignedText(teams: readonly Team[]): string {
  const who = teams.length >= 2 ? "두 팀 모두" : `팀 ${teams[0]}는 모두`;
  return `${who} 서포터를 배정받았어요. 서포터 횟수 초기화를 누르면 다시 처음부터 돌아가요.`;
}


/** 서포터만 바꾸기 결과를 명단 바로 아래에 이름과 함께 보여준다. 바꿀 수 있는 팀은 이미 바뀌어 있다. */
function DrawSummary(props: {
  result: DrawResult;
  nameOf: (key: string) => string;
  /** 지금 그 팀 서포터가 아직 서포터를 안 간 사람(0회)인지. 바꾸지 못한 이유 문구를 고른다. */
  supporterIsNew: (team: Team) => boolean;
}) {
  const { result, nameOf } = props;
  return (
    <div className="note" role="status">
      {result.outcomes.map((outcome) =>
        outcome.kind === "blocked" ? (
          outcome.block === "all-assigned" ? null : (
            <p key={outcome.team}>
              팀 {outcome.team}:{" "}
              {outcome.block === "supporter-locked"
                ? "서포터 자리가 고정돼 있어요. 고정을 풀거나 직접 자리를 바꿔 주세요."
                : props.supporterIsNew(outcome.team)
                  ? "지금 서포터가 아직 안 간 유일한 사람이라 그대로 두었어요."
                  : "아직 안 간 사람은 포지션이 고정돼 있어 그대로 두었어요. 고정을 풀면 바꿀 수 있어요."}
            </p>
          )
        ) : (
          <p key={outcome.team}>
            팀 {outcome.team}: {nameOf(outcome.record!.inKey)}{" "}
            {POSITION_LABEL[outcome.record!.fromPosition]}→서포터, {nameOf(outcome.record!.outKey)}{" "}
            서포터→{POSITION_LABEL[outcome.record!.fromPosition]}, 나머지 유지
            {outcome.kind === "kept" ? " (같은 조건이라 결과를 유지했어요)" : ""}
          </p>
        ),
      )}
      {result.allAssigned.length > 0 && <p>{allAssignedText(result.allAssigned)}</p>}
    </div>
  );
}
