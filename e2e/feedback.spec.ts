import { expect, test, type Page } from "@playwright/test";

// 피드백(시험 운영 기간, src/web/screens/Feedback.tsx): 로그인 없이 휴대폰에서 상단 바 링크로 들어와 글을 보낸다.
// 넓은 화면은 상단 바 링크 대신 주 메뉴 "피드백" 탭이 있다(운영 화면). 받은 글을 읽는 쪽은 test/feedback.test.ts가 본다.

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

test("390px: 상단 바 '피드백' → 글 적어 보내기 → 보냈어요", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const link = page.getByRole("banner").getByRole("link", { name: "피드백" });
  await expect(link).toBeVisible();
  // 휴대폰 하단 탭은 6칸 한계라 피드백 탭을 두지 않는다.
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "피드백" })).toBeHidden();
  await noHorizontalOverflow(page, "첫 화면 상단 바");
  await link.click();
  await expect(page.getByRole("heading", { name: "피드백", level: 1 })).toBeVisible();

  const field = page.getByLabel("불편한 점");
  const sendButton = page.getByRole("button", { name: "의견 보내기" });
  await field.fill("ㅇㅇ");
  await expect(sendButton).toBeDisabled();
  const text = "준비 화면에서 섞기 버튼이 하단 탭에 가려요";
  await field.fill(text);
  await expect(page.getByText(`${text.length}/1000자`)).toBeVisible();
  await noHorizontalOverflow(page, "피드백 화면");
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/feedback-390.png`, fullPage: true });
  await sendButton.click();
  await expect(page.getByRole("status")).toContainText("보냈어요");
  await page.getByRole("button", { name: "하나 더 적기" }).click();
  await expect(field).toHaveValue("");
});

test("1440px: 주 메뉴 '피드백' 탭으로 가고 상단 바 링크는 숨는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("banner").getByRole("link", { name: "피드백" })).toBeHidden();
  const tab = page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "피드백" });
  await tab.click();
  await expect(page.getByRole("heading", { name: "피드백", level: 1 })).toBeVisible();
  await expect(tab).toHaveAttribute("aria-current", "page");
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/feedback-1440.png`, fullPage: true });
});

test("예시 모임(운영 탭 없음)에서는 넓은 화면에도 상단 바 링크가 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/demo");
  await expect(page.getByRole("banner").getByRole("link", { name: "피드백" })).toBeVisible();
});

test("360px 로그인 상태: 상단 바(피드백·테마·로그인됨)가 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const login = await page.request.post("/api/auth/fake-login", { data: { subject: `e2e-feedback-${Date.now().toString(36)}` } });
  expect(login.ok()).toBe(true);
  await page.goto("/#/feedback");
  await expect(page.getByRole("heading", { name: "피드백", level: 1 })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("link", { name: "피드백" })).toBeVisible();
  await noHorizontalOverflow(page, "로그인 상단 바");
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/feedback-360-login.png` });
});
