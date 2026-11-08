import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";

// 참가자 본인 연결 · 멤버 화면 · 본인 확인 참가 신청 · 정정 요청(migrations/0019). 모두 390px.

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(request: APIRequestContext, prefix: string): Promise<void> {
  const response = await request.post("/api/auth/fake-login", { data: { subject: uniqueUser(prefix) } });
  expect(response.ok()).toBe(true);
}

async function noOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

const names = Array.from({ length: 12 }, (_, i) => `멤버${String(i + 1).padStart(2, "0")}`);

/** 운영자 계정·모임·참가자 12명·지난 경기 2판(앞 10명)을 만든다. */
async function seed(request: APIRequestContext, groupName: string): Promise<{ gid: string; ids: string[] }> {
  await apiLogin(request, "e2e-member-owner");
  const created = await request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: groupName } });
  const gid = ((await created.json()) as { id: string }).id;
  const ensured = await request.post(`/api/groups/${gid}/participants`, { data: { requestId: crypto.randomUUID(), names } });
  const ids = ((await ensured.json()) as { participants: { id: string }[] }).participants.map((p) => p.id);
  for (let i = 0; i < 2; i++) {
    const res = await request.post(`/api/groups/${gid}/matches/backfill`, {
      data: {
        requestId: uniqueUser(`seed-${i}`),
        playedAt: new Date(Date.now() - (5 - i) * 3600_000).toISOString(),
        roster: ids.slice(0, 10).map((id, k) => ({ participantId: id, team: k < 5 ? "A" : "B", position: null })),
        winnerTeam: i === 0 ? "A" : "B",
        winnerSide: "unknown",
      },
    });
    expect(res.ok()).toBe(true);
  }
  return { gid, ids };
}

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  return context.newPage();
}

/** API로 연결: 운영자가 링크를 만들고 멤버 계정이 수락한다. */
async function linkByApi(owner: APIRequestContext, member: APIRequestContext, gid: string, pid: string): Promise<void> {
  const link = await owner.post(`/api/groups/${gid}/participants/${pid}/claim-link`);
  const token = ((await link.json()) as { token: string }).token;
  await apiLogin(member, "e2e-member");
  expect((await member.post(`/api/claim/${token}/accept`)).ok()).toBe(true);
}

