import { expect, test, type Page } from "@playwright/test";

// 자체 계정(아이디 + 비밀번호): 상단 [로그인] → 회원가입 → 복구 코드 → 모임 탭 → 로그아웃 → 다시 로그인.

let n = 0;
function newName(): string {
  n += 1;
  return `e2e${Date.now().toString(36)}${n}${Math.floor(Math.random() * 100)}`.slice(0, 20);
}

const banner = (page: Page) => page.getByRole("banner");
const menu = (page: Page) => page.getByRole("navigation", { name: "주 메뉴" });

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 열린 로그인 창에서 회원가입을 끝내고 복구 코드 단계를 지난다. */
async function signUp(page: Page, username: string, password: string) {
  const dialog = page.getByRole("dialog", { name: "로그인" });
  await dialog.getByRole("tab", { name: "회원가입" }).click();
  await dialog.getByLabel("아이디").fill(username);
  await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "가입하고 시작하기" }).click();
  const codeDialog = page.getByRole("dialog", { name: "복구 코드" });
  await expect(codeDialog).toContainText("이 코드를 적어 두세요");
  const code = await codeDialog.getByLabel("복구 코드").innerText();
  expect(code.trim()).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  await codeDialog.getByLabel("코드를 안전한 곳에 적어 뒀어요").check();
  await codeDialog.getByRole("button", { name: "계속" }).click();
  await expect(codeDialog).toBeHidden();
  return code.trim();
}

test.describe("회원가입 (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("상단 [로그인] → 회원가입 → 복구 코드 → 모임 탭 → 로그아웃 → 같은 아이디로 로그인, 틀리면 안내", async ({ page }) => {
    const username = newName();
    const password = "my inhouse pw";
    await page.goto("/");
    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "로그인" });
    // 기본은 로그인 칸. 비밀번호 관리자가 알아보도록 autocomplete가 맞게 붙어 있다.
    await expect(dialog.getByLabel("아이디")).toHaveAttribute("autocomplete", "username");
    await expect(dialog.getByLabel("비밀번호", { exact: true })).toHaveAttribute("autocomplete", "current-password");
    await dialog.getByRole("tab", { name: "회원가입" }).click();
    await expect(dialog.getByLabel("비밀번호", { exact: true })).toHaveAttribute("autocomplete", "new-password");
    // 조건은 칸 아래에 미리 보인다.
    await expect(dialog.getByText("3~20자, 영문·숫자·밑줄(_)")).toBeVisible();
    await expect(dialog.getByText("8자 이상, 아이디와 다르게")).toBeVisible();

    // 틀리면 무엇이 틀렸는지 알려준다.
    await dialog.getByLabel("아이디").fill("가나");
    await dialog.getByLabel("비밀번호", { exact: true }).fill("short");
    await dialog.getByRole("button", { name: "가입하고 시작하기" }).click();
    await expect(dialog.getByText("아이디는 3자 이상이어야 해요.")).toBeVisible();
    await expect(dialog.getByText("비밀번호는 8자 이상이어야 해요.")).toBeVisible();

    // 비밀번호 보기 전환.
    await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "비밀번호 보기" }).click();
    await expect(dialog.getByLabel("비밀번호", { exact: true })).toHaveAttribute("type", "text");
    await dialog.getByRole("button", { name: "비밀번호 숨기기" }).click();
    await expect(dialog.getByLabel("비밀번호", { exact: true })).toHaveAttribute("type", "password");

    // 가입 → 복구 코드: 적지 않고 넘어가려면 한 번 더 묻는다.
    await dialog.getByLabel("아이디").fill(username);
    await dialog.getByRole("button", { name: "가입하고 시작하기" }).click();
    const codeDialog = page.getByRole("dialog", { name: "복구 코드" });
    await expect(codeDialog).toContainText("비밀번호를 잊으면 이 코드로만 다시 정할 수 있어요");
    await expect(codeDialog.getByRole("button", { name: "계속" })).toBeDisabled();
    await codeDialog.getByRole("button", { name: "적지 않고 넘어가기" }).click();
    await expect(codeDialog.getByRole("alert")).toContainText("그래도 넘어갈까요?");
    await codeDialog.getByRole("button", { name: "돌아가서 적기" }).click();
    await codeDialog.getByLabel("코드를 안전한 곳에 적어 뒀어요").check();
    await codeDialog.getByRole("button", { name: "계속" }).click();

    // 가입하면 바로 로그인된다.
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
    await menu(page).getByRole("button", { name: "모임" }).click();
    await expect(page.getByText("아직 모임이 없어요.")).toBeVisible();
    // 아이디는 화면 어디에도 그리지 않는다.
    await expect(page.locator("body")).not.toContainText(username);

    // 로그아웃.
    await banner(page).getByRole("button", { name: "로그인됨" }).click();
    await page.getByRole("group", { name: "로그인 상태" }).getByRole("button", { name: "로그아웃" }).click();
    await expect(banner(page).getByRole("button", { name: "로그인", exact: true })).toBeVisible();

    // 같은 아이디(대문자로 적어도)로 로그인: 틀리면 하나의 안내 문구.
    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    await dialog.getByLabel("아이디").fill(username.toUpperCase());
    await dialog.getByLabel("비밀번호", { exact: true }).fill("wrong password");
    await dialog.getByRole("button", { name: "아이디로 로그인" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("아이디 또는 비밀번호가 맞지 않아요.");
    await dialog.getByLabel("비밀번호", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "아이디로 로그인" }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
    await expect(menu(page).getByRole("button", { name: "모임" })).toBeVisible();
  });

  test("작성 중인 편성은 가입 뒤에도 그대로이고, 이어서 경기가 시작된다", async ({ page }) => {
    await page.goto("/#/pick");
    const names = Array.from({ length: 10 }, (_, i) => `가입편성${i + 1}`);
    await page.getByLabel("이름 검색 또는 새 이름 입력").fill(names.join("\n"));
    await page.getByRole("button", { name: "추가", exact: true }).click();
    await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
    await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
    await page.getByRole("button", { name: "이 팀으로 시작" }).click();
    await signUp(page, newName(), "draft keeper 1");
    const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
    const heading = page.getByRole("heading", { name: "1경기 진행 중" });
    await expect(confirm.or(heading)).toBeVisible();
    if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
    await expect(heading).toBeVisible();
    for (const name of names) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  });

  test("비밀번호를 잊었을 때: 복구 코드로 다시 정하면 새 코드를 주고, 모임 탭에서 비밀번호를 바꿀 수 있다", async ({ page }) => {
    const username = newName();
    await page.goto("/");
    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    const code = await signUp(page, username, "first password");
    await banner(page).getByRole("button", { name: "로그인됨" }).click();
    await page.getByRole("group", { name: "로그인 상태" }).getByRole("button", { name: "로그아웃" }).click();

    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "로그인" });
    await dialog.getByRole("button", { name: "비밀번호를 잊었어요" }).click();
    await expect(dialog.getByRole("heading", { name: "복구 코드로 비밀번호 다시 정하기" })).toBeVisible();
    await dialog.getByLabel("아이디").fill(username);
    await dialog.getByLabel("복구 코드", { exact: true }).fill(code.toLowerCase());
    await dialog.getByLabel("새 비밀번호", { exact: true }).fill("second password");
    await dialog.getByRole("button", { name: "비밀번호 다시 정하기" }).click();
    const codeDialog = page.getByRole("dialog", { name: "복구 코드" });
    const fresh = (await codeDialog.getByLabel("복구 코드").innerText()).trim();
    expect(fresh).not.toBe(code);
    await codeDialog.getByLabel("코드를 안전한 곳에 적어 뒀어요").check();
    await codeDialog.getByRole("button", { name: "계속" }).click();
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();

    // 모임 탭 → 계정 관리: 비밀번호 바꾸기.
    await menu(page).getByRole("button", { name: "모임" }).click();
    await page.getByText("계정 관리").click();
    const change = page.getByRole("region", { name: "비밀번호 바꾸기" });
    await change.getByLabel("지금 비밀번호", { exact: true }).fill("not it at all");
    await change.getByLabel("새 비밀번호", { exact: true }).fill("third password");
    await change.getByRole("button", { name: "비밀번호 바꾸기" }).click();
    await expect(change.getByRole("alert")).toContainText("지금 비밀번호가 맞지 않아요");
    await change.getByLabel("지금 비밀번호", { exact: true }).fill("second password");
    await change.getByRole("button", { name: "비밀번호 바꾸기" }).click();
    await expect(page.getByText("비밀번호를 바꿨어요.", { exact: false })).toBeVisible();
    // 이 기기는 로그인이 이어진다.
    await page.reload();
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
    const login = await page.request.post("/api/auth/login", { data: { username, password: "third password" } });
    expect(login.ok()).toBe(true);
  });
});

