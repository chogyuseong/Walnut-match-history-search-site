import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 디자인 단계(CLAUDE.md, docs/디자인-적용-계획-2026-11-11.md)의 전후 비교용 사진. 검사가 아니라 기록이다.
// SHOTS_DIR을 줄 때만 돈다. 화면 × 테마 × 너비(390·768·1440)로 전체 페이지 사진을 찍고,
// 화면·너비마다 가로 넘침(px)과 44px보다 작은 보이는 컨트롤을 SHOTS_DIR/layout.json에 남긴다.
//   npm run build; $env:SHOTS_DIR="…\stage0-before"; npx playwright test e2e/design-shots.spec.ts
// 두 번 찍어 픽셀 비교가 되도록 흔들리는 것을 고정한다: Math.random(팀 섞기 씨앗)은 고정 씨앗, 시계는 고정 시각,
// 챔피언 그림(외부 ddragon)은 투명 그림으로 바꾼다(404면 lazy 그림이 늦게 실패하며 줄 높이가 찍을 때마다 달라진다).
// 서버가 붙이는 경기 시작 시각은 고정할 수 없어 글자를 고정 시각으로 바꿔 쓴다(가리기만 하면 글자 폭이 달라 테두리가 흔들린다).
// 찍기 전에 마우스를 치우고, 끝이 있는 애니메이션·전환을 다 기다린다.

const SHOTS_DIR = process.env.SHOTS_DIR;
// 1B에서 violet을 지우면 여기서도 뺀다.
const THEMES = ["dark", "violet", "light"];
const SIZES = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const FIXED_NOW = new Date("2026-11-11T20:00:00+09:00");
const NAMES = Array.from({ length: 12 }, (_, i) => `사진${String(i + 1).padStart(2, "0")}`);

interface Layout {
  overflowX: number;
  under44: string[];
}
const layout: Record<string, Layout> = {};

test.skip(!SHOTS_DIR, "SHOTS_DIR을 줄 때만 사진을 찍는다");

/** 1×1 투명 PNG */
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** 화면 하나를 너비 셋 × 테마 셋으로 찍는다. 넘침·44px 목록은 너비마다 한 번(테마는 배치를 바꾸지 않는다). */
async function capture(page: Page, name: string) {
  // 앞에서 누른 버튼 위에 마우스가 남아 있으면 호버 색이 찍힌다.
  await page.mouse.move(0, 0);
  for (const size of SIZES) {
    await page.setViewportSize(size);
    for (const [i, theme] of THEMES.entries()) {
      await page.evaluate((t) => {
        localStorage.setItem("naejeon.theme", t);
        document.documentElement.dataset.theme = t;
        window.scrollTo(0, 0);
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      // 색 전환(0.15초 안팎)이 시작되도록 잠깐 둔 뒤, 막대가 차오르는 전환 등 끝이 있는 것을 모두 기다린다.
      await page.waitForTimeout(400);
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      await page.screenshot({ path: join(SHOTS_DIR!, `${name}-${theme}-${size.width}.png`), fullPage: true });
      if (i === 0) layout[`${name}-${size.width}`] = await measure(page);
    }
  }
}

async function measure(page: Page): Promise<Layout> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const controls = document.querySelectorAll<HTMLElement>("button, a, input:not([type=hidden]), select");
    const under44: string[] = [];
    for (const el of controls) {
      if (!el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (r.width >= 44 && r.height >= 44)) continue;
      const label = (el.getAttribute("aria-label") ?? el.textContent ?? (el as HTMLInputElement).name ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 30);
      const cls = el.classList[0] ? `.${el.classList[0]}` : "";
      under44.push(`${el.tagName.toLowerCase()}${cls} "${label}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return { overflowX: doc.scrollWidth - doc.clientWidth, under44 };
  });
}

async function openScreen(page: Page, hash: string) {
  await page.goto(`/${hash}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

test("디자인 비교 사진: 첫 화면·예시 모임·로그인·고르기·준비·경기·모임 설정", async ({ page }) => {
  test.setTimeout(900000);
  mkdirSync(SHOTS_DIR!, { recursive: true });
  await page.clock.setFixedTime(FIXED_NOW);
  // 팀 짜기·섞기 씨앗(Pick·Match의 Math.random)을 매번 같게.
  await page.addInitScript(() => {
    let s = 20261111;
    Math.random = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  await page.route("**/ddragon.leagueoflegends.com/**", (route) => route.fulfill({ contentType: "image/png", body: BLANK_PNG }));

  // 로그인 전: 첫 방문 소개, 예시 모임, 로그인 창.
  await page.goto("/");
  await expect(page.getByRole("region", { name: "이 사이트 소개" })).toBeVisible();
  await capture(page, "01-intro");
  const demo = [
    ["02-demo-home", "#/demo"],
    ["03-demo-records", "#/demo/records"],
    ["04-demo-ranking", "#/demo/ranking"],
    ["05-demo-person", "#/demo/p/demo-p01"],
    ["06-demo-graphs", "#/demo/graphs"],
    ["07-demo-compare", "#/demo/compare/demo-p01/demo-p02"],
    ["08-demo-champions", "#/demo/champions"],
  ];
  for (const [name, hash] of demo) {
    await openScreen(page, hash!);
    await capture(page, name!);
  }
  await page.goto("/");
  await page.getByRole("banner").getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "로그인" })).toBeVisible();
  await capture(page, "09-login");

  // 로그인 뒤: 참가자 12명 모임에서 10명 고르기 → 준비 → 경기 시작 → 결과 입력 창 → 모임 설정.
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-shots-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (
    await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "디자인 사진 모임" } })
  ).json()) as { id: string };
  const added = await page.request.post(`/api/groups/${group.id}/participants`, {
    data: { requestId: crypto.randomUUID(), names: NAMES },
  });
  expect(added.ok()).toBe(true);

  await page.goto("/#/pick");
  await page.reload();
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of NAMES.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await capture(page, "10-pick");

  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await capture(page, "11-prep");

  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const playing = page.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(playing)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
  await expect(playing).toBeVisible();
  await page.locator(".screen-head .badge.ok").evaluate((el) => (el.textContent = "저장됨 · 오후 8:00 시작"));
  await capture(page, "12-match");

  await page.getByRole("button", { name: "결과 입력" }).click();
  await expect(page.getByRole("dialog", { name: "1경기 결과" })).toBeVisible();
  await capture(page, "13-result-sheet");
  await page.keyboard.press("Escape");

  await openScreen(page, "#/group");
  await capture(page, "14-group");

  writeFileSync(join(SHOTS_DIR!, "layout.json"), JSON.stringify(layout, null, 2));
});
