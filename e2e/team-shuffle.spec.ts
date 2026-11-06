import { expect, test, type Locator, type Page } from "@playwright/test";

// 준비 화면의 팀 섞기 2종(올랜덤, 올랜덤 + 서포터 공평하게), 서포터만 바꾸기, 서포터 횟수 초기화, 진영 고르기.

test.use({ viewport: { width: 390, height: 844 } });

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

/** 로그인하고 12명 모임을 만든 뒤 참가자 고르기에서 앞 10명으로 준비 화면을 연다. */
async function openPrep(page: Page, prefix: string): Promise<string[]> {
  const login = await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser(prefix) } });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { name: "섞기 모임" } })).json()) as { id: string };
  const names = Array.from({ length: 12 }, (_, i) => `섞기${String(i + 1).padStart(2, "0")}`);
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { names } });
  expect(ensured.ok()).toBe(true);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  return names;
}

async function startMatch(page: Page) {
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const heading = page.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(heading)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
  await expect(heading).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const rows = (team: Locator) => team.getByRole("list").first().getByRole("button");

test("올랜덤 → 진영 고르기 → 시작하면 진행 화면에 진영이 보이고 결과 입력 창에 미리 골라져 있다", async ({ page }) => {
  await openPrep(page, "e2e-shuffle");
  const teamA = page.getByRole("region", { name: "팀 A" });
  const tools = page.getByRole("region", { name: "섞기" });
  await expect(tools.getByRole("button", { name: "팀 확정 올랜덤", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "팀 확정 올랜덤 + 서포터 공평하게" })).toBeVisible();
  await expect(tools.getByRole("button", { name: "서포터만 바꾸기" })).toBeVisible();
  await noHorizontalOverflow(page);

  // 올랜덤을 여러 번 눌러도 늘 5:5이고 팀원은 그대로다(라인만 섞는다). 한 번은 라인이 달라진다.
  const before = await rows(teamA).allInnerTexts();
  const members = (texts: string[]) => texts.map((t) => t.match(/섞기\d\d/)![0]).sort();
  let changed = false;
  for (let i = 0; i < 5; i++) {
    await tools.getByRole("button", { name: "팀 확정 올랜덤", exact: true }).click();
    await expect(rows(teamA)).toHaveCount(5);
    await expect(rows(page.getByRole("region", { name: "팀 B" }))).toHaveCount(5);
    const now = await rows(teamA).allInnerTexts();
    expect(members(now)).toEqual(members(before));
    if (JSON.stringify(now) !== JSON.stringify(before)) changed = true;
  }
  expect(changed).toBe(true);
  // "포지션 다시 뽑기"는 올랜덤과 같은 일이라 없앴다.
  await expect(page.getByRole("button", { name: "포지션 다시 뽑기" })).toHaveCount(0);
  // 직전 편성으로 되돌릴 수 있다.
  await expect(page.getByRole("button", { name: "직전 편성으로" })).toBeVisible();

  // 진영: 팀 A 레드. 팀 상자에 진영이 보인다.
  const sides = page.getByRole("region", { name: "진영" });
  await sides.getByRole("radio", { name: "팀 A 레드" }).check();
  await expect(teamA.getByRole("heading")).toContainText("레드");
  await expect(page.getByRole("region", { name: "팀 B" }).getByRole("heading")).toContainText("블루");
  // 좌우 바꾸기: 진영은 팀을 따라간다(지금 팀 A였던 사람들은 계속 레드 → 이름표가 B로 바뀐다).
  const redTeam = await rows(teamA).allInnerTexts();
  await page.getByRole("button", { name: "좌우 바꾸기" }).click();
  const teamB = page.getByRole("region", { name: "팀 B" });
  expect(await rows(teamB).allInnerTexts()).toEqual(redTeam);
  await expect(teamB.getByRole("heading")).toContainText("레드");
  await expect(sides.getByRole("radio", { name: "팀 A 블루" })).toBeChecked();
  await noHorizontalOverflow(page);

  await startMatch(page);
  // 진행 화면: 팀 A 블루 / 팀 B 레드.
  await expect(page.getByRole("region", { name: "팀 A" }).getByRole("heading")).toContainText("블루");
  await expect(page.getByRole("region", { name: "팀 B" }).getByRole("heading")).toContainText("레드");

  // 결과 입력: 승리 팀을 고르면 그 팀의 진영이 미리 골라져 있고 바꿀 수 있다.
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  await sheet.getByRole("radio", { name: /팀 B/ }).check();
  await expect(sheet.getByRole("radio", { name: "레드" })).toBeChecked();
  await expect(sheet.getByText("시작할 때 고른 진영으로 미리 골라 뒀어요.")).toBeVisible();
  await sheet.getByRole("radio", { name: /팀 A/ }).check();
  await expect(sheet.getByRole("radio", { name: "블루" })).toBeChecked();
  await sheet.getByRole("radio", { name: "기억나지 않음" }).check();
  await sheet.getByRole("radio", { name: "블루" }).check();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 팀 A 승 · 블루")).toBeVisible();
});

test("올랜덤 + 서포터 공평하게 → 시작 → 결과 → 다음 준비에 '서폿 1회' → 서포터만 바꾸기는 0회인 사람 → 초기화는 아직 꺼짐", async ({
  page,
}) => {
  await openPrep(page, "e2e-fair");
  const tools = page.getByRole("region", { name: "섞기" });
  await tools.getByRole("button", { name: "팀 확정 올랜덤 + 서포터 공평하게" }).click();
  await expect(page.getByText("팀마다 서포터를 아직 안 간 사람으로 정했어요.")).toBeVisible();
  // 처음에는 아무도 서포터를 하지 않았다.
  await expect(page.getByText(/서폿 \d회/)).toHaveCount(0);
  const teams = [page.getByRole("region", { name: "팀 A" }), page.getByRole("region", { name: "팀 B" })];
  // 각 팀의 다섯째 줄이 서포터 자리다(탑~서포터 순).
  const supporterNames = await Promise.all(teams.map((t) => rows(t).nth(4).innerText()));

  await startMatch(page);
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  await sheet.getByRole("radio", { name: /팀 A/ }).check();
  await sheet.getByRole("radio", { name: "블루" }).check();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨")).toBeVisible();
  await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  // 방금 서포터였던 두 사람에게 "서폿 1회"가 붙는다(팀 상자 안).
  const teamRows = page.locator(".teams").getByRole("button");
  await expect(teamRows.filter({ hasText: "서폿 1회" })).toHaveCount(2);
  const counted = await teamRows.filter({ hasText: "서폿 1회" }).allInnerTexts();
  for (const shown of supporterNames) {
    const name = shown.split("\n").map((x) => x.trim()).filter((x) => /^섞기\d\d$/.test(x))[0]!;
    expect(counted.some((t) => t.includes(name))).toBe(true);
  }

  // 서포터만 바꾸기: 팀마다 서포터가 0회인 사람이 된다(나머지 8명은 그대로).
  await page.getByRole("region", { name: "섞기" }).getByRole("button", { name: "서포터만 바꾸기" }).click();
  for (const team of teams) {
    await expect(rows(team).nth(4)).not.toContainText(/서폿 \d회/);
  }

  // 서포터 횟수 보기: 두 사람 1회. 아직 안 간 사람이 팀마다 있어 초기화 버튼은 꺼져 있고 이유를 글로 보여준다.
  // (모두 배정받은 팀이 생겼을 때 켜지고 누르면 다시 꺼지는 흐름은 scenarios.spec.ts 21번에서 본다.)
  await page.getByText(/^서포터 횟수: 2명 기록/).click();
  const list = page.getByRole("list", { name: "서포터 횟수 목록" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "서포터 횟수 초기화" })).toBeDisabled();
  await expect(page.getByText("아직 서포터를 안 간 사람이 있어요.", { exact: false })).toBeVisible();
});
