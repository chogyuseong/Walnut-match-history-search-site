import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

// 참가자 편성 화면 개인화(#/v/토큰/live, 2026-11-10 실험 B-1, docs/개선-경험-설계-2026-11-10.md 9절 B e2e).
// 내 이름 고르기·내 자리 요약·바뀐 자리 안내·끊김과 멈춤·폐기된 링크. 시간이 걸리는 확인은 page.clock으로 앞당긴다.
// 모임·경기는 운영자 API로 빠르게 만들고, 참가자는 로그인 없는 다른 브라우저(휴대폰)로 연다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
/** 첫 사람은 20자 이름(넘침 검사). */
const LONG = "아주아주긴이름을가진참가자예요열두명중첫째";
const NAMES = [LONG.slice(0, 20), ...Array.from({ length: 11 }, (_, i) => `참가${String(i + 2).padStart(2, "0")}`)];

interface Setup {
  groupId: string;
  token: string;
  people: { id: string; name: string }[];
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

async function setup(page: Page, name: string): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", { subject: `e2e-live-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name });
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names: NAMES });
  const snapshot = await snapshotOf(request, group.id);
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: crypto.randomUUID(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(res.ok()).toBe(true);
  return { groupId: group.id, token: snapshot.group.viewToken, people: ensured.participants };
}

async function startApi(request: APIRequestContext, s: Setup, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, s.groupId);
  return (
    await post(request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: crypto.randomUUID(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
      teamASide: "blue",
    })
  ).match;
}

async function guestPage(browser: Browser, width: number): Promise<{ context: BrowserContext; guest: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  return { context, guest: await context.newPage() };
}

/**
 * page.clock으로 시간을 앞당기는 테스트용. 흩뜨림(±20%)을 없애 확인이 정확히 간격(경기 중 60초, 대기 15초)에 나가게 한다.
 * 간격보다 더 멀리 앞당기면 그 사이 나간 요청의 15초 제한 시간(api.ts)까지 가짜 시계로 지나가 요청이 끊긴 것으로 잡힌다.
 */
async function clockedGuest(browser: Browser, width: number): Promise<{ context: BrowserContext; guest: Page }> {
  const pair = await guestPage(browser, width);
  await pair.context.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await pair.guest.clock.install();
  return pair;
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

for (const width of [320, 390]) {
  test(`${width}px: 명단 줄을 눌러 내 이름을 고르면 내 자리가 맨 위에, 다시 열어도 유지되고 요청에는 실리지 않는다`, async ({ page, browser }) => {
    const s = await setup(page, `편성 개인화 ${width}`);
    const match = await startApi(page.request, s, s.people.slice(0, 10));
    const { context, guest } = await guestPage(browser, width);
    await guest.goto(`/#/v/${s.token}/live`);
    await expect(guest.getByRole("heading", { name: "1경기 편성" })).toBeVisible();
    const mine = guest.getByRole("region", { name: "내 자리" });
    await expect(mine).toContainText("로그인이 아니에요");
    await noHorizontalOverflow(guest, "이름 고르기 전");

    // 고른 뒤 나가는 요청을 모두 모은다.
    const requests: string[] = [];
    guest.on("request", (req) => {
      if (req.url().includes("/api/")) requests.push(`${req.method()} ${new URL(req.url()).pathname}${new URL(req.url()).search}`);
    });
    // 20자 이름(블루 탑)을 고른다. 줄 전체가 버튼이다(높이 44px 이상).
    const blue = guest.getByRole("region", { name: "블루팀" });
    const row = blue.getByRole("button", { name: new RegExp(NAMES[0]!) });
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await row.click();
    await expect(mine).toContainText("블루팀");
    await expect(mine).toContainText("탑");
    await expect(mine).toContainText(NAMES[0]!);
    await expect(mine.getByText("나", { exact: true })).toBeVisible();
    await expect(mine).toContainText(`같은 팀 ${NAMES.slice(1, 5).join(" · ")}`);
    await expect(mine).toContainText(`맞라인 ${NAMES[5]}`);
    // 명단의 내 줄에는 글자 "나"가 붙는다(색 띠만이 아니다). 줄은 더 이상 버튼이 아니다.
    await expect(blue.getByRole("listitem").first().getByText("나", { exact: true })).toBeVisible();
    await expect(blue.getByRole("button")).toHaveCount(0);
    await noHorizontalOverflow(guest, "이름 고른 뒤");

    // 다시 열어도 유지된다(이 기기 저장값).
    await guest.reload();
    await expect(guest.getByRole("region", { name: "내 자리" })).toContainText(`맞라인 ${NAMES[5]}`);

    // 나간 요청은 조회 응답 읽기뿐이고 참가자 ID가 어디에도 없다.
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r).toBe(`GET /api/view/${s.token}`);
      expect(r).not.toContain(s.people[0]!.id);
    }
    // 이름 고르기는 로그인이 아니다: 같은 브라우저에서 쓰기는 거절된다.
    const write = await guest.request.post(`/api/groups/${s.groupId}/matches/${match.id}/result`, {
      data: { requestId: crypto.randomUUID(), baseMatchVersion: match.version, winnerTeam: "A", winnerSide: "blue" },
    });
    expect(write.status()).toBe(401);

    // 이름 바꾸기: 다시 줄을 눌러 고르는 상태로 돌아간다.
    await guest.getByRole("button", { name: "이름 바꾸기" }).click();
    await expect(blue.getByRole("button")).toHaveCount(5);
    await context.close();
  });
}

