import { expect, test } from "@playwright/test";

// 저장된 테마 읽기(src/web/theme.ts readTheme). 없앤 바이올렛 테마(violet·deeplol)를 고른 기기는 다크로 열리고
// 저장값도 dark로 바뀌어야 한다. 다크·라이트는 그대로 둔다.

const THEME_KEY = "naejeon.theme";

for (const retired of ["violet", "deeplol"]) {
  test(`옛 저장값 ${retired}은 다크로 열고 저장값을 dark로 고쳐 쓴다`, async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key!, value!), [THEME_KEY, retired]);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("dark");
  });
}

test("라이트 저장값은 그대로 읽고 바꾸지 않는다", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "light"), THEME_KEY);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate((key) => localStorage.getItem(key), THEME_KEY)).toBe("light");
});
