import { expect, test, type Page } from "@playwright/test";

// 일괄 입력 되돌리기, 운영자 넘기기, 팀 조건, 경기 시각 정정을 실제 브라우저에서 확인한다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(page: Page, prefix: string): Promise<void> {
  const response = await page.request.post("/api/auth/fake-login", {
    data: { subject: uniqueUser(prefix) },
  });
  expect(response.ok()).toBe(true);
}

async function createGroup(page: Page, name: string): Promise<string> {
  const group = await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name } })).json();
  return group.id as string;
}

test.use({ viewport: { width: 390, height: 844 } });

test("일괄 입력으로 넣은 경기를 한 번에 전적 제외하고 복구한다", async ({ page }) => {
  await apiLogin(page, "e2e-undo");
  await createGroup(page, "되돌리기 모임");
  const names = Array.from({ length: 10 }, (_, i) => `옛선수${i + 1}`);
  const rows = ["2026-06-01", "2026-06-02", "2026-06-03"].map((date, i) =>
    [date, ...names, i === 1 ? "B" : "A"].join("\t"),
  );

  await page.goto("/#/import");
  await page.getByLabel("붙여 넣을 표").fill(rows.join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "3경기 넣기" }).click();
  await expect(page.getByText("3경기 저장됨 · 진영 미상")).toBeVisible();

  // 모임 탭에 이번 일괄 입력 기록이 보이고, 한 번에 전적 제외할 수 있다.
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "모임" }).click();
  const section = page.getByRole("region", { name: "표 일괄 입력" });
  await expect(section.getByRole("listitem")).toHaveCount(1);
  await expect(section.getByRole("listitem")).toContainText("3경기");
  await section.getByRole("button", { name: "모두 전적 제외" }).click();
  await expect(section.getByRole("button", { name: "모두 복구" })).toBeVisible();
  await expect(section.getByRole("listitem")).toContainText("전적 제외 3경기");

  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" }).click();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { name: /전체 경기 · 0경기 확정 · 전적 제외 3/ })).toBeVisible();
  await expect(page.getByText("이 범위에는 확정된 경기가 없어요.")).toBeVisible();

  // 같은 자리에서 복구하면 기록이 돌아온다.
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "모임" }).click();
  await section.getByRole("button", { name: "모두 복구" }).click();
  await expect(section.getByRole("button", { name: "모두 전적 제외" })).toBeVisible();
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" }).click();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { name: /전체 경기 · 3경기 확정/ })).toBeVisible();
});

test("운영자를 넘기면 받은 사람만 수정할 수 있다", async ({ browser }) => {
  const oldContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await oldContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const oldPage = await oldContext.newPage();
  await apiLogin(oldPage, "e2e-old");
  const groupId = await createGroup(oldPage, "넘겨줄 모임");

  // 현재 운영자가 인수 링크를 만든다.
  await oldPage.goto("/#/group");
  await oldPage
    .getByRole("region", { name: "운영자 넘기기" })
    .getByRole("button", { name: "인수 링크 만들기" })
    .click();
  const dialog = oldPage.getByRole("dialog", { name: "운영자 넘기기" });
  await expect(dialog).toContainText("한 번만 쓸 수 있고 24시간 뒤 만료");
  await dialog.getByRole("button", { name: "인수 링크 만들기" }).click();
  await dialog.getByRole("button", { name: "인수 링크 복사" }).click();
  await expect(dialog.getByRole("button", { name: "복사했어요" })).toBeVisible();
  const link = await oldPage.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#\/transfer\/[\w-]+$/);

  // 받는 사람: 링크를 열고 로그인한 뒤 수락한다.
  const newContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const newPage = await newContext.newPage();
  await newPage.goto(link);
  await expect(newPage.getByRole("heading", { name: "운영자 넘겨받기" })).toBeVisible();
  await expect(newPage.getByText("넘겨줄 모임")).toBeVisible();
  await newPage.getByRole("button", { name: "로그인하고 계속" }).click();
  const login = newPage.getByRole("dialog", { name: "로그인" });
  await login.getByLabel("계정 이름").fill(uniqueUser("e2e-new"));
  await login.getByRole("button", { name: "개발용 로그인" }).click();
  await newPage.getByRole("button", { name: "운영자 맡기" }).click();
  await expect(newPage.getByRole("heading", { name: "모임", level: 1 })).toBeVisible();
  await expect(newPage.getByRole("textbox", { name: "모임 이름" })).toHaveValue("넘겨줄 모임");

  // 새 운영자는 모임을 읽을 수 있고, 이전 운영자는 더 이상 읽지도 고치지도 못한다.
  expect((await newPage.request.get(`/api/groups/${groupId}/snapshot`)).status()).toBe(200);
  expect((await oldPage.request.get(`/api/groups/${groupId}/snapshot`)).status()).toBe(404);
  expect((await (await oldPage.request.get("/api/me")).json()).groups).toEqual([]);
  await oldPage.reload();
  await expect(oldPage.getByText("아직 모임이 없어요.")).toBeVisible();

  // 같은 링크는 다시 쓸 수 없다.
  const thirdContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const thirdPage = await thirdContext.newPage();
  await thirdPage.goto(link);
  await expect(thirdPage.getByText("이 링크는 이미 썼거나 만료됐습니다.")).toBeVisible();

  await oldContext.close();
  await newContext.close();
  await thirdContext.close();
});