test("키보드만으로 이름 고르기, 움직임 없음", async ({ page, browser }) => {
  const s = await setup(page, "편성 키보드");
  await startApi(page.request, s, s.people.slice(0, 10));
  const { context, guest } = await guestPage(browser, 390);
  await guest.goto(`/#/v/${s.token}/live`);
  const red = guest.getByRole("region", { name: "레드팀" });
  await expect(red.getByRole("button")).toHaveCount(5);
  // 레드 정글(참가07)까지 Tab으로 간다.
  const target = red.getByRole("button", { name: /참가07/ });
  for (let i = 0; i < 30 && !(await target.evaluate((el) => el === document.activeElement)); i++) await guest.keyboard.press("Tab");
  await expect(target).toBeFocused();
  await guest.keyboard.press("Enter");
  const mine = guest.getByRole("region", { name: "내 자리" });
  await expect(mine).toContainText("레드팀");
  await expect(mine).toContainText("정글");
  expect(await guest.evaluate(() => document.getAnimations().length)).toBe(0);
  await context.close();
});

test("열어 둔 동안 사람이 바뀌면 바뀐 자리 글과 '바뀜' 꼬리표, 다음 경기가 시작되면 같은 화면이 바뀐다", async ({ page, browser }) => {
  const s = await setup(page, "편성 교체 안내");
  const match = await startApi(page.request, s, s.people.slice(0, 10));
  const { context, guest } = await clockedGuest(browser, 390);
  await guest.goto(`/#/v/${s.token}/live`);
  await expect(guest.getByRole("heading", { name: "1경기 편성" })).toBeVisible();

  // 레드 정글(참가07)을 참가11로 교체한다.
  const res = await page.request.patch(`/api/groups/${s.groupId}/matches/${match.id}/roster`, {
    data: {
      requestId: crypto.randomUUID(),
      baseMatchVersion: match.version,
      outParticipantId: s.people[6]!.id,
      inParticipantId: s.people[10]!.id,
    },
  });
  expect(res.ok()).toBe(true);
  // 경기 중 간격은 60초.
  await guest.clock.runFor(60_000);
  await expect(guest.getByText("바뀐 자리: 레드 정글 참가07 → 참가11")).toBeVisible();
  const red = guest.getByRole("region", { name: "레드팀" });
  await expect(red.getByRole("listitem").filter({ hasText: "참가11" }).getByText("바뀜")).toBeVisible();

  // 결과를 넣고 다음 경기를 시작하면 새로 고치지 않아도 바뀐다.
  const current = (await snapshotOf(page.request, s.groupId)).matches.find((m: { id: string }) => m.id === match.id);
  await post(page.request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
    requestId: crypto.randomUUID(),
    baseMatchVersion: current.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
  await guest.clock.runFor(60_000);
  await expect(guest.getByText("지금 진행 중인 경기가 없어요.")).toBeVisible();
  await expect(guest.getByText("다음 경기는 운영자가 시작하면 여기에 떠요.")).toBeVisible();
  await startApi(page.request, s, [...s.people.slice(0, 5), ...s.people.slice(6, 11)]);
  // 대기 중 간격은 15초.
  await guest.clock.runFor(15_000);
  await expect(guest.getByRole("heading", { name: "2경기 편성" })).toBeVisible();
  await expect(guest.getByText("2경기 편성이 올라왔어요.")).toBeVisible();
  await context.close();
});

test("결과가 들어오면 내 결과와 그날 성적 한 줄(확정 경기만)", async ({ page, browser }) => {
  const s = await setup(page, "편성 결과 뒤");
  const first = await startApi(page.request, s, s.people.slice(0, 10));
  await post(page.request, `/api/groups/${s.groupId}/matches/${first.id}/result`, {
    requestId: crypto.randomUUID(),
    baseMatchVersion: first.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
  const second = await startApi(page.request, s, s.people.slice(0, 10));
  await post(page.request, `/api/groups/${s.groupId}/matches/${second.id}/end-later`, {
    requestId: crypto.randomUUID(),
    baseMatchVersion: second.version,
  });
  const { context, guest } = await guestPage(browser, 390);
  await guest.goto(`/#/v/${s.token}/live`);
  await expect(guest.getByText("지금 진행 중인 경기가 없어요.")).toBeVisible();
  await guest.getByRole("region", { name: "블루팀" }).getByRole("button", { name: /참가02/ }).click();
  const mine = guest.getByRole("region", { name: "내 자리" });
  await expect(mine).toContainText("2경기 결과 미입력");
  await expect(mine).toContainText(/내전 1승 0패\(확정 1경기, 결과 안 들어온 1경기 제외\)/);
  await context.close();
});

test("조회 링크를 다시 만들면 다음 확인에서 명단이 사라지고 폐기 안내, 그 뒤로는 요청하지 않는다", async ({ page, browser }) => {
  const s = await setup(page, "편성 폐기");
  await startApi(page.request, s, s.people.slice(0, 10));
  const { context, guest } = await clockedGuest(browser, 390);
  await guest.goto(`/#/v/${s.token}/live`);
  await expect(guest.getByRole("heading", { name: "1경기 편성" })).toBeVisible();

  await post(page.request, `/api/groups/${s.groupId}/view-token`, { requestId: crypto.randomUUID() });
  await guest.clock.runFor(60_000);
  await expect(guest.getByText("이 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요.")).toBeVisible();
  await expect(guest.getByRole("region", { name: "블루팀" })).toHaveCount(0);

  const after: string[] = [];
  guest.on("request", (req) => {
    if (req.url().includes("/api/")) after.push(req.url());
  });
  await guest.clock.runFor(5 * 60_000);
  // 브라우저가 돌릴 시간을 조금 준 뒤에도 요청이 없다.
  await guest.waitForTimeout(500);
  expect(after).toEqual([]);
  await context.close();
});

test("끊기면 'N시 N분 내용', 실패 5번이면 자동 확인을 멈추고, 복구 뒤 '지금 확인'으로 다시 최신", async ({ page, browser }) => {
  const s = await setup(page, "편성 끊김");
  await startApi(page.request, s, s.people.slice(0, 10));
  const { context, guest } = await clockedGuest(browser, 390);
  await guest.goto(`/#/v/${s.token}/live`);
  await expect(guest.getByText(/확인 · 자동으로 확인하고 있어요/)).toBeVisible();
  await expect(guest.getByText(/진행 중 · .+ 시작/)).toBeVisible();

  await context.setOffline(true);
  await guest.clock.runFor(75_000);
  await expect(guest.getByText(/연결이 끊겼어요\. .+ 내용이에요\./)).toBeVisible();
  // 끊긴 내용을 진행 중으로 보이지 않는다: 머리 표시가 "기준"으로 바뀐다.
  await expect(guest.getByText(/진행 중 · .+ 시작/)).toHaveCount(0);
  await expect(guest.getByText(/ 기준$/)).toBeVisible();
  // 실패마다 간격이 두 배(최대 5분). 5번째 실패 뒤 멈춘다.
  for (let i = 0; i < 6 && !(await guest.getByText(/자동 확인을 멈췄어요/).isVisible()); i++) {
    await guest.clock.runFor(6 * 60_000);
  }
  await expect(guest.getByText(/자동 확인을 멈췄어요/)).toBeVisible();

  await context.setOffline(false);
  await guest.getByRole("button", { name: "지금 확인" }).click();
  await expect(guest.getByText(/확인 · 자동으로 확인하고 있어요/)).toBeVisible();
  await expect(guest.getByText(/진행 중 · .+ 시작/)).toBeVisible();
  await context.close();
});

test("경기 없음: 기존 문구, 열린 내전이 없으면 '다음 경기' 안내도 없다", async ({ page, browser }) => {
  const s = await setup(page, "편성 경기 없음");
  const { context, guest } = await guestPage(browser, 320);
  await guest.goto(`/#/v/${s.token}/live`);
  await expect(guest.getByText("지금 진행 중인 경기가 없어요.")).toBeVisible();
  await expect(guest.getByText("다음 경기는 운영자가 시작하면 여기에 떠요.")).toHaveCount(0);
  await expect(guest.getByRole("region", { name: "내 자리" })).toHaveCount(0);
  await noHorizontalOverflow(guest, "경기 없음");
  await context.close();
});
