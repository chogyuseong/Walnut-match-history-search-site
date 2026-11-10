import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 챔피언 티어(#/champions, 2026-11-10): 예시 모임에서 표·정렬·펼치기, 운영자가 챔피언을 기록하면 반영, 조회 링크, 빈 상태.
// 초상화는 외부 주소(Data Dragon)라 이 테스트에서는 막아 둔다(네트워크 없이도 글자로 떨어지는지 함께 본다).

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-ctier-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(page: Page): Promise<{ groupId: string; people: { id: string; name: string }[] }> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", { subject: `e2e-ctier-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "챔피언 티어 모임" });
  const names = Array.from({ length: 10 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  return { groupId: group.id, people: ensured.participants };
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

async function playOneBlueWin(page: Page, groupId: string, ten: { id: string }[]) {
  const snapshot = await snapshotOf(page.request, groupId);
  await post(page.request, `/api/groups/${groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    teamASide: "blue",
  });
  await page.goto("/#/match");
  // 앞에서 연 화면이 받아 둔 기록에는 방금 시작한 경기가 없다.
  await page.reload();
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  await sheet.getByRole("button", { name: "저장", exact: true }).click();
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/ddragon.leagueoflegends.com/**", (route) => route.fulfill({ status: 404, body: "" }));
});

test("예시 모임: 표가 열리고 승률로 정렬되며, 줄을 펼치면 사람별·라인·최근 경기가 보인다", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/#/demo/champions");
  await expect(page.getByRole("heading", { name: "챔피언 티어", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "예시 모임 메뉴" }).getByRole("button", { name: "챔피언" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByText(/챔피언 기록 \d+ \/ \d+경기/)).toBeVisible();
  const table = page.getByRole("table", { name: "챔피언 티어", exact: true });
  await expect(table.getByRole("columnheader", { name: /티어/ })).toHaveAttribute("aria-sort", "descending");

  await table.getByRole("button", { name: "승률" }).click();
  await expect(table.getByRole("columnheader", { name: /승률/ })).toHaveAttribute("aria-sort", "descending");
  const rates = async () =>
    (await table.locator("tbody tr:not(.dt-expand) td:nth-child(4)").allInnerTexts()).map((t) => Number(t.replace("%", "")));
  const desc = await rates();
  expect(desc.length).toBeGreaterThan(10);
  expect([...desc].sort((a, b) => b - a)).toEqual(desc);
  // 한 번 더 누르면 작은 값부터.
  await table.getByRole("button", { name: "승률" }).click();
  await expect(table.getByRole("columnheader", { name: /승률/ })).toHaveAttribute("aria-sort", "ascending");
  const asc = await rates();
  expect([...asc].sort((a, b) => a - b)).toEqual(asc);

  // 펼치기: 이름 버튼(aria-expanded).
  const first = table.locator("tbody tr").first().locator(".ct-name");
  await first.click();
  await expect(first).toHaveAttribute("aria-expanded", "true");
  const detail = table.locator(".ct-detail");
  await expect(detail.getByRole("heading", { name: "사람별" })).toBeVisible();
  await expect(detail.getByRole("heading", { name: "최근 경기" })).toBeVisible();
  // 최근 경기 링크는 경기 상세로 간다.
  await detail.getByRole("button", { name: /^\d+경기$/ }).first().click();
  await expect(page).toHaveURL(/#\/demo\/d\//);
  await page.goBack();

  // 초상화를 못 불러와도 이름 글자는 남고 깨진 그림이 없다. 불러오기를 마쳤는데 크기가 0인 그림(깨진 그림)이 남으면 안 된다.
  // 아직 화면 밖이라 요청하지 않은 그림(loading="lazy")은 빈 칸이라 세지 않는다.
  await expect
    .poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>("img.champ-portrait")].filter((img) => img.complete && img.naturalWidth === 0).length))
    .toBe(0);
  await expect(table.locator("img.champ-portrait")).toHaveCount(0);
  await expect(table.locator(".ct-name").first()).not.toHaveText("");

  // 초성 검색(챔피언 목록의 검색과 같은 규칙).
  await page.getByRole("searchbox", { name: "챔피언 검색" }).fill("ㄱㄹ");
  await expect(table.locator(".ct-name", { hasText: "가렌" })).toBeVisible();
  await expect(table.locator(".ct-name", { hasText: "아리" })).toHaveCount(0);
});

test("운영자: 빈 상태 → 빠진 경기에 챔피언을 기록하면 티어 화면에 반영되고, 조회 링크에서도 열린다", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await setup(page);

  // 경기가 하나도 없을 때: 표 대신 안내와 입력 버튼.
  await page.goto("/#/champions");
  await expect(page.getByRole("heading", { name: "챔피언 티어", level: 1 })).toBeVisible();
  await expect(page.getByText("챔피언 기록 0 / 0경기")).toBeVisible();
  await expect(page.getByRole("button", { name: "이름 넣고 팀 짜기" })).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  // 좁은 화면 하단 탭에는 "챔피언"이 없고 랭킹 화면 머리에서 간다.
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "챔피언" })).toBeHidden();

  await playOneBlueWin(page, s.groupId, s.people);
  await page.goto("/#/ranking");
  await page.getByRole("button", { name: "챔피언 티어 →" }).click();
  await expect(page).toHaveURL(/#\/champions$/);
  await expect(page.getByText("챔피언 기록 0 / 1경기")).toBeVisible();
  await page.locator(".empty-state").getByRole("button", { name: "1경기 챔피언 기록하기" }).click();
  await expect(page).toHaveURL(/#\/m\//);

  await page.getByRole("button", { name: "챔피언 기록" }).click();
  const dialog = page.getByRole("dialog", { name: "챔피언 기록" });
  const top = dialog.getByRole("combobox", { name: "탑 선수01 챔피언" });
  await top.click();
  await top.fill("ㅇㄹ");
  await top.press("Enter");
  await expect(top).toHaveValue("아리");
  await dialog.getByRole("button", { name: "챔피언 저장" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/#/champions");
  await expect(page.getByText("챔피언 기록 1 / 1경기")).toBeVisible();
  // 1판이라 티어 없이 "기록 부족" 묶음에 들어간다.
  const few = page.getByRole("region", { name: "기록 부족" });
  await expect(few.locator(".ct-name", { hasText: "아리" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // 조회 링크: 같은 화면을 읽기 전용으로(빠진 경기 채우기 버튼 없음).
  const token = (await snapshotOf(page.request, s.groupId)).group.viewToken as string;
  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await guest.route("**/ddragon.leagueoflegends.com/**", (route) => route.fulfill({ status: 404, body: "" }));
  await guest.goto(`/#/v/${token}/ranking`);
  await guest.getByRole("navigation", { name: "조회 메뉴" }).getByRole("button", { name: "챔피언" }).click();
  await expect(guest).toHaveURL(new RegExp(`#/v/${token}/champions$`));
  await expect(guest.getByRole("region", { name: "기록 부족" }).locator(".ct-name", { hasText: "아리" })).toBeVisible();
  await expect(guest.getByRole("button", { name: /빠진 경기 채우기/ })).toHaveCount(0);
  await guest.context().close();
});
