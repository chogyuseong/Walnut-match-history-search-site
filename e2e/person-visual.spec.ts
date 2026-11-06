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
  const group = await post(request, "/api/groups", { name: "그림 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { names });
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

  const synergy = page.getByRole("region", { name: "시너지" });
  await expect(synergy.getByRole("listitem").first().locator(".meter")).toBeVisible();
  const versus = page.getByRole("region", { name: "상대 전적" });
  await expect(versus.getByRole("listitem").first().locator(".meter")).toBeVisible();

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
    for (const theme of ["dark", "deeplol", "light"]) {
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
  void s;
});
