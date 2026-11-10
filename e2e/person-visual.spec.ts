import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 랭킹의 "누적 50경기 이상 먼저" 규칙과 개인 통계의 그림(고리·막대), 참여 경기의 위치를 확인한다.
// 경기는 API로 빠르게 만들고 화면은 읽는 쪽만 본다.
// SHOTS_DIR 환경 변수를 주면 세 테마 × 390·1440px 개인 통계 스크린샷을 그 폴더에 남긴다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-viz-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-viz-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "그림 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
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

/** 주어진 10명으로 한 경기를 시작하고 결과를 확정한다. 앞 5명이 팀 A다. */
async function play(
  request: APIRequestContext,
  s: Setup,
  ten: { id: string }[],
  winnerTeam: "A" | "B",
  winnerSide: "blue" | "red" | "unknown",
) {
  const snapshot = await (await request.get(`/api/groups/${s.groupId}/snapshot`)).json();
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: ten.map((p, i) => ({
      participantId: p.id,
      team: i < 5 ? "A" : "B",
      position: POSITIONS[i % 5],
    })),
  });
  await post(request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.match.version,
    winnerTeam,
    winnerSide,
  });
}

/**
 * 선수01~10이 50경기: 팀 A(선수01~05)가 10승 40패. 진영은 블루·레드를 번갈아.
 * 이어서 선수11·12가 선수01·06 대신 들어와 10경기, 팀 A가 모두 이긴다.
 * → 선수01: 누적 50경기 20%, 선수11: 누적 10경기 100%(배치 완료, 50경기 미만), 선수12: 10경기 0%.
 */
async function build(page: Page): Promise<Setup> {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  for (let i = 0; i < 50; i++) {
    await play(page.request, s, first10, i % 5 === 0 ? "A" : "B", i % 2 === 0 ? "blue" : "red");
  }
  const mixed = [s.people[10]!, ...first10.slice(1, 5), s.people[11]!, ...first10.slice(6)];
  for (let i = 0; i < 10; i++) await play(page.request, s, mixed, "A", i % 2 === 0 ? "red" : "blue");
  return s;
}

async function noHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "가로로 넘치지 않는다").toBeLessThanOrEqual(client);
}

/** 개인 통계의 마지막 구역이 "참여 경기"이고, 화면에서도 다른 구역보다 아래에 있다. */
async function playedIsLast(page: Page) {
  const regions = page.locator(".screen > section");
  const labels = await regions.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  expect(labels[labels.length - 1]).toBe("참여 경기");
  const boxes = await regions.evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { label: n.getAttribute("aria-label"), top: r.top, bottom: r.bottom };
    }),
  );
  const played = boxes.find((b) => b.label === "참여 경기")!;
  for (const b of boxes) {
    if (b.label === "참여 경기") continue;
    expect(played.top, `참여 경기가 ${b.label}보다 아래`).toBeGreaterThanOrEqual(b.bottom - 1);
  }
}

test.use({ viewport: { width: 390, height: 844 } });

