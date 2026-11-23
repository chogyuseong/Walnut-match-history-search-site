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

// ③ 받는 기기가 저장을 못 하면(저장 공간 가득 참·저장을 막은 브라우저) 서버 사본을 지우지 않는다.
// 탭을 닫고 다시 열어도 이어받을 수 있어야 한다(2026-11-23 재현: 전에는 서버 사본이 지워져 편성이 어디에도 남지 않았다).
// 쿠키 하나로 저장 막기를 켜고 끈다: 쿠키는 저장소와 따로라 막힌 동안에도 지울 수 있다.
const BLOCK_COOKIE = "e2e-block-storage";

test("390px 받는 기기 저장 실패: 서버 사본이 남고, 창을 닫았다 열어 다시 이어받는다", async ({ page, browser }) => {
  const subject = `e2e-handoff-keep-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  const gid = await setup(page, subject);
  await makeDraft(page);
  const sent = await lineup(page);
  await page.getByRole("button", { name: "다른 기기로 넘기기" }).click();
  await expect(page.getByText(/다른 기기로 넘겨 두었어요/)).toBeVisible();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript((cookie) => {
    if (!document.cookie.includes(`${cookie}=1`)) return;
    Storage.prototype.setItem = function () {
      throw new DOMException("quota", "QuotaExceededError");
    };
  }, BLOCK_COOKIE);
  await phone.addCookies([{ name: BLOCK_COOKIE, value: "1", url: new URL(page.url()).origin }]);
  const mobile = await phone.newPage();
  await post(mobile.request, "/api/auth/fake-login", { subject });
  await mobile.goto("/#/");
  await mobile.locator(".handoff-note").getByRole("button", { name: "이어받기" }).click();
  await expect(mobile.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
  expect(await lineup(mobile)).toEqual(sent);
  await expect(mobile.getByRole("alert").filter({ hasText: "넘긴 편성을 서버에 그대로 두었어요" })).toBeVisible();
  await noHorizontalOverflow(mobile, "준비 화면(저장 실패 안내)");
  expect((await mobile.request.get(`/api/groups/${gid}/draft-handoff`)).status()).toBe(200);

  // 탭을 닫고, 저장을 풀고 다시 연다: 이어받기 안내가 다시 보이고 같은 편성이 들어온다.
  await mobile.close();
  await phone.clearCookies({ name: BLOCK_COOKIE });
  const again = await phone.newPage();
  await again.goto("/#/");
  const offer = again.locator(".handoff-note");
  await expect(offer).toContainText("다른 기기에서 넘긴 편성이 있어요(10명)");
  await offer.getByRole("button", { name: "이어받기" }).click();
  await expect(again.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
  expect(await lineup(again)).toEqual(sent);
  expect((await again.request.get(`/api/groups/${gid}/draft-handoff`)).status()).toBe(404);
  await again.reload();
  await expect(again.locator(".teams li:not(.empty) .name")).toHaveCount(10);
  expect(await lineup(again)).toEqual(sent);
  await phone.close();
});

// ④ 받는 기기가 안내를 본 뒤 넘긴 기기가 다시 넘기면, 본 적 없는 판으로 바꾸지 않고 안내를 새로 보여 준다.
test("안내를 본 뒤 다시 넘겼으면 이어받기가 멈추고 새 안내를 보여 준다", async ({ page, browser }) => {
  const subject = `e2e-handoff-resent-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  const gid = await setup(page, subject);
  await makeDraft(page);
  const sent = await lineup(page);
  await page.getByRole("button", { name: "다른 기기로 넘기기" }).click();
  await expect(page.getByText(/다른 기기로 넘겨 두었어요/)).toBeVisible();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await post(mobile.request, "/api/auth/fake-login", { subject });
  await mobile.goto("/#/");
  const offer = mobile.locator(".handoff-note");
  await expect(offer).toContainText("(10명)");

  // 넘긴 기기가 두 사람 자리를 맞바꿔 다시 넘긴다(화면의 "다시 넘기기"와 같은 요청).
  const body = await (await page.request.get(`/api/groups/${gid}/draft-handoff`)).json();
  const [first, sixth] = [body.draft.slots[0].key, body.draft.slots[5].key];
  body.draft.slots[0].key = sixth;
  body.draft.slots[5].key = first;
  const resend = await page.request.put(`/api/groups/${gid}/draft-handoff`, {
    data: { handoffId: crypto.randomUUID(), draft: body.draft, nightPool: body.nightPool },
  });
  expect(resend.ok()).toBe(true);

  await offer.getByRole("button", { name: "이어받기" }).click();
  await expect(mobile.getByText(/그 사이 다른 기기에서 편성을 다시 넘겼어요/)).toBeVisible();
  await expect(mobile).not.toHaveURL(/#\/prep/);
  expect((await mobile.request.get(`/api/groups/${gid}/draft-handoff`)).status()).toBe(200);
  // 다시 누르면 새 판이 들어온다.
  await offer.getByRole("button", { name: "이어받기" }).click();
  await expect(mobile.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
  const got = await lineup(mobile);
  const snapshot = await (await page.request.get(`/api/groups/${gid}/snapshot`)).json();
  const nameOf = new Map<string, string>(snapshot.participants.map((p: { id: string; name: string }) => [`p:${p.id}`, p.name]));
  // 두 자리의 사람만 맞바뀐 판이다(화면 순서는 팀·포지션 순이라 자리 칸 순서와 다르다).
  const [a, b] = [nameOf.get(first)!, nameOf.get(sixth)!];
  expect(got).toEqual(sent.map((n) => (n === a ? b : n === b ? a : n)));
  await phone.close();
});

// ⑤ 12명 밤의 교대(docs/개선-투자결정-2026-11-23.md 인수 조건).
// P01~P10이 1경기를 뛰고 P03이 집에 가고 P11이 들어간 2경기 편성을 PC가 넘긴다. 받는 휴대폰에는 작성하던 편성이 있다.
// PC 화면에서 빼기·교체를 누르는 대신 넘긴 본문을 그 결과로 고쳐 다시 넘긴다: 여기서 보는 것은 받는 쪽이다.
test("12명 밤 교대: 그대로 두기 → 다시 이어받기 → 새로 고쳐도 출전 10·대기 P12·귀가 P03 → 2경기 시작", async ({ page, browser }) => {
  test.setTimeout(120000);
  const subject = `e2e-handoff-12-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await post(page.request, "/api/auth/fake-login", { subject });
  const group = await post(page.request, "/api/groups", { requestId: crypto.randomUUID(), name: "열두 명 모임" });
  const gid: string = group.id;
  const names = Array.from({ length: 12 }, (_, i) => `P${String(i + 1).padStart(2, "0")}`);
  const { participants } = await post(page.request, `/api/groups/${gid}/participants`, { requestId: crypto.randomUUID(), names });
  const idOf = new Map<string, string>(participants.map((p: { id: string; name: string }) => [p.name, p.id]));
  const person = (name: string) => ({ key: `p:${idOf.get(name)}`, name, participantId: idOf.get(name)! });

  // 1경기: P01~P10.
  let snapshot = await (await page.request.get(`/api/groups/${gid}/snapshot`)).json();
  const { match } = await post(page.request, `/api/groups/${gid}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: names.slice(0, 10).map((n, i) => ({ participantId: idOf.get(n), team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    teamASide: "blue",
  });
  await post(page.request, `/api/groups/${gid}/matches/${match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: match.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
  snapshot = await (await page.request.get(`/api/groups/${gid}/snapshot`)).json();
  const sessionId: string = snapshot.session.id;

  // PC: 편성을 만들어 넘긴 뒤, 본문을 2경기 편성으로 바꿔 다시 넘긴다.
  await makeDraft(page);
  await page.getByRole("button", { name: "다른 기기로 넘기기" }).click();
  await expect(page.getByText(/다른 기기로 넘겨 두었어요/)).toBeVisible();
  const body = await (await page.request.get(`/api/groups/${gid}/draft-handoff`)).json();
  const second = ["P01", "P02", "P04", "P05", "P06", "P07", "P08", "P09", "P10", "P11"].map(person);
  const draft = {
    ...body.draft,
    people: second,
    slots: body.draft.slots.map((slot: { key: string }, i: number) => ({ ...slot, key: second[i].key, locked: false })),
    bench: [person("P12")],
    previousSlots: null,
    baseLiveVersion: snapshot.group.liveVersion,
  };
  const nightPool = {
    v: 1,
    groupId: gid,
    sessionId,
    createdAt: new Date().toISOString(),
    people: names.filter((n) => n !== "P03").map(person),
    left: [person("P03").key],
  };
  const put = await page.request.put(`/api/groups/${gid}/draft-handoff`, { data: { handoffId: crypto.randomUUID(), draft, nightPool } });
  expect(put.ok(), await put.text()).toBe(true);

  // 휴대폰: 작성하던 편성이 있다.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobile = await phone.newPage();
  await post(mobile.request, "/api/auth/fake-login", { subject });
  await makeDraft(mobile);
  const own = await lineup(mobile);
  await mobile.goto("/#/");
  await mobile.reload();
  const offer = mobile.locator(".handoff-note");
  await expect(offer).toContainText("다른 기기에서 넘긴 편성이 있어요(11명)");

  // 그대로 두기: 이 기기 편성과 서버 사본이 그대로이고, 초점은 이어받기로 돌아간다.
  await offer.getByRole("button", { name: "이어받기" }).click();
  const ask = mobile.getByRole("dialog", { name: "작성하던 편성을 바꿀까요?" });
  await expect(ask).toContainText(/이 기기에서 .+에 만든 편성\(10명\)은 지워지고, .+에 다른 기기에서 넘긴 편성\(11명\)으로 바뀌어요/);
  await noHorizontalOverflow(mobile, "바꿀지 묻는 창");
  await ask.getByRole("button", { name: "그대로 두기" }).click();
  await expect(ask).toHaveCount(0);
  await expect(offer.getByRole("button", { name: "이어받기" })).toBeFocused();
  expect((await mobile.request.get(`/api/groups/${gid}/draft-handoff`)).status()).toBe(200);
  await mobile.goto("/#/prep");
  await expect(mobile.locator(".teams li:not(.empty) .name")).toHaveCount(10);
  expect(await lineup(mobile)).toEqual(own);

  // 다시 이어받아 바꾼다 → 새로 고쳐도 기대값.
  await mobile.goto("/#/");
  await offer.getByRole("button", { name: "이어받기" }).click();
  await ask.getByRole("button", { name: "넘겨받은 편성으로 바꾸기" }).click();
  await expect(mobile.getByRole("heading", { level: 1, name: "다음 경기 준비" })).toBeVisible();
  await mobile.reload();
  await expect(mobile.locator(".teams li:not(.empty) .name")).toHaveCount(10);
  const playing = await lineup(mobile);
  expect([...playing].sort()).toEqual(second.map((p) => p.name).sort());
  const rest = mobile.getByRole("region", { name: "쉬는 사람" });
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 1명 · 오늘 온 11명");
  await expect(rest).toContainText("P12");
  await expect(rest).not.toContainText("P03");
  expect((await mobile.request.get(`/api/groups/${gid}/draft-handoff`)).status()).toBe(404);
  await noHorizontalOverflow(mobile, "준비 화면(12명 이어받은 뒤)");

  // 2경기 시작: 경기 하나가 생기고 1경기 명단의 P03은 그대로.
  await mobile.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = mobile.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const live = mobile.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(live)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
  await expect(live).toBeVisible();
  const after = await (await mobile.request.get(`/api/groups/${gid}/snapshot`)).json();
  const played = after.matches
    .filter((m: { state: string }) => m.state !== "canceled")
    .sort((a: { matchNo: number }, b: { matchNo: number }) => a.matchNo - b.matchNo);
  expect(played.length).toBe(2);
  const rosterNames = (m: { roster: { participantId: string }[] }) =>
    m.roster.map((r) => names.find((n) => idOf.get(n) === r.participantId)).sort();
  expect(rosterNames(played[0])).toContain("P03");
  expect(rosterNames(played[1])).toEqual(second.map((p) => p.name).sort());
  await phone.close();
});
