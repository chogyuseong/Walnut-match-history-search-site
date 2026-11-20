import { expect, test, type Locator, type Page } from "@playwright/test";

// 최고의 콤비(shared/bestCombos.ts): 두 사람 비교·개인 통계·그래프 분석·팀 짜기에 같은 배지가 붙는다.
// 지난 경기 120판을 test/bestCombos.test.ts와 같은 모양으로 넣는다: 콤비01·콤비02가 같은 팀이면 90%, 따로면 반반.

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `콤비${String(i + 1).padStart(2, "0")}`);
const BLOCK = 40;
const SHOTS_DIR = process.env.SHOTS_DIR;

/** SHOTS_DIR을 줄 때만 그 구역 사진을 남긴다(눈으로 볼 기록, 검사 아님). */
async function shot(area: Locator, name: string) {
  if (SHOTS_DIR) await area.screenshot({ path: `${SHOTS_DIR}/${name}.png` });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 준비 화면에서 사람 이름 → 팀 상자("블루팀"/"레드팀"). */
async function teamsOf(page: Page): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const team of ["블루팀", "레드팀"]) {
    const texts = await page.getByRole("region", { name: team }).getByRole("list").first().getByRole("button").allInnerTexts();
    for (const t of texts) result.set(t.match(/콤비\d\d/)![0], team);
  }
  return result;
}

const row = (page: Page, name: string) => page.locator(".teams").getByRole("button").filter({ hasText: name });

test("최고의 콤비: 비교·개인 통계·그래프 분석에 배지, 팀 짜기에서 같은 팀이면 두 이름 옆에", async ({ page }) => {
  test.setTimeout(240000);
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-combo-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "콤비 모임" } })).json()) as {
    id: string;
  };
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names } });
  const ids = ((await ensured.json()) as { participants: { id: string; name: string }[] }).participants.map((p) => p.id);

  const blocks: [number[], number[], (i: number) => "A" | "B"][] = [
    [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], (i) => (i % 10 === 0 ? "B" : "A")],
    [[0, 2, 3, 4, 9], [1, 5, 6, 7, 8], (i) => (i % 2 === 0 ? "A" : "B")],
    [[1, 2, 3, 4, 5], [0, 6, 7, 8, 9], (i) => (i % 2 === 0 ? "A" : "B")],
  ];
  let n = 0;
  for (const [teamA, teamB, winner] of blocks) {
    for (let i = 0; i < BLOCK; i++) {
      n += 1;
      const res = await page.request.post(`/api/groups/${group.id}/matches/backfill`, {
        data: {
          requestId: `seed-${Date.now().toString(36)}-${n}-${Math.floor(Math.random() * 1e6)}`,
          playedAt: new Date(Date.now() - (200 - n) * 3600_000).toISOString(),
          roster: [
            ...teamA.map((k) => ({ participantId: ids[k], team: "A", position: null })),
            ...teamB.map((k) => ({ participantId: ids[k], team: "B", position: null })),
          ],
          winnerTeam: winner(i),
          winnerSide: "unknown",
        },
      });
      expect(res.ok()).toBe(true);
    }
  }

  // ---------- 두 사람 비교: 같은 팀일 때 두 이름 옆
  await page.goto(`/#/compare/${ids[0]}/${ids[1]}`);
  const together = page.getByRole("region", { name: "같은 팀일 때" });
  await expect(together.locator(".combo-tag")).toHaveText("최고의 콤비");
  await together.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await shot(together, "combo-compare");
  // 콤비가 아닌 짝에는 없다.
  await page.goto(`/#/compare/${ids[0]}/${ids[2]}`);
  await expect(page.getByRole("region", { name: "같은 팀일 때" })).toContainText("콤비01");
  await expect(page.getByRole("region", { name: "같은 팀일 때" }).locator(".combo-tag")).toHaveCount(0);

  // ---------- 개인 통계: 잘 맞는 동료 타일
  await page.goto(`/#/p/${ids[0]}`);
  const facts = page.getByRole("region", { name: "세부 기록" });
  await expect(facts).toContainText("콤비02");
  await expect(facts.locator(".combo-tag")).toHaveText("최고의 콤비");
  await facts.scrollIntoViewIfNeeded();
  await noHorizontalOverflow(page);
  await shot(facts, "combo-person");

  // ---------- 그래프 분석: 고른 플레이어
  await page.goto(`/#/graphs/${ids[1]}`);
  const profile = page.getByRole("region", { name: "고른 플레이어" });
  await expect(profile.locator(".combo-line")).toContainText("콤비01");
  await expect(profile.locator(".combo-line")).toContainText("같은 팀 90% (40경기) · 두 사람 평균보다 +27%p");
  await noHorizontalOverflow(page);
  await shot(profile, "combo-graphs");

  // ---------- 팀 짜기: 같은 팀이면 두 이름 옆에 "콤비"
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  let teams = await teamsOf(page);
  if (teams.get("콤비01") !== teams.get("콤비02")) {
    // 다른 팀이면 배지가 없다. 콤비02를 콤비01 팀의 다른 사람과 바꿔 같은 팀으로 만든다.
    await expect(page.locator(".teams .combo-tag")).toHaveCount(0);
    const mate = [...teams].find(([name, team]) => team === teams.get("콤비01") && name !== "콤비01")![0];
    await row(page, "콤비02").click();
    await row(page, mate).click();
    teams = await teamsOf(page);
    expect(teams.get("콤비01")).toBe(teams.get("콤비02"));
  }
  // 좁은 줄이라 보이는 글자는 "콤비"이고, 낭독기에는 숨은 글자로 전체 이름을 읽힌다.
  for (const name of ["콤비01", "콤비02"]) {
    await expect(row(page, name).locator(".combo-tag [aria-hidden]")).toHaveText("콤비");
    await expect(row(page, name).locator(".combo-tag .sr-only")).toHaveText("최고의 콤비");
  }
  await expect(page.locator(".teams .combo-tag")).toHaveCount(2);
  await noHorizontalOverflow(page);
  await shot(page.locator(".teams"), "combo-prep");
});