test("랭킹은 누적 50경기 이상을 먼저, 개인 통계는 그림과 숫자를 함께, 참여 경기는 맨 아래", async ({
  page,
}) => {
  test.setTimeout(240000);
  const s = await build(page);

  // 랭킹: 승률 20%인 선수01(누적 50경기)이 100%인 선수11(누적 10경기)보다 위다.
  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  await expect(ranking.getByText("누적 50경기 이상인 사람을 먼저 보여줘요.")).toBeVisible();
  const rows = ranking.getByRole("listitem");
  await expect(rows).toHaveCount(12);
  const names = (await rows.allInnerTexts()).map((t) => t.match(/선수\d\d/)?.[0] ?? "");
  expect(names.indexOf("선수01")).toBeLessThan(names.indexOf("선수11"));
  expect(names.slice(-2)).toEqual(["선수11", "선수12"]);
  // 순위 숫자는 묶음을 넘어 이어진다.
  expect((await rows.allInnerTexts()).map((t) => Number(t.trim().split(/\s+/)[0]))).toEqual(
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  // 묶음이 바뀌는 자리에 소제목이 있다(순위 줄 수에는 섞이지 않는다).
  await expect(ranking.locator(".rank-group")).toHaveText(["누적 50경기 이상", "배치 완료 · 50경기 미만"]);
  // 경기 수·승수 기준에서도 묶음 순서는 그대로다.
  for (const sort of ["경기 수", "승수"]) {
    await ranking.getByRole("button", { name: sort, exact: true }).click();
    const n = (await rows.allInnerTexts()).map((t) => t.match(/선수\d\d/)?.[0] ?? "");
    expect(n.slice(-2).sort()).toEqual(["선수11", "선수12"]);
  }
  // 검색하면 소제목은 숨고 순위 숫자는 그대로다.
  await ranking.getByLabel("이름 검색").fill("선수11");
  await expect(rows).toHaveCount(1);
  await expect(ranking.locator(".rank-group")).toHaveCount(0);
  expect((await rows.first().innerText()).trim().split(/\s+/)[0]).toBe("11");
  await noHorizontalOverflow(page);

  // 검색 화면: 결과 줄에 작은 승률 막대와 숫자.
  await page.goto("/#/search");
  await page.getByRole("searchbox").fill("선수0");
  const results = page.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(results.first().locator(".meter")).toBeVisible();
  await expect(results.filter({ hasText: "선수01" })).toContainText("20%");
  await noHorizontalOverflow(page);

  // 개인 통계(선수02: 누적 60경기, 정글만, 20승 40패).
  await page.getByRole("searchbox").fill("선수02");
  await results.first().getByRole("button").click();
  await expect(page.getByRole("heading", { name: "선수02", level: 1 })).toBeVisible();
  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary.locator(".ring")).toBeVisible();
  await expect(summary.locator(".ring")).toContainText("33%");
  await expect(summary).toContainText("33% · 20승 40패 (60경기)");
  await expect(summary.locator(".ps-tiles .meter").first()).toBeVisible();
  // 라인 타일 두 개: 가장 많이 플레이한 라인 · 가장 승률 높은 라인(정글만 뛰어 같은 라인).
  const tile = (label: string) => summary.locator(".ps-tiles > div").filter({ hasText: label });
  await expect(summary.locator(".ps-tiles > div")).toHaveCount(4);
  await expect(tile("가장 많이 플레이한 라인")).toContainText("정글");
  await expect(tile("가장 많이 플레이한 라인")).toContainText("33% · 20승 40패 (60경기)");
  await expect(tile("가장 승률 높은 라인")).toContainText("정글");
  await expect(tile("가장 승률 높은 라인")).toContainText("33% · 20승 40패 (60경기)");
  await expect(summary).not.toContainText("주 라인");
  // 연속 기록은 요약 머리에 있다(예전 "지금" 타일).
  await expect(summary.locator(".ps-streak")).toContainText("10연승 중");

  const recent = page.getByRole("region", { name: "최근" });
  await expect(recent.locator(".wl-bar")).toHaveCount(2);
  // 최근 10경기는 선수11·12가 들어온 경기 → 선수02(팀 A) 10승.
  await expect(recent.getByRole("listitem").filter({ hasText: "최근 10경기" })).toContainText(
    "100% · 10승 0패 (10경기)",
  );

  const lines = page.getByRole("region", { name: "라인별" });
  await expect(lines.locator(".meters")).toHaveCount(5);
  const jungle = lines.getByRole("listitem").filter({ hasText: "정글" });
  await expect(jungle.locator(".meters")).toContainText("비중");
  await expect(jungle.locator(".meters")).toContainText("100%");
  await expect(jungle.locator(".meter-fill").first()).toBeVisible();
  // 기록 없는 라인은 빈 막대만 있고 숫자를 적지 않는다.
  const support = lines.getByRole("listitem").filter({ hasText: "서폿" });
  await expect(support).toContainText("기록 없음");
  await expect(support).not.toContainText("0%");
  await expect(support.locator(".meter")).toHaveCount(2);

  const sides = page.getByRole("region", { name: "진영별" });
  await expect(sides.locator(".meter-fill.tone-blue")).toHaveCount(1);
  await expect(sides.locator(".meter-fill.tone-red")).toHaveCount(1);
  await expect(sides.getByRole("listitem").filter({ hasText: "블루" })).toContainText("경기)");

  // 맞라인 상대: 선수02는 정글에서 선수07과만 60경기 맞붙었다(20승 40패). 후보가 한 명이고 33%라 "가장 어려운" 칩만.
  const laneRivalsRegion = page.getByRole("region", { name: "맞라인 상대" });
  await expect(laneRivalsRegion.locator(".lane-chip.hard")).toHaveText("가장 어려운 선수07 33% (60경기)");
  await expect(laneRivalsRegion.locator(".lane-chip.easy")).toHaveCount(0);
  await laneRivalsRegion.getByText("전체 보기").click();
  const rivalRow = laneRivalsRegion.getByRole("button", { name: /선수07/ });
  await expect(rivalRow).toContainText("20승 40패 (60경기)");
  await expect(rivalRow.locator(".meter")).toBeVisible();

  // 비교 지표: 선수02는 누적 60경기. 누적 10경기인 선수11·12는 같은 팀·상대 팀 목록과 동료·상대에서 빠진다.
  const synergy = page.getByRole("region", { name: "시너지" });
  await expect(synergy.getByRole("listitem").first().locator(".meter")).toBeVisible();
  await expect(synergy).toContainText("누적 30경기 이상인 사람만 보여줘요.");
  const pairNames = async (region: typeof synergy) =>
    (await region.getByRole("listitem").allInnerTexts()).map((t) => t.match(/선수\d\d/)?.[0]).sort();
  expect(await pairNames(synergy)).toEqual(["선수01", "선수03", "선수04", "선수05"]);
  const versus = page.getByRole("region", { name: "상대 전적" });
  await expect(versus.getByRole("listitem").first().locator(".meter")).toBeVisible();
  await expect(versus).toContainText("누적 30경기 이상인 사람만 보여줘요.");
  expect(await pairNames(versus)).toEqual(["선수06", "선수07", "선수08", "선수09", "선수10"]);
  await expect(tile("잘 맞는 동료")).not.toContainText("선수11");
  await expect(tile("잘 맞는 동료").getByRole("button")).toHaveText(/선수0[1345]/);
  await expect(tile("어려운 상대").getByRole("button")).toHaveText(/선수(0[6-9]|10)/);

  // 그림은 화면 읽기에서 숨기고 숫자를 읽힌다.
  expect(
    await page.locator(".meter, .wl-bar, .ring").evaluateAll((nodes) =>
      nodes.every((n) => n.getAttribute("aria-hidden") === "true"),
    ),
  ).toBe(true);

  await playedIsLast(page);
  await noHorizontalOverflow(page);

  const personUrl = page.url();
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 700 : 900 });
    await page.goto(personUrl);
    await expect(page.getByRole("region", { name: "요약" }).locator(".ring")).toBeVisible();
    await playedIsLast(page);
    await noHorizontalOverflow(page);
  }
  // 1440px에서는 2단이다: 최근과 라인별이 나란히 놓인다.
  const recentBox = await page.getByRole("region", { name: "최근" }).boundingBox();
  const linesBox = await page.getByRole("region", { name: "라인별" }).boundingBox();
  expect(Math.abs(recentBox!.y - linesBox!.y)).toBeLessThan(2);
  expect(linesBox!.x).toBeGreaterThan(recentBox!.x + recentBox!.width - 1);
  // 진영별은 최근 바로 아래 왼쪽 칸에 붙는다(키 큰 라인별 옆이 비지 않게).
  const sidesBox = await page.getByRole("region", { name: "진영별" }).boundingBox();
  expect(Math.abs(sidesBox!.x - recentBox!.x)).toBeLessThan(2);
  expect(sidesBox!.y).toBeLessThan(linesBox!.y + linesBox!.height);
  // 요약 타일 4개가 한 줄에 놓인다.
  const tileTops = await page
    .locator(".ps-tiles > div")
    .evaluateAll((nodes) => nodes.map((n) => Math.round(n.getBoundingClientRect().top)));
  expect(new Set(tileTops).size).toBe(1);

  // 누적 30경기 미만인 사람(선수11: 누적 10경기)은 비교 지표 자리에 안내만 보인다. 390·1440px.
  const few = s.people[10]!;
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/p/${few.id}`);
    await expect(page.getByRole("heading", { name: "선수11", level: 1 })).toBeVisible();
    const locked = "누적 30경기부터 보여줘요 (지금 10경기)";
    const fewSummary = page.getByRole("region", { name: "요약" });
    for (const label of ["잘 맞는 동료", "어려운 상대"]) {
      await expect(fewSummary.locator(".ps-tiles > div").filter({ hasText: label })).toContainText(locked);
    }
    // 라인 타일은 경기 수와 무관하게 보인다(선수11은 탑만 10경기).
    await expect(fewSummary.locator(".ps-tiles > div").filter({ hasText: "가장 승률 높은 라인" })).toContainText(
      "100% · 10승 0패 (10경기)",
    );
    for (const name of ["시너지", "상대 전적"]) {
      const region = page.getByRole("region", { name });
      await expect(region).toContainText(locked);
      await expect(region.getByRole("listitem")).toHaveCount(0);
    }
    await playedIsLast(page);
    await noHorizontalOverflow(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 320px: 랭킹·검색 화면도 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("region", { name: "소환사 랭킹" }).getByRole("listitem")).toHaveCount(12);
  await noHorizontalOverflow(page);
  await page.goto("/#/search");
  await page.getByRole("searchbox").fill("선수");
  await expect(page.getByRole("region", { name: "검색 결과" })).toBeVisible();
  await noHorizontalOverflow(page);

  // 스크린샷(선택): 세 테마 × 390·1440px.
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    for (const theme of ["dark", "violet", "light"]) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(personUrl);
        await page.evaluate((t) => {
          localStorage.setItem("naejeon.theme", t);
          document.documentElement.dataset.theme = t;
        }, theme);
        await expect(page.getByRole("region", { name: "요약" }).locator(".ring")).toBeVisible();
        // 버튼 배경색 전환(0.15초)이 끝난 뒤 찍는다.
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(dir, `person-${theme}-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto("/#/records");
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await page.getByRole("button", { name: "전체", exact: true }).click();
      await page.getByRole("region", { name: "소환사 랭킹" }).scrollIntoViewIfNeeded();
      await page
        .getByRole("region", { name: "소환사 랭킹" })
        .screenshot({ path: join(dir, `ranking-${theme}-390.png`) });
    }
  }

  // 함께 뛴 경기가 적은 짝은 누적 기준을 넘어도 "자료 적음"이다: 선수01·06이 처음으로 2경기 같은 팀.
  // (위 검사들이 끝난 뒤에 넣는다. 선수01의 시너지에서 선수06은 2경기 · 자료 적음, 선수03은 아니다.)
  const p = (n: number) => s.people[n - 1]!;
  const together = [p(1), p(6), p(3), p(4), p(5), p(2), p(7), p(8), p(9), p(10)];
  for (let i = 0; i < 2; i++) await play(page.request, s, together, "A", "blue");
  await page.goto(`/#/p/${p(1).id}`);
  // 주소의 # 뒤만 바뀌면 화면이 예전 자료를 쓰므로 새로 읽는다.
  await page.reload();
  await expect(page.getByRole("heading", { name: "선수01", level: 1 })).toBeVisible();
  const synergy01 = page.getByRole("region", { name: "시너지" });
  await expect(synergy01.getByRole("listitem").filter({ hasText: "선수06" })).toContainText("(2경기)");
  await expect(synergy01.getByRole("listitem").filter({ hasText: "선수06" })).toContainText("자료 적음");
  await expect(synergy01.getByRole("listitem").filter({ hasText: "선수03" })).not.toContainText("자료 적음");
});
