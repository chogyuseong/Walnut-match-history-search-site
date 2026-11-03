"use strict";
const LANES = ["탑", "정글", "미드", "원딜", "서포터"],
  KEY = "rift-google-config-v1";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let db = { matches: [], resetAt: null },
  rev = 0,
  session = null,
  config = window.RIFT_CONFIG || {},
  demo = false,
  busy = false,
  assignment = null,
  names = Array(10).fill(""),
  locked = false,
  chartLane = "all",
  chartPlayer = "all";
try {
  config = { ...config, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  session = JSON.parse(
    sessionStorage.getItem("rift-google-session") ||
      localStorage.getItem("rift-google-session") ||
      "null",
  );
} catch {}
if (session?.expiresAt && session.expiresAt < Date.now()) {
  session = null;
  localStorage.removeItem("rift-google-session");
  sessionStorage.removeItem("rift-google-session");
}
if (window.RIFT_CONFIG?.scriptUrl)
  config.scriptUrl = window.RIFT_CONFIG.scriptUrl;
let publicLoading = !!config.scriptUrl,
  publicError = "";
const rate = (s) => (s.n ? `${((s.w / s.n) * 100).toFixed(1)}%` : "—");
const RATE_BANDS = [
  { min: 90, color: "#f8df91", rainbow: true, label: "90% 이상" },
  { min: 80, color: "#f8df91", label: "80–89%" },
  { min: 70, color: "#c6a0f4", label: "70–79%" },
  { min: 60, color: "#f391b4", label: "60–69%" },
  { min: 55, color: "#f3ad76", label: "55–59%" },
  { min: 50, color: "#61cddd", label: "50–54%" },
  { min: 45, color: "#75c3f5", label: "45–49%" },
  { min: 40, color: "#85aaff", label: "40–44%" },
  { min: 35, color: "#ffffff", label: "35–39%" },
  { min: 30, color: "#a6a6a6", label: "30–34%" },
  { min: 0, color: "#111111", label: "30% 미만" },
];
function rateColor(s) {
  return s.n
    ? RATE_BANDS.find((b) => (s.w / s.n) * 100 >= b.min).color
    : "#9aa7bd";
}
const RATE_RAINBOW =
  "linear-gradient(100deg,#ff9ea7 0%,#ffc883 20%,#ffe89a 38%,#85dece 56%,#8abaff 74%,#d2a4ff 100%)";
function rateFill(s) {
  return s.n && s.w / s.n >= 0.9 ? RATE_RAINBOW : rateColor(s);
}
function rateBackground(s) {
  const c = rateColor(s);
  return s.n
    ? `rgba(${[1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)).join(",")},.14)`
    : "#242c39";
}
function rateLegend() {
  return (
    '<div class="rate-legend" aria-label="승률 색상 안내">' +
    [...RATE_BANDS]
      .reverse()
      .map(
        (b) =>
          `<span><i style="background:${b.rainbow ? RATE_RAINBOW : b.color}"></i>${b.label}</span>`,
      )
      .join("") +
    "</div>"
  );
}
function rateHTML(s) {
  return `<span class="rate-value${s.n && s.w / s.n < 0.3 ? " rate-black" : ""}${s.n && s.w / s.n >= 0.9 ? " rate-rainbow" : ""}" style="color:${rateColor(s)}">${rate(s)}</span>`;
}
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").classList.remove("hide");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.add("hide"), 5000);
}
function confirmAction(title, body, acceptLabel = "확인") {
  return new Promise((resolve) => {
    const d = $("#confirm");
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    $("#accept").textContent = acceptLabel;
    $("#accept").classList.toggle("danger", acceptLabel === "전체 삭제");
    $("#accept").classList.toggle("primary", acceptLabel !== "전체 삭제");
    d.showModal();
    $("#accept").onclick = () => {
      d.close();
      resolve(true);
    };
    $("#cancel").onclick = () => {
      d.close();
      resolve(false);
    };
    d.oncancel = () => resolve(false);
  });
}
const MIN_RANK_GAMES = 50;
const HONOR_TIERS = [
  {
    min: 95,
    name: "협곡의 절대신",
    icon: "✨",
    color: "#f7df9c",
    desc: "승리를 넘어 전설을 쓰는 호두",
  },
  {
    min: 90,
    name: "호두의 신",
    icon: "👑",
    color: "#edc979",
    desc: "협곡을 지배하는 황금 호두",
  },
  {
    min: 85,
    name: "천안의 전설",
    icon: "🏆",
    color: "#e9bd77",
    desc: "우리 모임에 길이 남을 전적",
  },
  {
    min: 80,
    name: "천안의 패왕",
    icon: "🔥",
    color: "#ffad7c",
    desc: "이름만 들어도 긴장되는 상대",
  },
  {
    min: 75,
    name: "협곡의 지배자",
    icon: "🔱",
    color: "#c0a5ee",
    desc: "흐름을 읽고 협곡을 이끄는 플레이어",
  },
  {
    min: 70,
    name: "믿고 맡기는 에이스",
    icon: "⚡",
    color: "#a6a2ff",
    desc: "우리 팀에 있으면 든든한 한 사람",
  },
  {
    min: 65,
    name: "승리의 설계자",
    icon: "🎯",
    color: "#7ad8cd",
    desc: "승리까지의 길을 만드는 한 사람",
  },
  {
    min: 60,
    name: "승리의 호두",
    icon: "walnut",
    color: "#7bd9b4",
    desc: "한 판 한 판, 승리를 쌓는 중",
  },
  {
    min: 55,
    name: "든든한 캐리 후보",
    icon: "⚔️",
    color: "#e8ab90",
    desc: "반격의 첫걸음을 앞장서서",
  },
  {
    min: 50,
    name: "제 몫 하는 호두",
    icon: "red-shield",
    color: "#f18b9b",
    desc: "다음 한 판이 반등의 시작",
  },
  {
    min: 40,
    name: "불굴의 도전자",
    icon: "💪",
    color: "#bbb4e5",
    desc: "넘어져도 다시 큐를 잡는다",
  },
  {
    min: 30,
    name: "대기만성 호두",
    icon: "🌱",
    color: "#adbfae",
    desc: "지금은 성장 중, 전성기는 이제부터",
  },
  {
    min: 20,
    name: "성장하는 호두",
    icon: "🌿",
    color: "#9abfaa",
    desc: "경험을 쌓으며 단단해지는 중",
  },
  {
    min: 10,
    name: "새싹 호두",
    icon: "🍃",
    color: "#a4b8bc",
    desc: "작은 새싹도 언젠가는 큰 나무로",
  },
  {
    min: 0,
    name: "갓 심은 호두",
    icon: "🫘",
    color: "#afa9a3",
    desc: "승리의 씨앗을 심는 중",
  },
];
function honorIcon(t) {
  const markup =
    t.icon === "walnut"
      ? '<svg class="honor-svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M12,21 C17,21 19,17 19,13.1176471 C19,9.03921569 16.6666667,6 12,4 C7.33333333,6 5,9.03921569 5,13.1176471 C5,17 7,21 12,21 Z M12,6.671573 L13.061931,7.73319066 C13.3416946,7.58434358 13.6609976,7.50000012 14,7.50000012 C15.1045695,7.50000012 16,8.39543063 16,9.50000012 C16,9.91213989 15.8753378,10.2951632 15.6616637,10.6134199 C16.4408283,10.8848612 17,11.6271299 17,12.5000001 C17,12.8644244 16.9025324,13.2060839 16.7322434,13.5003323 C16.9025324,13.7939164 17,14.1355759 17,14.5000001 C17,15.6045696 16.1045695,16.5000001 15,16.5000001 C15,17.6045696 14.1045695,18.5000001 13,18.5000001 C12.6356829,18.5000001 12.2941173,18.4025898 11.9999275,18.2323938 C11.7066608,18.4023678 11.364732,18.5000001 11,18.5000001 C9.8954305,18.5000001 9,17.6045696 9,16.5000001 L9,16.5000001 L8.85073766,16.4945144 C7.81587779,16.4181652 7,15.5543619 7,14.5000001 C7,14.1355759 7.09746762,13.7939164 7.26775657,13.499668 C7.09746762,13.2060839 7,12.8644244 7,12.5000001 C7,11.6271299 7.55917167,10.8848612 8.33884361,10.6118654 C8.12466221,10.2951632 8,9.91213989 8,9.50000012 C8,8.39543063 8.8954305,7.50000012 10,7.50000012 C10.3390024,7.50000012 10.6583054,7.58434358 10.938069,7.73319066 L12,6.671573 Z M12,7.5 L12,17.5 M8.58578644,8.085786 C7.80473785,8.86683458 7.80473785,10.1331645 8.58578644,10.9142131 C9.05192952,11.3803562 9.69092525,11.5682972 10.2964508,11.478036 M14.4142136,17.9142131 C15.1952621,17.1331645 15.1952621,15.8668346 14.4142136,15.085786 M16.3677673,11.03934 C15.7819807,10.4535534 14.8322334,10.4535536 14.246447,11.03934 M7.64644661,15.9000002 C8.23223305,16.4857866 9.18198052,16.4857866 9.76776695,15.9000002" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : t.icon === "red-shield"
        ? '<svg class="honor-svg red-shield" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 6v6c0 5-5 9-9 10-4-1-9-5-9-10V6Z" fill="#a82b46" stroke="#ffabb9" stroke-width="1.5"/><path d="m8 12 4-4 4 4m-4-4v9" fill="none" stroke="#ffe2e7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : `<span aria-hidden="true">${t.icon}</span>`;
  const i = HONOR_TIERS.indexOf(t),
    level = i < 0 ? 0 : HONOR_TIERS.length - 1 - i;
  return `<span class="honor-symbol" style="--icon-size:${16 + level}px;--hero-icon-size:${34 + level * 1.5}px">${markup}</span>`;
}
function playerHonor(p) {
  if (p.n < MIN_RANK_GAMES)
    return {
      name: "배치 진행 중",
      icon: "🥚",
      color: "#adb6cb",
      desc: `${MIN_RANK_GAMES - p.n}경기 더 플레이하면 배치가 완료되고 칭호가 부여됩니다.`,
    };
  return HONOR_TIERS.find((t) => (p.w / p.n) * 100 >= t.min);
}
function honorBadge(p) {
  const t = playerHonor(p);
  return `<span class="honor-badge ${t.icon === "red-shield" ? "honor-red" : ""}" style="--honor:${t.color}" title="전체 승률 기준 · ${esc(t.desc)}">${honorIcon(t)} <span class="honor-name">${t.name}</span></span>`;
}
function honorPanel(p) {
  const t = playerHonor(p);
  return `<section class="panel honor-panel ${t.icon === "red-shield" ? "honor-red" : ""}" style="--honor:${t.color};margin:20px 0"><div class="honor-icon" aria-hidden="true">${honorIcon(t)}</div><div><div class="small">현재 칭호 · 전체 ${p.n}경기 기준</div><h2>${t.name}</h2><p>${t.desc}</p></div><details class="honor-guide"><summary>칭호 획득 기준</summary><p class="small">전체 ${MIN_RANK_GAMES}경기부터 승률에 따라 칭호가 자동 부여되고 배치 완료 그룹에 표시됩니다. 경기 추가·승패 수정 시 다시 계산됩니다. 포지션 필터와 관계없이 전체 승률 기준입니다.</p><div class="honor-tiers">${HONOR_TIERS.map((x, i) => `<div><span>${honorIcon(x)} <span class="honor-name">${x.name}</span></span><span>${i === 0 ? `${x.min}% 이상` : i === HONOR_TIERS.length - 1 ? `${HONOR_TIERS[i - 1].min}% 미만` : `${x.min}% 이상 · ${HONOR_TIERS[i - 1].min}% 미만`}</span></div>`).join("")}</div></details></section>`;
}
function permutations(a) {
  if (!a.length) return [[]];
  return a.flatMap((x, i) =>
    permutations(a.filter((_, j) => i !== j)).map((p) => [x, ...p]),
  );
}
const PERMS = permutations([0, 1, 2, 3, 4]);
function validateNames() {
  names = names.map((x) => x.trim().normalize("NFC"));
  if (names.some((x) => !x))
    throw Error("각 팀 5명, 총 10명의 이름을 입력해 주세요.");
  if (new Set(names.map((x) => x.toLocaleLowerCase())).size !== 10)
    throw Error("중복된 이름이 있습니다. 10명을 서로 다르게 입력해 주세요.");
  const known = stats();
  names = names.map(
    (n) =>
      known.find((p) => p.name.toLocaleLowerCase() === n.toLocaleLowerCase())
        ?.name || n,
  );
}
const empty = (title, text) =>
  `<div class="empty"><strong>${title}</strong>${text}</div>`;
