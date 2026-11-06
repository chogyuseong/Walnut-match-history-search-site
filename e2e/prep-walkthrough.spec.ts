import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 준비 화면을 실제로 눌러 보는 점검: 각 버튼 → 시작 → 결과 → 다음 준비를 여러 경기 반복한다.
// "올랜덤 + 서포터 공평하게"만으로 6경기를 하면 서포터가 겹치지 않다가, 팀 하나가 모두 배정받으면 알림과 초기화 버튼이 켜진다.
// PREP_SHOTS 환경 변수를 주면 상태별 스크린샷(390·1440px × 다크·라이트)을 그 폴더에 남긴다.

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `준비${String(i + 1).padStart(2, "0")}`);

async function openPrep(page: Page) {
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-walk-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { name: "준비 점검 모임" } })).json()) as {
    id: string;
  };
  expect((await page.request.post(`/api/groups/${group.id}/participants`, { data: { names } })).ok()).toBe(true);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
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
  await page.getByRole("dialog", { name: "팀 추천" }).getByRole("button", { name: "적용" }).first().click();
  const a = (await readTeam(page, "A")).map((r) => r.name);
  expect(a.includes(p1)).toBe(a.includes(p2));
  await page.getByRole("button", { name: "조건 지우기" }).click();
  await noHorizontalOverflow(page);

  // 연타: 서포터만 바꾸기를 빠르게 여러 번 눌러도 같은 결과(같은 조건이면 같은 결과).
  await tools.getByRole("button", { name: "서포터만 바꾸기" }).click();
  const drawn = [await readTeam(page, "A"), await readTeam(page, "B")];
  for (let i = 0; i < 5; i++) await tools.getByRole("button", { name: "서포터만 바꾸기" }).click({ delay: 0 });
  expect([await readTeam(page, "A"), await readTeam(page, "B")]).toEqual(drawn);
  await expect(page.getByText("같은 조건이라 결과를 유지했어요").first()).toBeVisible();

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
      if (anyFull) await expect(reset).toBeEnabled();
      else await expect(reset).toBeDisabled();
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
    await sheet.getByRole("radio", { name: /블루팀 승/ }).check();
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
  await page.getByText("서포터 횟수: 아직 없음").click();
  await expect(reset).toBeDisabled();
  await shots(page, "07-after-reset");
  await noHorizontalOverflow(page);
});
