import { useRef, useState } from "react";
import type { Draft } from "../../../shared/draft";
import { draftRoster, sameTeamsAsLast } from "../../../shared/prepTools";
import { fairRepeatSupporterIds, repeatSupporterIds, rotationContext } from "../../../shared/rotation";
import { sameComposition } from "../../../shared/series";
import type { MatchView, Snapshot } from "../../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../../api";
import { bindNightPool, saveCarry } from "../../nightPoolStore";
import { go, type AppValue } from "../../useApp";

const SESSION_GAP_MS = 12 * 60 * 60 * 1000;

export interface StartAsk {
  requestId: string;
  snapshot: Snapshot;
  inProgress: MatchView | null;
  /** 같은 팀에 더 적게 간 사람이 있는데 서포터 자리에 있는, 이미 간 사람. 확인을 묻는다. */
  repeatIds: string[];
  /** 이미 갔지만 팀에서 가장 적게 간 사람이라 공평한 반복. 묻지 않고 ackRepeat에 넣는다. */
  fairRepeatIds: string[];
  askSession: boolean;
  /**
   * 직전 경기와 두 팀 구성이 같으면 그 경기(진영이 바뀐 것도 같은 구성). 시작 전에 한 번 묻는다.
   * 시리즈로 이어가기 중이거나 "다음 경기 준비"로 만든 초안이면 null(src/shared/prepTools.ts sameTeamsAsLast).
   */
  sameTeams: MatchView | null;
}

/** 저장 중 표시와 마지막 오류. 시작 흐름과 서포터 횟수 초기화가 함께 쓴다(같은 버튼 잠금·같은 오류 표시). */
export interface PrepStatus {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  error: unknown;
  setError: (error: unknown) => void;
}

/**
 * "이 팀으로 시작" 흐름: 로그인 확인 → 모임·참가자 ID 준비 → 최신 상태 확인 → (물어볼 것이 있으면) 확인 창 →
 * 시작 요청(mutate, 응답이 없으면 같은 요청 ID로 재시도). 상태가 바뀌어 거절되면 확인 창을 닫고 최신 상태로 다시 묻는다.
 */
export function usePrepStart(app: AppValue, draft: Draft, status: PrepStatus) {
  const { setBusy, setError } = status;
  const [needLogin, setNeedLogin] = useState(false);
  const [ask, setAsk] = useState<StartAsk | null>(null);
  const [newSession, setNewSession] = useState(true);
  const lastAttempt = useRef<(() => Promise<void>) | null>(null);

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
      let current = draft;
      const unnamed = current.people.filter((p) => p.participantId === null);
      if (unnamed.length > 0) {
        const ensured = await mutate<{ participants: { id: string; name: string }[] }>(
          `/api/groups/${gid}/participants`,
          { requestId: newRequestId(), names: unnamed.map((p) => p.name) },
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
        sameTeams: sameTeamsAsLast(current, snapshot.matches),
      };
      // 물어볼 것이 하나라도 있으면 한 창에 모아 묻는다. "이대로 시작"을 누르면 이 시도에서는 다시 묻지 않는다.
      if (inProgress || repeatIds.length > 0 || askSession || next.sameTeams) {
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
    // 시리즈로 이어가기: 직전 경기와 두 팀 구성이 같을 때만 보낸다(다르면 화면에 미리 알렸다).
    const from = current.sourceMatchId
      ? plan.snapshot.matches.find((m) => m.id === current.sourceMatchId)
      : undefined;
    const series =
      current.series && from && sameComposition(from.roster, draftRoster(current))
        ? { fromMatchId: from.id, format: current.series.format, name: current.series.name.trim() || null }
        : null;
    const attempt = async () => {
      setBusy(true);
      setError(null);
      try {
        const started = await mutate<{ match: MatchView }>(`/api/groups/${plan.snapshot.group.id}/matches/start`, {
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
          // 준비 화면은 팀 A가 항상 블루팀이다.
          teamASide: current.teamASide ?? "blue",
          ...(series ? { series } : {}),
        } as { requestId: string });
        setAsk(null);
        // 성공한 뒤에만 오늘 명단을 이 세션에 묶고 팀 조건을 남긴다(실패하면 초안·명단 모두 그대로 둔다).
        bindNightPool(plan.snapshot, started.match.sessionId, current);
        saveCarry(plan.snapshot.group.id, current);
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

  /** 오류 안내의 "저장됐는지 확인"(응답을 못 받은 마지막 시도를 같은 요청 ID로 다시 보낸다). */
  const retryLast = () => void lastAttempt.current?.();

  return { needLogin, setNeedLogin, ask, setAsk, newSession, setNewSession, beginStart, sendStart, retryLast };
}

export type PrepStart = ReturnType<typeof usePrepStart>;