test("운영자가 연결 링크 발급 → 다른 계정이 수락 → 내 전적 → 내 기피 라인 → 운영자 화면에 반영", async ({ browser }) => {
  test.setTimeout(120000);
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const owner = await ownerContext.newPage();
  const { gid, ids } = await seed(owner.request, "연결 모임");

  // 운영자: 모임 탭 참가자 목록 → 멤버01 수정 → 연결 링크 만들기 → 복사.
  await owner.goto("/#/group");
  const people = owner.getByRole("region", { name: "참가자", exact: true });
  await people.getByRole("listitem").filter({ hasText: "멤버01" }).getByRole("button", { name: "수정" }).click();
  const edit = owner.getByRole("dialog", { name: "멤버01 수정" });
  await expect(edit.getByRole("region", { name: "익명 처리" })).toContainText("되돌릴 수 없어요");
  await edit.getByRole("button", { name: "연결 링크 만들기" }).click();
  await edit.getByRole("button", { name: "연결 링크 복사" }).click();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#\/claim\/[\w-]+$/);
  await noOverflow(owner, "참가자 수정 창");
  await owner.keyboard.press("Escape");

  // 다른 계정(로그인 안 한 브라우저): 링크 → 로그인하고 계속 → 확인 → 참가 중인 모임 화면.
  const member = await newPage(browser);
  await member.goto(link);
  await expect(member.getByText("'멤버01'을(를) 내 계정에 연결할까요?")).toBeVisible();
  await member.getByRole("button", { name: "로그인하고 계속" }).click();
  const login = member.getByRole("dialog", { name: "로그인" });
  await login.getByLabel("계정 이름").fill(uniqueUser("e2e-member"));
  await login.getByRole("button", { name: "개발용 로그인" }).click();
  await member.getByRole("button", { name: "내 계정에 연결" }).click();
  await expect(member).toHaveURL(new RegExp(`#/mine/${gid}$`));
  await expect(member.getByRole("heading", { name: "내 정보", level: 1 })).toBeVisible();
  await expect(member.getByRole("region", { name: "내 이름" })).toContainText("멤버01");
  // 운영 탭(오늘·기록·모임)은 보이지 않고 조회 메뉴를 쓴다. 티어는 보이지 않는다.
  await expect(member.getByRole("navigation", { name: "주 메뉴" })).toHaveCount(0);
  await expect(member.getByRole("navigation", { name: "조회 메뉴" })).toBeVisible();
  await expect(member.locator("body")).not.toContainText("티어");
  await noOverflow(member, "멤버 내 정보");

  // 내 전적 바로 가기.
  await member.getByRole("button", { name: "내 전적 보기" }).click();
  await expect(member).toHaveURL(new RegExp(`#/mine/${gid}/p/${ids[0]}$`));
  await expect(member.getByText("멤버01").first()).toBeVisible();
  await expect(member.getByText("1승 1패").first()).toBeVisible();
  await noOverflow(member, "멤버 개인 통계");

  // 내 기피 라인: 서폿을 고른다.
  await member.getByRole("navigation", { name: "조회 메뉴" }).getByRole("button", { name: "내 정보" }).click();
  const avoid = member.getByRole("region", { name: "내 기피 라인" });
  await avoid.getByRole("button", { name: "서폿 기피" }).click();
  await expect(avoid.getByRole("button", { name: "서폿 기피" })).toHaveAttribute("aria-pressed", "true");
  await expect(avoid).toContainText("지금: 서폿 · 내가 정함");

  // 계정 메뉴에 참가 중인 모임이 보인다.
  await member.getByRole("button", { name: "로그인됨" }).click();
  await expect(member.getByRole("group", { name: "참가 중인 모임" })).toContainText("연결 모임");
  await member.keyboard.press("Escape");

  // 운영자: 기피 라인 화면에 반영되고 "본인이 정함", 참가자 목록에 "연결됨".
  await owner.goto("/#/priority/avoid");
  // 다른 기기(멤버)가 바꾼 내용은 화면을 다시 불러와야 보인다(실시간 통신 없음).
  await owner.reload();
  const row = owner.getByRole("list", { name: "기피 라인 목록" }).getByRole("listitem").filter({ hasText: "멤버01" });
  await expect(row).toContainText("본인이 정함");
  await expect(row.getByRole("button", { name: "멤버01 서폿 기피" })).toHaveAttribute("aria-pressed", "true");
  await owner.goto("/#/group");
  await expect(
    owner.getByRole("region", { name: "참가자", exact: true }).getByRole("listitem").filter({ hasText: "멤버01" }),
  ).toContainText("연결됨");
  await noOverflow(owner, "기피 라인·모임 탭");
});

