import { expect, test, type Locator, type Page } from "@playwright/test";

// 준비 화면의 팀 섞기 2종(올랜덤, 올랜덤 + 서포터 공평하게), 서포터만 바꾸기, 서포터 횟수 초기화, 블루팀·레드팀과 진영 바꾸기.

test.use({ viewport: { width: 390, height: 844 } });

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

/** 로그인하고 12명 모임을 만든 뒤 참가자 고르기에서 앞 10명으로 준비 화면을 연다. */
async function openPrep(page: Page, prefix: string): Promise<{ names: string[]; groupId: string }> {
  const login = await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser(prefix) } });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "섞기 모임" } })).json()) as { id: string };
  const names = Array.from({ length: 12 }, (_, i) => `섞기${String(i + 1).padStart(2, "0")}`);
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names } });
  expect(ensured.ok()).toBe(true);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  return { names, groupId: group.id };
}

async function startMatch(page: Page) {
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const heading = page.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(heading)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
  await expect(heading).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const rows = (team: Locator) => team.getByRole("list").first().getByRole("button");

test("올랜덤 → 블루팀·레드팀 → 진영 바꾸기·진영 랜덤 → 시작하면 블루·레드로 저장되고 결과 입력 창에 미리 골라져 있다", async ({
  page,
}) => {
  const { groupId } = await openPrep(page, "e2e-shuffle");
  const teamA = page.getByRole("region", { name: "블루팀" });
  const teamB = page.getByRole("region", { name: "레드팀" });
  const tools = page.getByRole("region", { name: "섞기" });
  await expect(tools.getByRole("button", { name: "라인만 섞기", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "라인 섞기 + 서폿 돌아가며" })).toBeVisible();
  await expect(tools.getByRole("button", { name: "서포터만 바꾸기" })).toBeVisible();
  await noHorizontalOverflow(page);

  // 올랜덤을 여러 번 눌러도 늘 5:5이고 팀원은 그대로다(라인만 섞는다). 한 번은 라인이 달라진다.
  const before = await rows(teamA).allInnerTexts();
  const members = (texts: string[]) => texts.map((t) => t.match(/섞기\d\d/)![0]).sort();
  let changed = false;
  for (let i = 0; i < 5; i++) {
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    await expect(rows(teamA)).toHaveCount(5);
    await expect(rows(teamB)).toHaveCount(5);
    const now = await rows(teamA).allInnerTexts();
    expect(members(now)).toEqual(members(before));
    if (JSON.stringify(now) !== JSON.stringify(before)) changed = true;
  }
  expect(changed).toBe(true);
  // "포지션 다시 뽑기"는 올랜덤과 같은 일이라 없앴다.
  await expect(page.getByRole("button", { name: "포지션 다시 뽑기" })).toHaveCount(0);
  // 직전 편성으로 되돌릴 수 있다.
  await expect(page.getByRole("button", { name: "직전 편성으로" })).toBeVisible();

  // 팀 상자: 왼쪽 블루팀·오른쪽 레드팀, 진영 색 테두리. 준비 화면에 "팀 A/팀 B" 글자와 진영 고르기 칸은 없다.
  await expect(teamA.getByRole("heading")).toHaveText("● 블루팀");
  await expect(teamB.getByRole("heading")).toHaveText("■ 레드팀");
  await expect(teamA).toHaveClass(/side-blue/);
  await expect(teamB).toHaveClass(/side-red/);
  const border = (box: Locator) => box.evaluate((el) => getComputedStyle(el).borderTopColor);
  expect(await border(teamA)).not.toBe(await border(teamB));
  const a = (await teamA.boundingBox())!;
  const b = (await teamB.boundingBox())!;
  expect(a.x).toBeLessThan(b.x);
  await expect(page.locator("#root")).not.toContainText(/팀 [AB]/);
  const sides = page.getByRole("region", { name: "진영" });
  await expect(sides.getByRole("radio")).toHaveCount(0);
  await expect(page.getByText("나중에 정하기")).toHaveCount(0);

  // 진영 바꾸기: 블루팀 5명과 레드팀 5명이 서로 바뀐다(라인은 사람을 따라간다). 두 번 누르면 원래대로.
  const blueRows = await rows(teamA).allInnerTexts();
  const redRows = await rows(teamB).allInnerTexts();
  await tools.getByRole("button", { name: "진영 바꾸기" }).click();
  await expect(page.locator(".toast")).toContainText("블루팀과 레드팀을 맞바꿨어요.");
  expect(await rows(teamB).allInnerTexts()).toEqual(blueRows);
  expect(await rows(teamA).allInnerTexts()).toEqual(redRows);
  await expect(teamA.getByRole("heading")).toHaveText("● 블루팀");
  await tools.getByRole("button", { name: "진영 바꾸기" }).click();
  expect(await rows(teamA).allInnerTexts()).toEqual(blueRows);
  expect(await rows(teamB).allInnerTexts()).toEqual(redRows);

  // 진영 랜덤: 두 팀을 맞바꾸거나 그대로 둔다. 상자 이름은 그대로 블루팀·레드팀이다.
  await sides.getByRole("button", { name: "진영 랜덤" }).click();
  await expect(page.locator(".toast")).toContainText("진영 랜덤");
  const randomBlue = await rows(teamA).allInnerTexts();
  expect([blueRows, redRows]).toContainEqual(randomBlue);
  await expect(teamA.getByRole("heading")).toHaveText("● 블루팀");
  await noHorizontalOverflow(page);

  // 진영 바꾸기로 지금 블루팀을 정한 뒤 시작한다.
  if (JSON.stringify(randomBlue) !== JSON.stringify(redRows)) await tools.getByRole("button", { name: "진영 바꾸기" }).click();
  expect(await rows(teamA).allInnerTexts()).toEqual(redRows);
  const blueNames = members(redRows);
  await startMatch(page);
  // 서버에 팀 A = 블루로 저장된다. 팀 A는 준비 화면의 블루팀 사람들이다.
  const snap = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  const started = snap.matches.find((m: { state: string }) => m.state === "in_progress");
  expect(started.teamASide).toBe("blue");
  const nameOfId = new Map(snap.participants.map((x: { id: string; name: string }) => [x.id, x.name]));
  const startedA = started.roster
    .filter((r: { team: string }) => r.team === "A")
    .map((r: { participantId: string }) => nameOfId.get(r.participantId))
    .sort();
  expect(startedA).toEqual(blueNames);
  // 진행 화면: 블루팀 / 레드팀.
  await expect(page.getByRole("region", { name: "블루팀" }).getByRole("heading")).toHaveText("● 블루팀");
  await expect(page.getByRole("region", { name: "레드팀" }).getByRole("heading")).toHaveText("■ 레드팀");
  await expect(page.getByRole("region", { name: "블루팀" })).toHaveClass(/side-blue/);

  // 결과 입력: "블루팀 승 / 레드팀 승" 큰 버튼을 고르면 그 진영이 미리 골라져 있고, 접힘 영역에서 바꿀 수 있다.
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  await sheet.getByRole("button", { name: /레드팀 승/ }).click();
  await sheet.getByText("진영이 시작할 때와 달랐나요?").click();
  await expect(sheet.getByRole("radio", { name: "레드", exact: true })).toBeChecked();
  await expect(sheet.getByText("시작할 때 정한 진영으로 미리 골라 뒀어요.")).toBeVisible();
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  await expect(sheet.getByRole("radio", { name: "블루", exact: true })).toBeChecked();
  await sheet.getByRole("radio", { name: "기억나지 않음" }).check();
  await expect(sheet.getByText("1경기 · 팀 A 승 · 진영 미상")).toBeVisible();
  await sheet.getByRole("radio", { name: "블루", exact: true }).check();
  await expect(sheet.getByText("1경기 · 블루팀 승", { exact: true })).toBeVisible();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();
});

test("올랜덤 + 서포터 공평하게 → 시작 → 결과 → 다음 준비에 '서폿 1회' → 서포터만 바꾸기는 0회인 사람 → 초기화는 아직 꺼짐", async ({
  page,
}) => {
  await openPrep(page, "e2e-fair");
  const tools = page.getByRole("region", { name: "섞기" });
  await tools.getByRole("button", { name: "라인 섞기 + 서폿 돌아가며" }).click();
  await expect(page.getByText("팀마다 서포터를 아직 안 간 사람으로 정했어요.")).toBeVisible();
  // 처음에는 아무도 서포터를 하지 않았다.
  await expect(page.getByText(/서폿 \d회/)).toHaveCount(0);
  const teams = [page.getByRole("region", { name: "블루팀" }), page.getByRole("region", { name: "레드팀" })];
  // 각 팀의 다섯째 줄이 서포터 자리다(탑~서포터 순).
  const supporterNames = await Promise.all(teams.map((t) => rows(t).nth(4).innerText()));

  await startMatch(page);
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: "1경기 결과" });
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  await sheet.getByText("진영이 시작할 때와 달랐나요?").click();
  await sheet.getByRole("radio", { name: "블루", exact: true }).check();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨")).toBeVisible();
  await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  // 방금 서포터였던 두 사람에게 "서폿 1회"가 붙는다(팀 상자 안).
  const teamRows = page.locator(".teams").getByRole("button");
  await expect(teamRows.filter({ hasText: "서폿 1회" })).toHaveCount(2);
  const counted = await teamRows.filter({ hasText: "서폿 1회" }).allInnerTexts();
  for (const shown of supporterNames) {
    const name = shown.split("\n").map((x) => x.trim()).filter((x) => /^섞기\d\d$/.test(x))[0]!;
    expect(counted.some((t) => t.includes(name))).toBe(true);
  }

  // 서포터만 바꾸기: 팀마다 서포터가 0회인 사람이 된다(나머지 8명은 그대로).
  await page.getByRole("region", { name: "섞기" }).getByRole("button", { name: "서포터만 바꾸기" }).click();
  for (const team of teams) {
    await expect(rows(team).nth(4)).not.toContainText(/서폿 \d회/);
  }

  // 서포터 횟수 보기: 두 사람 1회. 아직 안 간 사람이 팀마다 있어도 초기화 버튼은 누를 수 있고(2026-11-06 변경),
  // 옆의 이유 글과 확인 창의 경고로 알린다.
  await page.getByText(/^서포터 횟수: 2명 기록/).click();
  const list = page.getByRole("list", { name: "서포터 횟수 목록" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "서포터 횟수 초기화" })).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("아직 서포터를 안 간 사람이 있어요");
  await expect(page.getByText("아직 서포터를 안 간 사람이 있어요.", { exact: false })).toBeVisible();

  // 누르면 바로 지워지지 않고 경고가 든 확인 창이 뜬다. "그대로 두기"면 횟수가 남는다.
  await page.getByRole("button", { name: "서포터 횟수 초기화" }).click();
  const dialog = page.getByRole("dialog", { name: "서포터 횟수 초기화" });
  await expect(dialog.getByRole("alert")).toContainText("아직 서포터를 안 간 사람이 있어요");
  await dialog.getByRole("button", { name: "그대로 두기" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(list.getByRole("listitem")).toHaveCount(2);

  // 동의하면 모두 0이 된다.
  await page.getByRole("button", { name: "서포터 횟수 초기화" }).click();
  await dialog.getByRole("button", { name: "초기화", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/서폿 \d회/)).toHaveCount(0);
});