function heading(title, sub) {
  return `<header><div><div class="eyebrow">5V5 SCRIM JOURNAL</div><h1>${title}</h1><div class="small">${sub}</div></div><button data-action="sync">${demo ? "체험 모드" : config.scriptUrl ? "새로고침" : "구글 시트 연결"}</button></header>${demo ? '<div class="notice">임시 분석 모드 · 이 화면의 기록은 공용 저장소에 저장되지 않습니다. <button data-action="exit-demo">실제 기록으로 돌아가기</button></div>' : config.scriptUrl ? `<div class="notice" role="status">${publicLoading ? "공용 기록을 불러오는 중입니다…" : publicError ? esc(publicError) : session ? "공용 기록 연결됨 · 기록 변경 가능" : "공용 기록 조회 중 · 친구들은 연결 없이 볼 수 있습니다."} ${!session ? '<a href="#settings"><u>기록 변경용 암호 입력</u></a>' : ""}</div>` : !session ? '<div class="notice">연결 없이 일괄 입력·경기 저장을 사용할 수 있습니다. 현재 브라우저에 저장되며, 친구들과 공유하려면 공용 저장을 연결하세요. <a href="#settings"><u>연결 설정</u></a> · <button data-action="demo">예시로 둘러보기</button></div>' : ""}`;
}
function cards() {
  const p = stats(),
    b = db.matches.filter(
      (m) =>
        (m.sidesKnown !== false || m.source === "sheet") && m.winner === "blue",
    ).length;
  return `<div class="cards"><div class="card"><span class="small">누적 경기</span><strong>${db.matches.length}<span class="unit">경기</span></strong></div><div class="card"><span class="small">참여 플레이어</span><strong>${p.length}<span class="unit">명</span></strong></div><div class="card"><span class="small">블루 / 레드 승리 (진영 확인)</span><strong><span class="blue-text">${b}</span> <span class="unit">/</span> <span class="red-text">${db.matches.filter((m) => (m.sidesKnown !== false || m.source === "sheet") && m.winner === "red").length}</span></strong></div></div>`;
}
function setup() {
  return (
    heading("오늘의 팀 편성", "팀원 입력부터 결과 저장까지, 한 곳에서.").replace('<h1>오늘의 팀 편성</h1>', `<div class="setup-title"><h1>오늘의 팀 편성</h1><button type="button" data-setup-help-toggle aria-pressed="${setupHelpVisible()}">${setupHelpVisible()?'설명 끄기':'설명 켜기'}</button></div>`) +
    uxTop("setup") +
    `<div class="teams">${["blue", "red"]
      .map(
        (t, ti) =>
          `<section class="panel team ${ti ? "red" : ""}"><div class="row between"><h2 class="${t}-text" style="margin:0">${ti ? "RED" : "BLUE"} TEAM</h2><span class="badge">5 PLAYERS</span></div><div class="slots">${Array.from(
            { length: 5 },
            (_, i) => {
              const j = ti * 5 + i;
              return `<div class="slot"><span class="num">0${i + 1}</span><input list="players" maxlength="40" data-name="${j}" aria-label="${t} 팀원 ${i + 1}" placeholder="소환사 이름" value="${esc(names[j])}">${manualMode && assignment ? `<select data-direct="${t}:${i}" aria-label="${esc(names[j])} 포지션">${LANES.map((l, k) => `<option value="${k}" ${assignment[t][i].lane === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : `<span class="lane">${assignment ? (LANES[assignment[t][i].lane]||"미배정") : "미배정"}</span>`}</div>`;
            },
          ).join("")}</div></section>`,
      )
      .join("")}</div><datalist id="players">${stats()
      .map((p) => `<option value="${esc(p.name)}">`)
      .join(
        "",
      )}</datalist><div class="toolbar setup-actions"><div class="position-actions" role="group" aria-label="일반 포지션 배정"><button data-action="manual-positions">포지션 직접 지정</button><button class="primary" data-action="assign">${assignment ? "포지션 다시 배정" : "포지션 자동 배정"}</button></div><div class="support-actions" role="group" aria-label="서포터 순환 실행"><div class="support-action-column"><button data-action="support-cycle">서폿 돌리기</button></div>${['blue','red'].map(t=>`<div class="support-action-column"><button class="${t}-text" data-action="support-${t}" ${supportUsed(t).length>=5?'disabled':''}>${t==='blue'?'블루':'레드'}팀만 서포터 돌리기</button><button data-action="support-reset-${t}" class="support-reset">${t==='blue'?'블루':'레드'}팀 서포터 초기화</button></div>`).join('')}</div></div>${supportStatus()}${manualMode && assignment ? `<section class="notice"><strong>포지션 직접 지정</strong><p class="small">팀원 옆에서 실제로 플레이한 포지션을 선택하세요. 일반 배정은 이전 라인과 관계없이 완전 랜덤입니다. 한 팀에는 다섯 라인이 하나씩 있어야 합니다.</p><div id="position-check">${positionCheck()}</div></section>` : ""}<section class="panel probability"><div class="row between"><h2 style="margin:0">기록 기반 팀 전력 비교</h2><span class="small">누적 개인 · 라인 성적 기반</span></div>${assignment&&validTeams(assignment) ? probability() : empty("팀원을 입력하고 포지션을 배정해 주세요", "이전 경기 성적으로 양 팀의 예상 승률을 비교합니다.")}</section>${resultSection()}`
  );
}
function resultPreviewHTML(){return ['blue','red'].map(t=>`<div class="result-team"><h3 class="${t}-text">${t.toUpperCase()} TEAM</h3>${assignment?LANES.map((lane,i)=>{const players=assignment[t].filter(x=>x.lane===i);return `<div class="member" data-result-lane="${i}"><span class="result-lane">${lane}</span><div class="result-names">${players.length?players.map(x=>`<strong>${esc(x.name)}</strong>`).join(' · '):'<span class="small">미배정</span>'}${players.length>1?'<span class="small red-text">라인 중복</span>':''}</div></div>`}).join('')+(assignment[t].some(x=>!Number.isInteger(x.lane)||x.lane<0||x.lane>=5)?`<div class="member"><span class="result-lane">미배정</span><div class="result-names">${assignment[t].filter(x=>!Number.isInteger(x.lane)||x.lane<0||x.lane>=5).map(x=>`<strong>${esc(x.name)}</strong>`).join(' · ')}</div></div>`:''):'<p class="small">아직 배정되지 않았습니다.</p>'}</div>`).join('')}

function resultSection(){const ready=!!assignment&&validTeams(assignment);return `<section class="panel resultbar" aria-label="현재 배정으로 경기 결과 저장"><h2>이 배정으로 경기 결과 저장</h2><p class="small">경기가 끝나면 이긴 팀을 선택하세요. 상대 팀은 자동으로 패배로 기록됩니다.</p><p id="save-readiness" role="status">${ready?'저장 준비 완료 · 아래 10명의 팀과 라인을 확인하세요.':'먼저 양 팀 5명의 이름과 포지션을 모두 배정해 주세요.'}</p><div class="result-rosters">${resultPreviewHTML()}</div><div class="row result-actions"><button data-winner="blue" class="blue-text" ${ready?'':'disabled'}>블루 승리 · 레드 패배로 저장</button><button data-winner="red" class="red-text" ${ready?'':'disabled'}>레드 승리 · 블루 패배로 저장</button></div><p class="small save-target">${config.scriptUrl&&!demo?session?.password?'공용 구글 시트에 저장되어 친구들의 전적에도 반영됩니다.':'공용 기록 저장에는 모임 암호가 필요합니다. <a href="#settings">모임 암호 입력하기 →</a>':'현재 브라우저에 저장합니다. 공용 저장을 연결하면 친구들과 기록을 공유할 수 있습니다.'}</p>${assignment?`<details style="margin-top:15px"><summary class="small">이미 진행한 경기의 라인을 직접 입력하기</summary><div class="teams" style="margin-top:12px">${['blue','red'].map(t=>`<div>${assignment[t].map((x,i)=>`<label class="row small" style="margin:6px 0">${esc(x.name)}<select style="width:130px" data-manual="${t}:${i}" aria-label="${esc(x.name)} 실제 경기 라인">${LANES.map((l,k)=>`<option value="${k}" ${k===x.lane?'selected':''}>${l}</option>`).join('')}</select></label>`).join('')}</div>`).join('')}</div><p class="small">실제로 플레이한 라인이 다르면 저장 전에 수정하세요. 한 팀에는 다섯 라인이 하나씩 있어야 합니다.</p></details>`:''}</section>`}
function refreshResultPreview(){const preview=document.querySelector('.result-rosters');if(!preview)return;preview.innerHTML=resultPreviewHTML();const ready=!!assignment&&validTeams(assignment);document.querySelectorAll('[data-winner]').forEach(b=>b.disabled=!ready);const status=document.querySelector('#save-readiness');if(status)status.textContent=ready?'저장 준비 완료 · 아래 10명의 팀과 라인을 확인하세요.':'라인이 중복되거나 배정되지 않았습니다. 양 팀에 다섯 라인을 하나씩 지정해 주세요.';}

function probability() {
  const a = estimate();
  return `<div class="row between" style="margin-top:22px"><strong class="blue-text">BLUE ${a.toFixed(1)}%</strong><strong class="red-text">RED ${(100 - a).toFixed(1)}%</strong></div><div class="split"><span style="width:${a}%"></span><span style="width:${100 - a}%"></span></div><div class="row between">${[
    "blue",
    "red",
  ]
    .map((t) => {
      const r = teamRecord(assignment[t]);
      return `<span class="small">현재 5인 조합: ${r.n}전 ${r.w}승 ${r.n - r.w}패 · ${rateHTML(r)}</span>`;
    })
    .join(
      "",
    )}</div><details style="margin-top:16px"><summary class="small">전력 지표 계산 방법</summary><p class="small">개인 전체 승률과 배정 라인 승률에 각각 가상 2승 2패를 더해 작은 표본을 보정합니다. 두 지표를 절반씩 반영한 팀 평균을 양 팀 합으로 나눕니다. 실력·티어·챔피언을 반영하지 않는 참고 지표이며, 기록이 없으면 50%입니다.</p></details>`;
}
function historyBody() {
  return (
    heading("경기 기록", "함께한 모든 경기와 라인별 매치업.") +
    `<div class="toolbar"><span class="muted">총 ${db.matches.length}경기</span><div class="row"><a class="importlink" href="#sheet">스프레드시트 일괄 입력</a><button data-action="export">기록 백업</button><button data-action="import">백업 불러오기</button><button class="danger" data-action="delete-all" ${db.matches.length ? "" : "disabled"}>전체 기록 삭제</button><input id="import-file" class="hide" type="file" accept="application/json,.json"></div></div><div class="history">${
      filteredGames()
        .slice(0, historyLimit)
        .map(
          (m, i) =>
            `<section class="panel"><div class="row between matchhead"><div><span class="badge">MATCH ${String(db.matches.length - i).padStart(3, "0")}</span> <strong class="${m.winner}-text">${m.sidesKnown === false && m.source !== "sheet" ? (m.winner === "blue" ? "A팀" : "B팀") : m.winner === "blue" ? "BLUE" : "RED"} VICTORY ${m.source === "sheet" ? '<span class="badge">표에서 가져옴 · 진영 반영</span>' : ""}</strong><div class="small">${m.source === "sheet" ? new Date(m.time).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : new Date(m.time).toLocaleString("ko-KR")}</div></div><div class="row"><button data-correct="${esc(m.id)}">승패 수정</button><button class="danger" data-delete="${esc(m.id)}">삭제</button></div></div><div class="roster">${[
              "blue",
              "red",
            ]
              .map(
                (t) =>
                  `<div><h3 class="${t}-text">${m.sidesKnown === false && m.source !== "sheet" ? (t === "blue" ? "A팀" : "B팀") : t.toUpperCase()} <span class="small">${m.winner === t ? "승리" : "패배"}</span></h3>${[
                    ...m[t],
                  ]
                    .sort((a, b) => a.lane - b.lane)
                    .map(
                      (x) =>
                        `<div class="member"><span>${esc(x.name)}</span><span class="muted">${LANES[x.lane] ?? "라인 미상"}</span></div>`,
                    )
                    .join("")}</div>`,
              )
              .join("")}</div></section>`,
        )
        .join("") ||
      empty(
        "아직 기록된 경기가 없습니다",
        "팀을 편성하고 승리 팀을 선택하면 첫 기록이 남습니다.",
      )
    }</div>`
  );
}
let rankLane = -1,
  rankQuery = "",
  rankSort = "rate";
function rankingRows() {
  let all = stats()
    .map((p) => ({
      ...p,
      total: p,
      laneStats: rankLane < 0 ? p : p.lanes[rankLane],
    }))
    .filter((p) => p.laneStats.n > 0);
  all.sort(
    (a, b) =>
      (a.total.n < MIN_RANK_GAMES) - (b.total.n < MIN_RANK_GAMES) ||
      (rankSort === "games"
        ? b.laneStats.n - a.laneStats.n || b.laneStats.w - a.laneStats.w
        : rankSort === "wins"
          ? b.laneStats.w - a.laneStats.w || b.laneStats.n - a.laneStats.n
          : b.laneStats.w / b.laneStats.n - a.laneStats.w / a.laneStats.n ||
            b.laneStats.n - a.laneStats.n),
  );
  all = all
    .map((p, i) => ({ ...p, overallRank: i + 1 }))
    .filter((p) =>
      p.name.toLocaleLowerCase().includes(rankQuery.toLocaleLowerCase()),
    );
  return (
    all
      .map(
        (p, i) =>
          `<tr><td>${p.overallRank}</td><td><div class="playercell"><span class="avatar" aria-hidden="true">${esc(p.name.slice(0, 1))}</span><span>${esc(p.name)} ${honorBadge(p.total)}<em>${rankLane < 0 ? "전체 포지션" : LANES[rankLane]}</em></span></div></td><td>${p.laneStats.n}전<em><span class="blue-text">${p.laneStats.w}승</span> · <span class="red-text">${p.laneStats.n - p.laneStats.w}패</span></em></td><td class="ratecell"><strong>${rateHTML(p.laneStats)}</strong><div class="track"><i style="width:${(p.laneStats.w / p.laneStats.n) * 100}%;background:${rateFill(p.laneStats)}"></i></div><em>전체 ${rateHTML(p.total)}</em></td>${p.lanes.map((l) => `<td class="rolecell"><strong class="${l.n && l.w / l.n >= 0.5 ? "win" : ""}">${rateHTML(l)}</strong><em>${l.n ? `${l.n}전 ${l.w}승` : "기록 없음"}</em></td>`).join("")}</tr>`,
      )
      .join("") ||
    '<tr><td colspan="9" class="empty">조건에 맞는 참가자 기록이 없습니다.</td></tr>'
  );
}
function statistics() {
  return (
    heading(
      "소환사 랭킹",
      `전체 ${MIN_RANK_GAMES}전부터 배치 완료 · 배치 진행 중인 참가자는 모든 정렬에서 아래에 표시합니다.`,
    ) +
    cards() +
    `<section class="panel rankpanel"><div class="rankfilter"><div class="ranktabs" role="group" aria-label="포지션 필터">${["전체", ...LANES].map((l, i) => `<button data-rank-lane="${i - 1}" class="${rankLane === i - 1 ? "selected" : ""}" aria-pressed="${rankLane === i - 1}">${l}</button>`).join("")}</div><div class="ranktools"><input id="rank-search" type="search" aria-label="플레이어 검색" placeholder="플레이어 검색" value="${esc(rankQuery)}"><select id="rank-sort" aria-label="랭킹 정렬">${[
      ["rate", "승률 순"],
      ["games", "경기 수 순"],
      ["wins", "승리 수 순"],
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}" ${rankSort === v ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></div></div><div class="tablewrap"><table class="ranktable"><thead><tr><th>순위</th><th>소환사</th><th>전적</th><th>${rankLane < 0 ? "전체" : LANES[rankLane]} 승률</th>${LANES.map((l) => `<th>${l} 승률</th>`).join("")}</tr></thead><tbody id="rank-body">${rankingRows()}</tbody></table></div><div class="rankmeta">배치 기준: 전체 누적 ${MIN_RANK_GAMES}전 · 전체·라인별 정렬 모두 배치 완료자 우선 · 각 그룹 안에서 선택한 지표 순으로 표시합니다.</div></section>`
  );
}
function wireRanking() {
  document.querySelectorAll("[data-rank-lane]").forEach(
    (e) =>
      (e.onclick = () => {
        rankLane = +e.dataset.rankLane;
        render();
      }),
  );
  if ($("#rank-search"))
    $("#rank-search").oninput = (e) => {
      rankQuery = e.target.value;
      $("#rank-body").innerHTML = rankingRows();
    };
  if ($("#rank-sort"))
    $("#rank-sort").onchange = (e) => {
      rankSort = e.target.value;
      $("#rank-body").innerHTML = rankingRows();
    };
}

function chartRows(rows) {
  return rows
    .map(
      (p) =>
        `<div class="chartrow"${["blue", "red"].includes(p.side) ? ` data-side="${p.side}"` : ""}><span>${esc(p.name)}${p.totalGames !== undefined && p.totalGames < MIN_RANK_GAMES ? "<br><small>배치 진행 중</small>" : ""}</span><div class="track" role="img" aria-label="${esc(p.name)} 승률 ${rate(p)}"><i style="width:${p.n ? (p.w / p.n) * 100 : 0}%;background:${rateFill(p)}"></i></div><small>${rateHTML(p)} · ${p.n}전</small></div>`,
    )
    .join("");
}
function charts() {
  const p = stats(),
    person = p.find((p) => p.name === chartPlayer);
  return (
    heading("그래프 분석", "숫자로 보고, 색으로 비교하는 우리들의 플레이.") +
    (!p.length
      ? `<section class="panel">${empty("그래프를 그릴 기록이 없습니다", "첫 경기를 저장하거나 예시로 둘러보기를 선택해 주세요.")}</section>`
      : rateLegend() +
        `<div class="grid2"><section class="panel"><div class="row between"><h2>개인별 승률</h2><select id="chart-lane" aria-label="라인 필터" style="width:130px"><option value="all">전체 라인</option>${LANES.map((l, i) => `<option value="${i}" ${String(i) === chartLane ? "selected" : ""}>${l}</option>`).join("")}</select></div><div class="small">전체 50전 미만은 배치 진행 중 · 그룹 안에서는 승률 순</div>${chartRows(p.map((x) => (chartLane === "all" ? { ...x, totalGames: x.n } : { name: x.name, ...x.lanes[+chartLane], totalGames: x.n })).sort((a, b) => (a.totalGames < MIN_RANK_GAMES) - (b.totalGames < MIN_RANK_GAMES) || (b.n ? b.w / b.n : -1) - (a.n ? a.w / a.n : -1)))}</section><section class="panel"><div class="row between"><h2>라인별 승률</h2><select id="chart-player" aria-label="플레이어 필터" style="width:150px"><option value="all">전체 플레이어</option>${p.map((x) => `<option ${x.name === chartPlayer ? "selected" : ""} value="${esc(x.name)}">${esc(x.name)}</option>`).join("")}</select></div>${chartRows(LANES.map((l, i) => ({ name: l, ...(person ? person.lanes[i] : p.reduce((s, x) => ({ n: s.n + x.lanes[i].n, w: s.w + x.lanes[i].w }), { n: 0, w: 0 })) })))}<p class="small">전체 플레이어 합계는 각 경기마다 라인별 1승·1패가 생겨 50%입니다. 플레이어를 선택해 개인의 강한 라인을 확인하세요.</p><h2 style="margin-top:28px">진영별 누적 승률</h2><p class="small">왼쪽 팀은 블루, 오른쪽 팀은 레드입니다. 가져온 표의 위 5명(A팀)은 블루, 아래 5명(B팀)은 레드로 누적 승률에 반영합니다.</p>${chartRows(["blue", "red"].map((t) => ({ name: t.toUpperCase(), side: t, n: db.matches.filter((m) => m.sidesKnown !== false || m.source === "sheet").length, w: db.matches.filter((m) => (m.sidesKnown !== false || m.source === "sheet") && m.winner === t).length })))}</section></div><section class="panel" style="margin-top:20px"><div class="row between"><h2>플레이어 × 라인</h2><span class="small">— 기록 없음 · 숫자는 승률 · 아래 숫자는 경기 수</span></div><div class="tablewrap"><div class="heat"><div></div>${LANES.map((l) => `<div class="muted">${l}</div>`).join("")}${[
          ...p,
        ]
          .sort(
            (a, b) =>
              (a.n < MIN_RANK_GAMES) - (b.n < MIN_RANK_GAMES) ||
              b.w / b.n - a.w / a.n,
          )
          .map(
            (x) =>
              `<div class="who">${esc(x.name)}${x.n < MIN_RANK_GAMES ? "<br><small>배치 진행 중</small>" : ""}</div>${x.lanes.map((l) => `<div style="background:${rateBackground(l)};border:1px solid ${l.n ? rateColor(l) + "40" : "#303849"}">${rateHTML(l)}<br><span class="small">${l.n}전</span></div>`).join("")}`,
          )
          .join("")}</div></div></section>`)
  );
}
function inputHelp(id,text){return `<p class="field-help" id="${id}-help">${text}</p>`}
function importExample(){const people=['가람','나래','다온','라온','마루','바다','새봄','여름','하늘','한결'];return `<details class="guide-example"><summary>어떤 표를 복사하나요? · 1경기 예시 보기</summary><p>날짜를 포함하고, 이름·승패가 있는 두 칸씩 복사하세요. 한 경기는 반드시 서로 다른 10명입니다.</p><table class="guide-sample"><caption>위 5명은 블루, 아래 5명은 레드입니다. 예시는 블루 승리입니다.</caption><thead><tr><th>이름</th><th>승패</th></tr></thead><tbody><tr><td colspan="2">8월 19일</td></tr>${people.map((name,i)=>`<tr class="${i<5?'sample-blue':'sample-red'}"><td>${name}</td><td>${i<5?'승':'패'}</td></tr>`).join('')}</tbody></table><p class="field-help">여러 경기를 넣을 때는 오른쪽에 이름·승패 두 열을 더 붙이거나, 아래에 다음 날짜와 10명을 이어 붙이면 됩니다.</p></details>`}
function settings(){return heading('구글 시트 가져오기 · 공용 저장','기존 표를 가져오는 것과 친구들과 함께 저장하는 것은 서로 다른 기능입니다.')+`
<section class="panel guide-intro"><h2>무엇을 하려는지 먼저 골라 주세요</h2><ol class="guide-steps"><li><strong>전적만 보기</strong><p>이미 공용 기록이 연결된 사이트라면 따로 입력할 것이 없습니다. 이름 검색이나 경기 기록 메뉴로 가세요.</p></li><li><strong>예전 경기 표 가져오기</strong><p>가장 쉬운 방법은 구글 시트의 셀을 복사해서 이 사이트에 붙여넣는 것입니다.</p><a class="importlink" href="#sheet">표 복사·붙여넣기로 이동 →</a></li><li><strong>친구들과 새 경기 함께 저장하기</strong><p>아래 ‘공용 저장 연결’에서 관리자가 준 연결 주소와 모임 암호를 입력하세요.</p><a class="importlink" href="#settings" onclick="event.preventDefault();document.getElementById('shared-connect').scrollIntoView({behavior:'smooth'});">공용 저장 입력칸으로 이동 →</a></li></ol></section>
<section class="panel"><h2>방법 1 · 복사해서 붙여넣기 <span class="badge">처음이면 추천</span></h2><ol class="guide-list"><li>구글 시트에서 경기 기록이 있는 아래쪽 탭을 엽니다.</li><li>날짜와 10명의 이름·승패가 들어 있는 칸들을 선택합니다.</li><li>컴퓨터는 Ctrl+C로 복사합니다. 휴대전화는 선택한 칸의 복사 메뉴를 사용하세요.</li><li>이 사이트의 <a href="#sheet">표 일괄 입력</a>에 붙여넣고, 미리보기를 확인한 뒤 추가합니다.</li></ol><p class="field-help">보기 전용 시트라도 복사가 허용돼 있으면 가능합니다. 복사·가져오기는 원본 표의 셀을 수정하지 않습니다.</p></section>
<details class="panel guide-alternative"><summary>방법 2 · 파일로 가져오기 — 복사가 어려울 때</summary><p>CSV·TSV는 표를 글자 형태로 저장한 파일입니다. 어려우면 위의 복사 방법을 사용하세요.</p><ol class="guide-list"><li>구글 시트에서 원하는 경기 탭을 엽니다.</li><li>파일 → 다운로드에서 CSV 또는 TSV를 선택합니다.</li><li>아래에서 내려받은 파일을 선택합니다.</li><li>이동한 표 일괄 입력 화면에서 연도·라인·미리보기를 확인한 뒤 추가합니다.</li></ol><label for="google-file">내려받은 CSV·TSV 파일</label><input id="google-file" type="file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" aria-describedby="google-file-help">${inputHelp('google-file','파일을 선택하면 표를 읽어 미리보기를 만듭니다. 아직 경기 기록에 저장되는 것은 아닙니다. .xlsx 파일은 CSV나 TSV로 다시 내려받으세요. 한 번에 2MB 이하입니다.')}</details>
<details class="panel guide-alternative"><summary>방법 3 · 구글 시트 링크로 읽기 — 복사 없이 가져오기</summary><p>‘읽기’는 표를 가져오는 기능입니다. 읽은 뒤 미리보기에서 추가 버튼을 눌러야 실제 기록이 됩니다.</p><form id="google-link-form" class="guide-form"><label for="google-link">① 원본 구글 시트 주소</label><input id="google-link" type="url" placeholder="https://docs.google.com/spreadsheets/d/…/edit" value="${esc(googleReadDraft.url)}" aria-describedby="google-link-help" required>${inputHelp('google-link','구글 시트의 경기 탭을 연 뒤 브라우저 위쪽 주소창의 주소를 복사하세요. docs.google.com으로 시작하는 주소입니다. 아래 공용 저장 연결 주소와는 다릅니다.')}<label for="google-tab">② 기록이 있는 탭 이름</label><input id="google-tab" value="${esc(googleReadDraft.tab)}" placeholder="예: RAW DATA기입" aria-describedby="google-tab-help">${inputHelp('google-tab','구글 시트 맨 아래에 보이는 작은 탭의 이름을 그대로 쓰세요. 문서 제목이 아닙니다. 비워 두면 주소에 포함된 탭 번호를 사용합니다.')}<label for="google-range">③ 가져올 칸의 범위</label><input id="google-range" value="${esc(googleReadDraft.range)}" placeholder="예: C1:ANF1000" aria-describedby="google-range-help">${inputHelp('google-range','C1:ANF1000은 C열 1행부터 ANF열 1000행까지라는 뜻입니다. 빈칸이면 탭 전체를 읽습니다. 날짜·10명의 이름·승패가 모두 들어 있는 범위를 골라 주세요. C1만 쓰는 것은 전체 범위 지정이 아닙니다.')}<button class="primary">링크에서 읽어오기</button><p class="field-help">이름과 승패가 보이는 미리보기로 이동하면 읽기 성공입니다. 권한 오류가 나면 시트를 무조건 공개하지 말고, 복사·붙여넣기나 파일 가져오기를 사용하세요.</p></form><p id="google-link-status" class="field-help" role="status"></p></details>
<section class="panel guide-connect" id="shared-connect"><h2>공용 저장 연결 · 친구들과 같은 기록 쓰기</h2><p class="guide-state">${session&&!demo?'연결됨 · 이 기기에서 공용 기록을 변경할 수 있습니다.':config.scriptUrl?'조회 연결됨 · 전적은 볼 수 있습니다. 기록을 추가·수정하려면 모임 암호를 입력하세요.':'공용 저장을 사용하려면 관리자가 준 연결 주소와 모임 암호가 필요합니다.'}</p><p>처음 설정은 시트 소유자나 편집자 한 명이 준비합니다. 이미 주소가 입력돼 있다면 그대로 두고 모임 암호만 입력하세요. <strong>연결만 해도 예전 표가 자동으로 추가되지는 않습니다.</strong></p><form id="google-connect" class="settings guide-form"><label for="script-url">① 관리자가 준 공용 저장 연결 주소</label><input id="script-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(config.scriptUrl||'')}" aria-describedby="script-url-help" required>${inputHelp('script-url','script.google.com으로 시작하고 /exec로 끝나는 주소입니다. Apps Script는 구글 시트와 이 사이트를 이어 주는 작은 프로그램입니다. 위의 docs.google.com 시트 주소를 여기에 넣으면 연결되지 않습니다. API 키는 필요하지 않습니다.')}<label for="group-pass">② 모임 암호</label><input id="group-pass" type="password" autocomplete="current-password" minlength="8" required placeholder="관리자가 정한 8자 이상 암호" aria-describedby="group-pass-help">${inputHelp('group-pass','시트 관리자가 정한 모임 전용 암호를 입력하세요. 구글 계정 비밀번호가 아닙니다. 암호를 모르면 관리자가 알려 줘야 합니다.')}<label class="switch"><input type="checkbox" id="remember-session" aria-describedby="remember-session-help">이 기기에서 30일간 로그인 유지</label>${inputHelp('remember-session','내 개인 기기에서만 선택하세요. 선택하지 않으면 현재 탭에서 최대 8시간 유지합니다. 로그인은 기록을 추가·수정할 때 필요합니다.')}<button class="primary">구글 시트 연결</button><p class="field-help">주소와 암호를 확인합니다. 연결됨 안내가 나오면 팀 편성의 경기 저장이나 표 일괄 입력의 추가 버튼을 사용할 수 있습니다.</p>${session?'<button type="button" data-action="logout">연결 해제</button><p class="field-help">이 기기의 기록 변경 권한을 해제합니다. 공용 경기 기록은 삭제하지 않습니다. 공개 조회가 설정돼 있으면 전적은 계속 볼 수 있습니다.</p>':''}</form>
${session&&!demo?`<section class="guide-source"><h3>연결된 시트의 예전 표도 가져오려면</h3><ol class="guide-list"><li>기록이 있는 탭 이름과 범위를 입력합니다.</li><li>원본 읽기를 눌러 표 일괄 입력 화면으로 이동합니다.</li><li>연도·라인·오류·추가 예정 경기 수를 확인합니다.</li><li>추가 버튼을 눌러 공용 기록에 저장합니다.</li></ol><form id="google-source" class="guide-form"><label for="source-tab">기존 경기 표가 있는 탭 이름</label><input id="source-tab" value="RAW DATA기입" required aria-describedby="source-tab-help">${inputHelp('source-tab','구글 시트 맨 아래 탭 이름을 그대로 입력하세요. 예: RAW DATA기입. 기록을 저장하는 별도 탭과 원본 경기 표 탭을 혼동하지 마세요.')}<label for="source-range">읽을 경기 범위</label><input id="source-range" value="${esc(googleReadDraft.range)}" placeholder="예: C1:ANF1000" aria-describedby="source-range-help">${inputHelp('source-range','처음 칸:마지막 칸 형식으로 입력합니다. 예: C1:ANF1000. 빈칸이면 탭 전체입니다. 가져온 표에 다른 연도 기록이 섞였다면 연도별로 나눠 가져오세요.')}<button type="submit">연결된 시트에서 원본 읽기</button><p class="field-help">원본 셀을 바꾸지 않고 읽습니다. 읽기 성공 후에도 미리보기의 추가 버튼을 눌러야 기록으로 저장됩니다.</p></form></section>`:''}
<details class="guide-example"><summary>연결 주소가 없거나 처음 준비하는 관리자라면</summary><p>이 화면의 주소는 일반 구글 시트 주소가 아닙니다. 시트 소유자·편집자가 Apps Script를 웹 앱으로 준비한 뒤 발급받는 주소입니다.</p><p>이미 사용 중인 모임은 기존에 배포한 연결 프로그램을 유지하세요. 이번 업데이트는 사이트 파일이므로 구글 시트의 원본 기록을 지우거나 초기화할 필요가 없습니다.</p><p>처음부터 새 모임을 만드는 경우에는 관리자에게 연결 프로그램 준비를 요청하세요. 준비되지 않았다면 우선 복사·붙여넣기로 현재 브라우저에서 기록을 사용할 수 있습니다. 구글 계정 비밀번호를 모임 암호로 쓰지 마세요.</p></details></section><div class="toolbar"><div><button data-action="demo">예시로 둘러보기</button><p class="field-help">연습용 데이터로 사용법을 확인합니다. 예시는 실제 모임 기록에 추가되지 않습니다.</p></div></div>`}

const LOCAL_RECORDS_KEY = "rift-device-records-v1";
let localVersion = null;

function delimitedRows(text, delimiter) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted || !cell) quoted = !quoted;
      else cell += ch;
    } else if (ch === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted)
    throw Error("CSV 따옴표가 닫히지 않았습니다. 파일을 다시 내려받아 주세요.");
  row.push(cell);
  rows.push(row);
  return rows;
}
function sourceRangeText(text, range) {
  if (!range.trim()) return text;
  const m = range
    .trim()
    .toUpperCase()
    .match(/^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$/);
  if (!m) throw Error("경기 범위는 C1:ANF1000처럼 처음 칸:마지막 칸 형식으로 입력하세요.");
  const col = (v) =>
    [...v].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const a = col(m[1]),
    b = col(m[3]),
    start = +m[2] - 1,
    end = +m[4];
  if (a > b || start >= end) throw Error("범위의 시작과 끝을 확인하세요.");
  const rows = delimitedRows(text, "\t")
    .slice(start, end)
    .map((row) => row.slice(a, b + 1));
  if (
    !rows.some((row) =>
      row.some((v) => /^(승|패|승리|패배|win|loss|lose|w|l)$/i.test(v.trim())),
    )
  )
    throw Error(
      "선택한 범위에서 승패를 찾지 못했습니다. 구글 시트의 날짜·이름·승패가 있는 실제 범위를 확인해 주세요.",
    );
  return rows
    .map((row) => row.map((v) => v.replace(/[\r\n\t]+/g, " ")).join("\t"))
    .join("\n");
}
function loadGoogleText(text, type) {
  if (text.length > 2000000) throw Error("한 번에 2MB 이하로 가져와 주세요.");
  if (/^\s*</.test(text))
    throw Error(
      "시트 데이터 대신 로그인 화면이 반환되었습니다. CSV/TSV 다운로드 또는 복사·붙여넣기를 사용하세요.",
    );
  const rows = delimitedRows(
    text.replace(/^\uFEFF/, ""),
    type === "csv" ? "," : "\t",
  );
  sheetDraft.text = rows
    .map((r) => r.map((x) => x.replace(/[\r\n\t]+/g, " ")).join("\t"))
    .join("\n");
  const years = rows.flat().filter((x) => /^20\d\d$/.test(x.trim()));
  if (new Set(years).size === 1) sheetDraft.year = years[0].trim();
  if (
    rows.flat().some((x) => /^top$/i.test(x.trim())) &&
    rows.flat().some((x) => /^jungle$/i.test(x.trim())) &&
    rows.flat().some((x) => /^(support|suport|sup|서포터)$/i.test(x.trim()))
  )
    sheetDraft.lanes = "ordered";
  sheetPreview = null;
  location.hash = "sheet";
  render();
  const checked = previewSheet();
  if (checked)
    toast(
      "표를 가져와 경기 확인을 완료했습니다. 연도·라인·오류를 확인한 뒤 추가해 주세요.",
    );
}
function googleCsvURL(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com")
    throw Error("docs.google.com의 구글 시트 주소를 입력하세요.");
  const gid =
    u.searchParams.get("gid") ||
    new URLSearchParams(u.hash.slice(1)).get("gid") ||
    "0";
  if (!/^\d+$/.test(gid)) throw Error("시트 탭 gid가 올바르지 않습니다.");
  let m = u.pathname.match(
    /^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)\/(?:pubhtml|pub)/,
  );
  if (m)
    return `https://docs.google.com/spreadsheets/d/e/${m[1]}/pub?gid=${gid}&single=true&output=csv`;
  m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!m) throw Error("구글 시트의 문서 주소를 입력하세요.");
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
function wireGoogle() {
  if ($("#google-source"))
    $("#google-source").onsubmit = async (e) => {
      e.preventDefault();
      e.submitter.disabled = true;
      try {
        const data = await googleRequest("source", {
          tab: $("#source-tab").value.trim(),
        });
        loadGoogleText(
          sourceRangeText(data.text, $("#source-range")?.value || ""),
          "tsv",
        );
      } catch (err) {
        toast(err.message);
      } finally {
        e.submitter.disabled = false;
      }
    };
  if ($("#google-file"))
    $("#google-file").onchange = async (e) => {
      try {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 2000000) throw Error("2MB 이하의 파일을 선택해 주세요.");
        loadGoogleText(await f.text(), /\.csv$/i.test(f.name) ? "csv" : "tsv");
      } catch (e) {
        toast(e.message);
      }
    };
  if ($("#google-link-form"))
    $("#google-link-form").onsubmit = async (e) => {
      e.preventDefault();
      e.submitter.disabled = true;
      const status = $("#google-link-status");
      status.textContent = "원본 경기 탭을 읽는 중입니다…";
      googleReadDraft = {
        url: $("#google-link").value.trim(),
        tab: $("#google-tab").value.trim(),
        range: $("#google-range").value.trim(),
      };
      try {
        const options = googleReadOptions(
          googleReadDraft.url,
          googleReadDraft.tab,
          googleReadDraft.range,
        );
        const rows = await readGoogleRows(options);
        if (!rows.some((row) => row.some((x) => /^(승|패)$/.test(x.trim()))))
          throw Error(
            "선택한 탭/범위에 경기 승패가 없습니다. 원본 경기 탭과 범위를 확인하세요.",
          );
        loadGoogleText(
          rows
            .map((row) =>
              row.map((x) => x.replace(/[\t\r\n]+/g, " ")).join("\t"),
            )
            .join("\n"),
          "tsv",
        );
      } catch (error) {
        status.textContent = error.message;
        toast(error.message);
      } finally {
        e.submitter.disabled = false;
      }
    };
  if ($("#google-connect"))
    $("#google-connect").onsubmit = async (e) => {
      e.preventDefault();
      e.submitter.disabled = true;
      const previous = { session, config, db, rev, demo };
      try {
        const scriptUrl = $("#script-url").value.trim(),
          password = $("#group-pass").value;
        if (password.length < 8) throw Error("모임 암호는 8자 이상입니다.");
        config = { scriptUrl };
        session = {
          password,
          expiresAt:
            Date.now() +
            ($("#remember-session").checked ? 30 * 86400000 : 8 * 3600000),
        };
        rev = 0;
        await googleRequest("auth");
        await pull();
        demo = false;
        assignment = null;
        localStorage.setItem(KEY, JSON.stringify(config));
        if ($("#remember-session").checked)
          localStorage.setItem("rift-google-session", JSON.stringify(session));
        else localStorage.removeItem("rift-google-session");
        sessionStorage.setItem("rift-google-session", JSON.stringify(session));
        render();
        toast("구글 시트 공용 기록에 연결했습니다.");
      } catch (error) {
        ({ session, config, db, rev, demo } = previous);
        toast(error.message);
      } finally {
        e.submitter.disabled = false;
      }
    };
}

