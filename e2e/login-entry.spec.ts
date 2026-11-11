import { expect, test, type Page } from "@playwright/test";

// 로그인 진입점: 상단 바의 [로그인]·[로그인됨], 로그인해야 쓰는 주소로 바로 들어온 경우, 모임이 없는 계정의 시작 안내.
// 로컬 가짜 로그인(AUTH_MODE=fake)을 쓴다.

function uniqueUser(prefix = "e2e-entry"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function fakeLogin(page: Page, user: string) {
  const dialog = page.getByRole("dialog", { name: "로그인" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("계정 이름").fill(user);
  await dialog.getByRole("button", { name: "개발용 로그인" }).click();
  await expect(dialog).toBeHidden();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const banner = (page: Page) => page.getByRole("banner");
const menu = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });

test.describe("상단 바 로그인 (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("상단 [로그인] → 모임 탭이 생기고, 모임이 없으면 시트 가져오기로 바로 시작할 수 있다", async ({ page }) => {
    await page.goto("/");
    // 로그인 전: 상단에 [로그인], 주 메뉴에 모임 탭이 없다.
    await expect(banner(page).getByRole("button", { name: "로그인", exact: true })).toBeVisible();
    await expect(menu(page).getByRole("button", { name: "모임" })).toHaveCount(0);
    // 홈의 안내 문구도 상단 버튼과 같은 말을 쓴다.
    await expect(page.getByText(/맨 위 \[로그인\]을 누르거나/)).toBeVisible();

    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    await fakeLogin(page, uniqueUser());

    // 로그인 뒤: 상단은 [로그인됨], 주 메뉴에 모임 탭.
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
    await expect(banner(page).getByRole("button", { name: "로그인", exact: true })).toHaveCount(0);
    await menu(page).getByRole("button", { name: "모임" }).click();

    // 모임이 없는 계정: 시작하는 세 가지 길.
    await expect(page.getByRole("heading", { name: "모임", level: 1 })).toBeVisible();
    await expect(page.getByText("아직 모임이 없어요.")).toBeVisible();
    await expect(page.getByRole("region", { name: "오늘 경기부터" }).getByRole("button", { name: "참가자 고르기" })).toBeVisible();
    await expect(page.getByRole("region", { name: "백업 파일로 시작" }).getByLabel("백업 파일 고르기")).toBeVisible();
    await noHorizontalOverflow(page);

    // 경기를 한 번도 하지 않고 모임을 만들어 시트 가져오기로 간다.
    await page.getByRole("button", { name: "모임 만들고 구글 시트에서 가져오기" }).click();
    await expect(page.getByRole("heading", { name: "구글 시트에서 가져오기", level: 1 })).toBeVisible();
    await expect(page.getByLabel("구글 시트 주소")).toBeVisible();
    await expect(menu(page).getByRole("button", { name: "모임" })).toHaveAttribute("aria-current", "page");

    // 이제 모임 탭에는 운영 기능이 있다(시트 가져오기 포함).
    await menu(page).getByRole("button", { name: "모임" }).click();
    await page.getByRole("button", { name: "구글 시트에서 가져오기", exact: true }).click();
    await expect(page.getByRole("heading", { name: "구글 시트에서 가져오기", level: 1 })).toBeVisible();

    // [로그인됨]을 누르면 로그아웃이 나온다. 계정 식별자·이름은 보이지 않는다.
    await banner(page).getByRole("button", { name: "로그인됨" }).click();
    const account = page.getByRole("group", { name: "로그인 상태" });
    await expect(account).toContainText("로그인돼 있어요");
    await account.getByRole("button", { name: "로그아웃" }).click();
    // 로그인해야 쓰는 화면에 있었으므로 첫 화면으로 간다.
    await expect(banner(page).getByRole("button", { name: "로그인", exact: true })).toBeVisible();
    await expect(menu(page).getByRole("button", { name: "모임" })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/$/);
  });

  test("Esc로 계정 메뉴를 닫으면 초점이 [로그인됨]으로 돌아온다", async ({ page }) => {
    await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
    await page.goto("/");
    const toggle = banner(page).getByRole("button", { name: "로그인됨" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "로그인 상태" })).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("모임이 없는 계정: 백업 파일을 고르면 빈 모임을 만들지 않고 바로 새 모임으로 가져온다", async ({ page }) => {
    // 다른 계정의 모임 백업을 받아 둔다.
    await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser("e2e-entry-src") } });
    const source = await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "백업 원본 모임" } })).json();
    await page.request.post(`/api/groups/${source.id}/participants`, { data: { requestId: crypto.randomUUID(), names: ["가람", "나래", "다솜"] } });
    const backup = await (await page.request.get(`/api/groups/${source.id}/export`)).text();
    await page.request.post("/api/auth/logout");

    await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
    await page.goto("/#/group");
    const start = page.getByRole("region", { name: "백업 파일로 시작" });
    await start.getByLabel("백업 파일 고르기").setInputFiles({ name: "b.json", mimeType: "application/json", buffer: Buffer.from(backup) });
    await expect(start).toContainText("백업 원본 모임");
    await expect(start).toContainText("참가자 3명");
    const run = start.getByRole("button", { name: "새 모임으로 가져오기" });
    await expect(run).toBeDisabled();
    await start.getByLabel("확인을 위해 '복원'을 입력해 주세요").fill("복원");
    await run.click();
    await expect(page.getByRole("textbox", { name: "모임 이름" })).toHaveValue("백업 원본 모임");
    // 빈 모임은 만들어지지 않았다.
    const me = await (await page.request.get("/api/me")).json();
    expect(me.groups).toHaveLength(1);
  });

  test("로그인 없이 운영 주소로 들어오면 로그인 안내, 로그인하면 그 화면이 열린다", async ({ page }) => {
    // 모임이 있는 계정을 만들고 로그아웃해 둔다.
    const user = uniqueUser("e2e-entry-owner");
    await page.request.post("/api/auth/fake-login", { data: { subject: user } });
    expect((await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "입구 모임" } })).ok()).toBe(true);
    await page.request.post("/api/auth/logout");

    // 여섯 주소 모두 빈 화면·엉뚱한 화면이 아니라 로그인 안내가 나온다.
    for (const [path, title] of [
      ["group", "모임"],
      ["import", "표 일괄 입력"],
      ["sheet-import", "구글 시트에서 가져오기"],
      ["backfill", "지난 경기 입력"],
      ["merge", "중복 참가자 합치기"],
      ["delete", "모임 삭제 · 탈퇴"],
    ] as const) {
      await page.goto(`/#/${path}`);
      await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
      await expect(page.getByText("이 화면은 로그인이 필요해요.")).toBeVisible();
      await expect(page.getByRole("button", { name: "로그인하고 계속" })).toBeVisible();
      await expect(page.getByText("아직 모임이 없어요")).toHaveCount(0);
    }

    // 시트 가져오기 주소: 로그인하면 같은 화면이 그대로 열린다.
    await page.goto("/#/sheet-import");
    await expect(page.getByText("이 화면은 로그인이 필요해요.")).toBeVisible();
    await page.getByRole("button", { name: "로그인하고 계속" }).click();
    await fakeLogin(page, user);
    await expect(page).toHaveURL(/#\/sheet-import$/);
    await expect(page.getByRole("heading", { name: "구글 시트에서 가져오기", level: 1 })).toBeVisible();
    await expect(page.getByLabel("구글 시트 주소")).toBeVisible();
    await expect(page.getByText("이 화면은 로그인이 필요해요.")).toHaveCount(0);
  });
});

