import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// 오늘 명단 이어가기(docs/개선-오늘명단-설계-2026-11-10.md ④·⑥): 12명이 온 밤에 쉬던 사람이 다음 판 초안에 들어가고,
// 쉬는 사람 구역에서 빼기·되돌리기·늦게 온 사람을 다룬다. 정확히 10명인 밤은 예전과 같다.
// NIGHT_SHOTS 환경 변수를 주면 상태별 캡처(390px 다크·라이트, 1440px 다크)를 그 폴더에 남긴다.

test.use({ viewport: { width: 390, height: 844 } });

const names = ["도토리", "밤송이", "솔방울", "새벽별", "구름빵", "물방울", "호두알", "잣송이", "은행잎", "감자칩", "꿀떡", "모래알"];

async function setup(page: Page, extra: string[] = []): Promise<void> {
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-night-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (
    await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "호두나무 내전" } })
  ).json()) as { id: string };
  const all = [...names, ...extra];
  expect(
    (await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names: all } })).ok(),
  ).toBe(true);
}

async function pickTeams(page: Page, count: number) {
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, count)) await all.getByRole("button", { name: new RegExp(`^✓? ?${name}`) }).click();
  await page.getByRole("button", { name: count > 10 ? `팀 짜기 (10명 + 대기 ${count - 10}명)` : "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
}

const team = (page: Page, t: "A" | "B") => page.getByRole("region", { name: t === "A" ? "블루팀" : "레드팀" });
const rows = (box: Locator) => box.getByRole("list").first().getByRole("button");

async function playing(page: Page): Promise<string[]> {
  const texts = [...(await rows(team(page, "A")).allInnerTexts()), ...(await rows(team(page, "B")).allInnerTexts())];
  return texts.map((text) => names.find((n) => text.includes(n)) ?? text);
}

/** 시작 → 결과(블루팀 승) 저장까지. 저장 창을 돌려준다. */
async function startAndWin(page: Page, game: number): Promise<Locator> {
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  await expect(page.getByRole("heading", { name: /경기 진행 중/ })).toBeVisible();
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: `${game}경기 결과` });
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText(`${game}경기 저장됨`)).toBeVisible();
  return sheet;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

