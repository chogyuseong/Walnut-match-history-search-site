import { useState } from "react";
import {
  addConstraint,
  applyTeams,
  keepMatchPositions,
  randomDraftSide,
  redoDraft,
  removeConstraint,
  replacePerson,
  swapPeople,
  swapSides,
  toggleLock,
  undoDraft,
  type Draft,
  type DraftPerson,
} from "../../../shared/draft";
import { swapWithBench } from "../../../shared/prepTools";
import { avoidMapFor, avoidViolations } from "../../../shared/avoid";
import { shuffleTeamsByPriority, teamShuffleText, type PriorityMap } from "../../../shared/priority";
import { diversityFor, recommendTeams, type TeamCandidate } from "../../../shared/recommend";
import {
  allAssignedTeams,
  drawSupport,
  shuffleDraft,
  type DrawResult,
  type RotationContext,
} from "../../../shared/rotation";
import { DEFAULT_SETTINGS, type MatchView, type Team } from "../../../shared/types";
import { POSITION_LABEL } from "../../format";
import type { AppValue } from "../../useApp";
import { allAssignedText } from "./common";

/** 조건을 거는 중이면 다음에 누른 사람과 자리를 바꾸지 않고 조건을 만든다. */
export type PairMode = null | "same" | "different";

/**
 * 준비 화면의 편성 고치기: 고른 사람, 조건 걸기, 섞기·추천·되돌리기, 섞기 구역의 안내 문구.
 * 모든 고치기는 update를 거친다(초안 저장 + 오류·안내 문구 지우기). 서버에 보내는 것은 없다.
 */
