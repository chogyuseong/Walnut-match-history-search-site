import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// 검색 칸에서 검색 키(Enter)를 누르면 입력 칸 초점이 풀리고(휴대폰 키보드가 내려가고) 결과 첫머리가 보이는 자리로
// 옮겨지는지 본다(ui.tsx useSearchJump). 글자만 칠 때는 화면이 움직이지 않아야 한다.
// 화면 키보드 자체는 Playwright에서 띄울 수 없어, 키보드가 내려간 뒤의 화면(390×844)을 기준으로 잰다.
// 390 폭은 터치 기기(hasTouch → pointer: coarse)로 띄운다. 초점을 결과로 옮겨 키보드를 내리는 것은 터치 기기에서만이다.
// 모임·경기는 API로 만들고(rating.spec.ts와 같은 방식), 확인할 흐름만 화면으로 한다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const NAMES = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-jump-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

/** ten의 앞 다섯 명이 팀 A, 뒤 다섯 명이 팀 B. */
async function play(request: APIRequestContext, groupId: string, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, groupId);
  const started = (
    await post(request, `/api/groups/${groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
      teamASide: "blue",
    })
  ).match;
  await post(request, `/api/groups/${groupId}/matches/${started.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
}

/** 12명 모임 + 확정 경기 3개. 서포터 순환은 끈다(같은 사람을 다시 쓰려고). */
async function setup(page: Page) {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-jump-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "검색 이동 모임" });
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names: NAMES });
  const snapshot = await snapshotOf(request, group.id);
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(res.ok()).toBe(true);
  const people = ensured.participants as { id: string; name: string }[];
  await play(request, group.id, people.slice(0, 10));
  await play(request, group.id, people.slice(2, 12));
  await play(request, group.id, [...people.slice(0, 5), ...people.slice(7, 12)]);
}

/**
 * 휴대폰에서 검색 칸을 누른 직후처럼, 칸이 보이는 화면 아래쪽(하단 탭 바로 위)에 오게 내려 두고 초점을 준다.
 * 이 자리에서는 결과가 칸 아래, 화면 밖에 있다.
 */
async function focusNearBottom(page: Page, input: Locator) {
  await input.evaluate((el) => {
    const tabs = document.querySelector(".tabs");
    const tabsTop = tabs && getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect().top : innerHeight;
    const box = el.getBoundingClientRect();
    window.scrollBy(0, box.bottom - tabsTop + 8);
    (el as HTMLInputElement).focus({ preventScroll: true });
  });
}

/** 스크롤이 멈출 때까지(부드러운 스크롤이 끝날 때까지) 기다린다. */
async function scrollSettled(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const y = window.scrollY;
        setTimeout(() => resolve(window.scrollY === y), 150);
      }),
  );
}

/**
 * 결과 첫 줄이 보이는 화면 안에 있고, 위쪽 끝과 가운데에 그려진 것이 그 줄 자신인지(고정 머리·하단 탭에 가리지 않는지).
 */
async function expectRevealed(first: Locator, label: string) {
  const seen = await first.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const x = box.left + Math.min(box.width / 2, 40);
    const own = (y: number) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && (hit === el || el.contains(hit));
    };
    return { top: box.top, bottom: box.bottom, height: innerHeight, topOwn: own(box.top + 2), midOwn: own(box.top + box.height / 2) };
  });
  expect(seen.top, `${label}: 위로 벗어남`).toBeGreaterThanOrEqual(0);
  expect(seen.bottom, `${label}: 아래로 벗어남`).toBeLessThanOrEqual(seen.height);
  expect(seen.topOwn, `${label}: 윗변이 다른 요소에 가려짐`).toBe(true);
  expect(seen.midOwn, `${label}: 가운데가 다른 요소에 가려짐`).toBe(true);
}

async function expectBlurred(page: Page, input: Locator) {
  expect(await input.evaluate((el) => document.activeElement === el)).toBe(false);
}

const scrollY = (page: Page) => page.evaluate(() => window.scrollY);

