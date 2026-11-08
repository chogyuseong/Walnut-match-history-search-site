import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 사용자 편의 기능 6가지(2026-11-07)를 휴대폰 폭(390px)에서 확인한다.
// 1) 참가자용 편성 링크  2) 결과 입력 2버튼  3) 지난 내전 참가자 그대로  4) 오늘 요약 공유  5) 상대 전적 보기  6) 진행 중 교체
// 모임·참가자·지난 경기는 API로 빠르게 만들고, 확인할 흐름은 화면으로 한다.

test.use({ viewport: { width: 390, height: 844 } });

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-conv-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, s: Setup) {
  return (await request.get(`/api/groups/${s.groupId}/snapshot`)).json();
}

/** 12명 모임(선수01~12). rotation이 false면 서포터 순환을 끈다(같은 명단을 반복해서 쓰려고). */
async function setup(page: Page, name: string, rotation = false): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-conv-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  if (!rotation) {
    const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
    const res = await request.put(`/api/groups/${group.id}/settings`, {
      data: {
        requestId: requestId(),
        baseSettingsVersionId: snapshot.group.settingsVersionId,
        settings: { ...snapshot.group.settings, rotationEnabled: false },
      },
    });
    expect(res.ok()).toBe(true);
  }
  return { groupId: group.id, people: ensured.participants };
}

function rosterOf(ten: { id: string }[]) {
  return ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] }));
}

async function startApi(request: APIRequestContext, s: Setup, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, s);
  return (
    await post(request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: rosterOf(ten),
      teamASide: "blue",
    })
  ).match;
}

async function resultApi(request: APIRequestContext, s: Setup, match: { id: string; version: number }, winnerTeam: "A" | "B") {
  return (
    await post(request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: match.version,
      winnerTeam,
      winnerSide: winnerTeam === "A" ? "blue" : "red",
    })
  ).match;
}