export function usePrepEditing(app: AppValue, draft: Draft, ctx: RotationContext, setError: (error: unknown) => void) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TeamCandidate[] | null>(null);
  const [drawNote, setDrawNote] = useState<DrawResult | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [pairMode, setPairMode] = useState<PairMode>(null);
  /** 끌고 있는 사람(편성 또는 대기자)의 키. 놓을 자리 표시에 쓴다(TeamBoards·BenchSection). */
  const [dragKey, setDragKey] = useState<string | null>(null);
  // 팀·라인 모두 섞기을 눌렀는데 티어를 정한 사람이 없으면 섞기 구역에 배정 화면 링크를 남긴다(다음 조작 때 지운다).
  const [noPriorityNote, setNoPriorityNote] = useState(false);
  // 라인 섞기에서 기피 라인을 모두 피하지 못했으면 섞기 구역에 남긴다(다음 조작 때 지운다).
  const [avoidNote, setAvoidNote] = useState<string | null>(null);

  const nameOf = (key: string) => draft.people.find((p) => p.key === key)?.name ?? "";
  const update = (next: Draft) => {
    app.setDraft(next);
    setError(null);
    setNoPriorityNote(false);
    setAvoidNote(null);
  };
  // 초안 키 → 기피 라인(운영자 스냅숏의 참가자 정보). 아무도 없으면 빈 맵이라 섞기 결과가 예전과 같다.
  const avoidMap = avoidMapFor(draft.people, app.snapshot?.participants);
  const bench = draft.bench ?? [];

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

  /** 고른 사람·조건 걸기를 모두 푼다. */
  function clearSelection() {
    setSelectedKey(null);
    setPairMode(null);
  }

  function onTapPerson(key: string) {
    if (selectedKey === null) {
      setSelectedKey(key);
    } else if (selectedKey === key) {
      setSelectedKey(null);
      setPairMode(null);
    } else if (pairMode) {
      update(addConstraint(draft, { kind: pairMode, a: selectedKey, b: key }));
      setSelectedKey(null);
      setPairMode(null);
    } else {
      update(swapPeople(draft, selectedKey, key));
      setSelectedKey(null);
      setDrawNote(null);
    }
  }

  /** 초안 키 → 티어(skillGroup). 아직 참가자 ID가 없는 새 이름은 미지정. */
  function priorityMap(): PriorityMap {
    const groupOf = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.skillGroup]));
    return Object.fromEntries(
      draft.people.map((p) => [p.key, (p.participantId ? groupOf.get(p.participantId) : null) ?? null]),
    );
  }

  function showRecommendations() {
    const priorities = priorityMap();
    const people = draft.people.map((p) => ({ key: p.key, skillGroup: priorities[p.key] ?? null }));
    const weights = app.snapshot?.group.settings.groupWeights ?? DEFAULT_SETTINGS.groupWeights;
    // 조합 다양성(모임 설정, 기본 켜짐): 균형이 같은 후보 중 최근 경기와 덜 겹치는 조합을 먼저.
    const diversity = app.snapshot
      ? diversityFor({ matches: app.snapshot.matches, settings: app.snapshot.group.settings }, draft.people)
      : undefined;
    setCandidates(recommendTeams(people, weights, draft.seed, 3, draft.constraints ?? [], diversity));
  }

  function runDraw(teams: readonly Team[]) {
    const result = drawSupport(draft, teams, ctx);
    if (result.draft !== draft) update(result.draft);
    setDrawNote(result);
  }

  /** 팀·라인 모두 섞기: 같은 티어끼리 양 팀에 고르게 나누고 라인도 무작위(src/shared/priority.ts). */
  function runTeamShuffle() {
    const weights = app.snapshot?.group.settings.groupWeights ?? DEFAULT_SETTINGS.groupWeights;
    const result = shuffleTeamsByPriority(draft, priorityMap(), weights, avoidMap);
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
    update(result.draft);
    setNoPriorityNote(result.assigned === 0);
    app.setNotice(teamShuffleText(result) + noteAvoid(result.draft));
  }

  /** 라인만 섞기: fairSupport=false 라인만, true 라인 + 서포터 공평하게(src/shared/rotation.ts shuffleDraft). 팀원은 그대로다. */
  function runShuffle(fairSupport: boolean) {
    const next = shuffleDraft(draft, { fairSupport, avoid: avoidMap }, ctx);
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

  /** 진영 바꾸기: 블루팀 5명과 레드팀 5명을 통째로 맞바꾼다. */
  function swapTeamSides() {
    update(swapSides(draft));
    setSelectedKey(null);
    setPairMode(null);
    // 서포터 바꾸기 안내 문구의 팀 이름이 바뀌므로 지운다. 바꾼 결과 자체는 그대로 유지된다.
    setDrawNote(null);
    app.setNotice("블루팀과 레드팀을 맞바꿨어요. 라인·고정·서포터는 사람을 따라가요.");
  }

  /** 진영 랜덤: 반반 확률로 두 팀을 맞바꾼다. */
  function randomSide() {
    const next = randomDraftSide(draft);
    const first = draft.slots[0]!;
    const swapped = next.slots.find((s) => s.key === first.key)?.team !== first.team;
    update(next);
    setSelectedKey(null);
    setPairMode(null);
    if (swapped) setDrawNote(null);
    app.setNotice(
      swapped ? "진영 랜덤: 블루팀과 레드팀을 맞바꿨어요." : "진영 랜덤: 그대로예요. 지금 블루팀이 계속 블루예요.",
    );
  }

  /** "다음 경기 준비"로 만든 초안에서 지난 경기의 포지션을 그대로 쓴다. */
  function keepPositions(sourceMatch: MatchView) {
    const names = new Map(app.snapshot!.participants.map((p) => [p.id, p.name]));
    update(keepMatchPositions(draft, sourceMatch, (id) => names.get(id) ?? "", new Date().toISOString()));
    setDrawNote(null);
  }

  /** 고른 사람의 포지션 고정을 켜고 끈다. */
  function toggleSelectedLock() {
    if (selectedKey === null) return;
    update(toggleLock(draft, selectedKey));
    setSelectedKey(null);
  }

  /** 직전 편성으로(되돌리기) · 다시 앞으로. */
  function stepHistory(direction: "undo" | "redo") {
    update(direction === "undo" ? undoDraft(draft) : redoDraft(draft));
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
  }

  /** 추천 후보를 적용한다. 포지션은 새로 뽑는다. */
  function applyCandidate(candidate: TeamCandidate) {
    const next = applyTeams(draft, candidate.teamA, avoidMap);
    update(next);
    setCandidates(null);
    setDrawNote(null);
    const missed = noteAvoid(next).trim();
    if (missed) app.setNotice(missed);
  }

  /** 고른 사람을 편성 밖의 다른 참가자로 바꾼다. */
  function replaceSelected(person: DraftPerson) {
    if (selectedKey === null) return;
    update(replacePerson(draft, selectedKey, person));
    setReplacing(false);
    setSelectedKey(null);
    setDrawNote(null);
  }

  /** 조건 하나를 지운다. closeCandidates면 추천 창도 닫는다(충돌 안내에서 지울 때). */
  function dropConstraint(index: number, closeCandidates = false) {
    update(removeConstraint(draft, index));
    if (closeCandidates) setCandidates(null);
  }

  /**
   * 끌어다 놓기(2026-11-08, 손으로 배치를 고치는 자유도): source를 target 자리에 놓는다.
   * 둘 다 편성이면 자리(팀·포지션)를 맞바꾸고(swapPeople, 고정은 풀림), 한쪽이 대기자면 대기자와 바꾼다(swapWithBench).
   * 누르기 방식(onTapPerson·onTapBench)과 같은 함수를 쓰므로 되돌리기·서포터 기록도 같게 동작한다.
   */
  function dropPerson(sourceKey: string, targetKey: string) {
    setDragKey(null);
    if (sourceKey === targetKey) return;
    const inSlots = (key: string) => draft.slots.some((s) => s.key === key);
    const inBench = (key: string) => bench.some((p) => p.key === key);
    if (inSlots(sourceKey) && inSlots(targetKey)) {
      update(swapPeople(draft, sourceKey, targetKey));
    } else if (inSlots(sourceKey) && inBench(targetKey)) {
      update(swapWithBench(draft, sourceKey, targetKey));
      app.setNotice(`${nameOf(sourceKey)} 님 자리에 ${nameOf(targetKey)} 님을 넣었어요. ${nameOf(sourceKey)} 님은 대기자로 갔어요.`);
    } else if (inBench(sourceKey) && inSlots(targetKey)) {
      update(swapWithBench(draft, targetKey, sourceKey));
      app.setNotice(`${nameOf(targetKey)} 님 자리에 ${nameOf(sourceKey)} 님을 넣었어요. ${nameOf(targetKey)} 님은 대기자로 갔어요.`);
    } else {
      return;
    }
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
  }

  /** 대기자를 누르면: 편성 안의 사람을 골라 둔 상태면 둘을 맞바꾼다. 빠진 사람은 대기자 맨 뒤로 간다. */
  function onTapBench(benchKey: string) {
    const incoming = bench.find((p) => p.key === benchKey);
    if (!incoming) return;
    if (!selectedKey) {
      app.setNotice(`편성에서 ${incoming.name} 님과 바꿀 사람을 먼저 누르세요.`);
      return;
    }
    const outgoing = nameOf(selectedKey);
    update(swapWithBench(draft, selectedKey, benchKey));
    setSelectedKey(null);
    setPairMode(null);
    setDrawNote(null);
    app.setNotice(`${outgoing} 님 자리에 ${incoming.name} 님을 넣었어요. ${outgoing} 님은 대기자로 갔어요.`);
  }

  return {
    selectedKey,
    pairMode,
    setPairMode,
    candidates,
    setCandidates,
    drawNote,
    setDrawNote,
    replacing,
    setReplacing,
    noPriorityNote,
    avoidNote,
    avoidMap,
    bench,
    nameOf,
    update,
    priorityMap,
    clearSelection,
    onTapPerson,
    onTapBench,
    dragKey,
    setDragKey,
    dropPerson,
    showRecommendations,
    runDraw,
    runTeamShuffle,
    runShuffle,
    swapTeamSides,
    randomSide,
    keepPositions,
    toggleSelectedLock,
    stepHistory,
    applyCandidate,
    replaceSelected,
    dropConstraint,
  };
}

export type PrepEditing = ReturnType<typeof usePrepEditing>;
