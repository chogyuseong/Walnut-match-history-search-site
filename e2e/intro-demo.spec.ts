import { expect, test, type Page } from "@playwright/test";

// 첫 화면 소개(처음 온 방문자)와 예시 모임(#/demo). 로컬 가짜 로그인(AUTH_MODE=fake)을 쓴다.

function uniqueUser(prefix = "e2e-intro"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, where).toBeLessThanOrEqual(0);
}

const intro = (page: Page) => page.getByRole("region", { name: "이 사이트 소개" });

test.describe("처음 온 방문자 (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("소개 → 예시 모임(요약·기록·랭킹·개인 통계·그래프·시즌 요약) → 시작하기는 로그인", async ({ page }) => {
    // 첫 화면이 불러오는 스크립트에는 예시 데이터 코드가 없다(예시 모임을 열 때만 불러온다).
    const scripts: string[] = [];
    page.on("response", async (response) => {
      if (response.url().endsWith(".js")) scripts.push(await response.text().catch(() => ""));
    });

    await page.goto("/");
    await expect(intro(page)).toBeVisible();
    await expect(intro(page)).toContainText("라이엇 전적에 남지 않아요");
    await expect(intro(page).getByRole("listitem")).toHaveCount(6);
    // 소개 아래의 원래 첫 화면(로그인 없이 팀 짜기)은 그대로다.
    await expect(page.getByText("아직 경기가 없어요.")).toBeVisible();
    await expect(page.getByRole("button", { name: "이름 넣고 팀 짜기" })).toBeVisible();
    // 라이엇 게임즈와 무관 고지도 그대로다.
    await expect(page.getByRole("contentinfo")).toContainText("라이엇 게임즈의 공식 서비스가 아니며");
    await noHorizontalOverflow(page, "소개");
    expect(scripts.some((s) => s.includes("빨간우체통"))).toBe(false);

    // 예시 모임
    await intro(page).getByRole("button", { name: "예시 모임 둘러보기" }).click();
    await expect(page).toHaveURL(/#\/demo$/);
    const note = page.getByRole("note", { name: "예시 데이터 안내" });
    await expect(note).toContainText("예시 데이터예요");
    await expect(note.getByRole("button", { name: "내 모임 만들기" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "예시 모임 요약", level: 1 })).toBeVisible();
    expect(scripts.some((s) => s.includes("빨간우체통"))).toBe(true);
    await noHorizontalOverflow(page, "예시 요약");

    // 기록과 랭킹
    await page.getByRole("navigation", { name: "예시 모임 메뉴" }).getByRole("button", { name: "기록" }).click();
    await expect(page.getByRole("heading", { name: "기록", level: 1 })).toBeVisible();
    const ranking = page.getByRole("region", { name: "소환사 랭킹" });
    await expect(ranking.getByRole("listitem").first()).toBeVisible();
    expect(await ranking.getByRole("listitem").count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByRole("region", { name: "경기 목록" })).toBeVisible();
    await noHorizontalOverflow(page, "예시 기록");

    // 개인 통계: 랭킹 1위를 누른다.
    const firstName = (await ranking.getByRole("listitem").first().innerText()).trim().split(/\s+/)[1]!;
    await ranking.getByRole("listitem").first().getByRole("button").first().click();
    await expect(page).toHaveURL(/#\/demo\/p\/demo-p\d\d$/);
    await expect(page.getByRole("heading", { name: firstName, level: 1 })).toBeVisible();
    await noHorizontalOverflow(page, "예시 개인 통계");

    // 그래프
    await page.goto("/#/demo/graphs");
    await expect(page.getByRole("heading", { name: "그래프 분석", level: 1 })).toBeVisible();
    await noHorizontalOverflow(page, "예시 그래프");

    // 시즌 요약
    await page.goto("/#/demo/season/demo-season1");
    await expect(page.getByRole("heading", { name: "예시 시즌 1 요약", level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: "시상" }).getByRole("listitem").first()).toBeVisible();
    await noHorizontalOverflow(page, "예시 시즌 요약");

    // 예시에는 티어가 없다(조회 화면과 같은 모양).
    await expect(page.getByText(/티어/)).toHaveCount(0);

    // "내 모임 만들기"는 로그인 안내가 있는 모임 화면으로 간다.
    await page.getByRole("note", { name: "예시 데이터 안내" }).getByRole("button", { name: "내 모임 만들기" }).click();
    await expect(page).toHaveURL(/#\/group$/);
    await expect(page.getByRole("button", { name: "로그인하고 계속" })).toBeVisible();

    // 첫 화면의 "시작하기"는 로그인(가입) 창을 연다. 로그인하면 소개가 사라지고 원래 첫 화면이다.
    await page.goto("/#/");
    await intro(page).getByRole("button", { name: "시작하기" }).click();
    const dialog = page.getByRole("dialog", { name: "로그인" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "회원가입" })).toBeVisible();
    await dialog.getByLabel("계정 이름").fill(uniqueUser());
    await dialog.getByRole("button", { name: "개발용 로그인" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("banner").getByRole("button", { name: "로그인됨" })).toBeVisible();
    await expect(intro(page)).toHaveCount(0);
    await expect(page.getByText("아직 경기가 없어요.")).toBeVisible();
  });

  test("로그인한 사람·기기에 기억이 있는 사람의 첫 화면에는 소개가 없다", async ({ page }) => {
    await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("button", { name: "로그인됨" })).toBeVisible();
    await expect(page.getByText("아직 경기가 없어요.")).toBeVisible();
    await expect(intro(page)).toHaveCount(0);

    // 로그아웃해도 이 기기에 기억한 모임이 있으면 소개를 다시 보여주지 않는다.
    await page.request.post("/api/groups", { data: {} });
    await page.reload();
    await expect(page.getByRole("banner").getByRole("button", { name: "로그인됨" })).toBeVisible();
    await page.request.post("/api/auth/logout");
    await page.reload();
    await expect(page.getByRole("banner").getByRole("button", { name: "로그인", exact: true })).toBeVisible();
    await expect(intro(page)).toHaveCount(0);
  });
});

test("1440px: 소개와 예시 모임이 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(intro(page)).toBeVisible();
  await noHorizontalOverflow(page, "소개 1440");
  await page.goto("/#/demo/records");
  await expect(page.getByRole("heading", { name: "기록", level: 1 })).toBeVisible();
  await noHorizontalOverflow(page, "예시 기록 1440");
});
