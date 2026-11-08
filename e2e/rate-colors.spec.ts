import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 승률 색 단계(45~55% 중립, 높을수록 붉게, 낮을수록 가라앉게)와 칭호 색·엠블럼을 확인한다.
// 승률이 20%대~80%대로 고르게 퍼진 모임을 API로 만든다.
// SHOTS_DIR 환경 변수를 주면 세 테마 × 390·1440px 스크린샷(개인 통계·분석·랭킹·검색·칭호 설정)을 그 폴더에 남긴다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
/**
 * 사람별 목표 승률(선수01~12). 평균이 50%여야 한 경기에 5명씩 이기는 배정으로 맞출 수 있다.
 * 색 단계 -4~4가 고루 나오고, 기본 칭호 다섯 구간(65·55·45·35%)에도 모두 사람이 있다.
 */
const TARGETS = [0.2, 0.33, 0.38, 0.43, 0.48, 0.5, 0.52, 0.57, 0.58, 0.62, 0.67, 0.72];
const MATCHES = 48;

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-heat-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-heat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "색 단계 테스트 모임" });
  const names = TARGETS.map((t, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants };
}

/**
 * 매 경기 두 명을 돌아가며 쉬게 하고, 목표보다 덜 이긴 사람 다섯을 이기는 팀(팀 A)에 넣는다.
 * 라인은 경기마다 돌린다. 진영은 블루·레드를 번갈아.
 */
async function build(page: Page): Promise<Setup> {
  const s = await setup(page);
  const wins = TARGETS.map(() => 0);
  const games = TARGETS.map(() => 0);
  for (let m = 0; m < MATCHES; m++) {
    const resting = new Set([(m * 2) % 12, (m * 2 + 1) % 12]);
    const playing = TARGETS.map((_, i) => i).filter((i) => !resting.has(i));
    const deficit = (i: number) => TARGETS[i]! * (games[i]! + 1) - wins[i]!;
    playing.sort((a, b) => deficit(b) - deficit(a) || a - b);
    const winners = playing.slice(0, 5);
    const losers = playing.slice(5);
    for (const i of playing) games[i]! += 1;
    for (const i of winners) wins[i]! += 1;
    const ten = [...winners, ...losers];
    const snapshot = await (await page.request.get(`/api/groups/${s.groupId}/snapshot`)).json();
    const started = await post(page.request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((idx, k) => ({
        participantId: s.people[idx]!.id,
        team: k < 5 ? "A" : "B",
        position: POSITIONS[(k + m) % 5],
      })),
    });
    await post(page.request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: started.match.version,
      winnerTeam: "A",
      winnerSide: m % 2 === 0 ? "blue" : "red",
    });
  }
  return s;
}

async function setTheme(page: Page, theme: string) {
  await page.evaluate((t) => {
    localStorage.setItem("naejeon.theme", t);
    document.documentElement.dataset.theme = t;
    window.scrollTo(0, 0);
  }, theme);
  await page.waitForTimeout(300);
}

async function shots(page: Page, s: Setup, dir: string) {
  mkdirSync(dir, { recursive: true });
  const top = s.people[11]!; // 목표 72%
  for (const theme of ["dark", "deeplol", "light"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/#/p/${top.id}`);
      await setTheme(page, theme);
      await expect(page.getByRole("region", { name: "요약" }).locator(".ring")).toBeVisible();
      await page.screenshot({ path: join(dir, `person-${theme}-${width}.png`), fullPage: true });

      await page.goto("/#/graphs");
      await setTheme(page, theme);
      await page.getByLabel("플레이어", { exact: true }).selectOption({ label: "선수12" });
      await expect(page.getByRole("region", { name: "플레이어 × 라인" })).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(dir, `graphs-${theme}-${width}.png`), fullPage: true });

      await page.goto("/#/records");
      await setTheme(page, theme);
      await page.getByRole("button", { name: "전체", exact: true }).click();
      const ranking = page.getByRole("region", { name: "소환사 랭킹" });
      await expect(ranking.getByRole("listitem")).toHaveCount(12);
      await ranking.scrollIntoViewIfNeeded();
      await ranking.screenshot({ path: join(dir, `records-${theme}-${width}.png`) });

      await page.goto("/#/search");
      await setTheme(page, theme);
      await page.getByRole("searchbox").fill("선수");
      await expect(page.getByRole("region", { name: "검색 결과" }).getByRole("listitem").first()).toBeVisible();
      await page.screenshot({ path: join(dir, `search-${theme}-${width}.png`), fullPage: true });

      await page.goto("/#/group");
      await setTheme(page, theme);
      const section = page.getByRole("region", { name: "칭호" });
      await section.scrollIntoViewIfNeeded();
      await section.screenshot({ path: join(dir, `titles-${theme}-${width}.png`) });
      await section.getByRole("button", { name: "칭호 바꾸기" }).click();
      const dialog = page.getByRole("dialog", { name: "칭호 바꾸기" });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(dir, `titles-dialog-${theme}-${width}.png`) });
      await dialog.getByRole("button", { name: "닫기" }).click();
    }
  }
}