test.describe("좁은 화면의 로그인·가입 창", () => {
  test("320px: 로그인·가입·복구 코드 창이 넘치지 않고 터치 대상 44px 이상", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    await banner(page).getByRole("button", { name: "로그인", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "로그인" });
    const check = async (scope: ReturnType<Page["getByRole"]>) => {
      await noHorizontalOverflow(page);
      const boxes = await scope
        .locator("button, input:not([type=checkbox]), a")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => ({ h: r.height, right: r.right, left: r.left })));
      for (const b of boxes) {
        expect(b.h).toBeGreaterThanOrEqual(44);
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.right).toBeLessThanOrEqual(320);
      }
    };
    await check(dialog);
    await dialog.getByRole("tab", { name: "회원가입" }).click();
    await dialog.getByRole("button", { name: "가입하고 시작하기" }).click();
    await expect(dialog.getByText("아이디는 3자 이상이어야 해요.")).toBeVisible();
    await check(dialog);
    await dialog.getByLabel("아이디").fill(newName());
    await dialog.getByLabel("비밀번호", { exact: true }).fill("narrow screen pw");
    await dialog.getByRole("button", { name: "가입하고 시작하기" }).click();
    const codeDialog = page.getByRole("dialog", { name: "복구 코드" });
    await expect(codeDialog).toBeVisible();
    await codeDialog.getByRole("button", { name: "적지 않고 넘어가기" }).click();
    await check(codeDialog);
    await codeDialog.getByRole("button", { name: "그래도 넘어가기" }).click();
    await expect(banner(page).getByRole("button", { name: "로그인됨" })).toBeVisible();
  });
});
