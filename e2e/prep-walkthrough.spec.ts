import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 준비 화면을 실제로 눌러 보는 점검: 각 버튼 → 시작 → 결과 → 다음 준비를 여러 경기 반복한다.
// "올랜덤 + 서포터 공평하게"만으로 6경기를 하면 서포터가 겹치지 않다가, 팀 하나가 모두 배정받으면 알림과 초기화 버튼이 켜진다.
// PREP_SHOTS 환경 변수를 주면 상태별 스크린샷(390·1440px × 다크·라이트)을 그 폴더에 남긴다.

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `준비${String(i + 1).padStart(2, "0")}`);

/** 로그인·모임·참가자 12명을 만들고 앞에서 count명을 골라 팀을 짠다. 11명 이상이면 넘는 사람은 대기자가 된다. 모임 ID를 돌려준다. */
async function openPrep(page: Page, count = 10): Promise<string> {
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-walk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "준비 점검 모임" } })).json()) as {
    id: string;
  };
  expect((await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names } })).ok()).toBe(true);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, count)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page
    .getByRole("button", { name: count > 10 ? `팀 짜기 (10명 + 대기 ${count - 10}명)` : "팀 짜기 (10/10)" })
    .click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  return group.id;
}

/** 준비 화면의 팀 상자. 팀 A(왼쪽)는 항상 블루팀, 팀 B(오른쪽)는 레드팀이다. */
const team = (page: Page, t: "A" | "B") => page.getByRole("region", { name: t === "A" ? "블루팀" : "레드팀" });
const rows = (box: Locator) => box.getByRole("list").first().getByRole("button");