let playerSearch = "";
const playerLink = (name) => "#player/" + encodeURIComponent(name);
function playerResults() {
  const list = stats()
    .filter((p) =>
      p.name
        .toLocaleLowerCase()
        .includes(playerSearch.trim().toLocaleLowerCase()),
    )
    .sort((a, b) => (a.n < MIN_RANK_GAMES) - (b.n < MIN_RANK_GAMES));
  return list.length
    ? list
        .map(
          (p) =>
            `<a class="player-result" href="${playerLink(p.name)}"><span class="avatar" aria-hidden="true">${esc(p.name.slice(0, 1))}</span><span><strong>${esc(p.name)}</strong>${honorBadge(p)}<span class="small">${p.n}전 ${p.w}승 ${p.n - p.w}패</span></span><span class="win">${rateHTML(p)} <span aria-hidden="true">→</span></span></a>`,
        )
        .join("")
    : empty(
        "검색 결과가 없습니다",
        db.matches.length
          ? "이름을 다시 확인해 주세요."
          : "경기 기록을 추가하면 참가자를 검색할 수 있습니다.",
      );
}
function home() {
  return (
    `<section class="searchhero crew-hero"><div class="hero-copy"><div class="eyebrow">OUR SCRIM, OUR RECORD</div><h1>천안호두.GG</h1><p class="muted">이름을 검색하고, 우리들의 내전 기록을 확인하세요.</p><form id="player-search-form" class="searchbox"><input id="player-search" type="search" maxlength="40" aria-label="플레이어 이름 검색" placeholder="플레이어 이름을 입력하세요" value="${esc(playerSearch)}" autocomplete="off"><button class="primary" type="submit">전적 검색</button></form><p id="search-feedback" role="status" class="small">이름을 누르면 개인 통계 페이지로 이동합니다.</p></div><figure class="crew-photo"><img src="assets/crew.jpg" alt="하늘과 바다를 배경으로 함께 찍은 우리 모임 단체사진" width="1368" height="1824" fetchpriority="high"><figcaption><span class="eyebrow">OUR CREW</span><span>같이 즐기고, 함께 쌓는 기록.</span></figcaption></figure></section>` +
    cards() +
    `<section class="panel"><div class="row between"><h2>플레이어 검색</h2><a class="small" href="#setup">팀 편성 · 경기 저장 →</a></div><div id="player-results" class="player-results">${playerResults()}</div></section>`
  );
}
function synergyPanel(name) {
  const rows = calculateSynergy(db.matches, name, MIN_RANK_GAMES);
  return `<section class="panel synergy-panel" aria-labelledby="synergy-title"><div class="synergy-heading"><div><span class="eyebrow">TEAM SYNERGY</span><h2 id="synergy-title">시너지 승률</h2></div><span class="badge">같은 팀으로 플레이한 기록</span></div><p id="synergy-help" class="synergy-help"><strong>${esc(name)}</strong> 님이 각 플레이어와 같은 팀이었을 때의 승률입니다. 상대 팀으로 만난 경기는 제외합니다.</p><p class="small synergy-sort">배치 완료자 먼저 · 각 그룹 안에서 승률 높은 순 · 동률이면 함께한 경기 많은 순 · 함께한 기록이 없으면 그룹 맨 아래</p>${rows.length ? `<ul class="synergy-list" aria-describedby="synergy-help synergy-note">${rows.map(row => `<li class="synergy-row${row.n ? '' : ' synergy-unplayed'}" data-synergy-name="${esc(row.name)}"><a class="synergy-name" href="${playerLink(row.name)}" aria-label="${esc(row.name)} 개인 통계 보기">${esc(row.name)}<span aria-hidden="true"> ↗</span>${row.totalGames < MIN_RANK_GAMES ? `<small class="synergy-placement">배치 진행 중 · 전체 ${row.totalGames}전</small>` : ''}</a><div class="track synergy-track" role="img" aria-label="${esc(name)} · ${esc(row.name)}: ${row.n ? `${rate(row)}, 함께 ${row.n}전 ${row.w}승 ${row.n-row.w}패` : '함께한 기록 없음'}"><i style="width:${row.n ? row.w / row.n * 100 : 0}%;background:${rateFill(row)}"></i></div><strong class="synergy-value">${rateHTML(row)}</strong><span class="synergy-record">${row.n ? `함께 ${row.n}전 <span>${row.w}승 · ${row.n-row.w}패</span>` : '함께한 기록 없음'}</span></li>`).join('')}</ul>` : empty('함께한 팀원 기록이 없습니다', '경기 기록을 추가하면 자동으로 계산됩니다.')}<p class="small synergy-note" id="synergy-note">배치는 개인의 전체 누적 ${MIN_RANK_GAMES}전을 기준으로 판단하며, 함께한 경기 수와는 다릅니다. 배치 진행 중인 사람은 승률과 관계없이 배치 완료자 아래에 표시합니다. 계산: 함께 이긴 경기 ÷ 함께한 전체 경기 × 100. 예를 들어 10전 6승이면 60.0%입니다. 경기 수가 적으면 승률이 크게 달라질 수 있습니다. 아직 같은 팀으로 뛰지 않은 사람은 승률을 표시하지 않습니다.</p></section>`;
}
function profile() {
  let name;
  try {
    name = decodeURIComponent(location.hash.slice("#player/".length));
  } catch {
    return (
      heading("잘못된 이름", "검색 화면에서 다시 이름을 선택하세요.") +
      '<a href="#home">이름 검색으로 돌아가기</a>'
    );
  }
  const p = stats().find((x) => x.name === name);
  if (!p)
    return (
      heading(
        "플레이어 기록이 없습니다",
        "이름을 확인하거나 경기 기록을 먼저 추가해 주세요.",
      ) + '<a href="#home">이름 검색으로 돌아가기</a>'
    );
  const games = db.matches
    .filter((m) => [...m.blue, ...m.red].some((x) => x.name === name))
    .sort((a, b) => b.time - a.time);
  const side = (t) => {
    const ms = games.filter(
      (m) =>
        (m.sidesKnown !== false || m.source === "sheet") &&
        m[t].some((x) => x.name === name),
    );
    return { n: ms.length, w: ms.filter((m) => m.winner === t).length };
  };
  return (
    heading(
      esc(name) + " · 개인 통계",
      "전체 전적과 포지션별 성적, 팀원별 시너지 승률, 참가한 경기 기록",
    ) +
    `<a class="small" href="#home">← 이름 검색</a>${honorPanel(p)}<div class="cards" style="margin-top:20px"><div class="card"><span class="small">전체 경기</span><strong>${p.n}<span class="unit">전</span></strong></div><div class="card"><span class="small">전체 승률</span><strong>${rateHTML(p)}</strong></div><div class="card"><span class="small">승리 / 패배</span><strong>${p.w}<span class="unit">승</span> ${p.n - p.w}<span class="unit">패</span></strong></div></div><div class="grid2"><section class="panel"><h2>포지션별 승률</h2>${chartRows(LANES.map((name, i) => ({ name, ...p.lanes[i] })))}<p class="small">라인 미상 ${p.n - p.lanes.reduce((n, l) => n + l.n, 0)}경기는 전체 전적에만 반영됩니다.</p></section><section class="panel"><h2>진영별 성적</h2>${chartRows(["blue", "red"].map((t) => ({ name: t === "blue" ? "블루" : "레드", ...side(t) })))}<h2 style="margin-top:26px">포지션별 전적</h2><div class="tablewrap"><table><thead><tr><th>포지션</th><th>경기</th><th>승 / 패</th><th>승률</th></tr></thead><tbody>${p.lanes.map((l, i) => `<tr><td>${LANES[i]}</td><td>${l.n}</td><td>${l.w} / ${l.n - l.w}</td><td>${rateHTML(l)}</td></tr>`).join("")}</tbody></table></div></section></div>${recentForm(name)}<div class="profile-comparison" aria-label="시너지 성적과 상대 전적 비교">${synergyPanel(name)}${opponentPanel(name)}</div><section id="profile-matches" class="panel" style="margin-top:20px"><h2>참가한 경기 · ${games.length}경기</h2><div class="tablewrap"><table><thead><tr><th>날짜</th><th>결과</th><th>진영</th><th>포지션</th><th>함께한 팀원</th></tr></thead><tbody>${games
      .map((m) => {
        const t = m.blue.some((x) => x.name === name) ? "blue" : "red",
          x = m[t].find((x) => x.name === name);
        return `<tr><td>${new Date(m.time).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}</td><td class="${m.winner === t ? "blue-text" : "red-text"}">${m.winner === t ? "승리" : "패배"}</td><td>${m.sidesKnown === false && m.source !== "sheet" ? (t === "blue" ? "A팀" : "B팀") : t === "blue" ? "블루" : "레드"}</td><td>${LANES[x.lane] ?? "라인 미상"}</td><td>${m[
          t
        ]
          .filter((x) => x.name !== name)
          .map((x) => `<a href="${playerLink(x.name)}">${esc(x.name)}</a>`)
          .join(" · ")}</td></tr>`;
      })
      .join("")}</tbody></table></div></section>`
  );
}
function wirePlayerSearch() {
  if ($("#player-search"))
    $("#player-search").oninput = (e) => {
      playerSearch = e.target.value;
      $("#player-results").innerHTML = playerResults();
      $("#search-feedback").textContent =
        "이름을 누르면 개인 통계 페이지로 이동합니다.";
    };
  if ($("#player-search-form"))
    $("#player-search-form").onsubmit = (e) => {
      e.preventDefault();
      const q = playerSearch.trim();
      const exact = stats().find((p) => p.name === q),
        matches = stats().filter((p) =>
          p.name.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
        );
      if (exact || (q && matches.length === 1))
        location.hash = playerLink((exact || matches[0]).name);
      else
        $("#search-feedback").textContent = matches.length
          ? "검색 결과에서 원하는 이름을 선택하세요."
          : "검색 결과가 없습니다.";
    };
}
function render() {
  rememberSkillEditor();
  document.body.classList.toggle(
    "viewer",
    !!config.scriptUrl && !session && !demo,
  );
  let route = location.hash.slice(1) || "home";
  if (route.startsWith("player/")) route = "player";
  if (
    ![
      "home",
      "player",
      "setup",
      "history",
      "stats",
      "charts",
      "settings",
      "sheet",
      "community",
    ].includes(route)
  )
    route = "home";
  document.querySelectorAll("nav a").forEach((a) => {
    const active = a.hash === "#" + (route === "player" ? "home" : route);
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (
    config.scriptUrl &&
    !demo &&
    !["settings", "sheet"].includes(route) &&
    !db.matches.length &&
    (publicLoading || publicError)
  ) {
    $("#app").innerHTML =
      `<section class="panel" role="status"><h1>${publicLoading ? "기록을 불러오는 중입니다" : "기록을 불러오지 못했습니다"}</h1><p>${publicLoading ? "잠시만 기다려 주세요." : esc(publicError)}</p><button data-action="sync">다시 불러오기</button><a class="importlink" href="#settings">연결 설정 확인</a></section>`;
    wire();
    return;
  }
  $("#app").innerHTML =
    (route === "setup" ? "" : uxTop(route)) +
    {
      home,
      community,
      player: profile,
      setup,
      history,
      stats: statistics,
      charts,
      settings,
      sheet,
    }[route]() +
    `<div class="page-foot">${demo ? "임시 데이터 · 새로고침하면 기록이 사라집니다" : config.scriptUrl ? "구글 시트 공용 기록 · 30초마다 자동 갱신 · " + (session ? "기록 변경 가능" : "조회 모드 · 기록 변경에는 모임 암호 필요") : "이 브라우저에 자동 저장 · 새로고침 후에도 유지 · 다른 기기와는 자동 공유되지 않습니다"}</div>`;
  wire();
  enhanceCommunity(route);
  enhanceClarity();
  explainSetupControls();
  persistDraft();
  applyStage();
  finalizeProfileLayout(route);
  restoreSkillEditorFocus();
}

function positionCheck() {
  if (!assignment) return "";
  const messages = [];
  for (const t of ["blue", "red"]) {
    if (new Set(assignment[t].map((x) => x.lane)).size !== 5)
      messages.push(
        `${t === "blue" ? "블루" : "레드"} 팀의 포지션이 중복되었습니다. 팀마다 5개 포지션을 하나씩 선택하세요.`,
      );
  }
  return messages.length
    ? messages.map((m) => `<div class="small">${m}</div>`).join("")
    : "팀 내 포지션 중복 없음";
}
function wireDirectPositions() {
  document.querySelectorAll("[data-direct]").forEach(
    (e) =>
      (e.onchange = () => {
        const [t, i] = e.dataset.direct.split(":");
        assignment[t][i].lane = +e.value;
      refreshResultPreview();
        $("#position-check").innerHTML = positionCheck();
        $(".probability").innerHTML =
          "<h2>기록 기반 팀 전력 비교</h2>" + probability();
        document.querySelectorAll("[data-manual]").forEach((x) => {
          const [team, j] = x.dataset.manual.split(":");
          x.value = String(assignment[team][j].lane);
        });
      }),
  );
}
function wire() {
  wirePlayerSearch();
  wireDirectPositions();
  wireRanking();
  wireSheet();
  wireGoogle();
  document.querySelectorAll("[data-name]").forEach(
    (e) =>
      (e.oninput = () => {
        names[+e.dataset.name] = e.value;
        assignment = null;
        document
          .querySelectorAll("[data-direct]")
          .forEach((x) => (x.disabled = true));
        if ($("#position-check"))
          $("#position-check").textContent =
            "팀원이 변경되었습니다. 포지션 직접 지정을 다시 눌러 주세요.";
        document
          .querySelectorAll(".lane")
          .forEach((x) => (x.textContent = "미배정"));
        if ($(".resultbar")) $(".resultbar").outerHTML = resultSection();
        if ($(".probability"))
          $(".probability").innerHTML =
            '<h2>기록 기반 팀 전력 비교</h2><p class="small">팀원이 변경되었습니다. 포지션을 다시 배정해 주세요.</p>';
      }),
  );
  if ($("#lock"))
    $("#lock").onchange = (e) => {
      locked = e.target.checked;
      assignment = null;
      render();
    };
  document.querySelectorAll("[data-manual]").forEach(
    (e) =>
      (e.onchange = () => {
        const [t, i] = e.dataset.manual.split(":");
        assignment[t][i].lane = +e.value;
      refreshResultPreview();
        if (manualMode) {
          const e2 = document.querySelector(`[data-direct="${t}:${i}"]`);
          if (e2) e2.value = e.value;
          if ($("#position-check"))
            $("#position-check").innerHTML = positionCheck();
        } else
          document.querySelectorAll(".lane")[
            +i + (t === "red" ? 5 : 0)
          ].textContent = LANES[+e.value];
        $(".probability").innerHTML =
          "<h2>기록 기반 팀 전력 비교</h2>" + probability();
      }),
  );
  document
    .querySelectorAll("[data-action]")
    .forEach(
      (e) =>
        (e.onclick = () =>
          act(e.dataset.action).catch((err) => toast(err.message))),
    );
  document
    .querySelectorAll("[data-winner]")
    .forEach(
      (e) =>
        (e.onclick = () =>
          saveMatch(e.dataset.winner).catch((err) => toast(err.message))),
    );
  document
    .querySelectorAll("[data-delete],[data-correct]")
    .forEach(
      (e) =>
        (e.onclick = () =>
          changeMatch(
            e.dataset.delete || e.dataset.correct,
            !!e.dataset.delete,
          ).catch((err) => toast(err.message))),
    );
  if ($("#chart-lane"))
    $("#chart-lane").onchange = (e) => {
      chartLane = e.target.value;
      render();
    };
  if ($("#chart-player"))
    $("#chart-player").onchange = (e) => {
      chartPlayer = e.target.value;
      render();
    };
  if ($("#import-file"))
    $("#import-file").onchange = async (e) => {
      try {
        const f = e.target.files[0];
        if (!f) return;
        if (f.size > 10000000)
          throw Error("10MB 이하의 백업 파일을 선택하세요.");
        const v = JSON.parse(await f.text());
        if (!validPayload(v))
          throw Error("올바른 RIFT RECORD 백업 파일이 아닙니다.");
        if (
          await confirmAction(
            "백업으로 기록 교체",
            `현재 ${db.matches.length}경기를 백업의 ${v.matches.length}경기로 교체합니다. 기존 기록을 먼저 백업하세요.`,
          )
        ) {
          await commit({ ...v });
          assignment = v.cyclePending || null;
          if (assignment)
            names = [...assignment.blue, ...assignment.red].map((x) => x.name);
          render();
          toast("백업을 불러왔습니다.");
        }
      } catch (err) {
        toast(err.message);
      } finally {
        e.target.value = "";
      }
    };
}
let manualMode = false;
let savingMatch = false;
async function saveMatch(winner) {
  if (savingMatch) return;
  if (!assignment || !validTeams(assignment))
    throw Error("팀별 5명과 서로 다른 5개 포지션을 확인해 주세요.");
  if (!["blue", "red"].includes(winner))
    throw Error("승리 팀을 선택해 주세요.");
  if(config.scriptUrl&&!demo&&!session?.password)throw Error("공용 기록을 저장하려면 모임 암호를 먼저 입력해 주세요. 현재 팀 배정은 유지됩니다.");
  savingMatch = true;
  try {
    const current = structuredClone(assignment),
      signature = JSON.stringify({ winner, ...current });
    if (!pendingSave || pendingSave.signature !== signature) {
      pendingSave = {
        signature,
        match: {
          id: crypto.randomUUID(),
          time: Math.max(Date.now(), (db.resetAt || 0) + 1),
          winner,
          rotationMode: assignmentMode,
          ...current,
        },
      };
      persistDraft();
    }
    if (
      !(await confirmAction(
        `${winner==='blue'?'블루 승리 · 레드 패배':'레드 승리 · 블루 패배'}로 저장할까요?`,
        ['blue','red'].map(t=>`${t.toUpperCase()} ${t===winner?'승리':'패배'}: ${current[t].map(x=>x.name+' ('+LANES[x.lane]+')').join(', ')}`).join('\n\n'),
      ))
    )
      return;
    const m = pendingSave.match;
    if (config.scriptUrl && !demo) await pull();
    if (!db.matches.some((x) => x.id === m.id)) {
      try {
        await commit({
          ...db,
          matches: [...db.matches, m],
          resetAt: db.resetAt,
          cyclePending: null,
        });
      } catch (err) {
        if (config.scriptUrl && !demo) {
          try {
            await pull();
          } catch {}
          if (!db.matches.some((x) => x.id === m.id)) throw err;
        } else throw err;
      }
    }
    supportUndo = null;
    lastSaved = m;
    assignment = null;
    pendingSave = null;
    undoLineup = null;
    render();
    toast("경기가 저장되었습니다. 다음 경기 포지션을 배정해 주세요.");
  } finally {
    savingMatch = false;
  }
}
async function changeMatch(id, del) {
  if (
    !(await confirmAction(
      del ? "경기를 삭제할까요?" : "승리 팀을 바꿀까요?",
      del
        ? "이 경기의 개인 성적은 제외됩니다. 서포터 전용 배정 이력은 유지됩니다."
        : "블루와 레드의 승패가 서로 바뀌며 통계가 다시 계산됩니다.",
    ))
  )
    return;
  await commit({
    ...db,
    ...(del
      ? {
          trash: [
            ...(db.trash || []),
            db.matches.find((m) => m.id === id),
          ].filter(Boolean),
        }
      : {}),
    matches: del
      ? db.matches.filter((m) => m.id !== id)
      : db.matches.map((m) =>
          m.id === id
            ? { ...m, winner: m.winner === "blue" ? "red" : "blue" }
            : m,
        ),
  });
  assignment = null;
  render();
  toast("기록을 변경했습니다.");
}
let deletingAll = false;
async function deleteAllMatches() {
  if (deletingAll || busy) return;
  if (!db.matches.length) {
    toast("삭제할 경기 기록이 없습니다.");
    return;
  }
  deletingAll = true;
  try {
    const snapshot = JSON.stringify(db),
      previousRev = rev,
      previousVersion = localVersion;
    const scope = demo
      ? "체험 기록"
      : session
        ? "공용 구글 시트의 기록 (친구들에게도 적용)"
        : "현재 브라우저의 기록";
    const accepted = await confirmAction(
      "전체 경기 기록을 삭제할까요?",
      `${scope} ${db.matches.length}경기를 모두 삭제합니다. 개인·포지션 승률, 칭호와 이번 순환의 사용 포지션도 초기화됩니다. 원본 경기 표는 유지됩니다. 복구하려면 삭제 전에 ‘기록 백업’을 해 주세요.`,
      "전체 삭제",
    );
    if (!accepted) return;
    if (
      snapshot !== JSON.stringify(db) ||
      rev !== previousRev ||
      localVersion !== previousVersion
    )
      throw Error(
        "확인 중 기록이 변경되었습니다. 최신 기록을 확인하고 다시 삭제해 주세요.",
      );
    await commit({
      ...db,
      matches: [],
      resetAt: null,
      cyclePending: null,
      trash: [...(db.trash || []), ...db.matches],
    });
    assignment = null;
    manualMode = false;
    sheetPreview = null;
    render();
    toast("전체 경기 기록을 삭제했습니다.");
  } finally {
    deletingAll = false;
  }
}
async function act(a) {
  if (["support-blue", "support-red"].includes(a)) {
    await rotateSupport(a.slice(8));
    return;
  }
  if (a.startsWith("support-reset-")) {
    await resetSupport(a.slice(14));
    return;
  }
  if (a === "delete-all") {
    await deleteAllMatches();
    return;
  }
  if (a === "manual-positions") {
    if (!assignment) assignmentMode = "normal";
    validateNames();
    manualMode = true;
    if (!assignment)
      assignment = {
        blue: names.slice(0, 5).map((name, lane) => ({ name, lane })),
        red: names.slice(5).map((name, lane) => ({ name, lane })),
      };
    render();
    return;
  }
  if (a === "exit-demo") {
    demo = false;
    if (config.scriptUrl) await pull();
    else restoreLocalRecords();
    assignment = null;
    render();
    return;
  }
  if (a === "assign") {
    manualMode = false;
    validateNames();
    const blue = assignTeam(names.slice(0, 5)),
      red = assignTeam(names.slice(5));
    if (!blue || !red)
      throw Error(
        "팀별 5명의 이름을 확인하고 다시 배정해 주세요.",
      );
    const nextAssignment = { blue, red };
    assignment = nextAssignment;
    assignmentMode = "normal";
    supportUndo = null;
    undoLineup = null;
    render();
    toast("포지션 배정 완료 · 이전 라인과 관계없이 매번 무작위 배정합니다.");
  }
  if (a === "support-cycle") {
    await rotateSupport();
    return;
  }
  if (a === "sync") {
    if (config.scriptUrl && !demo) {
      await pull();
      render();
      toast("최신 기록을 불러왔습니다.");
    } else if (!demo) location.hash = "settings";
  }
  if (a === "export") {
    const u = URL.createObjectURL(
        new Blob(
          [JSON.stringify({ ...db, format: "rift-record-v1" }, null, 2)],
          { type: "application/json" },
        ),
      ),
      link = document.createElement("a");
    link.href = u;
    link.download = `rift-record-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(u), 1000);
  }
  if (a === "import") $("#import-file").click();
  if (a === "logout") {
    session = null;
    demo = false;
    if (!config.scriptUrl) restoreLocalRecords();
    localStorage.removeItem("rift-google-session");
    sessionStorage.removeItem("rift-google-session");
    assignment = null;
    names = Array(10).fill("");
    render();
  }
  if (a === "demo") {
    demo = true;
    names = [
      "구름",
      "새벽",
      "모카",
      "노을",
      "하루",
      "여름",
      "루키",
      "별빛",
      "도토리",
      "제로",
    ];
    db = {
      matches: Array.from({ length: 8 }, (_, j) => ({
        id: "demo-" + j,
        time: Date.now() - (8 - j) * 86400000,
        winner: j % 3 === 0 ? "red" : "blue",
        blue: names.slice(0, 5).map((name, i) => ({ name, lane: (i + j) % 5 })),
        red: names.slice(5).map((name, i) => ({ name, lane: (i + j) % 5 })),
      })),
      resetAt: cycleStartTime(),
    };
    assignment = null;
    location.hash = "setup";
    render();
  }
}
let sheetDraft = {
    text: "",
    year: String(new Date().getFullYear()),
    date: "",
    lanes: "unknown",
    duplicates: false,
  },
  sheetPreview = null;
function sheetDate(value, year) {
  const s = String(value || "").trim();
  let m = s.match(
    /^(?:(\d{2}|\d{4})\s*[년./-]\s*)?(\d{1,2})\s*[월./-]\s*(\d{1,2})\s*일?\s*\.?$/,
  );
  if (!m) return null;
  const y = m[1] ? (+m[1] < 100 ? 2000 + +m[1] : +m[1]) : +year,
    mo = +m[2],
    d = +m[3];
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  const time = Date.parse(
      `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00+09:00`,
    ),
    check = new Date(time);
  return check.getUTCFullYear() === y &&
    check.getUTCMonth() === mo - 1 &&
    check.getUTCDate() === d
    ? time
    : NaN;
}
function sheetSignature(m) {
  const key = (t) =>
    m[t]
      .map((x) => x.name.normalize("NFC").toLocaleLowerCase())
      .sort()
      .join("|");
  return (
    new Date(m.time).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) +
    ";" +
    key(m.winner) +
    ";" +
    key(m.winner === "blue" ? "red" : "blue")
  );
}
function pastedSheetRows(text) {
  if (text.length > 2000000)
    throw Error("한 번에 2MB 이하의 표를 붙여넣어 주세요.");
  const clean = (s) =>
    s
      .replace(/&nbsp;|&#(?:160|x[aA]0);|&#(?:32|x20);/g, " ")
      .replace(/\u00a0/g, " ")
      .trim()
      .replace(/^\*\*([\s\S]*)\*\*$/, "$1")
      .replace(/^__([\s\S]*)__$/, "$1")
      .trim()
      .normalize("NFC");
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const markdown =
    lines.some((line) => /^\s*\|/.test(line)) &&
    !lines.some((line) => line.includes("\t"));
  if (!markdown) return lines.map((line) => line.split("\t").map(clean));
  return lines
    .filter((line) => line.trim() && !/^\s*```/.test(line))
    .map((line) => {
      let value = line.trim();
      if (value.startsWith("|")) value = value.slice(1);
      if (value.endsWith("|") && !value.endsWith("\\|"))
        value = value.slice(0, -1);
      return value
        .split(/(?<!\\)\|/)
        .map((cell) => clean(cell.replace(/\\\|/g, "|")));
    })
    .filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
}

function parseSheet(text, options) {
  const rows = pastedSheetRows(text);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0),
    result = [],
    errors = [],
    known = new Map(stats().map((p) => [p.name.toLocaleLowerCase(), p.name]));
  if (width < 2)
    throw Error("스프레드시트의 이름·승패 셀 범위를 복사해서 붙여넣어 주세요.");
  const win = (v) =>
    /^(승|승리|win|w)$/i.test(v || "")
      ? "win"
      : /^(패|패배|lose|loss|l)$/i.test(v || "")
        ? "loss"
        : null;
  const dates = [];
  for (let r = 0; r < rows.length; r++) {
    dates[r] = [];
    let inherited = null;
    for (let c = 0; c < width; c++) {
      const d = sheetDate(rows[r][c], options.year);
      if (d !== null) inherited = d;
      dates[r][c] = inherited;
    }
  }
  for (let c = 0; c < width - 1; c++) {
    if (!rows.some((row) => win(row[c + 1]))) continue;
    let date = options.date ? sheetDate(options.date, options.year) : null,
      block = [],
      start = 0,
      poison = false,
      started = false;
    const flush = () => {
      if (!block.length) return;
      const title = `${c + 1}~${c + 2}열 / ${start + 1}행부터`;
      const b = block;
      block = [];
      if (poison) {
        poison = false;
        errors.push(title + ": 인식할 수 없는 행이 있어 제외했습니다.");
        return;
      }
      if (b.length !== 10) {
        errors.push(
          title + `: ${b.length}명입니다. 한 경기당 10명이 필요합니다.`,
        );
        return;
      }
      if (!Number.isFinite(date)) {
        errors.push(
          title +
            ": 날짜가 없습니다. 날짜 행을 포함하거나 기본 날짜를 지정해 주세요.",
        );
        return;
      }
      if (b.some((x) => !x.name || x.name.length > 40)) {
        errors.push(title + ": 이름은 1~40자로 입력해 주세요.");
        return;
      }
      if (new Set(b.map((x) => x.name.toLocaleLowerCase())).size !== 10) {
        errors.push(title + ": 중복된 이름이 있습니다.");
        return;
      }
      const a = b.slice(0, 5),
        z = b.slice(5);
      if (
        !a.every((x) => x.result === a[0].result) ||
        !z.every((x) => x.result === z[0].result) ||
        a[0].result === z[0].result
      ) {
        errors.push(
          title +
            ": 위 5명과 아래 5명이 각각 같은 결과이고, 5승·5패여야 합니다.",
        );
        return;
      }
      const players = (t) =>
        t.map((x, i) => ({
          name: known.get(x.name.toLocaleLowerCase()) || x.name,
          lane: options.lanes === "ordered" ? i : null,
        }));
      const m = {
        id: crypto.randomUUID(),
        time: date,
        blue: players(a),
        red: players(z),
        winner: a[0].result === "win" ? "blue" : "red",
        source: "sheet",
        sidesKnown: true,
      };
      for (const x of [...m.blue, ...m.red])
        known.set(x.name.toLocaleLowerCase(), x.name);
      result.push({ match: m, label: title });
    };
    for (let r = 0; r < rows.length; r++) {
      const n = rows[r][c] || "",
        value = rows[r][c + 1] || "",
        outcome = win(value),
        d = dates[r][c] ?? dates[r][c + 1];
      if (outcome) {
        started = true;
        if (!block.length) start = r;
        block.push({ name: n, result: outcome });
        if (block.length === 10) flush();
      } else if (d !== null && d !== undefined) {
        flush();
        date = d;
        if (!Number.isFinite(d))
          errors.push(`${r + 1}행: 유효하지 않은 날짜입니다.`);
      } else if (
        (!n && !value) ||
        (!block.length && /^[.\s]*$/.test(n) && /^[.\s]*$/.test(value))
      ) {
        flush();
      } else if (
        /^(이름|성명|플레이어|소환사|선수)$/i.test(n) &&
        /^(승패|결과|승\/패)$/i.test(value)
      ) {
        flush();
      } else if (started || Number.isFinite(date)) {
        if (block.length) poison = true;
        errors.push(
          `${r + 1}행 ${c + 1}~${c + 2}열: '${n} / ${value}'의 승패를 읽을 수 없습니다.`,
        );
      }
    }
    flush();
    c++;
  }
  if (!result.length && !errors.length)
    errors.push("승/패 값을 찾지 못했습니다. 이름·승패 두 열씩 복사해 주세요.");
  return { items: result, errors };
}
function sheet(){return heading('표 일괄 입력','예전 경기 기록을 여러 경기씩 한 번에 추가합니다.')+`<section class="panel guide-intro"><h2>처음이라면 이 순서대로 하세요</h2><ol class="guide-steps"><li><strong>구글 시트에서 복사</strong><p>날짜와 10명의 이름·승패를 포함해 복사합니다.</p></li><li><strong>아래 큰 칸에 붙여넣기</strong><p>컴퓨터는 Ctrl+V, 휴대전화는 입력칸을 길게 눌러 붙여넣기를 선택하세요.</p></li><li><strong>미리보기 확인</strong><p>가져올 경기 확인을 눌러 이름·날짜·승패가 맞는지 봅니다. 이때는 아직 저장되지 않습니다.</p></li><li><strong>추가 버튼으로 저장</strong><p>추가할 경기 수가 맞으면 미리보기 아래의 추가 버튼을 누르고 확인합니다.</p></li></ol><p class="guide-state">${demo?'지금은 예시 모드입니다. 실제 모임 기록에는 저장하지 않습니다.':config.scriptUrl?session?.password?'저장 위치: 공용 구글 시트 · 친구들의 전적에도 반영됩니다.':'현재는 공용 기록 조회 모드입니다. 추가하려면 <a href="#settings">연결 화면에서 모임 암호를 입력</a>하세요.':'저장 위치: 현재 브라우저 · 다른 기기와 공유하려면 <a href="#settings">공용 저장 연결</a>이 필요합니다.'}</p></section><section class="panel"><h2>1. 복사한 표 넣기</h2><p>한 경기에는 이름·승패 두 열과 선수 10명이 필요합니다. <strong>위 5명은 블루팀, 아래 5명은 레드팀</strong>으로 기록합니다. 각 팀의 5명은 같은 결과여야 합니다.</p>${importExample()}<label for="sheet-text">복사한 경기 표를 여기에 붙여넣으세요</label><textarea id="sheet-text" rows="12" spellcheck="false" aria-describedby="sheet-text-help" placeholder="구글 시트에서 날짜와 10명의 이름·승패를 복사해서 붙여넣으세요.">${esc(sheetDraft.text)}</textarea>${inputHelp('sheet-text','구글 시트 셀을 그대로 복사해도 되고, 채팅에 있는 | 기호로 된 표도 넣을 수 있습니다. 사진은 인식하지 않습니다. 표가 없으면 아래 예시 채우기로 연습해 보세요.')}<div class="sheetcontrols guide-fields"><div><label for="sheet-year">표에 연도가 없을 때 쓸 연도</label><input id="sheet-year" type="number" min="1900" max="2100" value="${esc(sheetDraft.year)}" aria-describedby="sheet-year-help">${inputHelp('sheet-year','예: 표에 8월 19일만 있고 2026년이 없다면 2026을 입력하세요. 서로 다른 연도 기록은 나눠 넣어 주세요. 표에 연도가 있으면 그 연도를 우선 사용합니다.')}</div><div><label for="sheet-date">표에 날짜가 없을 때만 선택</label><input id="sheet-date" type="date" value="${esc(sheetDraft.date)}" aria-describedby="sheet-date-help">${inputHelp('sheet-date','표에 날짜가 들어 있으면 비워도 됩니다. 첫 경기 날짜가 없는 경우에만 기본 날짜를 지정하세요. 빈 날짜 칸은 같은 열의 이전 날짜나 왼쪽 날짜를 이어받습니다.')}</div><div><label for="sheet-lanes">선수들이 적힌 순서가 실제 라인 순서인가요?</label><select id="sheet-lanes" aria-describedby="sheet-lanes-help"><option value="unknown" ${sheetDraft.lanes==='unknown'?'selected':''}>모르겠어요 · 전체 전적만 반영</option><option value="ordered" ${sheetDraft.lanes==='ordered'?'selected':''}>탑 → 정글 → 미드 → 원딜 → 서포터 순서예요</option></select>${inputHelp('sheet-lanes','각 팀의 위부터 탑·정글·미드·원딜·서포터 순서가 확실할 때만 두 번째 항목을 선택하세요. 잘못 고르면 라인별 성적이 틀어집니다. 모르겠어요를 고르면 전체 승률에는 반영되고 라인별 승률에서는 제외됩니다.')}</div></div><div class="row guide-actions"><div><button class="primary" id="sheet-parse">2. 가져올 경기 확인</button><p class="field-help">표를 읽고 미리보기를 만듭니다. 여기까지는 실제 경기 기록에 추가되지 않습니다.</p></div><div><button id="sheet-example">6경기 입력 예시 채우기</button><p class="field-help">큰 입력칸을 연습용 표로 바꿉니다. 확인 버튼을 눌러 보는 것만으로는 저장되지 않습니다. 실제 표를 붙여넣은 상태라면 먼저 따로 보관하세요.</p></div></div></section><section class="panel"><h2>3. 미리보기 확인 후 추가</h2><p class="small">날짜·이름·승패·라인과 추가 예정 경기 수를 확인하세요. 오류가 있으면 위 표를 고치고 다시 확인 버튼을 누릅니다.</p><div id="sheet-preview">${sheetPreview?sheetPreviewHTML():empty('아직 확인한 기록이 없습니다','위에 표를 붙여넣은 다음 ‘가져올 경기 확인’을 누르면 여기에 표시됩니다.')}</div></section>`}

function sheetCandidates() {
  if (!sheetPreview) return [];
  const seen = new Set(db.matches.map(sheetSignature));
  return sheetPreview.items.map((x) => {
    const key = sheetSignature(x.match),
      duplicate = seen.has(key);
    seen.add(key);
    return { ...x, duplicate };
  });
}
function sheetPreviewHTML() {
  const items = sheetCandidates(),
    selected = items.filter((x) => sheetDraft.duplicates || !x.duplicate),
    errors = sheetPreview.errors;
  return `<div class="notice">인식 ${items.length}경기 · 중복 의심 ${items.filter((x) => x.duplicate).length}경기 · 오류 ${errors.length}건 · <b>추가 예정 ${selected.length}경기</b><br>기존 기록은 유지하고 추가합니다. ${sheetDraft.lanes === "unknown" ? "라인 미상 기록은 전체 승률에만 반영됩니다." : "행 순서를 라인으로 사용합니다. 실제 라인 순서인지 확인해 주세요."}</div>${errors.length ? `<details open><summary class="red-text">오류가 있는 항목을 확인해 주세요</summary><ul class="errorlist">${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul><p class="small">잘못된 경기의 누락을 막기 위해 오류를 모두 수정한 뒤 다시 확인해야 저장할 수 있습니다.</p></details>` : ""}<label class="switch"><input type="checkbox" id="sheet-duplicates" aria-describedby="duplicate-help" ${sheetDraft.duplicates ? "checked" : ""}>중복 의심 경기까지 추가</label><p class="small" id="duplicate-help">같은 날짜·같은 10명·같은 승리 팀이면 중복으로 의심합니다. 실제로 같은 팀으로 여러 판 했다면 체크하세요. 체크 시 이미 저장된 경기까지 다시 추가될 수 있습니다.</p>${items.map((x, i) => `<div class="previewmatch"><div class="row between"><strong>${i + 1}. ${new Date(x.match.time).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })} · ${x.match.winner === "blue" ? "블루" : "레드"} 승리</strong><span class="badge">${x.duplicate ? (sheetDraft.duplicates ? "중복 의심 · 추가" : "중복 의심 · 제외") : "추가 예정"}</span></div><span class="small">${esc(x.label)} · 블루/레드 진영 반영</span><div class="previewteams">${["blue", "red"].map((t) => `<div><b>${t === "blue" ? "블루 · 왼쪽" : "레드 · 오른쪽"} · ${x.match.winner === t ? "승" : "패"}</b>${x.match[t].map((p) => `<div class="member"><span>${esc(p.name)}</span><span class="muted">${LANES[p.lane] ?? "라인 미상"}</span></div>`).join("")}</div>`).join("")}</div></div>`).join("")}<button id="sheet-save" class="primary" style="margin-top:20px" ${errors.length || !selected.length ? "disabled" : ""}>${selected.length}경기 한 번에 추가</button><p class="field-help">이 버튼이 실제 저장 단계입니다. 확인창에서 확인을 누르면 추가됩니다. 회색으로 눌리지 않으면 오류가 남았거나 추가할 경기가 0건인지 확인하세요.</p>`;
}
function previewSheet() {
  try {
    for (const [id, key] of [
      ["sheet-text", "text"],
      ["sheet-year", "year"],
      ["sheet-date", "date"],
      ["sheet-lanes", "lanes"],
    ]) {
      const input = $("#" + id);
      if (input) sheetDraft[key] = input.value;
    }
    if (
      !/^\d{4}$/.test(sheetDraft.year) ||
      +sheetDraft.year < 1900 ||
      +sheetDraft.year > 2100
    )
      throw Error("연도를 1900~2100 사이로 입력해 주세요.");
    if (!sheetDraft.text.trim())
      throw Error(
        "가져온 표가 비어 있습니다. 원본 읽기 후 위 입력 칸에 이름·승패가 들어왔는지 확인해 주세요.",
      );
    sheetPreview = parseSheet(sheetDraft.text, sheetDraft);
    $("#sheet-preview").innerHTML = sheetPreviewHTML();
    wireSheetPreview();
    return true;
  } catch (e) {
    sheetPreview = null;
    $("#sheet-preview").innerHTML =
      `<div class="notice" role="alert"><strong class="red-text">경기 확인에 실패했습니다</strong><p>${esc(e.message)}</p><p class="small">입력 표와 연도를 확인한 뒤 ‘가져올 경기 확인’을 다시 눌러 주세요.</p></div>`;
    toast(e.message);
    return false;
  }
}
function wireSheet() {
  if (!$("#sheet-text")) return;
  const invalidate = () => {
    sheetPreview = null;
    $("#sheet-preview").innerHTML = empty(
      "입력이 변경되었습니다",
      "다시 ‘가져올 경기 확인’을 눌러 주세요.",
    );
  };
  for (const [id, key] of [
    ["sheet-text", "text"],
    ["sheet-year", "year"],
    ["sheet-date", "date"],
    ["sheet-lanes", "lanes"],
  ])
    $("#" + id).oninput = (e) => {
      sheetDraft[key] = e.target.value;
      if (
        key === "text" &&
        /top/i.test(e.target.value) &&
        /jungle/i.test(e.target.value) &&
        /su[p]*port/i.test(e.target.value)
      ) {
        sheetDraft.lanes = "ordered";
        $("#sheet-lanes").value = "ordered";
      }
      invalidate();
    };
  $("#sheet-example").onclick = () => {
    sheetDraft.text =
      "| **8월 19일** |   |     |   |     |   | **9월 3일** |   |     |   |     |   |\n| ---------: | - | --- | - | --- | - | --------: | - | --- | - | --- | - |\n|        이건호 | 승 | 강석현 | 패 | 박정원 | 승 |       안재용 | 패 | 김대민 | 승 | 박정원 | 승 |\n|        강석현 | 승 | 김용호 | 패 | 성청록 | 승 |       김대민 | 패 | 조규성 | 승 | 이건호 | 승 |\n|        조규성 | 승 | 이건호 | 패 | 이준혁 | 승 |       이준혁 | 패 | 이준혁 | 승 | 김영래 | 승 |\n|        김용호 | 승 | 조규성 | 패 | 안재용 | 승 |       조규성 | 패 | 강석현 | 승 | 성청록 | 승 |\n|        박찬일 | 승 | 박찬일 | 패 | 김경민 | 승 |       강석현 | 패 | 김용호 | 승 | 안재용 | 승 |\n|        안재용 | 패 | 김경민 | 승 | 조규성 | 패 |       김영래 | 승 | 김영래 | 패 | 김대민 | 패 |\n|        김경민 | 패 | 이준혁 | 승 | 박찬일 | 패 |       이건호 | 승 | 이건호 | 패 | 김용호 | 패 |\n|        박정원 | 패 | 박정원 | 승 | 강석현 | 패 |       김용호 | 승 | 박정원 | 패 | 이준혁 | 패 |\n|        이준혁 | 패 | 안재용 | 승 | 이건호 | 패 |       성청록 | 승 | 안재용 | 패 | 조규성 | 패 |\n|        성청록 | 패 | 성청록 | 승 | 김용호 | 패 |       박정원 | 승 | 성청록 | 패 | 강석현 | 패 |\n";
    sheetPreview = null;
    render();
  };
  $("#sheet-parse").onclick = () => previewSheet();
  wireSheetPreview();
}
function wireSheetPreview() {
  if ($("#sheet-duplicates"))
    $("#sheet-duplicates").onchange = (e) => {
      sheetDraft.duplicates = e.target.checked;
      $("#sheet-preview").innerHTML = sheetPreviewHTML();
      wireSheetPreview();
    };
  if ($("#sheet-save"))
    $("#sheet-save").onclick = async () => {
      const button = $("#sheet-save");
      button.disabled = true;
      try {
        if (!sheetPreview || sheetPreview.errors.length)
          throw Error("오류를 수정한 후 미리보기를 다시 확인해 주세요.");
        let candidates = sheetCandidates().filter(
          (x) => sheetDraft.duplicates || !x.duplicate,
        );
        if (!candidates.length) throw Error("추가할 경기가 없습니다.");
        if (
          !(await confirmAction(
            `${candidates.length}경기를 추가할까요?`,
            demo
              ? "체험 기록에만 추가됩니다. 실제 공용 기록에는 저장되지 않습니다."
              : session
                ? "공용 구글 시트에 추가합니다. 기존 기록은 유지됩니다."
                : "현재 브라우저에 저장합니다. 새로고침해도 유지되며 기존 기록은 그대로 남습니다.",
          ))
        )
          return;
        candidates = sheetCandidates().filter(
          (x) => sheetDraft.duplicates || !x.duplicate,
        );
        const next = {
          ...db,
          matches: [...db.matches, ...candidates.map((x) => x.match)].sort(
            (a, b) => a.time - b.time,
          ),
        };
        if (!validPayload(next))
          throw Error(
            "기록 형식을 확인해 주세요. 최대 20,000경기를 지원합니다.",
          );
        await commit(next);
        sheetDraft.text = "";
        sheetPreview = null;
        assignment = null;
        location.hash = "history";
        render();
        toast(`${candidates.length}경기를 추가했습니다.`);
      } catch (e) {
        toast(e.message);
      } finally {
        button.disabled = false;
      }
    };
}