test.describe("390×844 터치", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("결과가 화면 아래에 조금만 걸쳐 있어도 Enter면 위로 올린다", async ({ page }) => {
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const ranking = page.getByRole("region", { name: "소환사 랭킹" });
    const search = ranking.getByLabel("이름 검색");
    await search.fill("선수");
    // 결과 머리와 첫 줄 정도만 하단 탭 위에 걸치게 내려 둔다(예전 기준에서는 움직이지 않던 자리).
    const results = ranking.locator(".search-results");
    await results.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 600));
    await search.focus();
    const startTop = await results.evaluate((el) => el.getBoundingClientRect().top);
    expect(Math.abs(startTop - 600)).toBeLessThanOrEqual(1);
    await search.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, search);
    const first = ranking.getByRole("listitem").first();
    await expectRevealed(first, "기록 랭킹 첫 줄");
    expect(await first.evaluate((el) => el.getBoundingClientRect().top)).toBeLessThan(844 / 3);
  });

  test("한 명만 맞으면 그 사람 화면이 맨 위에서 열린다", async ({ page }) => {
    await setup(page);
    await page.goto("/#/search");
    const nameSearch = page.getByLabel("플레이어 이름");
    await nameSearch.fill("선수01");
    await nameSearch.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: /선수01/ })).toBeVisible();
    await scrollSettled(page);
    expect(await scrollY(page)).toBeLessThanOrEqual(1);
  });

  test("초점은 결과 묶음으로 가고 다음 Tab은 결과 안 첫 버튼으로", async ({ page }) => {
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const search = page.getByRole("region", { name: "소환사 랭킹" }).getByLabel("이름 검색");
    await search.fill("선수0");
    await search.press("Enter");
    await scrollSettled(page);
    expect(await page.evaluate(() => document.activeElement?.classList.contains("search-results"))).toBe(true);
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const active = document.activeElement;
        return active?.tagName === "BUTTON" && active.closest(".search-results") !== null;
      }),
    ).toBe(true);
  });

  test("기록 소환사 랭킹: 글자만 치면 그대로, Enter면 결과 첫 줄로·없으면 안내로", async ({ page }) => {
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const ranking = page.getByRole("region", { name: "소환사 랭킹" });
    const search = ranking.getByLabel("이름 검색");
    await expect(search).toHaveAttribute("enterkeyhint", "search");

    await focusNearBottom(page, search);
    const before = await scrollY(page);
    await search.pressSequentially("선수0");
    await search.press("Backspace");
    await search.pressSequentially("0");
    expect(await scrollY(page), "입력 중에는 움직이지 않는다").toBe(before);

    await search.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, search);
    expect(await scrollY(page)).toBeGreaterThan(before);
    await expectRevealed(ranking.getByRole("listitem").first(), "기록 랭킹 첫 줄");

    // 일치하는 이름이 없으면 그 안내 문구로 간다.
    await focusNearBottom(page, search);
    await search.fill("없는이름");
    await search.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, search);
    await expectRevealed(ranking.getByText("일치하는 이름이 없어요."), "일치 없음 안내");

    // 검색어가 비면 키보드만 내린다(화면은 그대로).
    await search.fill("");
    await focusNearBottom(page, search);
    const blankAt = await scrollY(page);
    await search.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, search);
    expect(await scrollY(page)).toBe(blankAt);
  });

  test("한글 조합 중 Enter는 조합이 끝난 뒤 한 번만 옮긴다", async ({ page }) => {
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const search = page.getByRole("region", { name: "소환사 랭킹" }).getByLabel("이름 검색");
    await focusNearBottom(page, search);
    await search.fill("선수0");
    const before = await scrollY(page);
    // 실제 IME 조합은 재현할 수 없어, 조합 중 표시가 붙은 Enter keydown을 직접 보낸다.
    await search.evaluate((el) =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true })),
    );
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await search.evaluate((el) => document.activeElement === el), "조합 중에는 초점을 빼지 않는다").toBe(true);
    expect(await scrollY(page)).toBe(before);
    // 조합이 끝나면 그때 옮긴다.
    await search.evaluate((el) => el.dispatchEvent(new CompositionEvent("compositionend", { data: "0", bubbles: true })));
    await scrollSettled(page);
    await expectBlurred(page, search);
    await expectRevealed(page.getByRole("region", { name: "소환사 랭킹" }).getByRole("listitem").first(), "조합 뒤 첫 줄");
  });

  test("MMR 랭킹·전적 검색도 Enter로 결과 첫머리", async ({ page }) => {
    await setup(page);

    await page.goto("/#/ranking");
    const mmrSearch = page.getByRole("group", { name: "순위표 찾기" }).getByLabel("이름 검색");
    await focusNearBottom(page, mmrSearch);
    await mmrSearch.fill("선수0");
    await mmrSearch.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, mmrSearch);
    await expectRevealed(page.getByRole("region", { name: "MMR 순위표" }).locator(".mmr-item").first(), "MMR 랭킹 첫 줄");

    await page.goto("/#/search");
    const nameSearch = page.getByLabel("플레이어 이름");
    await focusNearBottom(page, nameSearch);
    await nameSearch.fill("선수0");
    await nameSearch.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, nameSearch);
    await expectRevealed(page.getByRole("region", { name: "검색 결과" }).getByRole("listitem").first(), "전적 검색 첫 줄");
  });

  test("움직임 줄이기 끔(부드러운 스크롤)에서도 멈춘 자리가 맞다", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const ranking = page.getByRole("region", { name: "소환사 랭킹" });
    const search = ranking.getByLabel("이름 검색");
    await focusNearBottom(page, search);
    await search.fill("선수0");
    await search.press("Enter");
    await scrollSettled(page);
    await expectBlurred(page, search);
    await expectRevealed(ranking.getByRole("listitem").first(), "부드러운 스크롤 뒤 첫 줄");
  });
});

test.describe("1440×900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("결과가 이미 보이면 Enter를 눌러도 화면이 움직이지 않는다", async ({ page }) => {
    await setup(page);
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    const ranking = page.getByRole("region", { name: "소환사 랭킹" });
    const search = ranking.getByLabel("이름 검색");
    // 검색 칸을 화면 위쪽(200px)에 둔다. 처음 자리 그대로 두면 상단 바 아래 메뉴 줄(디자인 3단계) 몫만큼 결과가
    // 화면 아래 절반에서 시작해, "이미 보이는" 경우가 아니게 된다(ui.tsx RESULT_SEEN_SHARE).
    await search.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 200));
    await search.fill("선수0");
    const before = await scrollY(page);
    await search.press("Enter");
    await scrollSettled(page);
    expect(Math.abs((await scrollY(page)) - before)).toBeLessThanOrEqual(1);
    // 마우스·실물 키보드 환경: 초점은 검색 칸에 남아 바로 검색어를 고칠 수 있다.
    expect(await search.evaluate((el) => document.activeElement === el)).toBe(true);
  });
});
