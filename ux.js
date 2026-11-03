"use strict";
let lastSyncedAt = null,
  lastSaved = null,
  undoLineup = null,
  historyQuery = "",
  historyDate = "",
  historySide = "",
  historyLimit = 20;
function filteredGames() {
  return [...db.matches]
    .filter(
      (m) =>
        (!historyQuery ||
          [...m.blue, ...m.red].some((x) => x.name.includes(historyQuery))) &&
        (!historyDate ||
          new Date(m.time).toLocaleDateString("en-CA", {
            timeZone: "Asia/Seoul",
          }) === historyDate) &&
        (!historySide || m.winner === historySide),
    )
    .sort((a, b) => b.time - a.time);
}
function recoveryPanel() {
  return `<details class="panel"><summary>삭제 보관함 · ${(db.trash || []).length}경기</summary>${
    [...(db.trash || [])]
      .reverse()
      .slice(0, 50)
      .map(
        (m) =>
          `<div class="row between"><span>${new Date(m.time).toLocaleDateString("ko-KR")} · ${esc(m.blue[0].name)} 외 9명 · ${m.winner === "blue" ? "블루" : "레드"} 승리</span><button data-recover-id="${esc(m.id)}">이 경기 복구</button></div>`,
      )
      .join("") || "<p>삭제한 경기가 없습니다.</p>"
  }</details><details class="panel"><summary>최근 변경 이력</summary>${
    [...(db.auditLog || [])]
      .reverse()
      .slice(0, 20)
      .map(
        (x) =>
          `<p class="small">${new Date(x.time).toLocaleString("ko-KR")} · ${x.kind === "add" ? "추가" : x.kind === "delete" ? "삭제" : "변경"} · ${x.before} → ${x.after}경기</p>`,
      )
      .join("") || "<p>새로 저장한 변경부터 표시됩니다.</p>"
  }</details>`;
}
function history() {
  return (
    `<section class="panel"><h2>경기 찾기</h2><form id="history-filter" class="row"><input aria-label="경기 참가자" name="player" placeholder="참가자 이름" value="${esc(historyQuery)}"><input aria-label="경기 날짜" type="date" name="date" value="${esc(historyDate)}"><select name="side" aria-label="승리 진영"><option value="">모든 결과</option><option value="blue" ${historySide === "blue" ? "selected" : ""}>블루 승리</option><option value="red" ${historySide === "red" ? "selected" : ""}>레드 승리</option></select><button>검색</button></form><p>${filteredGames().length}경기 검색됨</p></section>` +
    historyBody() +
    `<div class="row"><button data-ux="more" ${filteredGames().length <= historyLimit ? "disabled" : ""}>20경기 더 보기</button><button data-ux="restore" ${(db.trash || []).length ? "" : "disabled"}>최근 삭제 경기 복구 (${(db.trash || []).length})</button></div>` +
    recoveryPanel()
  );
}
function uxTop(route) {
  let html = "";
  if (route === "setup")
    html = `<section class="notice"><div class="step-strip"><span><b>1</b>팀원 선택</span><span><b>2</b>포지션 배정</span><span><b>3</b>승리 팀 선택</span><span><b>4</b>기록 저장</span></div><div class="row"><button data-ux="recent">지난 경기 멤버 불러오기</button><button data-ux="undo" ${supportUndo && assignment ? "" : "disabled"}>서포터 배정 되돌리기</button></div><p class="small">서포터 전용 순환은 서포터 중복만 제한합니다. 일반 포지션 배정과 별도로 진행합니다.</p></section>`;
  if (route === "setup")
    html += `<details id="quick-members" class="panel" ${quickMembersExpanded()?'open':''}><summary>참가자 빠르게 선택 · ${quickMembersExpanded()?'간편히 보기':'자세히 보기'}</summary><div class="row">${stats()
      .map(
        (p) =>
          `<button data-member="${esc(p.name)}" ${names.includes(p.name) ? "disabled" : ""}>${esc(p.name)}</button>`,
      )
      .join("")}</div></details>`;
  if (lastSaved && route === "setup")
    html += `<section class="notice" role="status"><h2>${config.scriptUrl && !demo ? "공용" : "현재 브라우저"} 저장 완료 · ${lastSaved.winner === "blue" ? "블루" : "레드"} 승리</h2><p>${new Date(lastSaved.time).toLocaleString("ko-KR")}</p>${["blue", "red"].map((t) => `<p>${t.toUpperCase()}: ${lastSaved[t].map((x) => esc(x.name) + " (" + LANES[x.lane] + ")").join(" · ")}</p>`).join("")}<a href="#history">경기 확인·승패 수정 →</a></section>`;
  if (route === "stats" || route === "charts") {
    const players = stats(),
      known = db.matches.filter((m) =>
        [...m.blue, ...m.red].every((x) => Number.isInteger(x.lane)),
      ).length;
    html += `<p class="notice">전체 ${db.matches.length}경기 · 라인 정보가 모두 있는 ${known}경기. 라인 미상 기록은 전체 승률에만 반영됩니다. 전체 ${MIN_RANK_GAMES}전 미만은 배치 진행 중입니다. 전체·라인 지표 모두 배치 완료자 아래에 표시됩니다.</p>`;
  }
  return (
    (lastSyncedAt
      ? `<p class="small" role="status">마지막 공용 기록 확인: ${new Date(lastSyncedAt).toLocaleTimeString("ko-KR")}</p>`
      : "") + html
  );
}
document.addEventListener("submit", (e) => {
  if (e.target.id !== "history-filter") return;
  e.preventDefault();
  const f = new FormData(e.target);
  historyQuery = String(f.get("player")).trim();
  historyDate = String(f.get("date"));
  historySide = String(f.get("side"));
  historyLimit = 20;
  render();
});
document.addEventListener("click", async (e) => {
  const button = e.target.closest("[data-ux]");
  if (!button) return;
  try {
    const a = button.dataset.ux;
    if (a === "recent") {
      const m = [...db.matches].sort((a, b) => b.time - a.time)[0];
      if (!m) throw Error("최근 경기 기록이 없습니다.");
      names = [...m.blue, ...m.red].map((x) => x.name);
      assignment = null;
      render();
    }
    if (a === "more") {
      historyLimit += 20;
      render();
    }
    if (a === "undo") {
      undoSupport();
      return;
    }
    if (a === "restore") {
      const trash = db.trash || [],
        m = trash[trash.length - 1];
      if (!m) return;
      if (db.matches.some((x) => x.id === m.id))
        throw Error("이미 복구된 경기입니다.");
      await commit({
        ...db,
        matches: [...db.matches, m],
        trash: trash.slice(0, -1),
      });
      render();
      toast("삭제한 경기를 복구했습니다.");
    }
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-member]");
  if (!b) return;
  const i = names.findIndex((n) => !n.trim());
  if (i < 0) {
    toast("10명이 모두 선택되었습니다. 교체할 이름 칸을 먼저 비워 주세요.");
    return;
  }
  rememberQuickMembers();
  const quickTop = document.querySelector("#quick-members")?.getBoundingClientRect().top;
  names[i] = b.dataset.member;
  assignment = null;
  render();
  if (quickTop !== undefined) requestAnimationFrame(() => { const panel = document.querySelector("#quick-members"); if(panel) window.scrollBy(0,panel.getBoundingClientRect().top-quickTop); });
});

