import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 전적 사이트 화면: 경기 카드, 랭킹 정렬·라인, 기록 거르기, 두 사람 비교, 결과 이미지, 참가자 고르기 격자.
// 경기는 API로 빠르게 만들고 화면은 읽는 쪽만 본다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-c-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

/** 12명 모임을 만들고 순환을 끈다(같은 명단을 반복해서 쓰기 위해). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { name: "전적 사이트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { names });
  const snapshot = await getSnapshot(request, group.id);
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants };
}

/** 주어진 10명으로 한 경기를 시작하고 결과를 확정한다. 앞 5명이 팀 A이고 포지션은 탑→서폿 순서다. */
async function play(
  request: APIRequestContext,
  s: Setup,
  ten: { id: string }[],
  winnerTeam: "A" | "B",
  winnerSide: "blue" | "red" | "unknown",
) {
  const snapshot = await getSnapshot(request, s.groupId);
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
 * 11경기:
 * - 1~10경기: 선수01~05(팀 A) vs 선수06~10(팀 B). 팀 A가 1~7경기 승, 8~10경기 패.
 *   이긴 팀의 진영: 1~4 블루, 5~7 레드, 8~10 미상.
 * - 11경기: 선수11·02~05(팀 A) vs 선수12·07~10(팀 B). 팀 A 승, 블루.
 * 결과: 선수02~05 11경기 8승, 선수01 10경기 7승(3연패 중), 선수06 10경기 3승(3연승 중),
 *       선수07~10 11경기 3승, 선수11 1경기 1승, 선수12 1경기 0승.
 */
async function seed(page: Page): Promise<Setup> {
  const s = await setup(page);
  const p = s.people;
  const first10 = p.slice(0, 10);
  for (let i = 0; i < 10; i++) {
    await play(page.request, s, first10, i < 7 ? "A" : "B", i < 4 ? "blue" : i < 7 ? "red" : "unknown");
  }
  const mixed = [p[10]!, ...first10.slice(1, 5), p[11]!, ...first10.slice(6)];
  await play(page.request, s, mixed, "A", "blue");
  return s;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("경기 카드: 이름은 개인 통계로, 카드는 경기 상세로", async ({ page }) => {
  await seed(page);
  await page.goto("/#/records");
  const list = page.getByRole("region", { name: "경기 목록" });
  const cards = list.getByRole("listitem");
  await expect(cards).toHaveCount(11);

  // 맨 위 카드는 가장 최근 경기(11경기)이고 양 팀 10명의 이름이 보인다.
  const first = cards.first();
  await expect(first.getByRole("button").first()).toContainText("11경기 · 팀 A 승 · 블루");
  const winners = first.getByRole("group", { name: "팀 A 블루 승리" });
  const losers = first.getByRole("group", { name: "팀 B 레드 패배" });
  await expect(winners.getByRole("button")).toHaveCount(5);
  await expect(losers.getByRole("button")).toHaveCount(5);
  await expect(winners.getByRole("button").first()).toHaveText("선수11");
  // 이름 칸도 터치 대상 44px 이상이다.
  const heights = await first
    .getByRole("button")
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
  // 전체 목록의 색은 이긴 팀의 진영(블루)이다.
  await expect(first).toHaveClass(/tone-blue/);
  await expect(cards.nth(1)).toHaveClass(/tone-none/); // 10경기: 진영 미상

  // 이름 → 그 사람의 개인 통계
  await winners.getByRole("button", { name: "선수11" }).click();
  await expect(page).toHaveURL(/#\/p\//);
  await expect(page.getByRole("heading", { level: 1, name: "선수11" })).toBeVisible();

  // 카드 머리 → 경기 상세
  await page.goBack();
  await cards.first().getByRole("button", { name: /11경기 · 팀 A 승/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "11경기" })).toBeVisible();

  // 카드의 빈 곳(팀 표시 칸)을 눌러도 경기 상세로 간다.
  await page.goBack();
  await cards.nth(2).scrollIntoViewIfNeeded();
  const label = await cards.nth(2).locator(".mc-team-label").first().boundingBox();
  await page.mouse.click(label!.x + label!.width / 2, label!.y + label!.height / 2);
  await expect(page.getByRole("heading", { level: 1, name: "9경기" })).toBeVisible();

  // 개인 화면의 카드: 그 사람의 승패가 글자로 붙고 색은 승·패를 따른다.
  await page.goto("/#/records");
  await page.getByRole("region", { name: "소환사 랭킹" }).getByRole("button", { name: /선수01/ }).click();
  const mine = page.getByRole("region", { name: "참여 경기" }).getByRole("listitem");
  await expect(mine).toHaveCount(10);
  await expect(mine.first()).toHaveClass(/tone-loss/);
  await expect(mine.first().getByRole("button").first()).toContainText("패10경기");
  await expect(mine.last()).toHaveClass(/tone-win/);

  // 320px에서도 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 320, height: 640 });
  await noHorizontalOverflow(page);
  await page.goto("/#/records");
  await expect(cards).toHaveCount(11);
  await noHorizontalOverflow(page);
});

test("랭킹: 정렬 기준·라인별·최근 승패와 연승·연패", async ({ page }) => {
  await seed(page);
  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  const rows = ranking.getByRole("listitem");
  await expect(rows).toHaveCount(12);
  const names = async () =>
    (await rows.allInnerTexts()).map((t) => t.match(/선수\d\d/)?.[0] ?? "");

  // 승률(기본): 배치 완료 먼저 → 승률. 선수01(70%)은 5위.
  expect((await names()).slice(0, 6)).toEqual(["선수02", "선수03", "선수04", "선수05", "선수01", "선수06"]);
  await expect(rows.filter({ hasText: "선수01" })).toContainText("3연패 중");
  await expect(rows.filter({ hasText: "선수06" })).toContainText("3연승 중");
  // 최근 5경기 칸: 글자로 승·패를 쓴다(최근 것이 왼쪽). 선수01은 패패패승승.
  await expect(rows.filter({ hasText: "선수01" }).locator(".form-dot")).toHaveText(["패", "패", "패", "승", "승"]);

  // 경기 수: 11경기인 사람이 먼저. 선수01은 9위로 내려간다.
  await ranking.getByRole("button", { name: "경기 수", exact: true }).click();
  expect((await names()).slice(0, 10)).toEqual([
    "선수02",
    "선수03",
    "선수04",
    "선수05",
    "선수07",
    "선수08",
    "선수09",
    "선수10",
    "선수01",
    "선수06",
  ]);
  // 검색해도 순위 숫자는 그대로다.
  await ranking.getByLabel("이름 검색").fill("선수01");
  await expect(rows).toHaveCount(1);
  expect((await rows.first().innerText()).trim().split(/\s+/)[0]).toBe("9");
  await ranking.getByLabel("이름 검색").fill("");

  // 승수: 선수06(3승, 10경기)이 선수07(3승, 11경기)보다 승률이 높아 앞이다.
  await ranking.getByRole("button", { name: "승수", exact: true }).click();
  const byWins = await names();
  expect(byWins.indexOf("선수06")).toBeLessThan(byWins.indexOf("선수07"));
  expect(byWins.slice(-2)).toEqual(["선수11", "선수12"]); // 배치 진행 중은 뒤

  // 라인별: 탑으로 뛴 사람만(선수01·06 각 10경기, 선수11·12 각 1경기). 배치는 누적 기준이라 11·12는 뒤.
  await ranking.getByRole("button", { name: "승률", exact: true }).click();
  await ranking.getByLabel("라인별 랭킹").selectOption({ label: "탑" });
  await expect(ranking.getByRole("heading", { name: "소환사 랭킹 (전체 · 탑)" })).toBeVisible();
  await expect(rows).toHaveCount(4);
  expect(await names()).toEqual(["선수01", "선수06", "선수11", "선수12"]);
  await expect(rows.filter({ hasText: "선수01" })).toContainText("70% · 7승 3패 (10경기)");
  await expect(rows.filter({ hasText: "선수11" })).toContainText("배치 진행 중 1/10");
  await ranking.getByLabel("라인별 랭킹").selectOption({ label: "정글" });
  await expect(rows).toHaveCount(2);
  expect(await names()).toEqual(["선수02", "선수07"]);
  await noHorizontalOverflow(page);
});

test("기록 거르기: 사람(여러 명은 모두 함께)·승패·이긴 진영, 한 번에 지우기", async ({ page }) => {
  await seed(page);
  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const list = page.getByRole("region", { name: "경기 목록" });
  const cards = list.locator("li.match-card");
  await expect(cards).toHaveCount(11);
  // 사람을 고르기 전에는 라인·승패를 고를 수 없다.
  await expect(list.getByLabel("승패", { exact: true })).toHaveCount(0);

  await list.getByLabel("거를 사람 추가").selectOption({ label: "선수01" });
  await expect(cards).toHaveCount(10);
  const summary = list.getByRole("status");
  await expect(summary).toContainText("선수01 참가 · 10경기 · 선수01 7승 3패");

  // 두 번째 사람: 둘 다 뛴 경기만. 선수01과 선수11은 함께 뛴 적이 없다.
  await list.getByLabel("거를 사람 추가").selectOption({ label: "선수11" });
  await expect(cards).toHaveCount(0);
  await expect(list.getByText("조건에 맞는 경기가 없어요.")).toBeVisible();
  await list.getByRole("button", { name: "선수11 조건 빼기" }).click();
  await expect(cards).toHaveCount(10);

  // 승패(첫 사람 기준)
  await list.getByLabel("승패", { exact: true }).selectOption({ label: "패" });
  await expect(cards).toHaveCount(3);
  await expect(summary).toContainText("선수01 참가 · 선수01 패 · 3경기");
  // 라인
  await list.getByLabel("라인", { exact: true }).selectOption({ label: "정글" });
  await expect(cards).toHaveCount(0);
  await list.getByLabel("라인", { exact: true }).selectOption({ label: "탑" });
  await expect(cards).toHaveCount(3);

  // 한 번에 지우기
  await list.getByRole("button", { name: "조건 지우기" }).click();
  await expect(cards).toHaveCount(11);
  await expect(summary).toHaveCount(0);

  // 이긴 진영만으로도 거른다. 선수02 + 블루 승 = 5경기, 5승 0패.
  await list.getByLabel("이긴 진영").selectOption({ label: "블루 승" });
  await expect(cards).toHaveCount(5);
  await list.getByLabel("이긴 진영").selectOption({ label: "진영 미상" });
  await expect(cards).toHaveCount(3);
  await list.getByLabel("이긴 진영").selectOption({ label: "블루 승" });
  await list.getByLabel("거를 사람 추가").selectOption({ label: "선수02" });
  await expect(cards).toHaveCount(5);
  await expect(summary).toContainText("선수02 참가 · 블루 승 · 5경기 · 선수02 5승 0패");
  // 고른 사람이 한 명이면 카드는 그 사람 기준 승·패 색이다.
  await expect(cards.first()).toHaveClass(/tone-win/);
  await noHorizontalOverflow(page);
});

test("두 사람 비교: 개인 통계·검색에서 들어가고 조회 링크에서도 열린다", async ({ page }) => {
  const s = await seed(page);
  const id = (n: number) => s.people[n - 1]!.id;

  // 개인 통계 → 비교 → 두 번째 사람 고르기
  await page.goto(`/#/p/${id(2)}`);
  await page.getByRole("button", { name: "다른 사람과 비교" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "두 사람 비교" })).toBeVisible();
  await page.getByLabel("두 번째 사람").selectOption({ label: "선수07" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("선수02 vs 선수07");
  const side = page.getByRole("region", { name: "나란히 보기" });
  await expect(side.getByRole("row").filter({ hasText: "승률" })).toContainText("73%");
  await expect(side.getByRole("row").filter({ hasText: "승률" })).toContainText("27%");
  const against = page.getByRole("region", { name: "상대일 때" });
  await expect(against).toContainText("선수02 8승 : 3승 선수07");
  await expect(page.getByRole("region", { name: "같은 팀일 때" })).toContainText("같은 팀으로 뛴 경기가 없어요.");
  const lines = page.getByRole("region", { name: "라인별 승률 비교" });
  await expect(lines.getByRole("row").filter({ hasText: "정글" })).toContainText("8승 3패 · 11경기");
  // 맞대결 경기 목록(경기 카드): 최근 10개를 먼저 그리고 "더 보기"로 11개. 첫 카드는 선수02 기준 승.
  const gameList = page.getByRole("region", { name: "맞대결 경기" });
  const games = gameList.getByRole("listitem");
  await expect(games).toHaveCount(10);
  await gameList.getByRole("button", { name: "나머지 1경기 중 1경기 더 보기" }).click();
  await expect(games).toHaveCount(11);
  await expect(games.first()).toHaveClass(/tone-win/);

  // 같은 팀: 선수02와 선수03은 11경기 모두 같은 팀(8승 3패)
  await page.getByLabel("두 번째 사람").selectOption({ label: "선수03" });
  await expect(page.getByRole("region", { name: "같은 팀일 때" })).toContainText("73% · 8승 3패 (11경기)");
  await page.getByRole("button", { name: "같은 팀 11" }).click();
  await expect(games).toHaveCount(10);
  await gameList.getByRole("button", { name: /더 보기/ }).click();
  await expect(games).toHaveCount(11);
  await noHorizontalOverflow(page);

  // 검색 → 두 사람 비교
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "검색" }).click();
  await page.getByRole("button", { name: "두 사람 비교" }).click();
  await page.getByRole("searchbox").fill("선수01");
  await page.getByRole("region", { name: "검색 결과" }).getByRole("button").click();
  await page.getByRole("searchbox").fill("선수06");
  await page.getByRole("region", { name: "검색 결과" }).getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("선수01 vs 선수06");
  await expect(page.getByRole("region", { name: "상대일 때" })).toContainText("선수01 7승 : 3승 선수06");

  // 조회 링크에서도 같은 화면
  const snapshot = await getSnapshot(page.request, s.groupId);
  await page.goto(`/#/v/${snapshot.group.viewToken}/compare/${id(2)}/${id(7)}`);
  await expect(page.getByRole("region", { name: "상대일 때" })).toContainText("선수02 8승 : 3승 선수07");
  await page.setViewportSize({ width: 320, height: 640 });
  await noHorizontalOverflow(page);
});

test("홈 요약과 결과 이미지(PNG)", async ({ page }, testInfo) => {
  await seed(page);
  await page.goto("/#/");
  // 운영 흐름은 위에 그대로, 아래에 랭킹 상위·요즘 흐름.
  await expect(page.getByRole("heading", { name: "오늘의 결과 · 11경기 확정" })).toBeVisible();
  const top = page.getByRole("region", { name: "랭킹 상위" }).getByRole("listitem");
  await expect(top).toHaveCount(5);
  await expect(top.first()).toContainText("선수02");
  const flow = page.getByRole("region", { name: "요즘 흐름" });
  await expect(flow).toContainText("선수06");
  await expect(flow).toContainText("3연승 중");
  // 최근 10경기를 채운 사람만 최근 승률에 들어간다(선수11·12는 1경기라 빠진다).
  await expect(flow).not.toContainText("선수11");

  // 오늘의 결과 이미지
  await page.getByRole("button", { name: "결과 이미지" }).click();
  const dialog = page.getByRole("dialog", { name: "오늘의 결과 이미지" });
  await expect(dialog.getByRole("img")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "내려받기" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^오늘의결과-\d{4}-\d{2}-\d{2}\.png$/);
  const path = testInfo.outputPath("today.png");
  await download.saveAs(path);
  const png = await readFile(path);
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(png.readUInt32BE(16)).toBe(1080); // 너비
  expect(png.length).toBeGreaterThan(20_000);
  await dialog.getByRole("button", { name: "닫기" }).click();

  // 경기 한 건 이미지
  await page.goto("/#/records");
  await page.getByRole("region", { name: "경기 목록" }).getByRole("button", { name: /11경기 · 팀 A 승/ }).click();
  await page.getByRole("button", { name: "결과 이미지" }).click();
  const matchDialog = page.getByRole("dialog", { name: "11경기 결과 이미지" });
  await expect(matchDialog.getByRole("img")).toBeVisible();
  const second = page.waitForEvent("download");
  await matchDialog.getByRole("button", { name: "내려받기" }).click();
  const matchPng = await readFile(await (await second).path());
  expect(matchPng.subarray(1, 4).toString("ascii")).toBe("PNG");
  expect(matchPng.length).toBeGreaterThan(20_000);
});

test("참가자 고르기: 넓은 화면은 여러 열, 정렬, 10명 골라 팀 짜기", async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  const items = all.getByRole("listitem");
  await expect(items).toHaveCount(12);
  // 여러 열: 첫 두 칸이 같은 줄에 있다.
  const a = await items.nth(0).boundingBox();
  const b = await items.nth(1).boundingBox();
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);

  // 기본은 최근 참가 순(docs/P2 P2-11): 마지막 경기에 나온 사람이 먼저다.
  await expect(all.getByRole("button", { name: "최근 참가 순" })).toHaveAttribute("aria-pressed", "true");
  // 마지막(11번째) 경기에 빠진 선수01·선수06이 맨 뒤 두 칸이다.
  const recentOrder = await items.allInnerTexts();
  expect(recentOrder.slice(10).join(" ")).toMatch(/선수01[\s\S]*선수06|선수06[\s\S]*선수01/);
  expect(recentOrder.slice(0, 10).join(" ")).not.toMatch(/선수01|선수06/);
  // 자주 나온 순: 11경기인 선수02가 먼저, 누적 경기 수와 최근 참가가 보인다.
  await all.getByRole("button", { name: "자주 나온 순" }).click();
  await expect(items.first()).toContainText("선수02");
  await expect(items.first()).toContainText("11경기 · 이번 세션 참가");
  await all.getByRole("button", { name: "이름 순" }).click();
  await expect(items.first()).toContainText("선수01");
  await expect(items.first()).toContainText("10경기");

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    await all.getByRole("button", { name: new RegExp(`선수${String(n).padStart(2, "0")}`) }).click();
  }
  await expect(page.getByText("10/10", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
});
