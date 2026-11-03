"use strict";
let rotationState = null;
function rotationKey() {
  return "rift-rotation-v1:" + (demo ? "demo" : config.scriptUrl || "local");
}
function ensureLocalCycle() {
  if (!rotationState) {
    try {
      const x = JSON.parse(localStorage.getItem(rotationKey()) || "null");
      if (
        x &&
        Array.isArray(x.rounds) &&
        x.rounds.length <= 200 &&
        x.rounds.every(
          (r) => r && typeof r.id === "string" && validTeams(r.teams),
        ) &&
        Number.isFinite(x.startAt)
      )
        rotationState = x;
    } catch {}
  }
  if (
    !rotationState ||
    rotationState.scope !== rotationKey() ||
    rotationState.baseResetAt !== db.resetAt
  ) {
    rotationState = {
      scope: rotationKey(),
      baseResetAt: db.resetAt,
      startAt: db.resetAt || cycleStartTime(),
      rounds: [],
      activeId: null,
    };
  }
  return rotationState;
}
function persistRotation() {
  if (demo) return;
  try {
    localStorage.setItem(rotationKey(), JSON.stringify(rotationState));
  } catch {
    throw Error(
      "라인 순환 이력을 저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.",
    );
  }
}
function rotationLanes(name) {
  return [
    ...new Set(
      ensureLocalCycle()
        .rounds.flatMap((r) => [...r.teams.blue, ...r.teams.red])
        .filter((x) => x.name === name)
        .map((x) => x.lane),
    ),
  ];
}
function rotationReserved(x) {
  const state = ensureLocalCycle(),
    r = state.rounds.find((r) => r.id === state.activeId);
  return (
    !!r &&
    [...r.teams.blue, ...r.teams.red].some(
      (p) => p.name === x.name && p.lane === x.lane,
    )
  );
}
function rememberAssignment(teams, replace = false) {
  const state = ensureLocalCycle(),
    previous = structuredClone(state);
  if (replace && state.activeId) {
    const r = state.rounds.find((r) => r.id === state.activeId);
    if (r) r.teams = structuredClone(teams);
    else throw Error("현재 배정 이력을 찾지 못했습니다. 다시 배정해 주세요.");
  } else {
    if (state.rounds.length >= 200)
      throw Error("이번 순환의 배정 횟수가 많습니다. 새 순환을 시작해 주세요.");
    const id = crypto.randomUUID();
    state.rounds.push({ id, teams: structuredClone(teams) });
    state.activeId = id;
  }
  try {
    persistRotation();
  } catch (err) {
    rotationState = previous;
    throw err;
  }
}
function completeRotationMatch() {
  if (!rotationState) return;
  rotationState.baseResetAt = db.resetAt;
  rotationState.activeId = null;
  persistRotation();
}
function rotationComplete(){return locked&&names.length===10&&names.every(n=>n.trim()&&usedCycleLanes(n).length===5)}
async function showCycleComplete(){const cancel=document.querySelector('#cancel');cancel.hidden=true;try{await confirmAction('5회 배정 완료','모든 팀원이 다섯 라인을 한 번씩 배정받았습니다. 이번 배정으로 경기 결과를 저장할 수 있습니다. 다음 배정은 ‘새 5회 배정 시작’을 누른 뒤 가능합니다.','확인')}finally{cancel.hidden=false}}
