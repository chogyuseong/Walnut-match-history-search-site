import { expect, test } from "@playwright/test";

// 검색 노출(scripts/search-index-plugin.mjs). 브라우저 테스트는 `npm run dev`의 기본 빌드(운영이 아닌 빌드)를 쓰므로
// 검색엔진에 막혀 있어야 한다. 운영 빌드(--mode deploy-production)의 열린 상태는 npm run check:bundle이 엇갈림만 본다.

test("운영이 아닌 빌드는 검색엔진에 막혀 있다(noindex·X-Robots-Tag, sitemap 없음)", async ({ request }) => {
  const home = await request.get("/");
  expect(await home.text()).toContain('<meta name="robots" content="noindex" />');
  expect(home.headers()["x-robots-tag"]).toBe("noindex");

  // robots.txt로 전체를 막으면 검색엔진이 noindex를 읽지 못하므로 열어 둔다.
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).not.toMatch(/^Disallow: \/$/m);

  // 운영이 아닌 빌드에는 사이트맵이 없다. 없는 파일은 404 상태와 없는 주소 안내(public/404.html)로 돌아온다.
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(404);
  expect(await sitemap.text()).not.toContain("<urlset");
});

test("없는 경로는 404 상태로 없는 주소 안내를 준다(앱 화면을 200으로 주지 않는다)", async ({ request, page }) => {
  // 화면 주소는 모두 # 뒤라 서버 경로는 "/", "/guide", 정적 파일뿐이다(wrangler.jsonc not_found_handling "404-page").
  for (const path of ["/nope-page", "/admin", "/.env"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(404);
    expect(await res.text(), path).toContain("<h1>없는 주소예요</h1>");
  }
  // # 뒤 화면 주소·질의가 붙은 첫 화면은 그대로 앱이다.
  expect((await request.get("/?from=share")).status()).toBe(200);
  await page.goto("/nope-page");
  await page.getByRole("link", { name: "내전로그 첫 화면으로" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("로그인하지 않은 첫 화면은 검색용 제목과 소개를 그대로 둔다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "이 사이트 소개" })).toContainText("리그 오브 레전드");
  await expect(page).toHaveTitle("내전 기록 · 팀 짜기와 전적 관리 | 내전로그");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://naejeon.guseong-family.workers.dev/",
  );
});

test("사용 안내(/guide)는 스크립트 없이 읽히고, 운영이 아닌 빌드에서는 막혀 있다", async ({ browser, request }) => {
  // public/guide.html: 첫 화면이 비어 있는 HTML이라 색인이 안 돼서 둔 정적 글(2026-11-19).
  const guide = await request.get("/guide");
  expect(guide.status()).toBe(200);
  expect(guide.headers()["x-robots-tag"]).toBe("noindex");
  const html = await guide.text();
  expect(html).toContain("<h1>내전 기록 사이트 사용 안내</h1>");
  expect(html).toContain('<link rel="canonical" href="https://naejeon.guseong-family.workers.dev/guide" />');

  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  const page = await context.newPage();
  await page.goto("/guide");
  await expect(page.getByRole("heading", { level: 2, name: "자주 묻는 질문" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "360px 가로 넘침").toBeLessThanOrEqual(0);
  await context.close();
});

test("앱 바닥글에서 사용 안내로 간다", async ({ page }) => {
  await page.goto("/#/demo");
  await page.getByRole("contentinfo").getByRole("link", { name: "사용 안내" }).click();
  await expect(page).toHaveURL(/\/guide$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("내전 기록 사이트 사용 안내");
});
