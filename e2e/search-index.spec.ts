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

  // 없는 파일은 화면(index.html)으로 돌아온다(single-page-application). 사이트맵 내용이 없어야 한다.
  expect(await (await request.get("/sitemap.xml")).text()).not.toContain("<urlset");
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