test("멤버가 신청 링크에서 본인 확인 신청 → 로그인 안 한 사람은 못 뺀다", async ({ browser }) => {
  const owner = await newPage(browser);
  const { gid, ids } = await seed(owner.request, "본인 신청 모임");
  const token = ((await (await owner.request.post(`/api/groups/${gid}/join/link`)).json()) as { token: string }).token;
  const member = await newPage(browser);
  await linkByApi(owner.request, member.request, gid, ids[1]!);

  await member.goto(`/#/join/${token}`);
  const mine = member.getByRole("region", { name: "내 이름으로 신청" });
  await expect(mine).toContainText("멤버02");
  await mine.getByRole("button", { name: "멤버02(으)로 오늘 참가" }).click();
  const signed = member.getByRole("region", { name: "신청한 사람" });
  await expect(signed.getByRole("listitem").filter({ hasText: "멤버02" })).toContainText("본인 확인됨");
  await expect(mine).toContainText("본인 확인된 신청이에요");
  await expect(signed.getByRole("button", { name: "멤버02 신청 취소" })).toBeVisible();
  await noOverflow(member, "멤버 신청 화면");

  // 로그인 안 한 사람: 본인 확인 표시가 보이고 취소 버튼이 없다. API로 빼도 거절된다.
  const guest = await newPage(browser);
  await guest.goto(`/#/join/${token}`);
  const guestList = guest.getByRole("region", { name: "신청한 사람" });
  await expect(guestList.getByRole("listitem").filter({ hasText: "멤버02" })).toContainText("본인 확인됨");
  await expect(guestList.getByRole("button", { name: "멤버02 신청 취소" })).toHaveCount(0);
  await expect(guest.getByRole("region", { name: "내 이름으로 신청" })).toHaveCount(0);
  const denied = await guest.request.post(`/api/join/${token}/cancel`, { data: { key: `p:${ids[1]}` } });
  expect(denied.status()).toBe(403);
  // 익명 신청은 예전처럼 누구나 넣고 뺀다.
  await guest.getByRole("button", { name: "멤버03 오늘 참가" }).click();
  await guestList.getByRole("button", { name: "멤버03 신청 취소" }).click();
  await expect(guestList.getByRole("listitem")).toHaveCount(1);
  await noOverflow(guest, "공개 신청 화면");

  // 운영자 화면(고르기)의 신청 목록에도 본인 확인됨.
  await owner.goto("/#/pick");
  await expect(owner.getByRole("list", { name: "신청자 목록" })).toContainText("본인 확인됨");
});

test("멤버가 정정 요청 → 운영자가 처리 → 멤버에게 상태가 보인다", async ({ browser }) => {
  const owner = await newPage(browser);
  const { gid, ids } = await seed(owner.request, "요청 모임");
  const member = await newPage(browser);
  await linkByApi(owner.request, member.request, gid, ids[2]!);

  await member.goto(`/#/mine/${gid}`);
  const form = member.getByRole("region", { name: "요청 남기기" });
  await form.getByLabel("경기 결과 정정 요청").check();
  await form.getByLabel("정정할 경기").selectOption({ index: 1 });
  await form.getByLabel("요청 내용").fill("레드팀이 이겼어요\n<b>확인</b> 부탁해요");
  await form.getByRole("button", { name: "요청 보내기" }).click();
  const mineList = member.getByRole("list", { name: "내 요청 목록" });
  await expect(mineList.getByRole("listitem")).toHaveCount(1);
  await expect(mineList).toContainText("처리 대기");
  // 글은 그대로 글자로 보인다(HTML로 해석하지 않음).
  await expect(mineList).toContainText("<b>확인</b> 부탁해요");
  await noOverflow(member, "멤버 요청");

  // 운영자: 모임 탭 "참가자 요청"에 배지와 요청, 경기로 가는 링크, 처리함 + 답.
  await owner.goto("/#/group");
  const section = owner.getByRole("region", { name: "참가자 요청" });
  await expect(section.getByLabel("처리할 요청 1개")).toBeVisible();
  const item = section.getByRole("list", { name: "처리할 요청" }).getByRole("listitem");
  await expect(item).toContainText("멤버03");
  await expect(item).toContainText("레드팀이 이겼어요");
  await expect(item.getByRole("button", { name: /경기 보기$/ })).toBeVisible();
  await noOverflow(owner, "참가자 요청 구역");
  await item.getByRole("button", { name: "처리함" }).click();
  const dialog = owner.getByRole("dialog", { name: "처리함으로 표시" });
  await dialog.getByLabel("운영자 답").fill("고쳤어요");
  await dialog.getByRole("button", { name: "처리함으로 표시" }).click();
  await expect(section).toContainText("처리할 요청이 없어요.");
  await expect(section.getByText("처리한 요청 1개")).toBeVisible();

  // 멤버: 새로 고치면 상태와 답이 보인다.
  await member.getByRole("button", { name: "새로 고침" }).click();
  await expect(mineList).toContainText("처리함");
  await expect(mineList).toContainText("운영자 답: 고쳤어요");
});
