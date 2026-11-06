import { expect, test, type Locator, type Page } from "@playwright/test";

// 우선순위 배정 화면 → 준비 화면 "팀·라인 모두 섞기"(같은 순위끼리 양 팀에 나뉨) · "라인만 섞기"(팀원 그대로).

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `우선${String(i + 1).padStart(2, "0")}`);

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const team = (page: Page, t: "A" | "B") => page.getByRole("region", { name: `팀 ${t}` });
const rows = (box: Locator) => box.getByRole("list").first().getByRole("button");

async function members(page: Page, t: "A" | "B"): Promise<string[]> {
  return (await rows(team(page, t)).allInnerTexts()).map((text) => text.match(/우선\d\d/)![0]).sort();
}

test("우선순위 배정 → 팀·라인 모두 섞기 여러 번: 1순위 두 명은 매번 다른 팀, 라인만 섞기은 팀원 그대로", async ({ page }) => {
  test.setTimeout(120000);
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-priority-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { name: "우선순위 모임" } })).json()) as { id: string };
  expect((await page.request.post(`/api/groups/${group.id}/participants`, { data: { names } })).ok()).toBe(true);

  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  const tools = page.getByRole("region", { name: "섞기", exact: true });
  await expect(tools.getByRole("button", { name: "팀·라인 모두 섞기" })).toBeVisible();
  await expect(tools.getByRole("button", { name: "라인만 섞기", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "라인 섞기 + 서폿 돌아가며" })).toBeVisible();
  await noHorizontalOverflow(page);

  // 아직 아무도 정하지 않았으면 무작위로 나누고, 배정 화면으로 가는 링크를 남긴다.
  await tools.getByRole("button", { name: "팀·라인 모두 섞기" }).click();
  await expect(page.locator(".toast")).toHaveText("우선순위를 정한 사람이 없어 무작위로 나눴어요.");
  await expect(tools.getByRole("button", { name: "우선순위 배정하기" })).toBeVisible();
  await tools.getByRole("button", { name: "우선순위 배정하기" }).click();
  await expect(page.getByRole("heading", { name: "우선순위 배정" })).toBeVisible();

  // 배정: 1순위 2명, 2순위 2명, 3순위 2명, 4순위 3명, 1명 미지정.
  const plan: [string, string][] = [
    [names[0]!, "1순위"],
    [names[1]!, "1순위"],
    [names[2]!, "2순위"],
    [names[3]!, "2순위"],
    [names[4]!, "3순위"],
    [names[5]!, "3순위"],
    [names[6]!, "4순위"],
    [names[7]!, "4순위"],
    [names[8]!, "4순위"],
  ];
  for (const [name, label] of plan) {
    const button = page.getByRole("button", { name: `${name} ${label}`, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toBeEnabled();
  }
  const section = (label: string) => page.getByRole("region", { name: label, exact: true });
  await expect(section("1순위").getByRole("listitem")).toHaveCount(2);
  await expect(section("4순위").getByRole("listitem")).toHaveCount(3);
  // 미지정 칸: 이번 편성 1명 + 편성 밖 2명.
  await expect(section("미지정").getByRole("listitem")).toHaveCount(3);
  // 터치 대상 44px 이상, 390px 가로 넘침 없음.
  for (const b of await section("1순위").getByRole("button").all()) {
    const box = (await b.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
  // 다시 읽어도 저장돼 있다.
  await page.reload();
  await expect(section("1순위").getByRole("listitem")).toHaveCount(2);

  await page.getByRole("button", { name: "← 다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  // 팀·라인 모두 섞기 8번: 1순위 두 명·2순위 두 명은 매번 다른 팀, 4순위 세 명은 한 팀에 몰리지 않는다. 팀 구성은 한 번 이상 바뀐다.
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    await tools.getByRole("button", { name: "팀·라인 모두 섞기" }).click();
    await expect(page.locator(".toast")).toContainText("1순위 1:1 · 2순위 1:1 · 3순위 1:1");
    await expect(rows(team(page, "A"))).toHaveCount(5);
    await expect(rows(team(page, "B"))).toHaveCount(5);
    const a = await members(page, "A");
    expect(a.includes(names[0]!)).not.toBe(a.includes(names[1]!));
    expect(a.includes(names[2]!)).not.toBe(a.includes(names[3]!));
    const fourthInA = [names[6]!, names[7]!, names[8]!].filter((n) => a.includes(n)).length;
    expect(fourthInA === 1 || fourthInA === 2).toBe(true);
    seen.add(a.join(","));
  }
  expect(seen.size).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "직전 편성으로" })).toBeVisible();
  await noHorizontalOverflow(page);

  // 라인만 섞기: 팀원은 그대로 두고 라인만 섞는다.
  const keep = [await members(page, "A"), await members(page, "B")];
  for (let i = 0; i < 4; i++) {
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    expect([await members(page, "A"), await members(page, "B")]).toEqual(keep);
  }

  // 모임 탭에서도 배정 화면으로 갈 수 있고, 목록의 고르기 칸도 순위 이름을 쓴다.
  await page.goto("/#/group");
  await expect(page.getByRole("combobox", { name: `${names[0]}의 우선순위` })).toHaveValue("1");
  await page.getByRole("button", { name: "우선순위 배정", exact: true }).click();
  await expect(page.getByRole("heading", { name: "우선순위 배정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "← 다음 경기 준비" })).toBeVisible();
});
