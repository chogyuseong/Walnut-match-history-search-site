import { expect, test, type Page } from "@playwright/test";

// docs/P3의 첫 이용 흐름과 docs/P4 P4-5의 화면 시나리오를 실제 브라우저에서 확인한다.

const NAMES = [
  "김용호",
  "조규성",
  "박서연",
  "이민재",
  "최하늘",
  "한지우",
  "오세훈",
  "윤가람",
  "정다은",
  "강민수",
];

function uniqueUser(): string {
  return `e2e-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function enterNames(page: Page, names: string[]) {
  await page.getByLabel("이름 검색 또는 새 이름 입력").fill(names.join("\n"));
  await page.getByRole("button", { name: "추가", exact: true }).click();
}

async function login(page: Page, user: string) {
  const dialog = page.getByRole("dialog", { name: "로그인" });
  await expect(dialog).toBeVisible();
  // 한 글자씩 입력해 입력 도중 초점이 빠지지 않는지도 함께 확인한다.
  await dialog.getByLabel("계정 이름").fill("");
  await dialog.getByLabel("계정 이름").pressSequentially(user);
  await expect(dialog.getByLabel("계정 이름")).toHaveValue(user);
  await dialog.getByRole("button", { name: "개발용 로그인" }).click();
}

/** 시작을 누른다. 반복 서포터 확인 창이 뜨면 그대로 시작을 고른다. */
async function startMatch(page: Page) {
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const heading = page.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(heading)).toBeVisible();
  if (await confirm.isVisible()) {
    await confirm.getByRole("button", { name: /시작$/ }).click();
  }
  await expect(heading).toBeVisible();
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("첫 이용 흐름 (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("이름 입력부터 결과 저장·정정·조회 링크까지", async ({ page, browser }) => {
    const user = uniqueUser();
    await page.goto("/");

    // 처음 온 사람의 첫 화면은 소개이고 채운 주 버튼은 하나다.
    await expect(page.locator("button.primary")).toHaveCount(1);
    await page.getByRole("button", { name: "로그인 없이 팀 짜기" }).click();

    // 참가자 선택: 8명만 넣으면 인원과 부족 인원을 알려준다.
    await enterNames(page, NAMES.slice(0, 8));
    await expect(page.getByText("8/10", { exact: true })).toBeVisible();
    await expect(page.getByText("2명이 더 필요해요.")).toBeVisible();
    await expect(page.getByRole("button", { name: "팀 짜기 (8/10)" })).toBeDisabled();

    // 중복과 10명 초과를 구체적으로 안내한다. 11번째부터는 대기자가 된다(2026-11-07, 예전에는 넣지 않았다).
    await enterNames(page, ["김용호", ...NAMES.slice(8), "초과한사람"]);
    await expect(page.getByText("10/10 +1", { exact: true })).toBeVisible();
    await expect(page.getByText(/10명이 넘었어요. 먼저 고른 10명으로 팀을 짜고 나머지 1명은 대기자로/)).toBeVisible();
    await expect(page.getByRole("button", { name: "팀 짜기 (10명 + 대기 1명)" })).toBeEnabled();
    // 이 흐름은 10명으로 이어간다(대기자 흐름은 prep-walkthrough.spec.ts).
    await page.getByRole("button", { name: "초과한사람 빼기" }).click();
    await expect(page.getByText("10/10", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();

    // 다음 경기 준비: 로그인 없이 편성이 보이고 기기 보관임을 표시한다.
    await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
    await expect(page.getByText("이 기기에만 있어요")).toBeVisible();
    await expect(page.getByRole("button", { name: "결과 입력" })).toHaveCount(0);
    for (const name of NAMES) await expect(page.getByText(name, { exact: true })).toBeVisible();

    // 창을 닫았다 열어도 편성이 남아 있고 자동으로 전송되지 않는다. (14)
    await page.reload();
    await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
    for (const name of NAMES) await expect(page.getByText(name, { exact: true })).toBeVisible();
    // 홈으로 가면 작성하던 편성이 있다고 알려주고 이어서 쓸 수 있다.
    await page.getByRole("button", { name: "← 오늘" }).click();
    await expect(page.getByText("작성하던 편성이 있어요")).toBeVisible();
    await page.getByRole("button", { name: "이어서 편성" }).click();
    for (const name of NAMES) await expect(page.getByText(name, { exact: true })).toBeVisible();

    // 두 사람을 차례로 누르면 자리가 바뀐다.
    const teamA = page.getByRole("region", { name: "블루팀" });
    const teamB = page.getByRole("region", { name: "레드팀" });
    const firstA = (await teamA.getByRole("button").first().innerText()).split("\n").pop()!.trim();
    const firstB = (await teamB.getByRole("button").first().innerText()).split("\n").pop()!.trim();
    await teamA.getByRole("button").first().click();
    await teamB.getByRole("button").first().click();
    await expect(teamA.getByRole("button").first()).toContainText(firstB);
    await expect(teamB.getByRole("button").first()).toContainText(firstA);

    // 서포터만 바꾸기: 누가 어디로 갔는지 이름으로 보여주고, 다시 누르면 아직 안 간 다른 사람으로 또 바뀐다. (17)
    // (2026-11-06 변경: 예전에는 같은 조건이면 같은 결과를 유지했다.)
    await page.getByRole("button", { name: "서포터만 바꾸기" }).click();
    const drawLine = page.getByText(/^블루팀: .+→서포터, .+ 서포터→.+, 나머지 유지/);
    await expect(drawLine).toBeVisible();
    const firstDraw = await drawLine.innerText();
    await page.getByRole("button", { name: "서포터만 바꾸기" }).click();
    await expect(drawLine).toBeVisible();
    await expect(drawLine).not.toHaveText(firstDraw);
    await expect(page.getByText(/같은 조건이라 결과를 유지했어요/)).toHaveCount(0);

    // 이 팀으로 시작: 여기서 처음 로그인한다.
    await page.getByRole("button", { name: "이 팀으로 시작" }).click();
    await login(page, user);
    await expect(page.getByRole("heading", { name: "1경기 진행 중" })).toBeVisible();

    // 결과 입력: 준비 화면에서 시작한 경기라 "블루팀 승 / 레드팀 승"이고, 고른 팀의 진영이 미리 골라져 있다.
    // 승리 팀을 바꾸면 진영도 그 팀 것으로 다시 고른다. (3)
    await page.getByRole("button", { name: "결과 입력" }).click();
    const sheet = page.getByRole("dialog", { name: "1경기 결과" });
    await expect(sheet.getByRole("button", { name: "저장" })).toBeDisabled();
    await expect(sheet.getByText(/팀 [AB]/)).toHaveCount(0);
    // 결과 입력 2버튼(2026-11-07): 큰 버튼으로 고르고, 진영 정정은 "진영이 시작할 때와 달랐나요?" 접힘 영역 안이다.
    await sheet.getByRole("button", { name: /레드팀 승/ }).click();
    await expect(sheet.getByRole("button", { name: /레드팀 승/ })).toHaveAttribute("aria-pressed", "true");
    await sheet.getByText("진영이 시작할 때와 달랐나요?").click();
    await expect(sheet.getByRole("radio", { name: "레드", exact: true })).toBeChecked();
    await expect(sheet.getByRole("button", { name: "저장" })).toBeEnabled();
    await sheet.getByRole("button", { name: /블루팀 승/ }).click();
    await expect(sheet.getByRole("radio", { name: "블루", exact: true })).toBeChecked();

    // 실제로는 왼쪽 팀이 레드였다: 진영 단계에서 바로잡는다. 요약이 곧 확인이다. (2)
    await sheet.getByRole("radio", { name: "레드", exact: true }).check();
    await expect(sheet.getByText("1경기 · 레드팀 승", { exact: true })).toBeVisible();
    await expect(sheet.getByText("시작할 때와 진영이 반대예요.", { exact: false })).toBeVisible();
    await sheet.getByRole("button", { name: "저장" }).click();
    await expect(sheet.getByText("1경기 저장됨 · 레드팀 승")).toBeVisible();
    // 서버 상태를 다시 읽은 뒤에도 같은 자리에 저장 결과가 남아 있어야 한다.
    await page.waitForLoadState("networkidle");
    await expect(sheet.getByText("1경기 저장됨 · 레드팀 승")).toBeVisible();

    // 다음 경기 준비: 같은 팀으로 초안이 만들어진다. (26)
    await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
    await expect(page.getByText("지난 경기와 같은 팀이에요. 포지션은 새로 뽑았어요.")).toBeVisible();
    await expect(page.getByText("서폿 1회").first()).toBeVisible();

    // 두 번째 경기를 시작하고 결과는 나중에 넣는다. (27)
    await startMatch(page);
    await expect(page.getByRole("heading", { name: "2경기 진행 중" })).toBeVisible();
    await page.getByRole("button", { name: "결과는 나중에" }).click();
    await expect(page.getByRole("heading", { name: "결과 미입력 1경기" })).toBeVisible();

    // 기록 확인: 확정 1경기, 결과 미입력 1경기, 개인 승패.
    await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" }).click();
    await expect(page.getByRole("heading", { name: /오늘의 결과 · 1경기 확정 · 결과 미입력 1/ })).toBeVisible();
    await expect(page.getByText("1승 0패").first()).toBeVisible();
    await expect(page.getByText("배치 진행 중 1/10 (누적 기준)").first()).toBeVisible();

    // 진영만 정정한다. 승리 팀은 그대로다. (4)
    await page.getByRole("button", { name: /1경기 · 레드팀 승/ }).click();
    // 경기 상세: 진영이 레드로 정정된 팀 A는 왼쪽 그대로 "레드팀"이다.
    await expect(page.getByRole("region", { name: "레드팀" })).toHaveClass(/side-red/);
    await expect(page.getByText("승리 팀의 진영: 레드")).toBeVisible();
    await page
      .getByRole("listitem")
      .filter({ hasText: "승리 팀의 진영" })
      .getByRole("button", { name: "수정" })
      .click();
    const sideDialog = page.getByRole("dialog", { name: "진영 수정" });
    await expect(sideDialog.getByText("진영만 변경합니다. 개인 승패는 유지")).toBeVisible();
    await sideDialog.getByRole("radio", { name: "블루", exact: true }).check();
    await sideDialog.getByRole("button", { name: "진영 저장" }).click();
    await expect(page.getByText("승리 팀의 진영: 블루")).toBeVisible();
    await expect(page.getByText("승리 팀: 블루팀")).toBeVisible();
    await expect(page.getByText(/정정 · 진영/)).toBeVisible();

    // 조회 링크: 로그인 없는 다른 브라우저에서 명단을 본다. 실력 그룹은 응답에 없다. (12)
    const me = await page.request.get("/api/me");
    const groupId = (await me.json()).groups[0].id as string;
    const snapshot = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
    const token = snapshot.group.viewToken as string;

    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const guestPage = await guest.newPage();
    const viewResponse = guestPage.waitForResponse((r) => r.url().includes(`/api/view/${token}`));
    await guestPage.goto(`/#/v/${token}/now`);
    const viewBody = await (await viewResponse).text();
    expect(viewBody).not.toContain("skillGroup");
    expect(viewBody).not.toContain("viewToken");
    await expect(guestPage.getByRole("heading", { name: "2경기 · 결과 미입력" })).toBeVisible();
    await expect(guestPage.getByText("확정 명단")).toBeVisible();
    for (const name of NAMES) await expect(guestPage.getByText(name, { exact: true })).toBeVisible();
    await expect(guestPage.getByRole("button", { name: "결과 입력" })).toHaveCount(0);

    // 내 이름을 고르면 내 자리를 먼저 보여준다.
    await guestPage.getByRole("button", { name: "내 이름 고르기" }).click();
    await guestPage.getByRole("dialog").getByRole("button", { name: "조규성" }).click();
    // 준비 화면에서 시작한 경기라 내 팀을 블루팀·레드팀으로 부른다.
    await expect(guestPage.getByText(/조규성 님 · (블루|레드)팀 · /)).toBeVisible();
    await expect(guestPage.getByRole("region", { name: "블루팀" })).toHaveClass(/side-blue/);

    // 특정 경기 링크로 지난 경기를 열면 현재 경기로 가는 길을 보여준다.
    await guestPage.goto(`/#/v/${token}/m/1`);
    await expect(guestPage.getByRole("heading", { name: "1경기 · 결과 확정" })).toBeVisible();
    await expect(guestPage.getByRole("button", { name: "현재 경기 보기" })).toBeVisible();

    // 조회 토큰으로 수정 요청을 보내면 거절된다. (11)
    const forbidden = await guestPage.request.post(
      `/api/groups/${groupId}/matches/${snapshot.matches[0].id}/exclude`,
      { data: { requestId: "guest-request-1", baseMatchVersion: 1 } },
    );
    expect(forbidden.status()).toBe(401);
    await guest.close();
  });
});