/** 팀 상자의 다섯 줄(탑~서포터)에서 이름과 "서폿 N회"를 읽는다. */
async function readTeam(page: Page, t: "A" | "B") {
  const texts = await rows(team(page, t)).allInnerTexts();
  return texts.map((text) => ({
    name: text.match(/준비\d\d/)![0],
    count: Number(text.match(/서폿 (\d+)회/)?.[1] ?? 0),
  }));
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shots(page: Page, stage: string) {
  const dir = process.env.PREP_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  for (const theme of ["dark", "light"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      // 버튼 배경색 전환(0.15초)이 끝난 뒤 찍는다.
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(dir, `${stage}-${theme}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
}

test("준비 화면 버튼 점검 → 공평 섞기로 6경기: 서포터가 겹치지 않고, 모두 배정받은 팀이 생기면 알림·초기화", async ({
  page,
}) => {
  test.setTimeout(180000);
  await openPrep(page);
  const tools = page.getByRole("region", { name: "섞기" });
  const reset = page.getByRole("button", { name: "서포터 횟수 초기화" });

  // 올랜덤: 팀원은 그대로 두고 라인만 섞는다. 안내가 뜨고 4초 안팎에 사라진다.
  const membersOf = async (t: "A" | "B") => (await readTeam(page, t)).map((r) => r.name).sort();
  const firstA = await membersOf("A");
  await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
  const toast = page.locator(".toast");
  await expect(toast).toHaveText("팀원은 그대로 두고 라인을 섞었어요.");
  expect(await membersOf("A")).toEqual(firstA);
  expect((await readTeam(page, "B")).length).toBe(5);
  await shots(page, "01-shuffled");
  await expect(toast).toHaveCount(0, { timeout: 8000 });

  // 진영: 왼쪽 블루팀·오른쪽 레드팀(고르는 칸 없음). 진영 바꾸기를 하면 블루팀 5명과 레드팀 5명이 서로 바뀐다.
  await expect(team(page, "A").getByRole("heading")).toHaveText("● 블루팀");
  await expect(team(page, "B").getByRole("heading")).toHaveText("■ 레드팀");
  await expect(page.locator("#root")).not.toContainText(/팀 [AB]/);
  await expect(page.getByRole("radiogroup")).toHaveCount(0);
  const aBefore = (await readTeam(page, "A")).map((r) => r.name).sort();
  const bBefore = (await readTeam(page, "B")).map((r) => r.name).sort();
  await tools.getByRole("button", { name: "진영 바꾸기" }).click();
  expect((await readTeam(page, "B")).map((r) => r.name).sort()).toEqual(aBefore);
  expect((await readTeam(page, "A")).map((r) => r.name).sort()).toEqual(bBefore);
  await shots(page, "02-side");
  await page.getByRole("button", { name: "진영 랜덤" }).click();
  expect([aBefore, bBefore]).toContainEqual((await readTeam(page, "A")).map((r) => r.name).sort());
  await expect(team(page, "A").getByRole("heading")).toHaveText("● 블루팀");

  // 포지션 고정 → 올랜덤: 고정한 사람은 자리를 지킨다. 직전 편성으로 되돌릴 수 있다.
  const lockedName = (await readTeam(page, "A"))[0]!.name;
  await rows(team(page, "A")).nth(0).click();
  await page.getByRole("button", { name: "포지션 고정" }).click();
  await expect(rows(team(page, "A")).nth(0)).toContainText("고정");
  for (let i = 0; i < 3; i++) {
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    expect((await readTeam(page, "A"))[0]!.name).toBe(lockedName);
  }
  const beforeUndo = await readTeam(page, "B");
  await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
  await page.getByRole("button", { name: "직전 편성으로" }).click();
  expect(await readTeam(page, "B")).toEqual(beforeUndo);

  // 같은 팀 조건을 걸어도 라인만 섞기는 팀원을 바꾸지 않는다(조건은 팀 추천·팀·라인 모두 섞기에만 쓴다).
  const [p1, p2] = [(await readTeam(page, "A"))[1]!.name, (await readTeam(page, "B"))[1]!.name];
  await rows(team(page, "A")).nth(1).click();
  await page.getByRole("button", { name: "같은 팀으로 묶기" }).click();
  await rows(team(page, "B")).nth(1).click();
  await expect(page.getByText("팀 조건 1개")).toBeVisible();
  const [keepA, keepB] = [await membersOf("A"), await membersOf("B")];
  for (let i = 0; i < 5; i++) {
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    expect([await membersOf("A"), await membersOf("B")]).toEqual([keepA, keepB]);
  }
  // 팀 추천 적용: 조건을 지키고 고정은 유지된다.
  await tools.getByRole("button", { name: "팀 추천" }).click();
  await page.getByRole("dialog", { name: "팀 추천" }).getByRole("button", { name: "이 편성으로 바꾸기" }).first().click();
  const a = (await readTeam(page, "A")).map((r) => r.name);
  expect(a.includes(p1)).toBe(a.includes(p2));
  await page.getByRole("button", { name: "조건 지우기" }).click();
  await noHorizontalOverflow(page);

  // 서포터만 바꾸기는 누를 때마다 새로 뽑는다(2026-11-06 변경. 예전에는 같은 조건이면 같은 결과였다).
  // 아직 아무도 서포터를 안 갔으므로 누를 때마다 두 팀 서포터가 다른 사람으로 바뀌고, 팀원은 그대로다.
  const supportOf = (rows: { name: string; position?: string }[]) => JSON.stringify(rows);
  const teamNames = async () => [
    (await readTeam(page, "A")).map((r) => r.name).sort(),
    (await readTeam(page, "B")).map((r) => r.name).sort(),
  ];
  const namesBefore = await teamNames();
  await tools.getByRole("button", { name: "서포터만 바꾸기" }).click();
  let lineup = supportOf([...(await readTeam(page, "A")), ...(await readTeam(page, "B"))]);
  for (let i = 0; i < 5; i++) {
    await tools.getByRole("button", { name: "서포터만 바꾸기" }).click();
    const next = supportOf([...(await readTeam(page, "A")), ...(await readTeam(page, "B"))]);
    expect(next).not.toBe(lineup);
    lineup = next;
  }
  expect(await teamNames()).toEqual(namesBefore);
  await expect(page.getByText("같은 조건이라 결과를 유지했어요")).toHaveCount(0);

  // 공평 섞기로 6경기. 팀원은 매 경기 그대로(다음 경기 준비는 같은 팀)라 6번째에 두 팀 모두 다 배정받는다.
  const supportedBefore = new Set<string>();
  let sawAllAssigned = false;
  for (let game = 1; game <= 6; game++) {
    const membersBefore = [await membersOf("A"), await membersOf("B")];
    await tools.getByRole("button", { name: "라인 섞기 + 서폿 돌아가며" }).click();
    expect([await membersOf("A"), await membersOf("B")]).toEqual(membersBefore);
    const teams = [await readTeam(page, "A"), await readTeam(page, "B")];
    const full = teams.map((t) => t.every((r) => r.count >= 1));
    for (const [i, t] of teams.entries()) {
      const supporter = t[4]!;
      if (full[i]) {
        sawAllAssigned = true;
      } else {
        // 팀에 안 간 사람이 있으면 서포터는 그중 한 명이고, 앞선 경기의 서포터와 겹치지 않는다.
        expect(supporter.count, `${game}경기 팀 ${i ? "B" : "A"} 서포터 0회`).toBe(0);
        expect(supportedBefore.has(supporter.name), `${game}경기 서포터 겹침`).toBe(false);
      }
    }
    // 알림과 초기화 버튼은 "모두 배정받은 팀이 있는가"와 맞는다.
    const anyFull = full.some(Boolean);
    if (anyFull) {
      await expect(toast).toContainText("모두 서포터를 배정받았어요");
      await shots(page, "05-all-assigned-notice");
      // 토스트는 몇 초 뒤 사라지지만 명단 아래 안내에는 남는다(2026-11-06 점검에서 고침).
      await expect(toast).toHaveCount(0, { timeout: 8000 });
      await expect(page.locator(".note").filter({ hasText: "모두 서포터를 배정받았어요" })).toBeVisible();
    } else {
      await expect(toast).toContainText("팀마다 서포터를 아직 안 간 사람으로 정했어요");
    }
    if (game > 1) {
      if (!(await reset.isVisible())) await page.getByText(/^서포터 횟수: /).click();
      // 초기화 버튼은 항상 누를 수 있다(2026-11-06 변경). 상태는 옆의 이유 글로 구분한다.
      await expect(reset).toBeEnabled();
      await expect(page.locator("#reset-counts-why")).toContainText(
        anyFull ? "모두 서포터를 배정받았어요" : "아직 서포터를 안 간 사람이 있어요",
      );
      if (game === 2) await shots(page, "03-counts-reset-disabled");
      if (anyFull) await shots(page, "06-reset-enabled");
    }
    if (anyFull) break;
    for (const t of teams) supportedBefore.add(t[4]!.name);

    // 시작: 안 간 사람이 서포터라 반복 확인 없이 바로 시작된다.
    await page.getByRole("button", { name: "이 팀으로 시작" }).click();
    await expect(page.getByRole("heading", { name: /경기 진행 중/ })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "시작 전에 확인해 주세요" })).toHaveCount(0);
    await page.getByRole("button", { name: "결과 입력" }).click();
    const sheet = page.getByRole("dialog", { name: `${game}경기 결과` });
    await sheet.getByRole("button", { name: /블루팀 승/ }).click();
    await sheet.getByText("진영이 시작할 때와 달랐나요?").click();
    await expect(sheet.getByRole("radio", { name: "블루", exact: true })).toBeChecked();
    await sheet.getByRole("button", { name: "저장" }).click();
    await expect(sheet.getByText(`${game}경기 저장됨`)).toBeVisible();
    await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
    await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
    if (game === 1) {
      // "포지션 유지"를 눌러도 왼쪽은 블루팀·오른쪽은 레드팀 그대로다.
      await page.getByRole("button", { name: "포지션 유지" }).click();
      await expect(team(page, "A").getByRole("heading")).toHaveText("● 블루팀");
      await expect(team(page, "B").getByRole("heading")).toHaveText("■ 레드팀");
      // 좁은 화면에서 팀 상자 제목이 줄바꿈되지 않는다.
      for (const t of ["A", "B"] as const) {
        const [textHeight, fontSize] = await team(page, t)
          .getByRole("heading")
          .evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return [range.getBoundingClientRect().height, parseFloat(getComputedStyle(el).fontSize)];
          });
        expect(textHeight).toBeLessThan(fontSize * 2);
      }
    }
    // 다음 준비 화면: 방금 서포터였던 두 사람에게 횟수가 붙는다.
    const counted = [...(await readTeam(page, "A")), ...(await readTeam(page, "B"))].filter((r) => r.count > 0);
    expect(counted.map((r) => r.name).sort()).toEqual([...supportedBefore].sort());
    expect(counted.every((r) => r.count === 1)).toBe(true);
  }
  expect(sawAllAssigned, "6경기 안에 모두 배정받은 팀이 생긴다").toBe(true);

  // 초기화 → 횟수 표시가 모두 사라지고 버튼은 다시 꺼진다.
  await reset.click();
  await page.getByRole("dialog", { name: "서포터 횟수 초기화" }).getByRole("button", { name: "초기화" }).click();
  await expect(page.locator(".teams").getByText(/서폿 \d+회/)).toHaveCount(0);
  // 판은 펼친 그대로다(버튼 글자만 바뀐다). 예전에는 판이 CSS 때문에 늘 보여 버튼을 눌러 닫아도 지나갔다.
  await expect(page.getByText("서포터 횟수: 아직 없음")).toBeVisible();
  await expect(reset).toBeEnabled();
  await expect(page.locator("#reset-counts-why")).toContainText("아직 서포터를 안 간 사람이 있어요");
  await shots(page, "07-after-reset");
  await noHorizontalOverflow(page);
});

test("준비 화면 추가 기능(390px): 대기자 교체 · 예상 승률 판(티어 점수·라인 우위) · 되돌리기 여러 번 · 편성 이미지", async ({ page }) => {
  test.setTimeout(120000);
  // 11명을 고르면 앞 10명으로 팀을 짜고 11번째(준비11)는 대기자가 된다.
  await openPrep(page, 11);
  // 2026-11-10: 대기자 구역은 "쉬는 사람"으로 바뀌어 편성 판 아래로 옮겼다. 11명을 골라 오늘 명단도 함께 보인다.
  const bench = page.getByRole("region", { name: "쉬는 사람" });
  await expect(bench.getByRole("heading")).toHaveText("쉬는 사람 1명 · 오늘 온 11명");
  await expect(bench.getByRole("listitem")).toHaveCount(1);
  await expect(bench).toContainText("준비11");
  const inTeams = async () => [...(await readTeam(page, "A")), ...(await readTeam(page, "B"))].map((r) => r.name);
  expect(await inTeams()).not.toContain("준비11");
  await noHorizontalOverflow(page);

  // 예상 승률 판(2026-11-09): 기본 펼침. 지난 경기가 없으므로 모두 시작 MMR이라 50:50이고 신뢰 불가 문구가 나온다.
  const forecast = page.getByRole("region", { name: "예상 승률" });
  await expect(forecast.getByRole("heading", { name: "예상 승률" })).toBeVisible();
  await expect(forecast.getByRole("img", { name: "블루팀 50% : 레드팀 50%" })).toBeVisible();
  await expect(forecast).toContainText("아직 MMR이 쌓이지 않아 예상이 정확하지 않아요");
  await expect(forecast).toContainText("팀 평균 MMR 1200 : 1200 · 배치 완료 0/10명");

  // 티어 점수: 판 맨 아래에 접힌 채로 있고, 열면 두 팀 티어 점수와 티어별 인원이 보인다(운영자만).
  const balanceList = page.getByRole("list", { name: "티어별 인원" });
  await expect(forecast.getByText("티어 점수 보기", { exact: true })).toBeVisible();
  await expect(balanceList).toBeHidden();
  await forecast.getByText("티어 점수 보기", { exact: true }).click();
  await expect(balanceList).toBeVisible();
  await expect(balanceList.getByRole("listitem")).toHaveCount(6);
  // 아무도 티어를 정하지 않았으므로 두 팀 모두 0점이고 균형이다.
  await expect(page.getByText(/블루팀 티어 점수 0 · 레드팀 0 · 균형/)).toBeVisible();
  await expect(balanceList.getByRole("listitem").last()).toContainText("블루 5 · 레드 5");
  await noHorizontalOverflow(page);

  // 라인별 우위: 다섯 줄, 모두 같은 MMR이라 "비슷", 지난 경기가 없으므로 "첫 맞대결". 이름은 잘리지 않는다.
  const lanes = forecast.getByRole("list", { name: "라인별 우위" }).getByRole("listitem");
  await expect(lanes).toHaveCount(5);
  for (let i = 0; i < 5; i++) {
    await expect(lanes.nth(i)).toContainText("첫 맞대결");
    await expect(lanes.nth(i).locator(".fc-edge")).toHaveText("비슷");
    for (const name of await lanes.nth(i).locator(".fc-name").all()) {
      expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), `라인 ${i + 1}번째 이름 잘림 없음`).toBe(true);
    }
  }
  // 왼쪽(첫 사람 칸)은 블루팀 같은 라인 사람이다.
  const blueTop = (await readTeam(page, "A"))[0]!.name;
  const redTop = (await readTeam(page, "B"))[0]!.name;
  await expect(lanes.first().locator(".fc-side-A")).toContainText(blueTop);
  await expect(lanes.first().locator(".fc-side-B")).toContainText(redTop);

  // 되돌리기 여러 번: 처음 만든 편성에는 이력이 없고, 섞을 때마다 단계 수가 늘어난다.
  const tools = page.getByRole("region", { name: "섞기" });
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(0);
  const lineups: string[] = [JSON.stringify(await inTeams())];
  for (let i = 1; i <= 3; i++) {
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    await expect(page.getByRole("button", { name: `직전 편성으로 (${i})` })).toBeVisible();
    lineups.push(JSON.stringify(await inTeams()));
  }
  for (let i = 2; i >= 0; i--) {
    await page.getByRole("button", { name: /직전 편성으로/ }).click();
    expect(JSON.stringify(await inTeams()), `${3 - i}번 되돌림`).toBe(lineups[i]);
    if (i > 0) await expect(page.getByRole("button", { name: `직전 편성으로 (${i})` })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(0);
  // 다시 앞으로(1단계): 마지막 되돌리기만 취소한다.
  await page.getByRole("button", { name: "다시 앞으로" }).click();
  expect(JSON.stringify(await inTeams())).toBe(lineups[1]);
  await expect(page.getByRole("button", { name: "다시 앞으로" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "직전 편성으로 (1)" })).toBeVisible();

  // 편성 이미지: 명단 텍스트 복사 옆 버튼. 누르면 미리보기 이미지가 만들어진다.
  await expect(page.getByRole("button", { name: "명단 텍스트 복사" })).toBeVisible();
  await page.getByRole("button", { name: "편성 이미지" }).click();
  const imageDialog = page.getByRole("dialog", { name: "편성 이미지" });
  await expect(imageDialog.getByRole("img", { name: "편성 이미지 미리보기" })).toBeVisible();
  await imageDialog.getByRole("button", { name: "닫기" }).click();
  await expect(imageDialog).toHaveCount(0);

  // 대기자 교체: 블루팀 첫 사람을 누른 뒤 대기자를 누르면 둘이 바뀌고, 빠진 사람은 대기자로 간다.
  const out = (await readTeam(page, "A"))[0]!.name;
  await rows(team(page, "A")).nth(0).click();
  await bench.getByRole("button").first().click();
  expect((await readTeam(page, "A"))[0]!.name).toBe("준비11");
  await expect(bench.getByRole("listitem")).toHaveCount(1);
  await expect(bench).toContainText(out);
  expect(await inTeams()).not.toContain(out);
  // 교체하면 되돌리기 이력은 비워진다(다른 사람으로 교체와 같다).
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(0);
  await noHorizontalOverflow(page);

  // 시작 요청 명단은 10명 그대로이고 대기자는 서버로 가지 않는다.
  const playing = await inTeams();
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  await expect(page.getByRole("heading", { name: /경기 진행 중/ })).toBeVisible();
  await expect(page.locator("#root")).toContainText("준비11");
  for (const name of playing) await expect(page.locator("#root")).toContainText(name);
  await expect(page.locator("#root")).not.toContainText(out);
});

test("끌어다 놓기(PC): 사람을 다른 자리에 놓으면 둘이 바뀌고, 대기자에 놓으면 대기자와 바뀐다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPrep(page, 11);
  const a0 = (await readTeam(page, "A"))[0]!.name;
  const b2 = (await readTeam(page, "B"))[2]!.name;
  // 블루 탑 → 레드 미드 자리에 놓기: 두 사람의 팀·포지션이 맞바뀐다.
  await team(page, "A")
    .getByRole("button", { name: new RegExp(a0) })
    .dragTo(team(page, "B").getByRole("button", { name: new RegExp(b2) }));
  expect((await readTeam(page, "A"))[0]!.name).toBe(b2);
  expect((await readTeam(page, "B"))[2]!.name).toBe(a0);
  await noHorizontalOverflow(page);
  // 되돌리기 한 번이면 처음 배치로, 다시 앞으로 하면 바뀐 배치로.
  await page.getByRole("button", { name: /직전 편성으로/ }).click();
  expect((await readTeam(page, "A"))[0]!.name).toBe(a0);
  await page.getByRole("button", { name: "다시 앞으로" }).click();
  expect((await readTeam(page, "B"))[2]!.name).toBe(a0);
  // 레드 미드(이제 a0) → 대기자에 놓기: 대기자가 들어오고 a0은 대기자로 간다(교체와 같이 되돌리기 이력은 비워진다).
  const benchList = page.getByRole("region", { name: "쉬는 사람" });
  const benchName = (await benchList.getByRole("button").first().innerText()).match(/준비\d\d/)![0];
  await team(page, "B")
    .getByRole("button", { name: new RegExp(a0) })
    .dragTo(benchList.getByRole("button").first());
  expect((await readTeam(page, "B"))[2]!.name).toBe(benchName);
  await expect(benchList.getByRole("button").filter({ hasText: a0 })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(0);
});


test("직전 편성 대비 한 줄(390px): 두 사람을 바꾸면 달라진 조건이 편성 판 아래에, '방금 변경 되돌리기'로 사라진다", async ({ page }) => {
  await openPrep(page);
  const blue = team(page, "A");
  const red = team(page, "B");
  const note = page.getByRole("status").filter({ hasText: "직전 편성 대비" });
  // 처음 만든 편성에는 직전 편성이 없어 줄이 없다.
  await expect(note).toHaveCount(0);

  // 블루 탑을 고정하고, 블루 탑·블루 정글을 같은 팀으로 묶는다(고정·조건 걸기는 이력을 남기지 않는다).
  await rows(blue).nth(0).click();
  await page.getByRole("button", { name: "포지션 고정" }).click();
  await rows(blue).nth(0).click();
  await page.getByRole("button", { name: "같은 팀으로 묶기" }).click();
  await rows(blue).nth(1).click();
  await expect(note).toHaveCount(0);
  const before = [...(await readTeam(page, "A")), ...(await readTeam(page, "B"))].map((r) => r.name);

  // 블루 탑과 레드 탑을 바꾼다: 묶은 조건이 깨지고 고정이 풀린다. 둘 다 경고라 줄 전체가 경고 톤이다.
  await rows(blue).nth(0).click();
  await rows(red).nth(0).click();
  await expect(note).toHaveText(/^직전 편성 대비 · 어긴 팀 조건 0 → 1개 · 옮겨져 풀린 고정 1명/);
  await expect(note).toHaveClass(/warn/);
  // 평가 낱말 없이 숫자만.
  await expect(note).not.toContainText(/좋아|나빠|개선/);
  // "직전 편성으로" 버튼은 그대로 하나다(새 버튼은 이름이 다르다).
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(1);
  await noHorizontalOverflow(page);
  const box = await note.boundingBox();
  // 320px 기준 최대 3줄 설계(390px에서는 더 적다): 글줄 높이 약 24px × 4 미만.
  expect(box!.height).toBeLessThan(110);

  // 명단 텍스트에는 이 줄이 들어가지 않는다.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "명단 텍스트 복사" }).click();
  const manual = page.locator("textarea");
  const copied = page.getByRole("button", { name: "복사했어요" });
  await expect(manual.or(copied)).toBeVisible();
  const text = (await manual.isVisible()) ? await manual.inputValue() : await page.evaluate(() => navigator.clipboard.readText());
  expect(text).not.toContain("직전 편성 대비");
  expect(text).not.toContain("풀린 고정");

  await note.getByRole("button", { name: "방금 변경 되돌리기" }).click();
  await expect(note).toHaveCount(0);
  expect([...(await readTeam(page, "A")), ...(await readTeam(page, "B"))].map((r) => r.name)).toEqual(before);
  await expect(page.getByRole("button", { name: /직전 편성으로/ })).toHaveCount(0);
});