document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-recover-id]");
  if (!b) return;
  b.disabled = true;
  try {
    const m = (db.trash || []).find((x) => x.id === b.dataset.recoverId);
    if (!m || db.matches.some((x) => x.id === m.id))
      throw Error("복구할 경기를 다시 확인해 주세요.");
    await commit({
      ...db,
      matches: [...db.matches, m],
      trash: db.trash.filter((x) => x.id !== m.id),
    });
    render();
    toast("선택한 경기를 복구했습니다.");
  } catch (err) {
    toast(err.message);
    b.disabled = false;
  }
});

function enhanceClarity() {
  const app = document.querySelector("#app");
  app.setAttribute("aria-busy", String(publicLoading && !demo));
  document.querySelectorAll(".tablewrap").forEach((el) => {
    el.tabIndex = 0;
    el.setAttribute("role", "region");
    el.setAttribute(
      "aria-label",
      "통계 표 · 내용이 넓으면 좌우로 이동할 수 있습니다",
    );
  });
  document.querySelectorAll(".cycle-panel tbody tr").forEach((row) => {
    const name = row.cells[0]?.textContent;
    [...row.cells].slice(1).forEach((cell, i) => {
      const text = cell.textContent.trim();
      cell.setAttribute(
        "aria-label",
        name +
          " · " +
          LANES[i] +
          " · " +
          (text === "✓"
            ? "사용 완료"
            : text === "●"
              ? "현재 배정"
              : "선택 가능"),
      );
      cell.title = cell.getAttribute("aria-label");
      cell.dataset.laneState =
        text === "✓" ? "used" : text === "●" ? "current" : "available";
    });
  });
  document.querySelectorAll("#rank-body tr").forEach((row) => {
    const name = row.querySelector(".playercell");
    if (name)
      row.dataset.placement =
        !!name.querySelector(".honor-name") &&
        name.querySelector(".honor-name").textContent === "배치 진행 중"
          ? "pending"
          : "complete";
  });
  document.querySelectorAll("button:disabled").forEach((button) => {
    if (button.dataset.action === "support-cycle")
      button.title = "먼저 10명의 포지션을 배정해 주세요";
    if (button.dataset.ux === "undo")
      button.title = "서포터를 교체한 뒤 되돌릴 수 있습니다";
  });
}
document.addEventListener("click", (e) => {
  const link = e.target.closest(".skip-link");
  if (!link) return;
  e.preventDefault();
  document.querySelector("#app").focus();
});