async function shot(page: Page, stage: string, all = false) {
  const dir = process.env.NIGHT_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const runs: [string, number][] = all
    ? [["dark", 390], ["dark", 1440], ["light", 390]]
    : [["dark", 390]];
  for (const [theme, width] of runs) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(dir, `${stage}-${theme}-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = "dark"));
}

test("12명 밤: 결과 저장 창의 제안 → 쉬던 두 명이 들어간 초안 → 빼기·되돌리기 → 새로 고쳐도 유지 → 늦게 온 사람 → 같은 10명으로", async ({
  page,
}) => {
  test.setTimeout(120000);
  await setup(page, ["다람쥐"]);
  await pickTeams(page, 12);
  const rest = page.getByRole("region", { name: "쉬는 사람" });
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 2명 · 오늘 온 12명");
  await expect(rest.getByRole("listitem")).toHaveCount(2);
  // 첫 판은 아직 뛴 경기가 없다(사실 그대로 0경기).
  await expect(rest.getByRole("listitem").first()).toContainText("오늘 0경기");
  const first = await playing(page);
  expect(first.sort()).toEqual(names.slice(0, 10).sort());

  const sheet = await startAndWin(page, 1);
  // 동률(모두 연속 1판)이라 명단 앞쪽 두 사람이 다음 판에 쉰다.
  await expect(sheet.getByText("다음 판 쉬는 사람(제안): 도토리 · 밤송이")).toBeVisible();
  await shot(page, "01-result-sheet", true);
  await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  const note = page.getByRole("status").filter({ hasText: /오늘 온 \d+명 중 10명이에요/ });
  await expect(note).toContainText(/^2경기 · 오늘 온 12명 중 10명이에요\. 쉬던 꿀떡·모래알이 도토리\((블루|레드) \S+\)·밤송이\((블루|레드) \S+\) 자리에 들어갔어요\./);
  // 사람이 바뀐 초안에는 "포지션 유지"가 없다.
  await expect(page.getByRole("button", { name: "포지션 유지" })).toHaveCount(0);
  const second = await playing(page);
  expect(second).toContain("꿀떡");
  expect(second).toContain("모래알");
  expect(second).not.toContain("도토리");
  expect(second).not.toContain("밤송이");
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 2명 · 오늘 온 12명");
  for (const name of ["도토리", "밤송이"]) {
    await expect(rest.getByRole("listitem").filter({ hasText: name })).toContainText("오늘 1경기");
  }
  await noHorizontalOverflow(page);
  await shot(page, "02-prep-rotated", true);

  // 빼기 → 되돌리기: 명단과 쉬는 사람에서 함께 빠졌다가 제자리로.
  await rest.getByRole("button", { name: "밤송이 오늘 명단에서 빼기" }).click();
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 1명 · 오늘 온 11명");
  await expect(rest.getByText("밤송이 님을 오늘 명단에서 뺐어요.")).toBeVisible();
  await shot(page, "03-dropped", true);
  await rest.getByRole("button", { name: "되돌리기" }).click();
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 2명 · 오늘 온 12명");
  await expect(rest.getByRole("listitem").filter({ hasText: "밤송이" })).toHaveCount(1);

  // 새로 고쳐도 명단·초안·안내가 그대로다.
  await page.reload();
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 2명 · 오늘 온 12명");
  await expect(note).toBeVisible();
  expect(await playing(page)).toEqual(second);

  // 늦게 온 사람: 이름으로 찾아 넣으면 쉬는 사람 끝에 붙는다.
  await rest.getByRole("button", { name: "+ 늦게 온 사람" }).click();
  const late = page.getByRole("dialog", { name: "늦게 온 사람" });
  await late.getByLabel("이름 찾기").fill("다람");
  await late.getByRole("button", { name: "다람쥐" }).click();
  await expect(late).toHaveCount(0);
  await expect(rest.getByRole("heading")).toHaveText("쉬는 사람 3명 · 오늘 온 13명");
  await expect(rest.getByRole("listitem").last()).toContainText("다람쥐");
  await expect(rest.getByRole("listitem").last()).toContainText("오늘 0경기");
  // 안내 줄의 "오늘 온 n명"도 지금 명단을 따른다.
  await expect(note).toContainText("오늘 온 13명 중 10명이에요");
  await noHorizontalOverflow(page);
  await shot(page, "04-late", true);

  // 명단 텍스트(단톡용)에는 쉬는 사람이 들어가지 않는다.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "명단 텍스트 복사" }).click();
  const manual = page.locator("textarea");
  const copied = page.getByRole("button", { name: "복사했어요" });
  await expect(manual.or(copied)).toBeVisible();
  const text = (await manual.isVisible()) ? await manual.inputValue() : await page.evaluate(() => navigator.clipboard.readText());
  for (const name of ["도토리", "밤송이", "다람쥐"]) expect(text).not.toContain(name);

  // 같은 10명으로: 1경기 열 명으로 다시 만들고, 쉬는 사람은 명단 순서(꿀떡·모래알·다람쥐).
  await note.getByRole("button", { name: "같은 10명으로" }).click();
  await expect(page.getByText("지난 경기와 같은 팀이에요. 포지션은 새로 뽑았어요.")).toBeVisible();
  expect((await playing(page)).sort()).toEqual(names.slice(0, 10).sort());
  await expect(rest.getByRole("listitem")).toHaveText([/꿀떡/, /모래알/, /다람쥐/]);
  await noHorizontalOverflow(page);
});

test("10명 밤: 새 표시가 없고, 지난 경기의 팀 조건을 이어 온다", async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  await pickTeams(page, 10);
  await expect(page.getByRole("region", { name: "쉬는 사람" })).toHaveCount(0);
  // 블루 정글·레드 정글을 다른 팀으로 묶어 시작한다.
  await rows(team(page, "A")).nth(1).click();
  await page.getByRole("button", { name: "다른 팀으로 나누기" }).click();
  await rows(team(page, "B")).nth(1).click();
  await expect(page.getByText("팀 조건 1개", { exact: true })).toBeVisible();
  const sheet = await startAndWin(page, 1);
  await expect(sheet.getByText(/다음 판 쉬는 사람/)).toHaveCount(0);
  await sheet.getByRole("button", { name: "다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "지난 경기와 같은 팀이에요" })).toHaveText(
    /^지난 경기와 같은 팀이에요\. 포지션은 새로 뽑았어요\. 지난 경기의 팀 조건 1개를 이어 왔어요\./,
  );
  await expect(page.getByRole("button", { name: "포지션 유지" })).toBeVisible();
  await expect(page.getByText("팀 조건 1개", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "쉬는 사람" })).toHaveCount(0);
  await expect(page.getByText(/오늘 온/)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await shot(page, "05-ten-carried", true);
  // 이어 온 조건은 조건 구역에서 바로 지울 수 있다.
  await page.getByRole("button", { name: "조건 지우기" }).click();
  await expect(page.getByText("팀 조건 1개", { exact: true })).toHaveCount(0);
});
