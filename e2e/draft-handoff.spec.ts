import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 편성 넘기기(2026-11-18, src/web/draftHandoff.ts · migrations/0029).
// 같은 계정으로 연 두 기기(PC → 휴대폰)를 두 브라우저 문맥으로 흉내 낸다.
// ① PC 준비 화면에서 "다른 기기로 넘기기" → 휴대폰 오늘 화면에 이어받기 → 같은 편성으로 준비 화면이 열리고 서버 칸은 비워진다.
// ② 휴대폰에 작성하던 편성이 있으면 바꿀지 묻고, "그대로 두기"면 그대로, "넘긴 편성 버리기"면 넘긴 것이 사라진다.
// 캡처는 SHOT_DIR 환경 변수가 있을 때만 남긴다(눈으로 확인할 때).

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const SHOT_DIR = process.env.SHOT_DIR;

let counter = 0;
const requestId = () => `e2e-handoff-${Date.now().toString(36)}-${++counter}`;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** 운영자 계정·모임·10명과 확정 경기 하나(고르기 화면의 "지난 내전 참가자 그대로"를 쓰려고). */
async function setup(page: Page, subject: string): Promise<string> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", { subject });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "넘기기 모임" });
  const names = Array.from({ length: 10 }, (_, i) => `넘김${String(i + 1).padStart(2, "0")}`);
  const { participants } = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  const { match } = await post(request, `/api/groups/${group.id}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: participants.map((p: { id: string }, i: number) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    teamASide: "blue",
  });
  await post(request, `/api/groups/${group.id}/matches/${match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: match.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
  return group.id;
}

/** 오늘 화면에서 지난 참가자 그대로 팀을 짜 준비 화면까지 간다. */
async function makeDraft(page: Page) {
  await page.goto("/#/");
  await page.getByRole("region", { name: "지금 할 일" }).getByRole("button", { name: "참가자 고르기" }).click();
  await page.getByRole("button", { name: /지난 내전 참가자 그대로/ }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
}

/** 두 팀 상자의 이름 순서(편성이 같은지 견줄 때). */
async function lineup(page: Page): Promise<string[]> {
  return page.locator(".teams li:not(.empty) .name").allInnerTexts();
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

for (const width of [390, 1440]) {
  test(`${width}px 받는 기기: PC에서 넘긴 편성을 이어받고, 작성하던 편성이 있으면 묻는다`, async ({ page, browser }) => {
    const subject = `e2e-handoff-${width}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    await page.setViewportSize({ width: 1440, height: 900 });
    await setup(page, subject);

    // PC: 팀을 짜고 넘긴다.
    await makeDraft(page);
    const sent = await lineup(page);
    expect(sent.length).toBe(10);
    await expect(page.getByText("이 편성은 이 기기에만 있어요.")).toBeVisible();
    await page.getByRole("button", { name: "다른 기기로 넘기기" }).click();
    await expect(page.getByText(/다른 기기로 넘겨 두었어요/)).toBeVisible();
    await expect(page.getByRole("button", { name: "다시 넘기기" })).toBeVisible();
    if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/handoff-sent-pc-${width}.png` });

    // 휴대폰: 같은 계정으로 연다.
    const phone = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 } });
    const mobile = await phone.newPage();
    await post(mobile.request, "/api/auth/fake-login", { subject });
    await mobile.goto("/#/");
    const offer = mobile.locator(".handoff-note");
    await expect(offer).toContainText("다른 기기에서 넘긴 편성이 있어요(10명)");
    await noHorizontalOverflow(mobile, "오늘 화면(이어받기 안내)");
    if (SHOT_DIR) await mobile.screenshot({ path: `${SHOT_DIR}/handoff-offer-${width}.png` });
    await offer.getByRole("button", { name: "이어받기" }).click();
    await expect(mobile).toHaveURL(/#\/prep/);
    await expect(mobile.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
    expect(await lineup(mobile)).toEqual(sent);
    await noHorizontalOverflow(mobile, "준비 화면(이어받은 뒤)");
    if (SHOT_DIR) await mobile.screenshot({ path: `${SHOT_DIR}/handoff-taken-${width}.png` });
    // 이어받으면 서버 칸이 비워져 PC에서도 넘긴 안내가 사라진다.
    await expect(mobile.getByText("이 편성은 이 기기에만 있어요.")).toBeVisible();
    await page.reload();
    await expect(page.getByText("이 편성은 이 기기에만 있어요.")).toBeVisible();

    // ② PC가 다시 넘기면, 작성하던 편성이 있는 휴대폰은 바꿀지 묻는다.
    await page.getByRole("button", { name: "다른 기기로 넘기기" }).click();
    await expect(page.getByText(/다른 기기로 넘겨 두었어요/)).toBeVisible();
    await mobile.goto("/#/");
    await mobile.reload();
    await offer.getByRole("button", { name: "이어받기" }).click();
    const ask = mobile.getByRole("dialog", { name: "작성하던 편성을 바꿀까요?" });
    await expect(ask).toBeVisible();
    if (SHOT_DIR) await mobile.screenshot({ path: `${SHOT_DIR}/handoff-ask-${width}.png` });
    await ask.getByRole("button", { name: "그대로 두기" }).click();
    await expect(ask).toHaveCount(0);
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: "넘긴 편성 버리기" }).click();
    await expect(offer).toHaveCount(0);
    await page.reload();
    await expect(page.getByText("이 편성은 이 기기에만 있어요.")).toBeVisible();
    await phone.close();
  });
}