test.describe("좁은 화면과 긴 이름 (39)", () => {
  const LONG = NAMES.map((name, i) => `${name}의아주아주긴닉네임열자${i}`.slice(0, 20));

  for (const width of [320, 390, 768, 1440]) {
    test(`${width}px에서 가로로 넘치지 않는다`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await page.goto("/");
      await noHorizontalOverflow(page);
      await page.getByRole("button", { name: "로그인 없이 팀 짜기" }).click();
      await enterNames(page, LONG);
      await expect(page.getByText("10/10", { exact: true })).toBeVisible();
      await noHorizontalOverflow(page);
      await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
      await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
      await noHorizontalOverflow(page);

      // 360px 미만에서는 두 팀을 위아래로 쌓는다.
      const a = await page.getByRole("region", { name: "블루팀" }).boundingBox();
      const b = await page.getByRole("region", { name: "레드팀" }).boundingBox();
      if (width < 360) expect(b!.y).toBeGreaterThan(a!.y + a!.height - 1);
      else expect(Math.abs(b!.y - a!.y)).toBeLessThan(2);

      // 주요 버튼이 하단 탭에 가려지지 않는다.
      const start = await page.getByRole("button", { name: "이 팀으로 시작" }).boundingBox();
      const tabs = await page.getByRole("navigation", { name: "주 메뉴" }).boundingBox();
      await page.getByRole("button", { name: "이 팀으로 시작" }).scrollIntoViewIfNeeded();
      const startAfter = await page.getByRole("button", { name: "이 팀으로 시작" }).boundingBox();
      expect(start).not.toBeNull();
      if (width >= 768) {
        // 넓은 화면: 탭이 위에 있으므로 버튼은 탭 아래에 있어야 한다.
        expect(startAfter!.y).toBeGreaterThanOrEqual(tabs!.y + tabs!.height - 1);
      } else {
        expect(startAfter!.y + startAfter!.height).toBeLessThanOrEqual(tabs!.y + 1);
      }

      // 터치 대상은 44px 이상이다.
      const heights = await page
        .getByRole("button")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
      expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);

      // 동작 버튼의 글자가 한 글자씩 꺾여 세로로 늘어나지 않는다.
      const actionHeights = await page
        .locator("button.primary, button.secondary, button.danger, button.link")
        .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
      expect(Math.max(...actionHeights)).toBeLessThanOrEqual(50);

      // 넓은 화면에서는 탭이 상단 바(64px) 바로 아래에, 좁은 화면에서는 아래에 있다.
      await page.evaluate(() => window.scrollTo(0, 0));
      const tabsBox = await page.getByRole("navigation", { name: "주 메뉴" }).boundingBox();
      if (width >= 768) expect(tabsBox!.y).toBe(64);
      else expect(tabsBox!.y).toBeGreaterThan(300);
    });
  }
});
