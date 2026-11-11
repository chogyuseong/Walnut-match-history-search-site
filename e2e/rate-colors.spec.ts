import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 승률 색(3단: 높음 강조색 · 45~55% 주요 글자 · 낮음 보조 글자, 단계 클래스 이름은 heat-h1~h4·0·l1~l4 그대로)과
// 칭호 등급 클래스·엠블럼·등급 색을 확인한다. 칭호는 등급마다 색(--title-N)이 다르고, 색만으로 가르지 않게
// 엠블럼 모양과 이름 글자가 함께 있다(CLAUDE.md 5절 예외). 승률이 20%대~80%대로 고르게 퍼진 모임을 API로 만든다.
// SHOTS_DIR 환경 변수를 주면 두 테마 × 390·1440px 스크린샷(개인 통계·분석·랭킹·검색·칭호 설정, 8구간 칭호 목록)을
// 그 폴더에 남긴다.

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
  for (const theme of ["dark", "light"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/#/p/${top.id}`);
      await setTheme(page, theme);
      await expect(page.getByRole("region", { name: "요약" }).locator(".ring")).toBeVisible();
      await page.screenshot({ path: join(dir, `person-${theme}-${width}.png`), fullPage: true });

      await page.goto("/#/graphs");
      await setTheme(page, theme);
      await page.getByLabel("플레이어", { exact: true }).selectOption({ label: "선수12" });
      await expect(page.getByRole("region", { name: "고른 플레이어" })).toBeVisible();
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

test("승률 막대·글자는 같은 색 단계를 따르고 진영·승패·비중 막대는 그대로다, 칭호는 등급 클래스·엠블럼", async ({
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
  // 진영 막대는 진영 색 그대로(승률 단계 클래스가 붙지 않는다). 다크 테마의 승리 색 #4f8ddd · 패배 색 #d9534f.
  const sides = page.getByRole("region", { name: "진영별" });
  await expect(sides.locator(".meter-fill.tone-blue")).toHaveCount(1);
  await expect(sides.locator(".meter-fill.tone-red")).toHaveCount(1);
  await expect(sides.locator(".meter-fill[class*='heat-']")).toHaveCount(0);
  const bg = (el: Element) => getComputedStyle(el).backgroundColor;
  expect(await sides.locator(".meter-fill.tone-blue").evaluate(bg)).toBe("rgb(79, 141, 221)");
  expect(await sides.locator(".meter-fill.tone-red").evaluate(bg)).toBe("rgb(217, 83, 79)");
  // 승·패 막대도 그대로: 승은 승리 색 #4f8ddd 채움, 패는 패배 색 #d9534f 테두리만(속 빈 막대, 빗금 무늬 대신).
  const recent = page.getByRole("region", { name: "최근" });
  expect(await recent.locator(".wl-win").first().evaluate(bg)).toBe("rgb(79, 141, 221)");
  const lossBar = recent.locator(".wl-loss").first();
  expect(await lossBar.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(217, 83, 79)");
  expect(await lossBar.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe("none");
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
  await expect(summary.locator(".title-chip")).toHaveClass(/grade-8/);
  await expect(summary.locator(".title-chip")).toHaveText("불굴의 개척자");
  // 최근 승패 점(2026-11-10): 승은 승리 색 #4f8ddd로 채우고, 패는 바탕 없이 패배 테두리 + 패배 글자 #ea847f.
  const dots = page.locator(".ps-form .form-dot");
  expect(await dots.and(page.locator(".win")).first().evaluate(bg)).toBe("rgb(79, 141, 221)");
  const lossDot = dots.and(page.locator(".loss")).first();
  expect(await lossDot.evaluate(bg)).toBe("rgba(0, 0, 0, 0)");
  expect(await lossDot.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(234, 132, 127)");
  expect(await lossDot.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgba(217, 83, 79, 0.35)");

  // 랭킹: 승률 숫자 글자가 여러 단계 클래스로 나뉘고, 높은 줄(강조색)과 낮은 줄(보조 글자)의 글자 색이 다르다(3단).
  // 칭호 여섯 구간의 등급(1·2·4·5·7·8)이 모두 보이고 서로 다르다.
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
  expect(new Set(grades)).toEqual(new Set(["grade-1", "grade-2", "grade-4", "grade-5", "grade-7", "grade-8"]));

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
  // 진영은 요약 타일의 두 색 띠(진영 색 그대로, 승률 단계 클래스 없음).
  const sideBars = page.getByRole("region", { name: "분석 요약" });
  await expect(sideBars.locator(".side-bar .side-blue")).toHaveCount(1);
  await expect(sideBars.locator(".side-bar .side-red")).toHaveCount(1);
  await expect(sideBars.locator("[class*='heat-']")).toHaveCount(0);
  await page.getByRole("group", { name: "분석 보기" }).getByRole("button", { name: "플레이어 × 라인" }).click();
  const matrix = page.getByRole("region", { name: "플레이어 × 라인" });
  expect(await matrix.locator("td[class*='heat-']").count()).toBeGreaterThan(20);
  await expect(matrix.locator(".swatch.heat-h4")).toHaveCount(1);
  await expect(matrix.locator(".swatch.heat-l4")).toHaveCount(1);

  // 칭호 설정: 기본 6구간은 여덟 등급에 고르게 벌려 구간마다 다른 등급(1·2·4·5·7·8).
  // 구간 수를 8개로 늘리면 1~8, 2개로 줄이면 1·8로 순서대로 붙는다.
  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "칭호" });
  const sectionGrades = () =>
    section.locator(".title-chip").evaluateAll((nodes) => nodes.map((n) => n.className.match(/grade-\d/)?.[0]));
  expect(await sectionGrades()).toEqual(["grade-1", "grade-2", "grade-4", "grade-5", "grade-7", "grade-8"]);
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
    "grade-3",
    "grade-4",
    "grade-5",
    "grade-6",
    "grade-7",
    "grade-8",
  ]);
  // 여덟 등급의 글자색(엠블럼도 currentColor)이 모두 다르다. 1등급은 다크 토큰 --title-1 #d0f65f.
  const chipColors = await section
    .locator(".title-chip")
    .evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).color));
  expect(new Set(chipColors).size).toBe(8);
  expect(chipColors[0]).toBe("rgb(208, 246, 95)");
  if (dir) {
    for (const theme of ["dark", "light"]) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await setTheme(page, theme);
        await section.scrollIntoViewIfNeeded();
        await section.screenshot({ path: join(dir, `titles8-${theme}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 390, height: 900 });
    await setTheme(page, "dark");
  }
  // 8구간: 선수12(70% 이상 → 65% 구간, 위에서 3번째)는 3등급.
  await page.goto(`/#/p/${top.id}`);
  await page.reload();
  await expect(page.getByRole("region", { name: "요약" }).locator(".title-chip")).toHaveClass(/grade-3/);

  await page.goto("/#/group");
  await section.getByRole("button", { name: "칭호 바꾸기" }).click();
  for (let i = 0; i < 6; i++) await dialog.getByRole("button", { name: "1번째 칭호 빼기" }).click();
  await expect(dialog.locator(".title-preview")).toHaveCount(2);
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();
  await expect(section.locator(".title-chip")).toHaveCount(2);
  expect(await sectionGrades()).toEqual(["grade-1", "grade-8"]);
  await page.goto(`/#/p/${low.id}`);
  await page.reload();
  const lowChip = page.getByRole("region", { name: "요약" }).locator(".title-chip");
  await expect(lowChip).toHaveClass(/grade-8/);
  await expect(lowChip.locator("svg.title-emblem")).toHaveCount(1);
});

// 5경기 미만(자료 적음) 막대는 두 테마 모두 색 없이 속 빈 테두리 막대다. 예전 라이트 전용 덮어쓰기가 회색으로 채워
// "낮음" 막대와 같아 보였던 것을 다시 막는다. 모두 2경기씩만 뛴 모임에서 그래프 분석 개인별 승률 막대를 본다.
test("자료 적음 막대는 라이트·다크 모두 속 빈 테두리 막대", async ({ page }) => {
  const s = await setup(page);
  for (let m = 0; m < 2; m++) {
    const snapshot = await (await page.request.get(`/api/groups/${s.groupId}/snapshot`)).json();
    const started = await post(page.request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: s.people.slice(0, 10).map((p, k) => ({ participantId: p.id, team: k < 5 ? "A" : "B", position: POSITIONS[k % 5] })),
    });
    await post(page.request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: started.match.version,
      winnerTeam: "A",
      winnerSide: "blue",
    });
  }
  await page.goto("/#/graphs");
  const muted = page.getByRole("region", { name: "개인별 승률" }).locator(".bar-fill.tone-muted").first();
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    await expect(muted).toBeVisible();
    const look = await muted.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, border: cs.borderTopWidth };
    });
    expect(look, theme).toEqual({ bg: "rgba(0, 0, 0, 0)", border: "1px" });
  }
});
