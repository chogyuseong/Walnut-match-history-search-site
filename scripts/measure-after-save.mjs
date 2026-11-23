// 결과 저장 뒤 측정(로컬 전용, CI에 넣지 않는다). 운영자가 진행 화면에서 "결과 저장"을 누른 때부터 다음 행동을 할 수 있게 될 때까지,
// 그리고 "다음 경기 준비"를 눌러 준비 화면이 뜰 때까지를 브라우저에서 잰다. 첫 진입은 measure-load.mjs가, 서버 응답·JSON 해석·
// 통계 계산을 노드에서 나눠 재는 것은 test/measure/snapshot-size.measure.ts가 맡는다. 이 스크립트는 그 사이, 실제 화면이 하는 일 전부다.
//
//   node scripts/measure-after-save.mjs [--base http://127.0.0.1:8787] [--sizes 50,500,2000] [--runs 3] [--label 이름]
//
// 조건은 measure-load.mjs와 같다: 390×844, CPU 4배 감속, 느린 4G(지연 150ms, 1.6Mbps/750kbps), 캐시 끔, 외부 주소 막음.
// 감속은 화면을 연 뒤 결과 창을 열기 직전에 건다. 측정 대상이 아닌 첫 진입(경기 2,000개면 수십 초)을 기다리지 않으려고.
// 경기 수마다 가짜 로그인 계정·모임을 새로 만들고, 지난 경기를 가져오기로 넣는다(30명, 이틀에 한 번 저녁 6경기).
// 그래서 로컬 서버(wrangler dev, AUTH_MODE=fake)에만 쓴다. 50·500·2,000경기는 성장 시나리오이지 실제 모임의 측정값이 아니다.
//
// 재는 것(화면마다 runs번, 중앙값. 모두 "결과 저장" 누른 입력 시각부터):
//   저장됨 표시   "N경기 저장됨"이 화면에 그려진 때. 저장 POST 하나만 기다린다(ResultSheet.tsx save의 setSaved).
//   기록 다시 받음 저장 뒤 다시 읽는 스냅숏 GET의 응답이 끝난 때(refreshAfterOwnChange).
//   조용해짐      저장 뒤 마지막 긴 작업(50ms 넘게 메인 스레드를 잡은 일)이 끝난 때. 이때부터 누르면 바로 반응한다.
//                 이것을 "다음 행동이 가능해진 때"로 본다. 긴 작업이 없으면 저장됨 표시와 같다.
//   긴 작업 합    그 사이 메인 스레드가 막힌 시간의 합. 조용해짐이 늦은 까닭이 계산인지 네트워크인지 가른다.
//   준비 화면     조용해진 뒤 "다음 경기 준비"를 누른 입력 시각부터 "이 팀으로 시작" 버튼이 그려진 때까지(따로 잰다).
//   준비 긴 작업  준비 화면으로 넘어가며 생긴 긴 작업의 합(편성판 MMR 나누기·콤비·어려운 상대 계산).
// "그려진 때"는 DOM에 생긴 뒤 다음 그림 프레임(rAF 다음 작업)으로 어림한다. 실제 휴대폰·Cloudflare까지의 거리와 다르므로
// 같은 조건의 전·후 비교와, 경기 수가 늘 때 어느 단계가 먼저 커지는지를 보는 데만 쓴다.
// page.addInitScript에 넘기는 함수는 브라우저에서 돈다(아래 전역은 그 안에서만 쓴다).
/* global window, document, Element, MutationObserver, requestAnimationFrame */
import { chromium, request as apiRequest } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "8787"}`;
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error(`로컬 주소가 아닙니다: ${BASE}`);
const SIZES = (args.sizes ?? "50,500,2000").split(",").map(Number);
const RUNS = Number(args.runs ?? 3);
const LABEL = args.label ?? "";

// measure-load.mjs와 같은 저사양 조건. 한쪽을 바꾸면 다른 쪽도 맞춰야 두 측정을 나란히 읽을 수 있다.
const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6e6 / 8) | 0, uploadThroughput: (750e3 / 8) | 0 };
const CPU_SLOWDOWN = 4;

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const PEOPLE = 30;
/** 자주 나오는 사람 수. 나머지는 가끔 나와 개인 기록 길이가 고르지 않게 한다(실제 모임처럼). */
const REGULARS = 16;
const GAMES_PER_EVENING = 6;
const DAYS_BETWEEN_EVENINGS = 2;
/** 가져오기 한 번에 넣을 수 있는 경기 수(src/server/matchImport.ts MAX_IMPORT_MATCHES). */
const IMPORT_BATCH = 50;
/** 마지막 긴 작업 뒤 이만큼 아무 일이 없으면 조용해졌다고 본다. 결과 저장 뒤 화면이 따로 늦게 시작하는 계산이 없어 넉넉히 둔다. */
const QUIET_WAIT_MS = 3000;

// 시드 고정 난수(scripts/seed.mjs와 같은 식): 매번 같은 모임이 만들어져 전·후 비교가 된다.
let seed = 20261123;
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 한 판 10명. 단골 16명에서 8명, 나머지에서 2명을 뽑아 섞는다. */
function pickTen(ids) {
  const draw = (pool, n) => [...pool].sort(() => random() - 0.5).slice(0, n);
  return draw([...draw(ids.slice(0, REGULARS), 8), ...draw(ids.slice(REGULARS), 2)], 10);
}

/** 경기 count개를 가진 모임을 만든다. 돌려주는 값: 로그인 쿠키가 든 storageState와 모임 ID·참가자 ID. */
async function seedGroup(count) {
  const api = await apiRequest.newContext({ baseURL: BASE });
  const send = async (method, path, data) => {
    const response = await api.fetch(path, { method, data });
    if (!response.ok()) throw new Error(`${method} ${path} → ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await send("POST", "/api/auth/fake-login", { subject: `measure-save-${count}-${Date.now().toString(36)}` });
  const group = await send("POST", "/api/groups", { requestId: crypto.randomUUID(), name: `저장 측정 ${count}` });
  const names = Array.from({ length: PEOPLE }, (_, i) => `측정${String(i + 1).padStart(2, "0")}`);
  const ids = (await send("POST", `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names })).participants.map(
    (p) => p.id,
  );
  // 측정 판마다 같은 10명을 다시 시작하므로 서포터 순환을 끈다(켜 두면 같은 서포터의 두 번째 판을 409로 막는다).
  const before = await send("GET", `/api/groups/${group.id}/snapshot`);
  await send("PUT", `/api/groups/${group.id}/settings`, {
    requestId: crypto.randomUUID(),
    baseSettingsVersionId: before.group.settingsVersionId,
    settings: { ...before.group.settings, rotationEnabled: false },
  });

  // 가장 오래된 저녁부터 어제까지. 오늘에는 넣지 않아 측정 경기만 "오늘"이 된다.
  const evenings = Math.ceil(count / GAMES_PER_EVENING);
  const matches = Array.from({ length: count }, (_, i) => {
    const evening = Math.floor(i / GAMES_PER_EVENING);
    const daysAgo = (evenings - evening) * DAYS_BETWEEN_EVENINGS;
    const playedAt = new Date(Date.now() - daysAgo * 86_400_000 + (i % GAMES_PER_EVENING) * 40 * 60_000);
    const ten = pickTen(ids);
    return {
      playedAt: playedAt.toISOString(),
      roster: ten.map((participantId, k) => ({ participantId, team: k < 5 ? "A" : "B", position: POSITIONS[k % 5] })),
      winnerTeam: random() < 0.5 ? "A" : "B",
      winnerSide: random() < 0.5 ? "blue" : "red",
    };
  });
  for (let i = 0; i < matches.length; i += IMPORT_BATCH) {
    await send("POST", `/api/groups/${group.id}/matches/import`, {
      requestId: `measure-save-${group.id}-${i}`,
      batchId: `measure-save-${group.id}`,
      matches: matches.slice(i, i + IMPORT_BATCH),
    });
  }
  const storageState = await api.storageState();
  await api.dispose();
  return { storageState, groupId: group.id, ten: ids.slice(0, 10) };
}

/**
 * 진행 중 경기를 하나 연다. 팀 A = 블루라 결과 창이 "블루팀 승/레드팀 승" 빠른 입력이 된다(실제 준비 화면에서 시작한 경기와 같다).
 * 돌려주는 값: 가장 최근 확정 경기 ID(MMR을 미리 계산해 둘 때 그 경기 상세를 연다).
 */
async function startLiveMatch(storageState, groupId, ten) {
  const api = await apiRequest.newContext({ baseURL: BASE, storageState });
  const snapshot = await (await api.get(`/api/groups/${groupId}/snapshot`)).json();
  const response = await api.post(`/api/groups/${groupId}/matches/start`, {
    data: {
      requestId: crypto.randomUUID(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((participantId, k) => ({ participantId, team: k < 5 ? "A" : "B", position: POSITIONS[k % 5] })),
      teamASide: "blue",
    },
  });
  if (!response.ok()) throw new Error(`경기 시작 → ${response.status()} ${await response.text()}`);
  await api.dispose();
  return snapshot.matches.filter((m) => m.state === "confirmed").at(-1).id;
}

/**
 * warm이 false면 진행 화면을 막 연 상태(휴대폰이 탭을 새로 고친 직후처럼 MMR을 아직 한 번도 계산하지 않음)에서 잰다.
 * true면 먼저 경기 상세를 열어 MMR을 계산해 둔다. 평소 흐름(준비 화면 → 시작 → 저장 → 다음 준비)은 준비 화면이 이미
 * 계산해 두었으므로 이쪽에 가깝다. 계산해 둔 상태면 다음 스냅숏은 뒤에 붙은 경기만 이어 넣는다(rating.ts fitRatings).
 */
async function measureOnce(browser, group, warm) {
  const lastConfirmedId = await startLiveMatch(group.storageState, group.groupId, group.ten);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    storageState: group.storageState,
  });
  const page = await context.newPage();
  const origin = new URL(BASE).origin;
  await page.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  // CDP로 넣는 스크립트라 보안 정책(script-src 'self')에 막히지 않는다. 측정용이며 화면 코드에는 없다.
  await page.addInitScript(() => {
    const m = { longTasks: [] };
    window.__save = m;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) m.longTasks.push([e.startTime, e.startTime + e.duration]);
    }).observe({ type: "longtask", buffered: true });
    // 누른 시각은 입력 이벤트의 timeStamp다. 메인 스레드가 바빠 처리가 늦어진 시간(입력 지연)까지 들어간다.
    document.addEventListener(
      "click",
      (e) => {
        const label = e.target instanceof Element ? e.target.closest("button")?.textContent?.trim() : null;
        if (label === "결과 저장") m.saveClick = e.timeStamp;
        if (label === "다음 경기 준비") m.prepClick = e.timeStamp;
      },
      true,
    );
    const paintedAt = (key) => requestAnimationFrame(() => setTimeout(() => (m[key] ??= performance.now())));
    new MutationObserver(() => {
      if (m.saveClick !== undefined && m.savedDom === undefined && document.querySelector("p.saved")) {
        m.savedDom = performance.now();
        paintedAt("savedAt");
      }
      if (m.prepClick !== undefined && m.prepDom === undefined) {
        const start = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "이 팀으로 시작");
        if (start) {
          m.prepDom = performance.now();
          paintedAt("prepAt");
        }
      }
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });

  await page.goto(`${BASE}/#/match`, { timeout: 300_000 });
  await page.getByRole("heading", { name: /경기 진행 중/ }).waitFor({ timeout: 300_000 });
  await page.waitForLoadState("networkidle");
  if (warm) {
    // 같은 문서 안에서 주소만 바꾼다(새로 불러오면 계산해 둔 MMR이 사라진다).
    await page.evaluate((id) => (window.location.hash = `#/m/${id}`), lastConfirmedId);
    await page.getByText("이 경기로 바뀐 MMR", { exact: true }).waitFor({ timeout: 300_000 });
    await page.evaluate(() => (window.location.hash = "#/match"));
    await page.getByRole("heading", { name: /경기 진행 중/ }).waitFor();
  }
  await page.waitForTimeout(QUIET_WAIT_MS);

  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  await page.getByRole("button", { name: "결과 입력", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /블루팀 승/ }).click();
  await dialog.getByRole("button", { name: "결과 저장", exact: true }).click();
  await dialog.getByText(/경기 저장됨/).waitFor({ timeout: 120_000 });
  // 다시 읽기가 끝나고 그 뒤 계산까지 가라앉을 때까지 기다린다.
  await page.waitForLoadState("networkidle");
  await waitQuiet(page);

  const prep = dialog.getByRole("button", { name: "다음 경기 준비", exact: true });
  await prep.click();
  await page.getByRole("button", { name: "이 팀으로 시작", exact: true }).waitFor({ timeout: 120_000 });
  await waitQuiet(page);

  const result = await page.evaluate(() => {
    const m = window.__save;
    const snapshotEnd = performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/snapshot") && e.startTime >= m.saveClick)
      .map((e) => e.responseEnd)[0];
    const between = (from, to) => m.longTasks.filter(([start]) => start >= from && start < to);
    const saveTasks = between(m.saveClick, m.prepClick);
    const prepTasks = between(m.prepClick, Infinity);
    const sum = (tasks) => tasks.reduce((total, [start, end]) => total + (end - start), 0);
    const lastEnd = (tasks, fallback) => Math.max(fallback, ...tasks.map(([, end]) => end));
    return {
      saved: m.savedAt - m.saveClick,
      snapshot: snapshotEnd === undefined ? null : snapshotEnd - m.saveClick,
      quiet: lastEnd(saveTasks, m.savedAt) - m.saveClick,
      saveLong: sum(saveTasks),
      prep: m.prepAt - m.prepClick,
      prepQuiet: lastEnd(prepTasks, m.prepAt) - m.prepClick,
      prepLong: sum(prepTasks),
    };
  });
  await context.close();
  return result;
}

/** 마지막 긴 작업 뒤 QUIET_WAIT_MS 동안 새 긴 작업이 없을 때까지 기다린다. */
async function waitQuiet(page) {
  let seen = -1;
  for (;;) {
    const count = await page.evaluate(() => window.__save.longTasks.length);
    if (count === seen) return;
    seen = count;
    await page.waitForTimeout(QUIET_WAIT_MS);
  }
}

const median = (values) => {
  const sorted = values.filter((v) => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};

const browser = await chromium.launch();
const rows = [];
for (const size of SIZES) {
  const group = await seedGroup(size);
  for (const warm of [false, true]) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(browser, group, warm));
    const pick = (key) => median(runs.map((r) => r[key]));
    rows.push({ size, warm, ...Object.fromEntries(Object.keys(runs[0]).map((key) => [key, pick(key)])), raw: runs });
  }
}
await browser.close();

const ms = (v) => (v === null ? "-" : `${Math.round(v)}ms`);
console.log(`결과 저장 뒤 측정 ${LABEL} (${BASE}, ${RUNS}회 중앙값, 390×844, CPU ${CPU_SLOWDOWN}배 감속, 지연 ${NETWORK.latency}ms·1.6Mbps/750kbps)`);
console.log("| 경기 수 | MMR | 저장됨 표시 | 기록 다시 받음 | 조용해짐 | 긴 작업 합 | 준비 화면 | 준비 조용해짐 | 준비 긴 작업 |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(
    `| ${r.size} | ${r.warm ? "계산해 둠" : "처음"} | ${ms(r.saved)} | ${ms(r.snapshot)} | ${ms(r.quiet)} | ${ms(r.saveLong)} | ${ms(r.prep)} | ${ms(r.prepQuiet)} | ${ms(r.prepLong)} |`,
  );
}
if ("verbose" in args) console.log(JSON.stringify(rows, null, 2));
