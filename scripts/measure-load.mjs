// 첫 진입 속도 측정(로컬 전용, CI에 넣지 않는다). Lighthouse 대신 이미 있는 Playwright(chromium)와 CDP로 저사양 조건을 건다.
//
//   node scripts/measure-load.mjs [--base http://127.0.0.1:8787] [--runs 3] [--label 이름]
//
// 조건: CPU 4배 감속, 느린 4G 수준 네트워크(지연 150ms, 내려받기 1.6Mbps, 올리기 750kbps), 캐시 끔, 매번 새 브라우저 문맥.
// 화면: 첫 화면(#/, 로그인 안 함), 조회 링크(#/v/토큰), 예시 모임(#/demo). 조회 링크용 모임은 가짜 로그인(AUTH_MODE=fake)으로
// 그때그때 만든다(참가자 10명, 지난 경기 8판). 그래서 로컬 서버(wrangler dev)에만 쓴다.
// 지표: 첫 콘텐츠 표시(FCP), 가장 큰 콘텐츠 표시(LCP), 화면 조각 표시(main 안에 "불러오는 중…"과 푸터가 아닌 것이
// 처음 생긴 때), 받은 JS(전송 바이트, 압축된 크기), 요청 수. 화면마다 runs번 재서 중앙값.
// 화면 조각 표시를 따로 재는 까닭: 상단 바와 아래의 긴 법적 고지(푸터)가 껍데기와 함께 먼저 그려져 LCP가 거기서 정해지기 쉽다.
// 그러면 LCP는 화면 조각이 늦게 와도 그대로라, 화면 조각 미리 받기의 효과는 화면 조각 표시 시각으로 본다.
//
// 외부 주소(글꼴 CSS·woff2, 챔피언 초상화)는 막는다: 측정할 때마다 외부 CDN 상태에 따라 수치가 흔들리지 않게.
// 로컬 측정이라 실제 휴대폰·실제 네트워크(특히 Cloudflare 가장자리까지의 거리)와 다르다. 같은 조건의 전·후 비교에만 쓴다.
// page.evaluate·addInitScript에 넘기는 함수는 브라우저에서 돈다(아래 전역은 그 안에서만 쓴다).
/* global window, document, MutationObserver */
import { chromium, request as apiRequest } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const BASE = args.base ?? `http://127.0.0.1:${process.env.E2E_PORT ?? "8787"}`;
const RUNS = Number(args.runs ?? 3);
const LABEL = args.label ?? "";

const NETWORK = { offline: false, latency: 150, downloadThroughput: (1.6e6 / 8) | 0, uploadThroughput: (750e3 / 8) | 0 };
const CPU_SLOWDOWN = 4;

/** 조회 링크를 열 모임을 만든다. 돌려주는 값: 조회 토큰. */
async function makeViewToken() {
  const api = await apiRequest.newContext({ baseURL: BASE });
  const post = async (path, data) => {
    const response = await api.post(path, { data });
    if (!response.ok()) throw new Error(`${path} → ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await post("/api/auth/fake-login", { subject: `measure-${Date.now().toString(36)}` });
  const group = await post("/api/groups", { requestId: crypto.randomUUID(), name: "측정용 모임" });
  const names = Array.from({ length: 10 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ids = (await post(`/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names })).participants.map((p) => p.id);
  const positions = ["top", "jungle", "mid", "adc", "support"];
  for (let i = 0; i < 8; i++) {
    // 사람 순서를 돌려 가며 팀을 바꾼다(기록·통계 화면에 그릴 거리가 있게).
    const order = ids.map((_, k) => ids[(k + i * 3) % ids.length]);
    await post(`/api/groups/${group.id}/matches/backfill`, {
      requestId: crypto.randomUUID(),
      playedAt: new Date(Date.now() - (10 - i) * 3600_000).toISOString(),
      roster: order.map((id, k) => ({ participantId: id, team: k < 5 ? "A" : "B", position: positions[k % 5] })),
      winnerTeam: i % 3 === 0 ? "B" : "A",
      winnerSide: "unknown",
    });
  }
  const snapshot = await (await api.get(`/api/groups/${group.id}/snapshot`)).json();
  await api.dispose();
  return snapshot.group.viewToken;
}

async function measureOnce(browser, path) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ko-KR", timezoneId: "Asia/Seoul" });
  const page = await context.newPage();
  const origin = new URL(BASE).origin;
  await page.route("**/*", (route) => (route.request().url().startsWith(origin) ? route.continue() : route.abort()));
  // CDP로 넣는 스크립트라 보안 정책(script-src 'self')에 막히지 않는다. 측정용이며 화면 코드에는 없다.
  await page.addInitScript(() => {
    // p.screen은 App.tsx의 "불러오는 중…" 표시다.
    const check = () => {
      if (window.__contentAt !== undefined) return;
      if (document.querySelector("main > :not(footer):not(p.screen)")) window.__contentAt = performance.now();
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", NETWORK);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });

  const types = new Map();
  let requests = 0;
  let jsBytes = 0;
  cdp.on("Network.requestWillBeSent", (e) => {
    if (e.request.url.startsWith(origin)) requests += 1;
  });
  cdp.on("Network.responseReceived", (e) => types.set(e.requestId, e.type));
  cdp.on("Network.loadingFinished", (e) => {
    if (types.get(e.requestId) === "Script") jsBytes += e.encodedDataLength;
  });

  await page.goto(`${BASE}/${path}`, { waitUntil: "networkidle", timeout: 120000 });
  // LCP 후보는 그림이 끝난 뒤에도 잠깐 더 바뀔 수 있어 조금 기다렸다 읽는다.
  await page.waitForTimeout(1500);
  const paint = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve({ fcp, lcp: entries[entries.length - 1]?.startTime ?? null });
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve({ fcp, lcp: null }), 1000);
      }),
  );
  const content = await page.evaluate(() => window.__contentAt ?? null);
  await context.close();
  return { ...paint, content, jsBytes, requests };
}

const median = (values) => {
  const sorted = values.filter((v) => v !== null).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};

const token = await makeViewToken();
const targets = [
  ["첫 화면 #/", "#/"],
  ["조회 링크 #/v/토큰", `#/v/${token}`],
  ["예시 모임 #/demo", "#/demo"],
];
const browser = await chromium.launch();
const rows = [];
for (const [label, path] of targets) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(browser, path));
  rows.push({
    label,
    fcp: median(runs.map((r) => r.fcp)),
    lcp: median(runs.map((r) => r.lcp)),
    content: median(runs.map((r) => r.content)),
    js: median(runs.map((r) => r.jsBytes)),
    requests: median(runs.map((r) => r.requests)),
    raw: runs,
  });
}
await browser.close();

const ms = (v) => (v === null ? "-" : `${Math.round(v)}ms`);
console.log(`측정 ${LABEL} (${BASE}, ${RUNS}회 중앙값, CPU ${CPU_SLOWDOWN}배 감속, 지연 ${NETWORK.latency}ms·1.6Mbps/750kbps)`);
console.log("| 화면 | FCP | LCP | 화면 조각 표시 | 받은 JS | 요청 수 |");
console.log("|---|---|---|---|---|---|");
for (const r of rows) {
  console.log(`| ${r.label} | ${ms(r.fcp)} | ${ms(r.lcp)} | ${ms(r.content)} | ${(r.js / 1000).toFixed(1)}KB | ${r.requests} |`);
}
if (args.verbose !== undefined) console.log(JSON.stringify(rows, null, 2));