test("같은 팀·다른 팀 조건이 팀 추천에 적용된다", async ({ page }) => {
  const names = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"].map((n) => `${n}선수`);
  await page.goto("/");
  await page.getByRole("button", { name: "이름 넣고 팀 짜기" }).click();
  await page.getByLabel("이름 검색 또는 새 이름 입력").fill(names.join("\n"));
  await page.getByRole("button", { name: "추가", exact: true }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();

  const teamA = page.getByRole("region", { name: "블루팀" });
  const nameAt = async (index: number) =>
    (await teamA.getByRole("button").nth(index).innerText()).split("\n").pop()!.trim();
  const first = await nameAt(0);
  const second = await nameAt(1);
  const third = await nameAt(2);

  // 같은 팀에 있는 두 사람을 "다른 팀"으로 묶으면 지금 편성과 다르다고 알려준다.
  await teamA.getByRole("button").nth(0).click();
  await page.getByRole("button", { name: "다른 팀으로 나누기" }).click();
  await expect(page.getByText("다른 팀으로 나눌 사람을 누르세요.")).toBeVisible();
  await teamA.getByRole("button").nth(1).click();
  const conditions = page.getByRole("group").filter({ hasText: "팀 조건 1개" });
  await expect(conditions).toContainText(`${first} · ${second} 다른 팀`);
  await expect(conditions).toContainText("지금 편성과 다름");
  // 조건을 거는 동안에는 자리가 바뀌지 않는다.
  expect(await nameAt(0)).toBe(first);
  expect(await nameAt(1)).toBe(second);

  // 팀 추천을 적용하면 조건을 만족하는 편성이 된다.
  await page.getByRole("button", { name: "팀 추천" }).click();
  await page.getByRole("dialog", { name: "팀 추천" }).getByRole("button", { name: "적용" }).first().click();
  await expect(conditions).not.toContainText("지금 편성과 다름");
  const teamOf = async (name: string) =>
    (await teamA.getByRole("button").filter({ hasText: name }).count()) > 0 ? "A" : "B";
  expect(await teamOf(first)).not.toBe(await teamOf(second));

  // 서로 모순인 조건을 만들면 추천이 이유를 알려주고 조건을 지울 수 있게 한다.
  const person = (name: string) => page.getByRole("button", { name: new RegExp(`${name}$`) });
  await person(first).click();
  await page.getByRole("button", { name: "같은 팀으로 묶기" }).click();
  await person(third).click();
  await person(second).click();
  await page.getByRole("button", { name: "같은 팀으로 묶기" }).click();
  await person(third).click();
  await expect(page.getByText("팀 조건 3개")).toBeVisible();
  await page.getByRole("button", { name: "팀 추천" }).click();
  const recommend = page.getByRole("dialog", { name: "팀 추천" });
  await expect(recommend).toContainText("조건을 모두 만족하는 편성이 없어요.");
  await recommend.getByRole("button", { name: "조건 지우기" }).first().click();
  await expect(page.getByText("팀 조건 2개")).toBeVisible();
});

test("경기 시각만 고치면 승패는 그대로이고 이력이 남는다", async ({ page }) => {
  await apiLogin(page, "e2e-time");
  const groupId = await createGroup(page, "시각 정정 모임");
  const ensured = await (
    await page.request.post(`/api/groups/${groupId}/participants`, {
      data: { requestId: crypto.randomUUID(), names: Array.from({ length: 10 }, (_, i) => `시각선수${i + 1}`) },
    })
  ).json();
  const started = await (
    await page.request.post(`/api/groups/${groupId}/matches/start`, {
      data: {
        requestId: `time-start-${Date.now()}`,
        baseLiveVersion: 0,
        roster: ensured.participants.map((p: { id: string }, i: number) => ({
          participantId: p.id,
          team: i < 5 ? "A" : "B",
          position: POSITIONS[i % 5],
        })),
      },
    })
  ).json();
  await page.request.post(`/api/groups/${groupId}/matches/${started.match.id}/result`, {
    data: {
      requestId: `time-result-${Date.now()}`,
      baseMatchVersion: started.match.version,
      winnerTeam: "B",
      winnerSide: "red",
    },
  });

  await page.goto(`/#/m/${started.match.id}`);
  await expect(page.getByText("승리 팀: 레드팀")).toBeVisible();
  await page
    .getByRole("listitem")
    .filter({ hasText: "경기 시각:" })
    .getByRole("button", { name: "수정" })
    .click();
  const dialog = page.getByRole("dialog", { name: "경기 시각 수정" });
  await expect(dialog).toContainText("승패와 명단은 그대로");
  await dialog.getByLabel("경기 시각").fill("2025-01-15T20:30");
  await dialog.getByRole("button", { name: "변경" }).click();
  await expect(page.getByText(/경기 시각: 1월 15일 오후 8:30/)).toBeVisible();
  await expect(page.getByText("승리 팀: 레드팀")).toBeVisible();
  await expect(page.getByText("승리 팀의 진영: 레드")).toBeVisible();
  await expect(page.getByText(/정정 · 경기 시각/)).toBeVisible();
});
