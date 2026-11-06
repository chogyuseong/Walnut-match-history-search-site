import { expect, test, type Page } from "@playwright/test";

// 우선순위 제안(기록으로 제안받기 → 고른 사람만 적용) · 순위 점검 · 기피 라인(지정 → 섞기에서 피함).

test.use({ viewport: { width: 390, height: 844 } });

const names = Array.from({ length: 12 }, (_, i) => `기피${String(i + 1).padStart(2, "0")}`);
const POS = ["탑", "정글", "미드", "원딜", "서폿"];

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 준비 화면 명단에서 사람마다 [팀, 라인]. 팀 목록의 줄 순서가 탑→서폿이다. */
async function lineup(page: Page): Promise<Map<string, [string, string]>> {
  const result = new Map<string, [string, string]>();
  for (const team of ["A", "B"]) {
    const texts = await page.getByRole("region", { name: `팀 ${team}` }).getByRole("list").first().getByRole("button").allInnerTexts();
    expect(texts).toHaveLength(5);
    texts.forEach((t, i) => result.set(t.match(/기피\d\d/)![0], [team, POS[i]!]));
  }
  return result;
}

test("기록으로 제안받기 → 고른 사람만 적용, 순위 점검, 기피 라인 지정 → 팀 확정·팀·라인 모두 섞기이 피함", async ({ page }) => {
  test.setTimeout(180000);
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-avoid-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { name: "기피 모임" } })).json()) as { id: string };
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { names } });
  const ids = ((await ensured.json()) as { participants: { id: string; name: string }[] }).participants.map((p) => p.id);

  // 지난 경기 12판: 앞 다섯 명(팀 A)이 9승 3패. 모두 배치 완료(10경기 이상)가 된다.
  for (let i = 0; i < 12; i++) {
    const res = await page.request.post(`/api/groups/${group.id}/matches/backfill`, {
      data: {
        requestId: `seed-${Date.now().toString(36)}-${i}-${Math.floor(Math.random() * 1e6)}`,
        playedAt: new Date(Date.now() - (20 - i) * 3600_000).toISOString(),
        roster: ids.slice(0, 10).map((id, k) => ({ participantId: id, team: k < 5 ? "A" : "B", position: null })),
        winnerTeam: i < 9 ? "A" : "B",
        winnerSide: "unknown",
      },
    });
    expect(res.ok()).toBe(true);
  }

  // ---------- 우선순위: 기록으로 제안받기
  await page.goto("/#/priority");
  await expect(page.getByRole("heading", { name: "우선순위 배정" })).toBeVisible();
  // 순위 점검: 아직 아무도 안 정했으므로 합은 모두 같고, 배치 완료 10명이 "아직 안 정함"이다.
  const check = page.getByRole("region", { name: "순위 점검" });
  await expect(check).toContainText("경기 당시의 순위는 저장하지 않아요. 지금 순위를 지난 경기에 적용해 계산한 값이에요.");
  await expect(check).toContainText("자료 적음");
  await expect(check.getByRole("list", { name: "아직 안 정함" }).getByRole("listitem")).toHaveCount(10);

  await page.getByRole("button", { name: "기록으로 제안받기" }).click();
  const dialog = page.getByRole("dialog", { name: "기록으로 제안받기" });
  await expect(dialog).toContainText("승률만 본 참고값");
  const boxes = dialog.getByRole("list", { name: "제안 목록" }).getByRole("checkbox");
  await expect(boxes).toHaveCount(10);
  for (const box of await boxes.all()) await expect(box).toBeChecked();
  // 앞 다섯 명(75%)은 1순위, 뒤 다섯 명(25%)은 3순위로 제안(같은 성적은 같은 순위).
  await expect(dialog.getByText(/기피01/).first()).toBeVisible();
  await expect(dialog.getByRole("listitem").filter({ hasText: "기피01" })).toContainText("미지정 → 1순위");
  await expect(dialog.getByRole("listitem").filter({ hasText: "기피06" })).toContainText("미지정 → 3순위");
  await expect(dialog.getByRole("listitem").filter({ hasText: "기피06" })).toContainText("12경기 · 승률 25%");
  await expect(dialog.getByText("기록이 적어 제안 없음 2명")).toBeVisible();
  await noHorizontalOverflow(page);
  // 한 명은 빼고 적용한다.
  await dialog.getByRole("listitem").filter({ hasText: "기피10" }).getByRole("checkbox").uncheck();
  await dialog.getByRole("button", { name: "선택한 9명 적용" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast")).toHaveText("9명의 우선순위를 바꿨어요.");
  const section = (label: string) => page.getByRole("region", { name: label, exact: true });
  await expect(section("1순위").getByRole("listitem")).toHaveCount(5);
  await expect(section("3순위").getByRole("listitem")).toHaveCount(4);
  await expect(check.getByRole("list", { name: "아직 안 정함" }).getByRole("listitem")).toHaveCount(1);
  await expect(check.getByRole("list", { name: "아직 안 정함" })).toContainText("기피10");
  // 이제 두 팀 순위 합이 달랐던 12경기 중 합이 높은 팀이 9승.
  await expect(check).toContainText("12경기 중 합이 높은 팀이 9승 (75%)");
  await noHorizontalOverflow(page);

  // ---------- 기피 라인
  await page.getByRole("tab", { name: "기피 라인" }).click();
  await expect(page.getByRole("heading", { name: "기피 라인" })).toBeVisible();
  await expect(page.getByText("서폿 돌아가며·서포터만 바꾸기는 서포터 횟수 규칙이 먼저예요")).toBeVisible();
  const toggle = (name: string, pos: string) => page.getByRole("button", { name: `${name} ${pos} 기피`, exact: true });
  // 기피01: 탑·정글·미드·원딜(서폿만 감). 다섯 번째는 눌리지 않고 이유를 알린다.
  for (const pos of ["탑", "정글", "미드", "원딜"]) {
    await toggle("기피01", pos).click();
    await expect(toggle("기피01", pos)).toHaveAttribute("aria-pressed", "true");
    await expect(toggle("기피01", pos)).toBeEnabled();
  }
  // 다섯 번째는 aria-disabled(보조 기술에 "누를 수 없음")지만 누르면 이유를 알린다.
  await expect(toggle("기피01", "서폿")).toHaveAttribute("aria-disabled", "true");
  await toggle("기피01", "서폿").click({ force: true });
  await expect(page.locator(".toast")).toContainText("4개까지");
  await expect(toggle("기피01", "서폿")).toHaveAttribute("aria-pressed", "false");
  // 기피06: 서폿.
  await toggle("기피06", "서폿").click();
  await expect(toggle("기피06", "서폿")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle("기피06", "서폿")).toBeEnabled();
  // 터치 44px 이상, 390px 넘침 없음, 새로 읽어도 저장됨.
  for (const pos of POS) {
    const box = (await toggle("기피02", pos).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
  await page.reload();
  await expect(toggle("기피01", "원딜")).toHaveAttribute("aria-pressed", "true");
  await expect(toggle("기피06", "서폿")).toHaveAttribute("aria-pressed", "true");

  // ---------- 준비 화면에서 섞기
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const name of names.slice(0, 10)) await all.getByRole("button", { name: new RegExp(name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  const tools = page.getByRole("region", { name: "섞기", exact: true });
  await expect(tools).toContainText("서폿 돌아가며·서포터만 바꾸기는 서포터 횟수 규칙이 먼저예요");
  // 처음 팀 짜기도 기피를 피했다.
  let seen = await lineup(page);
  expect(seen.get("기피01")![1]).toBe("서폿");
  expect(seen.get("기피06")![1]).not.toBe("서폿");

  for (let i = 0; i < 6; i++) {
    const before = await lineup(page);
    await tools.getByRole("button", { name: "라인만 섞기", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("팀원은 그대로 두고 라인을 섞었어요.");
    seen = await lineup(page);
    for (const [name, [team]] of before) expect(seen.get(name)![0]).toBe(team);
    expect(seen.get("기피01")![1]).toBe("서폿");
    expect(seen.get("기피06")![1]).not.toBe("서폿");
  }
  const teams = new Set<string>();
  for (let i = 0; i < 6; i++) {
    await tools.getByRole("button", { name: "팀·라인 모두 섞기" }).click();
    await expect(page.locator(".toast")).toContainText("나눴어요");
    seen = await lineup(page);
    expect(seen.get("기피01")![1]).toBe("서폿");
    expect(seen.get("기피06")![1]).not.toBe("서폿");
    teams.add([...seen].filter(([, [t]]) => t === "A").map(([n]) => n).sort().join(","));
  }
  expect(teams.size).toBeGreaterThan(1);
  await expect(page.locator(".tag.avoid-tag")).toHaveCount(0);
  await noHorizontalOverflow(page);

  // 손으로 바꾸는 것은 막지 않고, 기피 라인에 선 사람에게 "기피" 표시를 붙인다.
  const [team01] = seen.get("기피01")!;
  const topName = [...seen].find(([, [t, p]]) => t === team01 && p === "탑")![0];
  const teamBox = page.getByRole("region", { name: `팀 ${team01}` });
  await teamBox.getByRole("button", { name: /기피01/ }).click();
  await teamBox.getByRole("button", { name: new RegExp(topName) }).click();
  const moved = teamBox.getByRole("button", { name: /기피01/ });
  await expect(moved).toContainText("탑");
  await expect(moved.locator(".tag.avoid-tag")).toHaveText("기피");
  await noHorizontalOverflow(page);
});
