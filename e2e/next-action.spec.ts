import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 운영 흐름 손질 셋(2026-11-17).
// ③ 오늘 화면 주 버튼: 진행 중이면 그 경기 결과 입력, 오늘 끝낸 경기가 있으면 그 경기에서 이어 다음 경기 준비.
// ⑤ 팀 짜기: 티어를 정하지 않은 모임은 MMR이 가장 고른 나누기를 먼저, 두 팀 위 한 줄에 순위와 "다음 추천".
// ⑥ 모임 링크 하나: 복사 버튼은 /live 하나, 예전 /now 링크도 경기 중이면 편성 화면으로 넘어온다.
// 캡처는 SHOT_DIR 환경 변수가 있을 때만 남긴다(눈으로 확인할 때).

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const SHOT_DIR = process.env.SHOT_DIR;

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let counter = 0;
const requestId = () => `e2e-next-${Date.now().toString(36)}-${++counter}`;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, s: Setup) {
  return (await request.get(`/api/groups/${s.groupId}/snapshot`)).json();
}

async function setup(page: Page, name: string): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-next-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name });
  const names = Array.from({ length: 10 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  // 같은 명단을 되풀이해 시작하려고 서포터 순환을 끈다.
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

async function startApi(request: APIRequestContext, s: Setup, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, s);
  return (
    await post(request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
      teamASide: "blue",
    })
  ).match;
}

async function playApi(request: APIRequestContext, s: Setup, ten: { id: string }[]) {
  const match = await startApi(request, s, ten);
  await post(request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: match.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
}

async function shot(page: Page, name: string) {
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

for (const width of [390, 1440]) {
  test(`${width}px: 주 버튼이 상태를 따르고, 팀 짜기는 MMR 1위 나누기부터, 링크는 하나`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page, `다음 행동 ${width}`);
    // 선수01~05가 세 번 다 이겨 MMR이 갈린다. 같은 다섯이 한 팀이면 MMR 꼴찌 나누기다.
    for (let i = 0; i < 3; i++) await playApi(page.request, s, s.people);

    // ③ 오늘 끝낸 경기가 있으면 주 버튼은 이어서 준비, 처음부터 고르기는 보조.
    await page.goto("/#/");
    const now = page.getByRole("region", { name: "지금 할 일" });
    await expect(now.getByRole("button", { name: "3경기에서 이어 다음 경기 준비" })).toHaveClass(/primary/);
    await expect(now.getByRole("button", { name: "참가자 고르기" })).toHaveClass(/secondary/);
    await shot(page, `today-confirmed-${width}`);

    // ⑤ 참가자 고르기 → 팀 짜기: MMR 차 1위 나누기가 먼저, "다음 추천"은 2위.
    await now.getByRole("button", { name: "참가자 고르기" }).click();
    await page.getByRole("button", { name: /지난 내전 참가자 그대로/ }).click();
    await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
    const line = page.locator(".balance-line");
    await expect(line).toContainText("126가지 나누기 중 MMR 차 1위");
    await noHorizontalOverflow(page, "준비 화면");
    await shot(page, `prep-${width}`);
    await line.getByRole("button", { name: "다음 추천" }).click();
    await expect(line).toContainText(/MMR 차 [12]위/);
    await expect(page.getByRole("button", { name: /직전 편성으로/ })).toBeVisible();

    // ③ 진행 중이면 주 버튼은 그 경기 결과 입력(결과 창이 바로 열린다).
    await page.getByRole("button", { name: "이 팀으로 시작" }).click();
    await expect(page.getByRole("heading", { name: "4경기 진행 중" })).toBeVisible();
    await page.goto("/#/");
    await expect(now.getByRole("button", { name: "4경기 결과 입력" })).toHaveClass(/primary/);
    await expect(now.getByRole("button", { name: "현재 경기 보기" })).toHaveClass(/secondary/);
    await shot(page, `today-playing-${width}`);
    await now.getByRole("button", { name: "4경기 결과 입력" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    // ⑥ 모임 탭의 링크 복사는 하나, 주소는 /live.
    await page.goto("/#/group");
    const linkBox = page.getByRole("region", { name: "모임 링크", exact: true });
    await expect(linkBox.getByRole("button", { name: /복사/ })).toHaveCount(1);
    await expect(linkBox.getByRole("button", { name: "모임 링크 복사" })).toBeVisible();

    // 예전 /now 링크를 경기 중에 열면 편성 화면으로 넘어오고, 이름을 고르면 내 전적으로 가는 길이 있다.
    const token = (await snapshotOf(page.request, s)).group.viewToken as string;
    const guestContext = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const guest = await guestContext.newPage();
    await guest.goto(`/#/v/${token}/now`);
    await expect(guest).toHaveURL(new RegExp(`#/v/${token}/live$`));
    await expect(guest.getByRole("heading", { name: "4경기 편성" })).toBeVisible();
    await guest.getByRole("region", { name: "블루팀" }).getByRole("listitem").first().click();
    const mine = guest.getByRole("link", { name: "내 전적 보기 →" });
    await expect(mine).toBeVisible();
    await noHorizontalOverflow(guest, "편성 화면");
    await shot(guest, `live-${width}`);
    await mine.click();
    await expect(guest).toHaveURL(new RegExp(`#/v/${token}/p/`));
    await guestContext.close();
  });
}