async function playApi(request: APIRequestContext, s: Setup, ten: { id: string }[], winnerTeam: "A" | "B") {
  return resultApi(request, s, await startApi(request, s, ten), winnerTeam);
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

test("1) 참가자에게 편성 보내기: 링크를 복사하고, 로그인 없는 휴대폰에서 블루·레드 10명과 포지션만 가볍게 본다", async ({
  page,
  browser,
}) => {
  const s = await setup(page, "편성 링크 모임");
  const match = await startApi(page.request, s, s.people.slice(0, 10));
  const token = (await snapshotOf(page.request, s)).group.viewToken as string;
  await page.goto("/#/match");
  await expect(page.getByRole("heading", { name: "1경기 진행 중" })).toBeVisible();

  await page.getByRole("button", { name: "참가자에게 편성 보내기" }).click();
  const dialog = page.getByRole("dialog", { name: "참가자에게 편성 보내기" });
  await expect(dialog.getByText("티어·서포터 횟수는 보이지 않아요.", { exact: false })).toBeVisible();
  await noHorizontalOverflow(page, "편성 보내기 창");
  // 클립보드가 막힌 브라우저에서는 직접 복사할 글 상자가 뜬다. 어느 쪽이든 /live 주소다.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await dialog.getByRole("button", { name: "편성 링크 복사" }).click();
  const manual = dialog.locator("textarea");
  const copied = dialog.getByRole("button", { name: "복사했어요" });
  await expect(manual.or(copied)).toBeVisible();
  const link = (await manual.isVisible())
    ? await manual.inputValue()
    : await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(new RegExp(`/#/v/${token}/live$`));
  await dialog.getByRole("button", { name: "닫기" }).click();

  // 로그인 없는 다른 브라우저(참가자 휴대폰).
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  const scripts: string[] = [];
  guest.on("request", (req) => {
    if (req.resourceType() === "script") scripts.push(req.url());
  });
  await guest.goto(`/#/v/${token}/live`);
  await expect(guest.getByRole("heading", { name: "1경기 편성" })).toBeVisible();
  await expect(guest.getByText(/진행 중 · .+ 시작/)).toBeVisible();
  const blue = guest.getByRole("region", { name: "블루팀" });
  const red = guest.getByRole("region", { name: "레드팀" });
  await expect(blue.getByRole("listitem")).toHaveCount(5);
  await expect(red.getByRole("listitem")).toHaveCount(5);
  await expect(blue.getByRole("listitem").first()).toContainText("탑");
  await expect(blue.getByRole("listitem").first()).toContainText("선수01");
  await expect(red.getByRole("listitem").last()).toContainText("서폿");
  await expect(red.getByRole("listitem").last()).toContainText("선수10");
  await expect(guest.locator("#root")).not.toContainText(/티어|서폿 \d회|기피/);
  await noHorizontalOverflow(guest, "참가자 편성 화면");
  // 조회 화면 묶음(기록·통계)은 받지 않고 작은 편성 묶음만 받는다.
  expect(scripts.some((u) => /\/assets\/ViewerLive-/.test(u))).toBe(true);
  expect(scripts.some((u) => /\/assets\/Viewer-/.test(u))).toBe(false);

  // 결과를 넣으면 "진행 중인 경기가 없어요"와 최근 경기 1개.
  await resultApi(page.request, s, match, "A");
  await guest.reload();
  await expect(guest.getByText("지금 진행 중인 경기가 없어요.")).toBeVisible();
  await expect(guest.getByRole("heading", { name: "최근 경기 · 1경기 · 블루팀 승" })).toBeVisible();
  await noHorizontalOverflow(guest, "참가자 편성 화면(경기 없음)");
  await guest.getByRole("link", { name: "기록 보기" }).click();
  await expect(guest.getByRole("navigation", { name: "조회 메뉴" })).toBeVisible();
  await guestContext.close();
});

test("2) 결과 입력 2버튼: 큰 버튼 두 개로 고르고 진영 정정은 접혀 있다. 저장 내용은 같다", async ({ page }) => {
  const s = await setup(page, "2버튼 모임");
  const match = await startApi(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  const blueWin = sheet.getByRole("button", { name: /블루팀 승/ });
  const redWin = sheet.getByRole("button", { name: /레드팀 승/ });
  for (const button of [blueWin, redWin]) {
    const box = (await button.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(120);
  }
  // 두 버튼이 나란히(한 손으로 누르기 쉬운 높이).
  expect((await blueWin.boundingBox())!.y).toBe((await redWin.boundingBox())!.y);
  await expect(sheet.getByRole("button", { name: "저장" })).toBeDisabled();
  await redWin.click();
  await expect(redWin).toHaveAttribute("aria-pressed", "true");
  await expect(blueWin).toHaveAttribute("aria-pressed", "false");
  await expect(sheet.getByText("1경기 · 레드팀 승", { exact: true })).toBeVisible();
  // 진영 정정은 접혀 있다(라디오가 보이지 않음).
  await expect(sheet.getByRole("radio", { name: "레드", exact: true })).toHaveCount(0);
  await expect(sheet.getByText("진영이 시작할 때와 달랐나요?")).toBeVisible();
  await noHorizontalOverflow(page, "결과 입력 2버튼");
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 레드팀 승")).toBeVisible();

  const saved = (await snapshotOf(page.request, s)).matches.find((m: { id: string }) => m.id === match.id);
  expect(saved.winnerTeam).toBe("B");
  expect(saved.teamASide).toBe("blue");
});

test("3) 지난 내전 참가자 그대로: 같은 날 두 경기의 참가자 전체를 고르고 10명 넘으면 대기자, 보관한 사람은 뺀다", async ({
  page,
}) => {
  const s = await setup(page, "지난 내전 모임");
  await page.goto("/#/pick");
  await expect(page.getByRole("heading", { name: "참가자 고르기" })).toBeVisible();
  // 경기가 없으면 버튼이 없다.
  await expect(page.getByRole("button", { name: /지난 내전 참가자 그대로/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /지난 참가자 불러오기/ })).toHaveCount(0);

  await playApi(page.request, s, s.people.slice(0, 10), "A");
  await playApi(page.request, s, s.people.slice(2, 12), "B");
  // 선수12는 보관한다.
  const archived = await page.request.patch(`/api/groups/${s.groupId}/participants/${s.people[11]!.id}`, {
    data: { requestId: crypto.randomUUID(), status: "archived" },
  });
  expect(archived.ok()).toBe(true);

  await page.reload();
  const button = page.getByRole("button", { name: /지난 내전 참가자 그대로 · .+ 11명/ });
  await expect(button).toBeVisible();
  await noHorizontalOverflow(page, "고르기 화면");
  await button.click();
  await expect(page.locator(".count")).toHaveText("10/10 +1");
  await expect(page.getByText("지난 내전(2경기)에 나온 11명을 골랐어요.", { exact: false })).toBeVisible();
  await expect(page.getByText("1명은 보관된 참가자라 뺐습니다.")).toBeVisible();
  const chips = page.getByRole("region", { name: "선택된 참가자" }).getByRole("listitem");
  await expect(chips).toHaveCount(11);
  await expect(chips.filter({ hasText: "선수12" })).toHaveCount(0);
  // 두 경기 모두 뛴 사람(선수03~10)이 앞, 한 경기만 뛴 선수01·02 중 하나가 대기자다.
  await expect(chips.filter({ hasText: "대기" })).toHaveCount(1);
  await expect(chips.first()).toContainText("선수03");
  await expect(page.getByRole("button", { name: "팀 짜기 (10명 + 대기 1명)" })).toBeEnabled();
});

test("4) 오늘 요약 공유: 경기 수·승 많은 순 승패·연승을 글과 이미지로 만든다. 오늘 경기가 없으면 버튼이 없다", async ({
  page,
}) => {
  const s = await setup(page, "요약 모임");
  await page.goto("/#/");
  await expect(page.getByRole("heading", { name: "요약 모임" })).toBeVisible();
  await expect(page.getByRole("button", { name: "오늘 요약 공유" })).toHaveCount(0);

  await playApi(page.request, s, s.people.slice(0, 10), "A");
  await playApi(page.request, s, s.people.slice(0, 10), "A");
  await page.reload();
  await page.getByRole("button", { name: "오늘 요약 공유" }).click();
  const dialog = page.getByRole("dialog", { name: "오늘 요약 공유" });
  const text = dialog.getByLabel("붙여 넣을 글");
  await expect(text).toContainText("요약 모임 ·");
  await expect(text).toContainText("확정 2경기 · 참가 10명");
  await expect(text).toContainText("선수01 2승 0패");
  await expect(text).toContainText("선수10 0승 2패");
  await expect(text).toContainText("서포터: 선수05 2번 · 선수10 2번");
  await expect(text).toContainText("연승 중: 선수01 2연승");
  await expect(text).not.toContainText(/티어/);
  // 승 많은 순: 첫 승패 줄이 2승이다.
  const lines = (await text.innerText()).split("\n");
  const first = lines[lines.indexOf("개인 승패 (승 많은 순)") + 1]!;
  expect(first).toMatch(/2승 0패$/);
  await expect(dialog.getByRole("button", { name: "글 복사" })).toBeVisible();
  await noHorizontalOverflow(page, "오늘 요약 공유 창");

  await dialog.getByRole("button", { name: "이미지로 만들기" }).click();
  const image = page.getByRole("dialog", { name: "오늘 요약 이미지" });
  await expect(image.getByRole("img", { name: "오늘 요약 이미지 미리보기" })).toBeVisible();
  await noHorizontalOverflow(page, "오늘 요약 이미지 창");
});

test("5) 상대 전적 보기(다른 플레이어와 비교): 개인 통계에서 상대를 고르면 맞대결·같은 팀 전적, 두 사람 비교로 이어진다", async ({ page }) => {
  const s = await setup(page, "상대 전적 모임");
  const [a, b] = [s.people[0]!, s.people[5]!];
  await playApi(page.request, s, s.people.slice(0, 10), "A"); // 선수01(A) vs 선수06(B): 선수01 승
  await playApi(page.request, s, s.people.slice(0, 10), "B"); // 선수01 패
  // 같은 팀: 선수01·선수06이 팀 A.
  const together = [a, b, s.people[1]!, s.people[2]!, s.people[3]!, s.people[4]!, ...s.people.slice(6, 10)];
  await playApi(page.request, s, together, "A");

  await page.goto(`/#/p/${a.id}`);
  const section = page.getByRole("region", { name: "다른 플레이어와 비교" });
  await section.scrollIntoViewIfNeeded();
  await section.getByLabel("상대 고르기").selectOption({ label: "선수06" });
  const list = section.getByRole("list", { name: "선수06 님과의 전적" });
  await expect(list.getByRole("listitem").filter({ hasText: "상대 팀으로" })).toContainText("50% · 1승 1패 (2경기)");
  await expect(list.getByRole("listitem").filter({ hasText: "같은 팀으로" })).toContainText("100% · 1승 0패 (1경기)");
  // 활성 참가자만 고를 수 있고 자기 자신은 없다.
  await expect(section.getByLabel("상대 고르기").locator("option", { hasText: "선수01" })).toHaveCount(0);
  await noHorizontalOverflow(page, "개인 통계 상대 전적");

  await section.getByRole("button", { name: /선수01 vs 선수06 비교 보기/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/compare/${a.id}/${b.id}$`));
  await expect(page.getByRole("heading", { name: "선수01 vs 선수06" })).toBeVisible();
  await expect(page.getByRole("region", { name: "상대일 때" })).toContainText("선수01 1승 : 1승 선수06");
});

test("6) 진행 중 화면에서 교체: 서포터를 누르고 다른 사람으로 바꾸면 자리·서포터 차례가 그대로 옮겨 간다", async ({
  page,
}) => {
  const s = await setup(page, "교체 모임", true);
  const match = await startApi(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await expect(page.getByRole("heading", { name: "1경기 진행 중" })).toBeVisible();
  const blue = page.getByRole("region", { name: "블루팀" });

  // 선수05 = 블루팀 서포터.
  await blue.getByRole("button", { name: /선수05 교체/ }).click();
  const dialog = page.getByRole("dialog", { name: "다른 사람으로 교체" });
  await expect(dialog.getByText("서포터 자리예요.", { exact: false })).toBeVisible();
  const candidates = dialog.getByRole("list", { name: "들어갈 사람" }).getByRole("button");
  // 명단 밖 활성 참가자 2명(선수11·12)만.
  await expect(candidates).toHaveCount(2);
  await noHorizontalOverflow(page, "교체 창");
  await candidates.filter({ hasText: "선수11" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".toast")).toContainText("선수05 자리에 선수11 님이 들어갔어요.");
  await expect(blue.getByRole("button").last()).toContainText("서폿");
  await expect(blue.getByRole("button").last()).toContainText("선수11");
  await expect(blue).not.toContainText("선수05");

  const snap = await snapshotOf(page.request, s);
  const live = snap.matches.find((m: { id: string }) => m.id === match.id);
  expect(live.state).toBe("in_progress");
  const seat = live.roster.find((r: { participantId: string }) => r.participantId === s.people[10]!.id);
  expect(seat).toMatchObject({ team: "A", position: "support" });
  const events = snap.rotation.events.filter((e: { matchId: string }) => e.matchId === match.id);
  expect(events.map((e: { participantId: string }) => e.participantId)).toContain(s.people[10]!.id);
  expect(events.map((e: { participantId: string }) => e.participantId)).not.toContain(s.people[4]!.id);
});
