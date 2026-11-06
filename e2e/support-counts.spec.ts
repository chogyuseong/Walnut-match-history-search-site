import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 서포터 횟수 직접 입력(준비 화면). 첫 경기 전(내전·주기 없음) 상태에서 한다.
// PREP_SHOTS 환경 변수를 주면 편집기 스크린샷(390·1440px × 다크·라이트)을 남긴다.
// 두 사람을 올림 → "서폿 N회" 표시 → 서포터만 바꾸기가 그 사람들을 피함 → 한 팀을 모두 1 이상으로 → 알림·초기화 버튼 → 초기화 후 0.

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `횟수${String(i + 1).padStart(2, "0")}`);

async function openPrep(page: Page) {
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-counts-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { name: "횟수 모임" } })).json()) as { id: string };
  expect((await page.request.post(`/api/groups/${group.id}/participants`, { data: { names } })).ok()).toBe(true);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  return group.id;
}

/** 준비 화면의 팀 상자. 팀 A는 블루팀, 팀 B는 레드팀이다. */
const team = (page: Page, t: "A" | "B") => page.getByRole("region", { name: t === "A" ? "블루팀" : "레드팀" });
const rows = (box: Locator) => box.getByRole("list").first().getByRole("button");
async function teamNames(page: Page, t: "A" | "B") {
  return (await rows(team(page, t)).allInnerTexts()).map((x) => x.match(/횟수\d\d/)![0]);
}

test("첫 경기 전에 서포터 횟수를 직접 넣고, 서포터만 바꾸기·알림·초기화가 그 값을 따른다", async ({ page }) => {
  const gid = await openPrep(page);
  const editor = page.getByRole("list", { name: "이번 편성 서포터 횟수" });
  const save = page.getByRole("button", { name: /^서포터 횟수 저장/ });
  const reset = page.getByRole("button", { name: "서포터 횟수 초기화" });

  // 아직 내전을 시작하지 않았다.
  const snap0 = await (await page.request.get(`/api/groups/${gid}/snapshot`)).json();
  expect(snap0.session).toBeNull();

  await page.getByText(/^서포터 횟수: /).click();
  await expect(editor.getByRole("listitem")).toHaveCount(10);
  await expect(reset).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("아직 서포터를 안 간 사람이 있어요");
  await expect(save).toBeDisabled();

  // 팀 A의 탑·정글 두 사람을 1회, 2회로 올린다(＋ 버튼과 숫자 칸 직접 입력).
  const a = await teamNames(page, "A");
  const [top, jungle, , , supporter] = a;
  await page.getByRole("button", { name: `${top} 서포터 횟수 늘리기` }).click();
  await page.getByRole("spinbutton", { name: `${jungle} 서포터 횟수` }).fill("2");
  await expect(save).toHaveText("서포터 횟수 저장 (2명)");
  await save.click();
  await expect(page.locator(".toast")).toHaveText("서포터 횟수를 저장했어요.");
  await expect(rows(team(page, "A")).filter({ hasText: top! })).toContainText("서폿 1회");
  await expect(rows(team(page, "A")).filter({ hasText: jungle! })).toContainText("서폿 2회");
  await expect(save).toBeDisabled();
  await expect(reset).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("아직 서포터를 안 간 사람이 있어요");
  const dir = process.env.PREP_SHOTS;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.getByRole("button", { name: `${supporter} 서포터 횟수 늘리기` }).click(); // 고치는 중 표시
    for (const theme of ["dark", "light"]) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
        // 버튼 배경색 전환(0.15초)이 끝난 뒤 찍는다.
        await page.waitForTimeout(300);
        await editor.scrollIntoViewIfNeeded();
        await page.locator(".count-editor").screenshot({ path: join(dir, `08-count-editor-${theme}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
    await page.getByRole("button", { name: "고친 값 되돌리기" }).click();
  }

  // 서포터만 바꾸기: 팀 A의 새 서포터는 0회인 사람(탑·정글·지금 서포터가 아님).
  await page.getByRole("region", { name: "섞기" }).getByRole("button", { name: "서포터만 바꾸기" }).click();
  const afterDraw = await teamNames(page, "A");
  expect([top, jungle, supporter]).not.toContain(afterDraw[4]);
  await expect(rows(team(page, "A")).nth(4)).not.toContainText(/서폿 \d+회/);

  // 팀 A 다섯 명을 모두 1회 이상으로 → 서포터만 바꾸기 → 팀 A는 그대로, 알림, 초기화 버튼 켜짐.
  for (const name of afterDraw) {
    const input = page.getByRole("spinbutton", { name: `${name} 서포터 횟수` });
    if ((await input.inputValue()) === "0") await page.getByRole("button", { name: `${name} 서포터 횟수 늘리기` }).click();
  }
  await save.click();
  await expect(page.locator(".toast")).toHaveText("서포터 횟수를 저장했어요.");
  await expect(reset).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("모두 서포터를 배정받았어요");
  const beforeA = await rows(team(page, "A")).allInnerTexts();
  await page.getByRole("region", { name: "섞기" }).getByRole("button", { name: "서포터만 바꾸기" }).click();
  await expect(page.locator(".note").filter({ hasText: "블루팀은 모두 서포터를 배정받았어요." })).toBeVisible();
  expect(await rows(team(page, "A")).allInnerTexts()).toEqual(beforeA);

  // 초기화 → 모두 0, 버튼 다시 꺼짐. 서버에도 내전·주기 없이 미리 넣은 값이 지워졌다.
  if (!(await reset.isVisible())) await page.getByText(/^서포터 횟수: /).click();
  await reset.click();
  await page.getByRole("dialog", { name: "서포터 횟수 초기화" }).getByRole("button", { name: "초기화" }).click();
  await expect(page.locator(".teams").getByText(/서폿 \d+회/)).toHaveCount(0);
  if (!(await reset.isVisible())) await page.getByText(/^서포터 횟수: /).click();
  await expect(reset).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("아직 서포터를 안 간 사람이 있어요");
  for (const name of afterDraw) {
    await expect(page.getByRole("spinbutton", { name: `${name} 서포터 횟수` })).toHaveValue("0");
  }
  const snap = await (await page.request.get(`/api/groups/${gid}/snapshot`)).json();
  expect(snap.rotation).toBeNull();

  // 390px에서 넘치지 않고, −/＋는 44px 이상이다.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.getByRole("button", { name: `${afterDraw[0]} 서포터 횟수 늘리기` }).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
