"use strict";
let pendingSave = null;
const DRAFT_KEY = "rift-local-draft-v2";
function persistDraft() {
  if (demo) return;
  try {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        url: config.scriptUrl || "",
        names,
        assignment,
        locked,
        manualMode,
        assignmentMode,
        pendingSave,
      }),
    );
  } catch {}
}
function restoreDraft() {
  try {
    const d = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    if (!d || d.url !== (config.scriptUrl || "")) return;
    if (
      Array.isArray(d.names) &&
      d.names.length === 10 &&
      d.names.every((n) => typeof n === "string" && n.length <= 40)
    )
      names = d.names;
    if (d.assignment && validTeams(d.assignment,true)) assignment = d.assignment;
    locked = false;
    manualMode = !!d.manualMode;
    assignmentMode = d.assignmentMode === "support" ? "support" : "normal";
    if (
      d.pendingSave &&
      typeof d.pendingSave.signature === "string" &&
      validMatch(d.pendingSave.match)
    )
      pendingSave = d.pendingSave;
  } catch {}
}
document.addEventListener("input", () => queueMicrotask(persistDraft));
document.addEventListener("change", () => queueMicrotask(persistDraft));
function applyStage() {
  const route = location.hash.slice(1);
  if (route !== "setup") return;
  document.body.dataset.stage =
    lastSaved && !assignment ? "saved" : assignment&&validTeams(assignment) ? "assigned" : "members";
  document.querySelectorAll(".step-strip span").forEach((el, i) => {
    const current =
      i === (document.body.dataset.stage === "saved" ? 3 : assignment ? 2 : 0);
    el.classList.toggle("is-current", current);
    if (current) el.setAttribute("aria-current", "step");
    else el.removeAttribute("aria-current");
  });
  const result = document.querySelector(".resultbar");
  if (result && assignment) {
    result.setAttribute("aria-label", "3단계: 경기 후 승리 팀 선택");
    const teams=document.querySelector("#app > .teams");
    if(teams)teams.after(result);
  }
  const assign = document.querySelector("[data-action=assign]");
  if (assign) {
    assign.classList.toggle("primary", !assignment);
    assign.disabled = false;

  }
  const bothSupport=document.querySelector('[data-action="support-cycle"]');if(bothSupport){bothSupport.disabled=['blue','red'].every(t=>supportUsed(t).length===5);if(bothSupport.disabled){bothSupport.textContent='서폿 돌리기 완료';bothSupport.title='팀별 서포터 초기화 후 다시 배정할 수 있습니다';}}

}
