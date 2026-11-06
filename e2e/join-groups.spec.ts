import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 참가 신청 링크(로그인 없이 신청 → 고르기 화면에서 불러오기 → 준비 화면)와 모임 고르기(한 계정 여러 모임).

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(request: APIRequestContext, prefix: string): Promise<void> {
  const response = await request.post("/api/auth/fake-login", { data: { subject: uniqueUser(prefix) } });
  expect(response.ok()).toBe(true);
}

async function makeGroup(request: APIRequestContext, name: string, names: string[]): Promise<string> {
  const created = await request.post("/api/groups", { data: { name } });
  expect(created.ok()).toBe(true);
  const gid = ((await created.json()) as { id: string }).id;
  expect((await request.post(`/api/groups/${gid}/participants`, { data: { names } })).ok()).toBe(true);
  return gid;
}

async function noOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

test("참가 신청: 링크 → 로그인 없는 사람이 신청 → 운영자가 불러와 준비 화면으로", async ({ browser }) => {
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const owner = await ownerContext.newPage();
  await apiLogin(owner.request, "e2e-join-owner");
  const names = Array.from({ length: 12 }, (_, i) => `신청선수${i + 1}`);
  await makeGroup(owner.request, "신청 모임", names);

  // 운영자: 참가자 고르기 화면 위쪽 "참가 신청"에서 링크를 만들고 복사한다.
  await owner.goto("/#/pick");
  const panel = owner.getByRole("region", { name: "참가 신청" });
  await expect(panel).toContainText("본인 확인이 없어");
  await expect(panel.getByText("아직 신청한 사람이 없어요.")).toBeVisible();
  await panel.getByRole("button", { name: "신청 링크 만들기" }).click();
  await panel.getByRole("button", { name: "신청 링크 복사" }).click();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#\/join\/[\w-]+$/);
  await noOverflow(owner, "고르기 화면(신청 구역)");

  // 로그인하지 않은 다른 브라우저: 신청 화면에서 자기 이름을 눌러 신청한다.
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  await guest.goto(link);
  await expect(guest.getByRole("heading", { name: "신청 모임 참가 신청", level: 1 })).toBeVisible();
  await expect(guest.getByText("0 / 10명")).toBeVisible();
  await expect(guest.getByRole("button", { name: "로그인" })).toHaveCount(0);
  await guest.getByLabel("이름 검색").fill("신청선수3");
  await guest.getByRole("button", { name: "신청선수3 오늘 참가" }).click();
  await expect(guest.getByText("1 / 10명")).toBeVisible();
  for (const n of [1, 2, 4, 5, 6, 7, 8, 9]) {
    await guest.getByRole("button", { name: `신청선수${n} 오늘 참가`, exact: true }).click();
    await expect(guest.getByRole("region", { name: "신청한 사람" })).toContainText(`신청선수${n}`);
  }
  // 명단에 없는 새 이름, 그리고 열한 번째(대기).
  await guest.getByRole("textbox", { name: "새 이름" }).fill("새로온친구");
  await guest.getByRole("button", { name: "신청", exact: true }).click();
  await expect(guest.getByText("10 / 10명")).toBeVisible();
  await guest.getByRole("button", { name: "신청선수11 오늘 참가" }).click();
  await expect(guest.getByText("11 / 10명")).toBeVisible();
  const signed = guest.getByRole("region", { name: "신청한 사람" });
  await expect(signed.getByRole("listitem").last()).toContainText("대기");
  // 취소하고 다시 신청: 맨 뒤로 간다.
  await signed.getByRole("button", { name: "신청선수1 신청 취소" }).click();
  await expect(guest.getByText("10 / 10명")).toBeVisible();
  await guest.getByRole("button", { name: "신청선수1 오늘 참가", exact: true }).click();
  await expect(signed.getByRole("listitem")).toHaveCount(11);
  await noOverflow(guest, "공개 신청 화면");

  // 운영자: 새로 고쳐 신청 순 목록을 보고 "불러오기" → 앞 10명 선택, 11번째는 대기.
  await panel.getByRole("button", { name: "새로 고침" }).click();
  const list = panel.getByRole("list", { name: "신청자 목록" });
  await expect(list.getByRole("listitem")).toHaveCount(11);
  await expect(list.getByRole("listitem").first()).toContainText("신청선수3");
  await expect(list.getByRole("listitem").last()).toContainText("신청선수1");
  await expect(list.getByRole("listitem").last()).toContainText("대기");
  await expect(list.getByRole("listitem").filter({ hasText: "새로온친구" })).toContainText("새 이름");
  await panel.getByRole("button", { name: "신청자 11명 불러오기" }).click();
  await expect(owner.getByText("대기 1명(신청선수1)")).toBeVisible();
  const chosen = owner.getByRole("region", { name: "선택된 참가자" });
  await expect(chosen.getByRole("listitem")).toHaveCount(10);
  await expect(chosen).toContainText("새로온친구");
  await expect(chosen.getByRole("button", { name: "신청선수1 빼기" })).toHaveCount(0);
  // 불러온 뒤에도 손으로 바꿀 수 있다: 한 명 빼고 대기자를 넣는다.
  await chosen.getByRole("button", { name: "신청선수9 빼기" }).click();
  await owner.getByRole("region", { name: "전체 참가자" }).getByRole("button", { name: /^신청선수1\b/ }).click();
  await expect(chosen.getByRole("listitem")).toHaveCount(10);
  await noOverflow(owner, "불러온 뒤 고르기 화면");
  await owner.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(owner.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await expect(owner.getByText("새로온친구").first()).toBeVisible();

  // 신청 목록은 자동으로 지우지 않는다. 닫으면 공개 화면이 신청을 받지 않는다.
  await owner.goto("/#/pick");
  await expect(panel.getByRole("list", { name: "신청자 목록" }).getByRole("listitem")).toHaveCount(11);
  await panel.getByRole("button", { name: "신청 닫기" }).click();
  await expect(panel.getByText("닫힘")).toBeVisible();
  await guest.reload();
  await expect(guest.getByText("지금은 신청을 받지 않아요.")).toBeVisible();
  await expect(guest.getByRole("button", { name: /오늘 참가/ })).toHaveCount(0);
  // 비우기.
  await panel.getByRole("button", { name: "신청 비우기" }).click();
  await owner.getByRole("dialog", { name: "신청 비우기" }).getByRole("button", { name: "신청 비우기" }).click();
  await expect(panel.getByText("아직 신청한 사람이 없어요.")).toBeVisible();

  await ownerContext.close();
  await guestContext.close();
});

test("모임 고르기: 모임이 있는 계정이 공동 운영 초대를 수락하고, 두 모임을 바꿔 가며 따로 본다", async ({ browser }) => {
  // 다른 사람(대표)의 모임과 초대 링크.
  const hostContext = await browser.newContext();
  await apiLogin(hostContext.request, "e2e-host");
  await makeGroup(hostContext.request, "둘째 모임", Array.from({ length: 10 }, (_, i) => `베타${i + 1}`));
  const hostGroups = (await (await hostContext.request.get("/api/me")).json()) as { groups: { id: string }[] };
  const invite = (await (
    await hostContext.request.post(`/api/groups/${hostGroups.groups[0]!.id}/co-operators/invite`)
  ).json()) as { token: string };

  // 나: 내 모임이 이미 있다.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await apiLogin(page.request, "e2e-multi");
  await makeGroup(page.request, "첫째 모임", Array.from({ length: 10 }, (_, i) => `알파${i + 1}`));
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "첫째 모임", level: 1 })).toBeVisible();
  // 모임이 하나면 고르기 목록은 접혀 있다.
  await page.goto("/#/group");
  await expect(page.getByRole("region", { name: "모임 고르기" })).toHaveCount(0);
  await expect(page.getByText("내 모임 1/5 · 새 모임 만들기")).toBeVisible();

  // 첫째 모임에서 세 명을 골라 둔다.
  await page.goto("/#/pick");
  const everyone = page.getByRole("region", { name: "전체 참가자" });
  for (const n of [1, 2, 3]) await everyone.getByRole("button", { name: new RegExp(`^알파${n}\\b`) }).click();
  await expect(page.getByRole("region", { name: "선택된 참가자" }).getByRole("listitem")).toHaveCount(3);

  // 초대 수락(이미 모임이 있어도 된다) → 그 모임으로 바뀌어 열린다.
  await page.goto(`/#/co-invite/${invite.token}`);
  await page.getByRole("button", { name: "공동 운영자 되기" }).click();
  await expect(page.getByRole("heading", { name: "둘째 모임", level: 1 })).toBeVisible();

  // 둘째 모임의 고르기 화면: 베타만 보이고 첫째 모임에서 고른 목록은 섞이지 않는다.
  await page.goto("/#/pick");
  await expect(page.getByRole("button", { name: /^베타1\b/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^알파1\b/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "선택된 참가자" }).getByRole("listitem")).toHaveCount(0);

  // 모임 탭: 두 모임이 역할과 함께 보이고, 공동 운영 모임이라 대표 전용 구역은 없다.
  await page.goto("/#/group");
  const switcher = page.getByRole("region", { name: "모임 고르기" });
  await expect(switcher).toContainText("내 모임 2/5");
  const rows = switcher.getByRole("list", { name: "내 모임 목록" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "첫째 모임" })).toContainText("대표");
  await expect(rows.filter({ hasText: "둘째 모임" })).toContainText("공동 운영자");
  await expect(rows.filter({ hasText: "둘째 모임" })).toContainText("지금 모임");
  await expect(page.getByRole("region", { name: "운영자 넘기기" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "공동 운영자에서 나가기" })).toBeVisible();
  await noOverflow(page, "모임 탭(두 모임)");

  // 첫째 모임으로 바꾸면 대표 구역이 보이고, 골라 둔 세 명이 그대로 있다.
  await switcher.getByRole("button", { name: "첫째 모임(대표) 열기" }).click();
  await expect(page.getByText("'첫째 모임' 모임으로 바꿨어요.")).toBeVisible();
  await expect(page.getByRole("region", { name: "운영자 넘기기" })).toBeVisible();
  await page.goto("/#/pick");
  await expect(page.getByRole("region", { name: "선택된 참가자" }).getByRole("listitem")).toHaveCount(3);
  await expect(page.getByRole("button", { name: /^베타1\b/ })).toHaveCount(0);
  // 10명을 채워 편성을 만든다.
  for (const n of [4, 5, 6, 7, 8, 9, 10]) await everyone.getByRole("button", { name: new RegExp(`^알파${n}\\b`) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await expect(page.getByText("알파1").first()).toBeVisible();

  // 상단 계정 메뉴에서 둘째 모임으로: 첫째 모임 편성은 맡겨 두고 둘째 모임에는 편성이 없다.
  await page.getByRole("button", { name: "로그인됨" }).click();
  await page.getByRole("group", { name: "모임 바꾸기" }).getByRole("button", { name: "둘째 모임 · 공동 운영자" }).click();
  await expect(page.getByText("작성 중인 편성이 없어요.")).toBeVisible();
  await page.goto("/#/records");
  await expect(page.getByText("알파1")).toHaveCount(0);

  // 새로 고쳐도 고른 모임(둘째)이 열린다.
  await page.goto("/#/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "둘째 모임", level: 1 })).toBeVisible();

  // 다시 첫째 모임: 맡겨 둔 편성이 돌아온다.
  await page.getByRole("button", { name: "로그인됨" }).click();
  await page.getByRole("group", { name: "모임 바꾸기" }).getByRole("button", { name: "첫째 모임 · 대표" }).click();
  await expect(page.getByRole("heading", { name: "첫째 모임", level: 1 })).toBeVisible();
  await page.goto("/#/prep");
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await expect(page.getByText("알파1").first()).toBeVisible();
  await noOverflow(page, "준비 화면(돌아온 편성)");

  // 새 모임 만들기(계정당 5개 안내) → 그 모임으로 바뀐다.
  await page.goto("/#/group");
  await expect(switcher).toContainText("5개까지");
  await switcher.getByLabel("새 모임 이름").fill("셋째 모임");
  await switcher.getByRole("button", { name: "새 모임 만들기" }).click();
  await expect(page.getByText("새 모임을 만들고 그 모임으로 바꿨어요.")).toBeVisible();
  await expect(switcher).toContainText("내 모임 3/5");
  await expect(rows.filter({ hasText: "셋째 모임" })).toContainText("지금 모임");

  await context.close();
  await hostContext.close();
});
