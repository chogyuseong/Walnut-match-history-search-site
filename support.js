"use strict";
let assignmentMode = "normal",
  supportUndo = null;
function supportKey() {
  return "rift-support-v1:" + (demo ? "demo" : config.scriptUrl || "local");
}
let supportCache = null,
  supportScope = "";
function supportLedger() {
  const scope = supportKey();
  if (!supportCache || scope !== supportScope) {
    supportScope = scope;
    supportCache = {};
    if (!demo)
      try {
        const v = JSON.parse(localStorage.getItem(scope) || "{}");
        if (v && typeof v === "object" && !Array.isArray(v))
          for (const [k, a] of Object.entries(v)) {
            if (
              Array.isArray(a) &&
              a.length <= 200 &&
              a.every((n) => typeof n === "string" && n.length <= 40)
            )
              supportCache[k] = [...new Set(a)];
          }
      } catch {}
  }
  return supportCache;
}
function supportRoster(t) {
  return names.slice(t === "blue" ? 0 : 5, t === "blue" ? 5 : 10);
}
function supportRosterKey(t){return t;}
function supportUsed(t){return (supportLedger()[t]||[]).filter(n=>supportRoster(t).includes(n));}

function storeSupport(next) {
  if (Object.keys(next).length > 200)
    throw Error(
      "서포터 순환 팀 이력이 많습니다. 사용하지 않는 팀 이력을 정리해 주세요.",
    );
  if (!demo) localStorage.setItem(supportKey(), JSON.stringify(next));
  supportCache = next;
  supportScope = supportKey();
}
function planSupport(t, ledger) {
  const list = supportRoster(t),
    used = ledger[supportRosterKey(t)] || [];
  const valid = PERMS.filter((p) =>
    list.every((n, i) => p[i] !== 4 || !used.includes(n)),
  );
  if (!valid.length)
    throw Error(
      `${t === "blue" ? "블루" : "레드"} 팀은 서포터를 모두 한 번씩 받았습니다. 해당 팀 서포터 순환을 초기화해 주세요.`,
    );
  const p = valid[Math.floor(Math.random() * valid.length)];
  return list.map((name, i) => ({ name, lane: p[i] }));
}
async function rotateSupport(target = "both") {
  validateNames();

  if (
    assignment &&
    !["blue", "red"].every((t) =>
      assignment[t].every((x, i) => x.name === supportRoster(t)[i]),
    )
  )
    throw Error(
      "팀원이 변경되었습니다. 양팀 서포터 순환으로 다시 배정해 주세요.",
    );
  const next = assignment ? structuredClone(assignment) : {blue:supportRoster("blue").map(name=>({name,lane:null})),red:supportRoster("red").map(name=>({name,lane:null}))},
    ledger = structuredClone(supportLedger()),
    teams = (target === "both" ? ["blue", "red"] : [target]).filter(
      (t) => (ledger[supportRosterKey(t)] || []).filter(n=>supportRoster(t).includes(n)).length < 5,
    );
  if (!teams.length)
    throw Error(
      "서포터 순환이 완료되었습니다. 팀별 초기화 후 다시 시작해 주세요.",
    );
  for (const t of teams) {
    next[t] = planSupport(t, ledger);
    ledger[supportRosterKey(t)] = [
      ...(ledger[supportRosterKey(t)] || []),
      next[t].find((x) => x.lane === 4).name,
    ];
  }
  if (!validTeams(next,true)) throw Error("팀 배정을 확인해 주세요.");
  const snapshot = {
    ledger: structuredClone(supportLedger()),
    assignment: assignment ? structuredClone(assignment) : null,
    mode: assignmentMode,
  };
  storeSupport(ledger);
  supportUndo = snapshot;
  undoLineup = snapshot.assignment;
  assignment = next;
  assignmentMode = "support";
  manualMode = false;
  pendingSave = null;
  render();
  const complete = teams.filter((t) => supportUsed(t).length === 5);
  toast(
    teams
      .map(
        (t) => `${t === "blue" ? "블루" : "레드"} ${supportUsed(t).length}/5`,
      )
      .join(" · ") +
      (complete.length ? " · 서포터 순환 완료, 초기화 후 재배정 가능" : ""),
  );
  if (complete.length) {
    const cancel = document.querySelector("#cancel");
    cancel.hidden = true;
    try {
      await confirmAction(
        "서포터 5회 배정 완료",
        complete.map((t) => (t === "blue" ? "블루팀" : "레드팀")).join(" · ") +
          " 전원이 서포터를 한 번씩 받았습니다. 해당 팀 초기화 후 다시 배정할 수 있습니다.",
        "확인",
      );
    } finally {
      cancel.hidden = false;
    }
  }
}
async function resetSupport(t) {
  if (
    !(await confirmAction(
      `${t === "blue" ? "블루" : "레드"} 팀 서포터 순환 초기화`,
      "해당 진영의 서포터 배정 이력만 초기화합니다. 일반 랜덤 배정과 경기 기록은 유지합니다.",
    ))
  )
    return;
  const next = structuredClone(supportLedger());
  delete next[supportRosterKey(t)];
  storeSupport(next);
  supportUndo = null;
  undoLineup = null;
  render();
}
function undoSupport() {
  if (!supportUndo || !assignment)
    throw Error("되돌릴 서포터 배정이 없습니다.");
  const prev = supportUndo;
  storeSupport(prev.ledger);
  assignment = prev.assignment;
  assignmentMode = prev.mode;
  supportUndo = null;
  undoLineup = null;
  render();
}
function supportStatus(){return `<section class="panel support-status"><h2>서포터 전용 순환</h2><p class="small">일반 포지션 배정은 매번 완전 랜덤입니다. 이 서포터 전용 기능만 이미 서포터를 받은 사람을 제외합니다. 각 팀 5명 모두 받으면 해당 팀 초기화 후 다시 시작하세요.</p><h3>서포터 라인 순환 현황</h3><div class="teams">${['blue','red'].map(t=>`<div><h3 class="${t}-text">${t.toUpperCase()} · ${supportUsed(t).length}/5</h3><div class="tablewrap"><table><thead><tr><th>플레이어</th><th>서포터 배정</th></tr></thead><tbody>${supportRoster(t).map(name=>`<tr><td>${esc(name)||'이름 미입력'}</td><td>${!name?'—':supportUsed(t).includes(name)?'✓ 배정 완료':'남음'}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}</div><p class="small">현재 배정: ${assignmentMode==='support'?'서포터 전용 모드':'일반 랜덤 모드'} · 서포터 이력은 이 기기에 저장됩니다.</p></section>`}