let googleReadDraft = {
  url: "https://docs.google.com/spreadsheets/d/1YFOgWnorOs_CFViCBuJC9ADb7Ja8Mbb5KEtl-vTtuQA/edit?usp=sharing",
  tab: "RAW DATA기입",
  range: "C1:ANF1000",
};
function googleReadOptions(value, tab, range) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.hostname !== "docs.google.com")
    throw Error("docs.google.com 구글 시트 주소를 입력하세요.");
  const m = u.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:\/|$)/);
  if (!m || m[1] === "e")
    throw Error(
      "게시 링크가 아닌 /spreadsheets/d/문서ID/edit 형식의 원본 시트 링크를 입력하세요.",
    );
  const gid =
    u.searchParams.get("gid") ||
    new URLSearchParams(u.hash.slice(1)).get("gid");
  if (gid && !/^\d+$/.test(gid)) throw Error("탭 번호가 올바르지 않습니다.");
  tab = tab.trim();
  range = range.trim().toUpperCase();
  if (tab.length > 100) throw Error("탭 이름은 100자 이하로 입력하세요.");
  if (range && !/^[A-Z]{1,3}[1-9]\d{0,5}:[A-Z]{1,3}[1-9]\d{0,5}$/.test(range))
    throw Error("범위는 C1:ANF1000처럼 입력하세요.");
  if (!tab && !gid)
    throw Error("주소에 탭 번호가 없습니다. 아래 탭 이름을 입력하세요.");
  return { id: m[1], sheet: tab, gid: gid || "", range };
}
function gvizRows(data) {
  if (data.status !== "ok" || !Array.isArray(data.table?.rows))
    throw Error("시트를 읽지 못했습니다. 탭 이름·보기 권한을 확인하세요.");
  return data.table.rows.map((row) =>
    (row.c || []).map((cell) => String(cell?.f ?? cell?.v ?? "")),
  );
}
function googleJSONP(options) {
  return new Promise((resolve, reject) => {
    const callback = "riftSheet_" + crypto.randomUUID().replace(/-/g, ""),
      script = document.createElement("script");
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      script.remove();
      delete window[callback];
    };
    window[callback] = (data) => {
      cleanup();
      try {
        resolve(gvizRows(data));
      } catch (e) {
        reject(e);
      }
    };
    const params = new URLSearchParams({
      tqx: `out:json;responseHandler:${callback}`,
      headers: "0",
    });
    if (options.sheet) params.set("sheet", options.sheet);
    else params.set("gid", options.gid);
    if (options.range) params.set("range", options.range);
    script.src = `https://docs.google.com/spreadsheets/d/${options.id}/gviz/tq?${params}`;
    script.onerror = () => {
      cleanup();
      reject(
        Error(
          "구글 시트 조회가 차단되었습니다. 보기 권한 또는 탭 이름을 확인하고, CSV 다운로드를 이용해 주세요.",
        ),
      );
    };
    timer = setTimeout(() => {
      cleanup();
      reject(
        Error(
          "구글 시트가 응답하지 않았습니다. CSV 다운로드 방식으로 가져와 주세요.",
        ),
      );
    }, 20000);
    document.head.appendChild(script);
  });
}
async function readGoogleRows(options) {
  if (location.protocol === "https:" || location.protocol === "http:") {
    try {
      const response = await fetch(
        "/api/google-sheet?" + new URLSearchParams(options),
        { signal: AbortSignal.timeout(20000) },
      );
      if (
        response.ok &&
        (response.headers.get("content-type") || "").includes(
          "application/json",
        )
      ) {
        const data = await response.json();
        if (data.ok && Array.isArray(data.rows)) return data.rows;
        throw Error(data.error || "시트 읽기에 실패했습니다.");
      }
    } catch {}
  }
  return googleJSONP(options);
}

