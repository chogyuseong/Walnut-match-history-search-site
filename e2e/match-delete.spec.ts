import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// 경기 삭제·되살리기(migrations/0026)를 실제 브라우저에서 확인한다. 경기는 API로 만들고 화면은 삭제·되살리기만 누른다.
// 경기 상세 "더보기" → 경기 삭제 → 확인 창 → 기록 목록·랭킹에서 사라짐 → 변경 내역에서 되살리기 → 다시 보임.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-delete-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

interface Person {
  id: string;
  name: string;
}

/** 12명 모임. 순환은 끈다(서포터 반복 확인 없이 경기를 만든다). */
async function setup(page: Page): Promise<{ groupId: string; people: Person[] }> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-delete-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "삭제 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `삭제${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await getSnapshot(request, group.id);
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants };
}

async function play(request: APIRequestContext, groupId: string, people: Person[]) {
  const snapshot = await getSnapshot(request, groupId);
  const started = await post(request, `/api/groups/${groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: people.slice(0, 10).map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
  });
  await post(request, `/api/groups/${groupId}/matches/${started.match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.match.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
  return started.match as { id: string; matchNo: number };
}

/** 단추가 화면 안에 있고, 가운데를 누르면 그 단추가 눌리는지(하단 탭 등 다른 요소에 가리지 않는지). */
async function expectClickable(button: Locator) {
  const box = (await button.boundingBox())!;
  const viewport = button.page().viewportSize()!;
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.height).toBeGreaterThanOrEqual(44);
  const hit = await button.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && el.contains(top);
  });
  expect(hit).toBe(true);
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("운영자가 경기 상세에서 지우면 기록·랭킹에서 사라지고, 변경 내역에서 되살리면 다시 보인다", async ({ page }) => {
  const s = await setup(page);
  await play(page.request, s.groupId, s.people);
  // 둘째 경기에만 나온 두 사람(삭제11·삭제12)은 이 경기를 지우면 랭킹에서 빠진다.
  const second = await play(page.request, s.groupId, [...s.people.slice(2), ...s.people.slice(0, 2)]);

  await page.goto(`/#/m/${second.id}`);
  await expect(page.getByRole("heading", { name: `${second.matchNo}경기` })).toBeVisible();
  await page.locator("summary", { hasText: "더보기" }).click();
  await page.getByRole("button", { name: "경기 삭제" }).click();

  const dialog = page.getByRole("dialog", { name: `${second.matchNo}경기 삭제` });
  await expect(dialog).toContainText("삭제11");
  await expect(dialog).toContainText("삭제03");
  const confirm = dialog.getByRole("button", { name: "삭제", exact: true });
  await expectClickable(confirm);
  await expectClickable(dialog.getByRole("button", { name: "그만두기" }));
  await noHorizontalOverflow(page);
  await confirm.click();

  await expect(page).toHaveURL(/#\/records$/);
  await expect(page.getByRole("status").filter({ hasText: `${second.matchNo}경기를 지웠어요` })).toBeVisible();
  const list = page.getByRole("region", { name: "경기 목록" });
  await expect(list.getByRole("heading", { level: 2 })).toContainText("1경기 확정");
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  await expect(ranking).toContainText("삭제01");
  await expect(ranking).not.toContainText("삭제11");
  expect((await getSnapshot(page.request, s.groupId)).matches).toHaveLength(1);

  // 변경 내역: "2경기 · 삭제"와 되살리기.
  await page.locator("summary", { hasText: "변경 내역" }).click();
  const line = page.locator("li").filter({ hasText: `${second.matchNo}경기 · 삭제` });
  await expect(line).toContainText("대표 운영자");
  const undo = line.getByRole("button", { name: `${second.matchNo}경기 되살리기` });
  await expectClickable(undo);
  await noHorizontalOverflow(page);
  await undo.click();

  await expect(page.getByRole("status").filter({ hasText: `${second.matchNo}경기를 되살렸어요` })).toBeVisible();
  await expect(list.getByRole("heading", { level: 2 })).toContainText("2경기 확정");
  await expect(ranking).toContainText("삭제11");
  await expect(page.locator("li").filter({ hasText: `${second.matchNo}경기 · 삭제 되살림` })).toBeVisible();
  // 되살린 뒤에는 되살리기 단추가 없다.
  await expect(page.getByRole("button", { name: `${second.matchNo}경기 되살리기` })).toHaveCount(0);
  expect((await getSnapshot(page.request, s.groupId)).matches).toHaveLength(2);
});
