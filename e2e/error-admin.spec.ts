import { expect, test, type Page } from "@playwright/test";

// 화면 오류 수집과 사이트 운영자 현황(#/admin).
// 로컬 설정(wrangler.jsonc 맨 위 vars)의 SITE_ADMIN_ACCOUNT_IDS가 "fake:e2e-site-admin"이라
// 가짜 로그인 "e2e-site-admin"이 사이트 운영자다. 다른 계정은 일반 계정이다.

const ADMIN = "e2e-site-admin";

function uniqueUser(prefix = "e2e-err"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const banner = (page: Page) => page.getByRole("banner");

test.use({ viewport: { width: 390, height: 844 } });

test("화면 오류는 서버에 기록되고 사이트 운영자의 현황 화면에 보인다. 일반 계정은 #/admin을 못 본다", async ({
  page,
  browser,
}) => {
  // 사이트 운영자: 지난 실행의 기록을 비우고 시작한다.
  await page.request.post("/api/auth/fake-login", { data: { subject: ADMIN } });
  expect((await page.request.post("/api/admin/errors/clear", { data: {} })).status()).toBe(200);

  // 일반 계정(다른 브라우저 문맥)
  const userContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const user = await userContext.newPage();
  await user.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
  expect((await user.request.get("/api/admin/overview")).status()).toBe(404);
  await user.goto("/#/admin");
  await expect(banner(user).getByRole("button", { name: "로그인됨" })).toBeVisible();
  // 없는 화면처럼 첫 화면이 보인다.
  await expect(user.getByText("아직 경기가 없어요.")).toBeVisible();
  await expect(user.getByRole("heading", { name: "사이트 현황" })).toHaveCount(0);
  await banner(user).getByRole("button", { name: "로그인됨" }).click();
  await expect(user.getByRole("group", { name: "로그인 상태" })).toBeVisible();
  await expect(user.getByRole("button", { name: "사이트 현황" })).toHaveCount(0);

  // 일반 계정의 화면에서 오류를 일부러 일으킨다: 전역 오류와 처리하지 않은 거절.
  await user.goto("/#/records");
  const secret = "Zq3vK8xP2mN7wR4tY6uB1c";
  const sent = user.waitForResponse((r) => r.url().endsWith("/api/client-errors") && r.request().method() === "POST");
  await user.evaluate((token) => {
    setTimeout(() => {
      throw new Error(`e2e 일부러 낸 화면 오류 token=${token}`);
    }, 0);
  }, secret);
  expect((await sent).status()).toBe(200);
  const sentRejection = user.waitForResponse((r) => r.url().endsWith("/api/client-errors"));
  await user.evaluate(() => {
    void Promise.reject(new Error("e2e 일부러 낸 거절"));
  });
  expect((await sentRejection).status()).toBe(200);
  // 같은 오류를 바로 또 내도 한 번만 보낸다(분당 억제).
  let repeated = 0;
  user.on("request", (r) => {
    if (r.url().endsWith("/api/client-errors")) repeated += 1;
  });
  await user.evaluate((token) => {
    setTimeout(() => {
      throw new Error(`e2e 일부러 낸 화면 오류 token=${token}`);
    }, 0);
  }, secret);
  await user.waitForTimeout(500);
  expect(repeated).toBe(0);
  await userContext.close();

  // 사이트 운영자: 계정 메뉴에서 현황 화면으로 간다.
  await page.goto("/");
  await banner(page).getByRole("button", { name: "로그인됨" }).click();
  await page.getByRole("group", { name: "로그인 상태" }).getByRole("button", { name: "사이트 현황" }).click();
  await expect(page).toHaveURL(/#\/admin$/);
  await expect(page.getByRole("heading", { name: "사이트 현황", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "전체 수치" })).toContainText("계정");
  const log = page.getByRole("region", { name: "오류 기록" });
  await expect(log.getByRole("heading", { name: "오류 기록 2건" })).toBeVisible();
  const item = log.getByRole("listitem").filter({ hasText: "e2e 일부러 낸 화면 오류" });
  await expect(item).toContainText("token=[가림]");
  await expect(item).toContainText("#/records");
  await expect(item).toContainText("1건");
  await expect(log).not.toContainText(secret);
  await expect(log.getByRole("listitem").filter({ hasText: "e2e 일부러 낸 거절" })).toBeVisible();
  // 펼치면 스택이 보인다.
  await item.locator("summary").click();
  await expect(item.locator("pre")).toBeVisible();
  await noHorizontalOverflow(page);

  // 비우기
  await log.getByRole("button", { name: "오류 기록 비우기" }).click();
  await log.getByRole("button", { name: "모두 지우기" }).click();
  await expect(log.getByRole("heading", { name: "오류 기록 0건" })).toBeVisible();
  await expect(log.getByText("기록된 오류가 없어요.", { exact: false })).toBeVisible();
});