if (config.scriptUrl) {
  try {
    const c = JSON.parse(localStorage.getItem("rift-public-cache") || "null");
    if (c?.url === config.scriptUrl && validPayload(c.payload)) {
      db = c.payload;
      rev = c.revision;
    }
  } catch {}
} else if (!session) {
  try {
    restoreLocalRecords();
  } catch (e) {
    toast(e.message);
  }
}
restoreDraft();
window.addEventListener("hashchange", render);
render();
if (config.scriptUrl)
  pull()
    .then(render)
    .catch((e) => {
      publicLoading = false;
      publicError =
        "공용 기록을 불러오지 못했습니다. 마지막 조회 기록을 유지합니다. " +
        e.message;
      render();
      toast(publicError);
    });
setInterval(async () => {
  if (!config.scriptUrl || demo || busy || document.hidden) return;
  try {
    const old = rev;
    await pull();
    if (old !== rev) {
      render();
      toast("다른 팀원이 변경한 기록을 반영했습니다.");
    }
  } catch (e) {
    publicError =
      "일시적으로 새 기록을 확인하지 못했습니다. 표시된 기록은 유지됩니다.";
    render();
  }
}, 30000);
if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(
      document.modelContext.registerTool({
        name: "read_scrim_statistics",
        description:
          "현재 연결된 내전 기록의 개인 전체·라인별 통계를 조회합니다. 체험 모드 여부를 함께 반환합니다.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute(input) {
          if (!input || Object.keys(input).length)
            throw Error("입력은 빈 객체여야 합니다.");
          return {
            demo,
            connected: !!session,
            matches: db.matches.length,
            players: stats(),
          };
        },
      }),
    ).catch(() => {});
  } catch {}
}