test.describe("상단 바 배치", () => {
  /** 상단 바 안의 조작이 서로·주 메뉴와 겹치지 않고, 한 줄(56px)에 들어가며, 44px 이상인지. */
  async function checkTopBar(page: Page, width: number) {
    await noHorizontalOverflow(page);
    const bar = await page.locator(".topbar-inner").boundingBox();
    expect(bar!.height).toBeLessThanOrEqual(57);
    const controls = await banner(page)
      .locator("a, button, select")
      .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height })));
    for (const c of controls) {
      expect(c.h).toBeGreaterThanOrEqual(44);
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(width);
    }
    for (let i = 1; i < controls.length; i++) expect(controls[i]!.x).toBeGreaterThanOrEqual(controls[i - 1]!.x + controls[i - 1]!.w);
    if (width >= 768) {
      // 넓은 화면에서는 주 메뉴가 상단 바에 겹쳐 놓인다: 로고와 오른쪽 조작 사이에 있어야 한다.
      const tabs = await menu(page).boundingBox();
      const brand = controls[0]!;
      const firstAction = controls[1]!;
      expect(tabs!.x).toBeGreaterThanOrEqual(brand.x + brand.w);
      expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(firstAction.x);
    }
  }

  for (const width of [320, 390, 720, 768, 1024, 1440]) {
    test(`${width}px: 상단 바가 넘치지 않고 로그인 전후 모두 한 줄에 들어간다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      await expect(banner(page).getByRole("button", { name: "로그인", exact: true })).toBeVisible();
      await checkTopBar(page, width);

      await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
      await page.reload();
      await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
      await expect(menu(page).getByRole("button", { name: "모임" })).toBeVisible();
      await checkTopBar(page, width);

      // 계정 메뉴도 화면 안에 들어온다.
      await banner(page).getByRole("button", { name: "로그인됨" }).click();
      const box = await page.getByRole("group", { name: "로그인 상태" }).boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await noHorizontalOverflow(page);
    });
  }

  test("조회 링크 화면의 상단 바에는 로그인 버튼이 없다", async ({ page }) => {
    await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser() } });
    const group = await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "조회 모임" } })).json();
    const snapshot = await (await page.request.get(`/api/groups/${group.id}/snapshot`)).json();
    await page.goto(`/#/v/${snapshot.group.viewToken}/now`);
    await expect(banner(page).getByRole("combobox", { name: "화면 테마" })).toBeVisible();
    await expect(banner(page).getByRole("button")).toHaveCount(0);
  });
});
