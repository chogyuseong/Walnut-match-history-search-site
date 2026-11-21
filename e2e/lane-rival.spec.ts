import { expect, test, type Page } from "@playwright/test";

// 팀 짜기 "어려운 상대" 배지(prep/rivalMarks.ts): 맞은편 개인 통계에서 그 라인 가장 어려운 상대로 뜨는 강한 쪽에만.
// 지난 경기 40판: 어려01(탑)은 늘 어려06(탑)을 만나 4판에 1승. 나머지 넷은 앞 20판과 뒤 20판에서 팀을 맞바꿔
// 맞라인 상대와 정확히 반반(50%)이 되게 해서 배지가 어려06 한 사람에게만 붙는다.

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 10 }, (_, i) => `어려${String(i + 1).padStart(2, "0")}`);
const POSITIONS = ["top", "jungle", "mid", "adc", "support"] as const;
const BLOCK = 20;
const SHOTS_DIR = process.env.SHOTS_DIR;

const row = (page: Page, name: string) => page.locator(".teams").getByRole("button").filter({ hasText: name });
const topRow = (page: Page, team: string) => page.getByRole("region", { name: team }).getByRole("listitem").first().getByRole("button");

test("어려운 상대: 탑 맞라인에서 4판 3승인 강한 쪽에만 배지, 자리를 바꾸면 사라진다", async ({ page }) => {
  test.setTimeout(240000);
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-rival-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "맞라인 모임" } })).json()) as {
    id: string;
  };
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names } });
  const ids = ((await ensured.json()) as { participants: { id: string; name: string }[] }).participants.map((p) => p.id);

  // 블록마다 [블루 다섯(탑~서폿), 레드 다섯(탑~서폿)]. 탑은 늘 어려01(블루) 대 어려06(레드), 블루는 4판에 1승.
  const blocks: [number[], number[]][] = [
    [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]],
    [[0, 6, 7, 8, 9], [5, 1, 2, 3, 4]],
  ];
  let n = 0;
  for (const [blue, red] of blocks) {
    for (let i = 0; i < BLOCK; i++) {
      n += 1;
      const res = await page.request.post(`/api/groups/${group.id}/matches/backfill`, {
        data: {
          requestId: `seed-${Date.now().toString(36)}-${n}-${Math.floor(Math.random() * 1e6)}`,
          playedAt: new Date(Date.now() - (100 - n) * 3600_000).toISOString(),
          roster: [
            ...blue.map((k, p) => ({ participantId: ids[k], team: "A", position: POSITIONS[p] })),
            ...red.map((k, p) => ({ participantId: ids[k], team: "B", position: POSITIONS[p] })),
          ],
          winnerTeam: i % 4 === 0 ? "A" : "B",
          winnerSide: "unknown",
        },
      });
      expect(res.ok()).toBe(true);
    }
  }

  // ---------- 기록: 경기 카드 위 줄에 "어려운 상대 탑 어려06", 경기 상세에서는 어려06 이름 옆에 배지
  await page.goto("/#/records");
  const firstCard = page.locator(".match-card").first();
  await expect(firstCard.locator(".mc-rivals")).toContainText("어려운 상대");
  await expect(firstCard.locator(".mc-rivals-who")).toHaveText("탑 어려06");
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS_DIR) await firstCard.screenshot({ path: `${SHOTS_DIR}/lane-rival-card.png` });
  await firstCard.locator(".mc-main").click();
  const strongRow = page.locator(".teams li").filter({ hasText: "어려06" });
  await expect(strongRow.locator(".rival-tag")).toHaveAttribute(
    "title",
    "어려01 상대로 탑 맞라인 30승 10패 · 어려01에게 이 라인에서 가장 어려운 상대 (지금까지 누적 기준)",
  );
  await expect(page.locator(".teams .rival-tag")).toHaveCount(1);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS_DIR) await page.locator(".teams").screenshot({ path: `${SHOTS_DIR}/lane-rival-detail.png` });

  // ---------- 검색에서 들어가는 개인 통계의 참여 경기 카드에도 같은 줄
  await page.goto(`/#/p/${ids[0]}`);
  const personCard = page.getByRole("region", { name: /참여 경기/ }).locator(".match-card").first();
  await expect(personCard.locator(".mc-rivals-who")).toHaveText("탑 어려06");
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  // 섞기 결과는 매번 다르므로 어려01을 블루 탑, 어려06을 레드 탑으로 옮긴다(두 사람을 차례로 누르면 자리가 바뀐다).
  for (const [name, team] of [["어려01", "블루팀"], ["어려06", "레드팀"]] as const) {
    if ((await topRow(page, team).innerText()).includes(name)) continue;
    await row(page, name).click();
    await topRow(page, team).click();
    await expect(topRow(page, team)).toContainText(name);
  }

  const badges = page.locator(".teams .tag", { hasText: "어려운 상대" });
  await expect(badges).toHaveCount(1);
  await expect(row(page, "어려06").locator(".tag", { hasText: "어려운 상대" })).toHaveAttribute(
    "title",
    "어려01 상대로 탑 맞라인 30승 10패 · 어려01에게 이 라인에서 가장 어려운 상대",
  );
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS_DIR) await page.locator(".teams").screenshot({ path: `${SHOTS_DIR}/lane-rival-prep.png` });

  // 어려06을 레드 정글과 바꾸면 탑에서 마주 서지 않으니 배지가 사라진다.
  await row(page, "어려06").click();
  await page.getByRole("region", { name: "레드팀" }).getByRole("listitem").nth(1).getByRole("button").click();
  await expect(badges).toHaveCount(0);
});