/** 첫 요소의 계산된 색. */
async function colorOf(page: Page, selector: string, prop: "stroke" | "color") {
  return page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], prop);
}

test.use({ viewport: { width: 390, height: 844 } });

test("승률 막대·글자는 같은 색 단계를 따르고 진영·승패·비중 막대는 그대로다, 칭호는 등급 색·엠블럼", async ({
  page,
}) => {
  test.setTimeout(400000);
  const s = await build(page);
  await page.goto("/");
  const dir = process.env.SHOTS_DIR;
  if (dir) await shots(page, s, dir);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  await setTheme(page, "dark");

  // 개인 통계: 가장 높은 선수12(70% 이상)는 가장 붉은 단계, 가장 낮은 선수01(20%)은 가장 가라앉은 단계.
  const top = s.people[11]!;
  const low = s.people[0]!;
  await page.goto(`/#/p/${top.id}`);
  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary.locator(".ring-fill")).toHaveClass(/heat-h4/);
  await expect(summary.locator(".summary-line")).toHaveClass(/heat-h4/);
  const hotRing = await colorOf(page, ".ring-fill", "stroke");
  const hotText = await colorOf(page, ".summary-line", "color");
  // 진영 막대는 진영 색 그대로(승률 단계 클래스가 붙지 않는다). 다크 테마의 블루 #3987e5 · 레드 #e66767.
  const sides = page.getByRole("region", { name: "진영별" });
  await expect(sides.locator(".meter-fill.tone-blue")).toHaveCount(1);
  await expect(sides.locator(".meter-fill.tone-red")).toHaveCount(1);
  await expect(sides.locator(".meter-fill[class*='heat-']")).toHaveCount(0);
  const bg = (el: Element) => getComputedStyle(el).backgroundColor;
  expect(await sides.locator(".meter-fill.tone-blue").evaluate(bg)).toBe("rgb(57, 135, 229)");
  expect(await sides.locator(".meter-fill.tone-red").evaluate(bg)).toBe("rgb(230, 103, 103)");
  // 승·패 막대도 그대로: 승은 승리 색 #3b82f6, 패는 패배 색 #ef4444 빗금.
  const recent = page.getByRole("region", { name: "최근" });
  expect(await recent.locator(".wl-win").first().evaluate(bg)).toBe("rgb(59, 130, 246)");
  expect(
    await recent.locator(".wl-loss").first().evaluate((el) => getComputedStyle(el).backgroundImage),
  ).toContain("rgb(239, 68, 68)");
  // 비중 막대는 중립 색이고 승률 단계를 따르지 않는다.
  const lines = page.getByRole("region", { name: "라인별" });
  await expect(lines.locator(".meter-fill.tone-share")).toHaveCount(5);
  await expect(lines.locator(".meter-fill.tone-share[class*='heat-']")).toHaveCount(0);
  // 칭호: 최상 구간(65% 이상)은 1등급. 엠블럼은 화면 읽기에서 숨기고 이름 글자가 옆에 있다.
  const chip = summary.locator(".title-chip");
  await expect(chip).toHaveClass(/grade-1/);
  await expect(chip).toHaveText("전장의 지배자");
  await expect(chip.locator("svg.title-emblem")).toHaveAttribute("aria-hidden", "true");

  await page.goto(`/#/p/${low.id}`);
  await page.reload();
  await expect(page.getByRole("heading", { name: "선수01", level: 1 })).toBeVisible();
  await expect(summary.locator(".ring-fill")).toHaveClass(/heat-l4/);
  await expect(summary.locator(".summary-line")).toHaveClass(/heat-l4/);
  expect(await colorOf(page, ".ring-fill", "stroke")).not.toBe(hotRing);
  expect(await colorOf(page, ".summary-line", "color")).not.toBe(hotText);
  await expect(summary.locator(".title-chip")).toHaveClass(/grade-5/);
  await expect(summary.locator(".title-chip")).toHaveText("불굴의 개척자");

  // 랭킹: 승률 숫자 글자가 여러 단계로 나뉘고, 높은 줄과 낮은 줄의 글자 색이 다르다. 칭호 다섯 등급이 모두 보인다.
  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  await expect(ranking.getByRole("listitem")).toHaveCount(12);
  const heats = await ranking
    .locator(".rate")
    .evaluateAll((nodes) => nodes.map((n) => n.className.match(/heat-\w+/)?.[0] ?? ""));
  expect(new Set(heats).size).toBeGreaterThanOrEqual(6);
  expect(heats[0]).toBe("heat-h4");
  expect(heats[heats.length - 1]).toBe("heat-l4");
  const rateColors = await ranking.locator(".rate").evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).color));
  expect(rateColors[0]).not.toBe(rateColors[rateColors.length - 1]);
  const grades = await ranking
    .locator(".title-chip")
    .evaluateAll((nodes) => nodes.map((n) => n.className.match(/grade-\d/)?.[0] ?? ""));
  expect(new Set(grades)).toEqual(new Set(["grade-1", "grade-2", "grade-3", "grade-4", "grade-5"]));

  // 검색: 작은 승률 막대도 같은 단계.
  await page.goto("/#/search");
  await page.getByRole("searchbox").fill("선수");
  const results = page.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(results.filter({ hasText: "선수12" }).locator(".meter-fill")).toHaveClass(/heat-h4/);
  await expect(results.filter({ hasText: "선수01" }).locator(".meter-fill")).toHaveClass(/heat-l4/);

  // 분석: 개인별 막대·숫자와 표 칸이 같은 단계를 쓰고, 진영 막대는 진영 색 그대로다.
  await page.goto("/#/graphs");
  const bars = page.getByRole("region", { name: "개인별 승률" }).getByRole("listitem");
  await expect(bars.filter({ hasText: "선수12" }).locator(".bar-fill")).toHaveClass(/heat-h4/);
  await expect(bars.filter({ hasText: "선수12" }).locator(".bar-value strong")).toHaveClass(/heat-h4/);
  await expect(bars.filter({ hasText: "선수01" }).locator(".bar-fill")).toHaveClass(/heat-l4/);
  await expect(bars.filter({ hasText: "선수12" }).locator(".title-chip")).toHaveClass(/grade-1/);
  const sideBars = page.getByRole("region", { name: "진영별 누적 승률" });
  await expect(sideBars.locator(".bar-fill.tone-blue")).toHaveCount(1);
  await expect(sideBars.locator(".bar-fill.tone-red")).toHaveCount(1);
  await expect(sideBars.locator(".bar-fill[class*='heat-']")).toHaveCount(0);
  const matrix = page.getByRole("region", { name: "플레이어 × 라인" });
  expect(await matrix.locator("td[class*='heat-']").count()).toBeGreaterThan(20);
  await expect(matrix.locator(".swatch.heat-h4")).toHaveCount(1);
  await expect(matrix.locator(".swatch.heat-l4")).toHaveCount(1);

  // 칭호 설정: 기본 6구간은 다섯 등급에 비율로 대응해 가운데 두 구간이 같은 등급(1·2·3·3·4·5).
  // 구간 수를 8개로 늘려도, 2개로 줄여도 등급이 순서대로 붙는다.
  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "칭호" });
  const sectionGrades = () =>
    section.locator(".title-chip").evaluateAll((nodes) => nodes.map((n) => n.className.match(/grade-\d/)?.[0]));
  expect(await sectionGrades()).toEqual(["grade-1", "grade-2", "grade-3", "grade-3", "grade-4", "grade-5"]);
  await section.getByRole("button", { name: "칭호 바꾸기" }).click();
  const dialog = page.getByRole("dialog", { name: "칭호 바꾸기" });
  await expect(dialog.locator(".title-preview")).toHaveCount(6);
  await dialog.getByRole("button", { name: "맨 위에 구간 더하기" }).click();
  await dialog.getByRole("button", { name: "맨 위에 구간 더하기" }).click();
  await expect(dialog.locator(".title-preview")).toHaveCount(8);
  await dialog.getByLabel("1번째 칭호 이름").fill("전설");
  await dialog.getByLabel("1번째 칭호 경계(% 이상)").fill("90");
  await dialog.getByLabel("2번째 칭호 이름").fill("영웅");
  await dialog.getByLabel("2번째 칭호 경계(% 이상)").fill("80");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.locator(".title-chip")).toHaveCount(8);
  expect(await sectionGrades()).toEqual([
    "grade-1",
    "grade-2",
    "grade-2",
    "grade-3",
    "grade-3",
    "grade-4",
    "grade-4",
    "grade-5",
  ]);
  // 8구간: 선수12(70% 이상 → 65% 구간, 위에서 3번째)는 2등급.
  await page.goto(`/#/p/${top.id}`);
  await page.reload();
  await expect(page.getByRole("region", { name: "요약" }).locator(".title-chip")).toHaveClass(/grade-2/);

  await page.goto("/#/group");
  await section.getByRole("button", { name: "칭호 바꾸기" }).click();
  for (let i = 0; i < 6; i++) await dialog.getByRole("button", { name: "1번째 칭호 빼기" }).click();
  await expect(dialog.locator(".title-preview")).toHaveCount(2);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.locator(".title-chip")).toHaveCount(2);
  expect(await sectionGrades()).toEqual(["grade-1", "grade-5"]);
  await page.goto(`/#/p/${low.id}`);
  await page.reload();
  const lowChip = page.getByRole("region", { name: "요약" }).locator(".title-chip");
  await expect(lowChip).toHaveClass(/grade-5/);
  await expect(lowChip.locator("svg.title-emblem")).toHaveCount(1);
});