function explainSetupControls(){
 document.body.dataset.setupHelp=location.hash==='#setup'?(setupHelpVisible()?'on':'off'):'on';
 if(location.hash!=='#setup')return;
 const help={
  sync:demo?'현재 예시 화면입니다. 실제 기록을 보려면 아래 실제 기록으로 돌아가기를 누르세요.':config.scriptUrl?'친구들이 저장한 최신 경기 기록을 다시 불러옵니다. 작성 중인 팀 배정은 유지됩니다.':'여러 기기에서 경기 기록을 함께 보려면 구글 시트 연결 화면으로 이동하세요.',
  recent:'가장 최근 경기의 10명을 같은 팀으로 불러옵니다. 이름을 확인한 뒤 포지션을 다시 배정하세요.',
  undo:'마지막 서포터 배정과 해당 사용 횟수를 함께 되돌립니다. 경기 저장 후에는 되돌릴 수 없습니다.',
  reset:'일반 포지션 배정을 처음부터 다시 시작합니다. 경기 기록과 서포터 전용 횟수는 지우지 않습니다.',
  'manual-positions':'팀원 옆에 라인 선택 메뉴를 엽니다. 한 팀 안에서 다섯 라인을 하나씩 선택하세요.',
  assign:'10명의 라인을 매번 완전히 무작위로 정합니다. 같은 사람이 이전과 같은 라인에 다시 배정될 수 있고 횟수 제한이 없습니다.',
  'support-cycle':'서포터를 받지 않은 사람을 양 팀에서 한 명씩 뽑습니다. 나머지 라인도 무작위로 바뀌며, 완료된 팀은 그대로 둡니다.',
  'support-blue':'블루팀 5명만 다시 배정합니다. 서포터를 받았던 사람은 서포터에서 제외하고, 레드팀은 그대로 둡니다.',
  'support-red':'레드팀 5명만 다시 배정합니다. 서포터를 받았던 사람은 서포터에서 제외하고, 블루팀은 그대로 둡니다.',
  'support-reset-blue':'블루팀의 서포터 사용 횟수만 0으로 되돌립니다. 레드팀·일반 포지션 배정·경기 기록은 유지됩니다.',
  'support-reset-red':'레드팀의 서포터 사용 횟수만 0으로 되돌립니다. 블루팀·일반 포지션 배정·경기 기록은 유지됩니다.',
  'exit-demo':'예시 화면을 닫고 실제 모임 기록으로 돌아갑니다. 예시 경기는 실제 기록에 저장되지 않습니다.',
  demo:'연습용 팀과 기록으로 기능을 시험합니다. 실제 모임 경기 기록에는 반영되지 않습니다.'
 };
 let count=0;
 const paragraph=(text)=>{const p=document.createElement('p');p.className='feature-help';p.textContent=text;p.id='setup-help-'+(++count);return p};
 document.querySelectorAll('#app button').forEach(button=>{if(button.closest('.feature-control'))return;const key=button.dataset.action||button.dataset.ux;let text=help[key];if(button.dataset.winner)text=`경기가 끝난 뒤 ${button.dataset.winner==='blue'?'블루팀':'레드팀'}이 이겼을 때 누르세요. 확인창에서 확인을 누르면 양 팀 10명의 승패와 라인 성적을 저장합니다.`;if(!text)return;const wrap=document.createElement('div');wrap.className='feature-control';if(key==='manual-positions')wrap.classList.add('manual-position-control');button.before(wrap);wrap.append(button);const p=paragraph(text);wrap.append(p);button.setAttribute('aria-describedby',p.id);});
 const lock=document.querySelector('#lock');if(lock&&!document.querySelector('[data-lock-help]')){const p=paragraph('켜짐: 일반 배정은 항상 랜덤입니다. 꺼짐: 같은 라인도 다시 나올 수 있습니다. 서포터 전용 순환은 별도 규칙을 사용합니다.');p.dataset.lockHelp='';lock.closest('label').after(p);lock.setAttribute('aria-describedby',p.id);}
 document.querySelectorAll('#app .team').forEach((team,index)=>{const header=team.querySelector('.row');const p=paragraph(`${index===0?'블루':'레드'}팀으로 함께할 5명의 이름을 한 칸에 한 명씩 입력하세요. 10명의 이름은 서로 달라야 합니다. 오른쪽에는 배정된 라인이 표시됩니다.`);header.after(p);team.querySelectorAll('[data-name]').forEach(input=>input.setAttribute('aria-describedby',p.id));});
 document.querySelectorAll('#app details>summary').forEach(summary=>{let text='누르면 자세한 설명을 펼치거나 접습니다.';if(summary.closest('.cycle-panel'))text='누르면 선수별 남은 라인과 사용 횟수를 확인합니다. 5/5가 되면 일반 순환 초기화가 필요합니다.';else if(summary.textContent.includes('참가자 빠르게'))text='펼친 뒤 이름을 누르면 첫 번째 빈 이름 칸에 들어갑니다. 블루 5칸을 먼저 채우고 레드 5칸을 채웁니다.';else if(summary.textContent.includes('이미 진행한'))text='실제로 플레이한 라인이 화면과 다를 때 펼쳐서 수정하세요. 저장 전에 양 팀의 라인을 모두 확인하세요.';const p=paragraph(text);const span=document.createElement("span");span.className=p.className;span.textContent=p.textContent;summary.append(span);});
 const probability=document.querySelector('.probability');if(probability){probability.querySelector('.row').after(paragraph('이전 전체·라인 전적으로 계산한 참고용 비교입니다. 실제 승리 확률을 보장하지 않으며 기록이 없으면 50%로 표시됩니다.'));}
 const result=document.querySelector('.resultbar');if(result){result.prepend(paragraph(config.scriptUrl?'경기 결과는 공용 구글 시트에 저장됩니다. 조회 모드라면 먼저 연결 설정에서 모임 암호를 입력하세요.':'경기 결과는 현재 브라우저에 저장됩니다. 친구들과 공유하려면 구글 시트 공용 저장을 연결하세요.'));}
}

