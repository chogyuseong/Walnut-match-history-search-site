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

  test("소개 → 예시 모임(요약·기록·랭킹·개인 통계·그래프·시즌 요약) → 로그인하고 모임 만들기", async ({ page }) => {
    // 첫 화면이 불러오는 스크립트에는 예시 데이터 코드가 없다(예시 모임을 열 때만 불러온다).
    const scripts: string[] = [];
    page.on("response", async (response) => {
      if (response.url().endsWith(".js")) scripts.push(await response.text().catch(() => ""));
    });

    await page.goto("/");
    await expect(intro(page)).toBeVisible();
    await expect(intro(page)).toContainText("라이엇 전적에 남지 않아요");
    await expect(intro(page).getByRole("listitem")).toHaveCount(4);
    // 스크롤하지 않은 첫 화면(390×844)에 로그인 없이 팀 짜기 버튼이 다 보인다. 하단 탭에 가려도 안 된다.
    const tryNow = intro(page).getByRole("button", { name: "로그인 없이 팀 짜기" });
    const tryBox = (await tryNow.boundingBox())!;
    const tabsTop = (await page.getByRole("navigation", { name: "주 메뉴" }).boundingBox())!.y;
    expect(tryBox.y + tryBox.height).toBeLessThanOrEqual(Math.min(844, tabsTop));
    // 소개가 첫 화면 전체다. 기록이 없는 사람에게 빈 안내(아직 경기가 없어요·빈 검색·빈 요약)를 겹쳐 보이지 않는다.
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByText("아직 경기가 없어요.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "이름 넣고 팀 짜기" })).toHaveCount(0);
    // 라이엇 게임즈와 무관 고지도 그대로다.
    await expect(page.getByRole("contentinfo")).toContainText("라이엇 게임즈의 공식 서비스가 아니며");
    await noHorizontalOverflow(page, "소개");
    expect(scripts.some((s) => s.includes("빨간우체통"))).toBe(false);

    // 예시 모임
    await intro(page).getByRole("button", { name: "예시 기록 보기" }).click();
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
    // 분석 코멘트의 편성 균형 문장: "근거 경기"를 펴면 판정 경기 수와 같은 수가 나오고, 줄을 누르면 그 경기 상세로 간다.
    const fairRemark = page.getByRole("region", { name: "분석 코멘트" }).getByRole("listitem").filter({ hasText: "MMR 차 35점 이내" });
    const judged = (await fairRemark.innerText()).match(/판정 (\d+)경기/)![1];
    await fairRemark.getByText(`근거 경기 ${judged}`).click();
    await expect(fairRemark.getByText(`MMR 차가 큰 경기부터 · ${judged}경기`)).toBeVisible();
    if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/evidence-390.png`, fullPage: true });
    await noHorizontalOverflow(page, "예시 그래프 근거 경기");
    await fairRemark.locator(".evidence-rows button").first().click();
    await expect(page).toHaveURL(/#\/demo\/d\/[^/]+$/);
    await expect(page.getByRole("heading", { name: /^\d+경기$/, level: 1 })).toBeVisible();

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

    // 소개의 "로그인 없이 팀 짜기"는 참가자 고르기로 간다.
    await page.goto("/#/");
    await intro(page).getByRole("button", { name: "로그인 없이 팀 짜기" }).click();
    await expect(page).toHaveURL(/#\/pick$/);

    // "로그인하고 모임 만들기"는 로그인(가입) 창을 연다. 로그인하면 소개가 사라지고 원래 첫 화면이다.
    await page.goto("/#/");
    await intro(page).getByRole("button", { name: "로그인하고 모임 만들기" }).click();
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
    // 저장한 경기가 없으면 빈 안내는 "지금 할 일" 하나다. 빈 전적 검색·빈 요약 패널을 겹쳐 두지 않는다(CLAUDE.md 8절).
    await expect(page.getByRole("region", { name: "전적 검색" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "기록 요약 안내" })).toHaveCount(0);

    // 로그아웃해도 이 기기에 기억한 모임이 있으면 소개를 다시 보여주지 않는다.
    await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID() } });
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
