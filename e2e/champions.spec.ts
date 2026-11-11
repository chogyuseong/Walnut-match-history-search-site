import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 챔피언 기록(2026-11-10, migrations/0025): 결과 입력 창의 접힌 영역에서 초성으로 찾아 고르고, 경기 상세에서 보이고 고친다.
// 영역을 펼치지 않은 결과 입력은 요청 본문이 예전과 같아야 한다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-champ-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** 12명 모임(서포터 순환 끔: 같은 명단을 다시 쓰려고). */
async function setup(page: Page): Promise<{ groupId: string; people: { id: string; name: string }[] }> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", { subject: `e2e-champ-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "챔피언 기록 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(res.ok()).toBe(true);
  return { groupId: group.id, people: ensured.participants };
}

async function startApi(request: APIRequestContext, groupId: string, ten: { id: string }[]) {
  const snapshot = await (await request.get(`/api/groups/${groupId}/snapshot`)).json();
  await post(request, `/api/groups/${groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    teamASide: "blue",
  });
}

async function openBlueWin(page: Page, matchNo: number) {
  await page.goto("/#/match");
  await expect(page.getByRole("heading", { name: `${matchNo}경기 진행 중` })).toBeVisible();
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: `${matchNo}경기 결과` });
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  return sheet;
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("결과 입력에서 초성으로 챔피언을 골라 저장하고, 경기 상세에서 보고 고친다", async ({ page }) => {
  const s = await setup(page);
  await startApi(page.request, s.groupId, s.people.slice(0, 10));
  const sheet = await openBlueWin(page, 1);

  await sheet.getByText("챔피언도 기록하기(선택)").click();
  const top = sheet.getByRole("combobox", { name: "탑 선수01 챔피언" });
  await top.click();
  await top.fill("ㅇㄹ");
  const list = sheet.getByRole("listbox", { name: "탑 선수01 챔피언 목록" });
  await expect(list.getByRole("option").first()).toHaveText(/^아리/);
  await noHorizontalOverflow(page, "챔피언 목록을 연 결과 입력 창");
  // Esc는 목록만 닫고 결과 입력 창은 남긴다.
  await top.press("Escape");
  await expect(list).toBeHidden();
  await expect(sheet).toBeVisible();

  await top.fill("ㅇㄹ");
  await top.press("Enter");
  await expect(top).toHaveValue("아리");
  // 고르면 다음 사람 칸으로 넘어가 목록이 열린다. 다른 사람이 고른 아리는 흐리게 맨 뒤로 간다.
  const jungle = sheet.getByRole("combobox", { name: "정글 선수02 챔피언" });
  await expect(jungle).toBeFocused();
  await jungle.fill("ㅇㄹ");
  const jungleOptions = sheet.getByRole("listbox", { name: "정글 선수02 챔피언 목록" }).getByRole("option");
  await expect(jungleOptions.last()).toHaveText(/아리.*다른 사람이 고름/);
  // 터치처럼 눌러서 고른다.
  await sheet.getByRole("option", { name: /^오로라/ }).click();
  await expect(jungle).toHaveValue("오로라");
  await expect(sheet.getByText("챔피언도 기록하기(선택) · 2명")).toBeVisible();

  const sent = page.waitForRequest((r) => r.url().endsWith("/result") && r.method() === "POST");
  await sheet.getByRole("button", { name: "결과 저장", exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(Object.values(body.champions).sort()).toEqual(["Ahri", "Aurora"]);
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();

  // 경기 상세: 이름 밑에 챔피언 이름.
  await page.goto("/#/records");
  await page.getByRole("region", { name: "경기 목록" }).getByRole("button", { name: /1경기 · 블루팀 승/ }).click();
  const blue = page.getByRole("region", { name: "블루팀" });
  await expect(blue.locator(".champ-name", { hasText: "아리" })).toBeVisible();
  await expect(blue.locator(".champ-name", { hasText: "오로라" })).toBeVisible();
  await expect(page.getByText("챔피언: 10명 중 2명")).toBeVisible();

  // 상세에서 고친다: 탑은 지우고 미드에 제드(영문으로 찾기).
  await page.getByRole("button", { name: "챔피언 수정" }).click();
  const dialog = page.getByRole("dialog", { name: "챔피언 기록" });
  await dialog.getByRole("button", { name: "탑 선수01 챔피언 지우기" }).click();
  const mid = dialog.getByRole("combobox", { name: "미드 선수03 챔피언" });
  await mid.click();
  await mid.fill("zed");
  await mid.press("Enter");
  await expect(mid).toHaveValue("제드");
  await noHorizontalOverflow(page, "챔피언 수정 창");
  await dialog.getByRole("button", { name: "챔피언 저장" }).click();
  await expect(dialog).toBeHidden();
  await expect(blue.locator(".champ-name", { hasText: "제드" })).toBeVisible();
  await expect(blue.locator(".champ-name", { hasText: "아리" })).toHaveCount(0);
  await expect(blue.locator(".champ-name", { hasText: "오로라" })).toBeVisible();
});

test("챔피언 영역을 펼치지 않으면 결과 입력 요청은 예전 그대로다", async ({ page }) => {
  const s = await setup(page);
  await startApi(page.request, s.groupId, s.people.slice(0, 10));
  const sheet = await openBlueWin(page, 1);
  await expect(sheet.getByText("챔피언도 기록하기(선택)")).toBeVisible();
  await expect(sheet.getByRole("combobox")).toHaveCount(0);

  const sent = page.waitForRequest((r) => r.url().endsWith("/result") && r.method() === "POST");
  await sheet.getByRole("button", { name: "결과 저장", exact: true }).click();
  expect(Object.keys((await sent).postDataJSON()).sort()).toEqual(
    ["baseMatchVersion", "requestId", "winnerSide", "winnerTeam"].sort(),
  );
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();
});