// Explicit user choice survives participant selection, redraw, route changes and reload.
let quickMembersMemory = null;
function quickMembersExpanded(){
 if(quickMembersMemory !== null)return quickMembersMemory;
 try{return localStorage.getItem('rift-quick-members-expanded')==='true'}catch{return false}
}
function rememberQuickMembers(){const el=document.querySelector('#quick-members');if(!el)return;quickMembersMemory=el.open;try{localStorage.setItem('rift-quick-members-expanded',String(el.open))}catch{}}
document.addEventListener('toggle',e=>{if(e.target.id!=='quick-members'||!e.target.isConnected)return;rememberQuickMembers();const summary=e.target.querySelector('summary');if(summary){const node=[...summary.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);if(node)node.textContent='참가자 빠르게 선택 · '+(e.target.open?'간편히 보기':'자세히 보기')}},true);
// Save the user's intent before the native toggle event, which may arrive after a redraw.
document.addEventListener('click',e=>{const summary=e.target.closest('#quick-members>summary');if(!summary)return;quickMembersMemory=!summary.parentElement.open;try{localStorage.setItem('rift-quick-members-expanded',String(quickMembersMemory))}catch{}},true);

let setupHelpMemory=null;
function setupHelpVisible(){if(setupHelpMemory!==null)return setupHelpMemory;try{return localStorage.getItem('rift-setup-help-visible')==='true'}catch{return false}}
document.addEventListener('click',e=>{const button=e.target.closest('[data-setup-help-toggle]');if(!button)return;setupHelpMemory=!setupHelpVisible();try{localStorage.setItem('rift-setup-help-visible',String(setupHelpMemory))}catch{}document.body.dataset.setupHelp=setupHelpMemory?'on':'off';button.textContent=setupHelpMemory?'설명 끄기':'설명 켜기';button.setAttribute('aria-pressed',String(setupHelpMemory));});
