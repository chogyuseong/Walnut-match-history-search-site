import { expect, test, type Page } from "@playwright/test";

// 티어 배정 속도(2026-11-11): 여러 명 적용은 일괄 저장 요청 한 번, 연달아 누르기는 기다리지 않고 마지막에 한 번만 다시 읽는다.
// 예전에는 누를 때마다 모임 전체 스냅숏을 다시 읽었고, "선택한 N명 적용"은 사람마다 PATCH를 차례로 보냈다.

test.use({ viewport: { width: 390, height: 844 } });

/** 이 페이지가 보낸 참가자 쓰기·스냅숏 읽기 요청을 센다. */
function countRequests(page: Page) {
  const seen = { bulk: 0, patch: 0, snapshot: 0 };
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path.endsWith("/participants/skill-groups")) seen.bulk += 1;
    if (req.method() === "PATCH" && /\/participants\/[^/]+$/.test(path)) seen.patch += 1;
    if (req.method() === "GET" && path.endsWith("/snapshot")) seen.snapshot += 1;
  });
  return {
    seen,
    reset: () => Object.assign(seen, { bulk: 0, patch: 0, snapshot: 0 }),
  };
}

async function setup(page: Page, prefix: string, count: number) {
  const login = await page.request.post("/api/auth/fake-login", {
    data: { subject: `e2e-${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` },
  });
  expect(login.ok()).toBe(true);
  const group = (await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "속도 모임" } })).json()) as { id: string };
  const names = Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, "0")}`);
  const ensured = await page.request.post(`/api/groups/${group.id}/participants`, { data: { requestId: crypto.randomUUID(), names } });
  const ids = ((await ensured.json()) as { participants: { id: string }[] }).participants.map((p) => p.id);
  return { gid: group.id, names, ids };
}

async function savedGroups(page: Page, gid: string): Promise<Record<string, number | null>> {
  const snap = (await (await page.request.get(`/api/groups/${gid}/snapshot`)).json()) as {
    participants: { name: string; skillGroup: number | null }[];
  };
  return Object.fromEntries(snap.participants.map((p) => [p.name, p.skillGroup]));
}

test("기록으로 제안받기의 여러 명 적용은 쓰기 요청 1번 + 스냅숏 읽기 1번", async ({ page }) => {
  test.setTimeout(120000);
  const { gid, ids } = await setup(page, "일괄", 12);
  // 앞 다섯 명이 9승 3패인 12판(모두 배치 완료가 되어 10명에게 제안이 나온다).
  for (let i = 0; i < 12; i++) {
    const res = await page.request.post(`/api/groups/${gid}/matches/backfill`, {
      data: {
        requestId: crypto.randomUUID(),
        playedAt: new Date(Date.now() - (20 - i) * 3600_000).toISOString(),
        roster: ids.slice(0, 10).map((id, k) => ({ participantId: id, team: k < 5 ? "A" : "B", position: null })),
        winnerTeam: i < 9 ? "A" : "B",
        winnerSide: "unknown",
      },
    });
    expect(res.ok()).toBe(true);
  }
  await page.goto("/#/priority");
  await expect(page.getByRole("heading", { name: "티어 배정" })).toBeVisible();
  const counter = countRequests(page);

  await page.getByRole("button", { name: "기록으로 제안받기" }).click();
  const dialog = page.getByRole("dialog", { name: "기록으로 제안받기" });
  await dialog.getByRole("button", { name: "선택한 10명 적용" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".toast")).toHaveText("10명의 티어를 바꿨어요.");
  expect(counter.seen).toEqual({ bulk: 1, patch: 0, snapshot: 1 });

  const saved = await savedGroups(page, gid);
  for (let i = 1; i <= 5; i++) expect(saved[`일괄${String(i).padStart(2, "0")}`]).toBe(1);
  for (let i = 6; i <= 10; i++) expect(saved[`일괄${String(i).padStart(2, "0")}`]).toBe(3);
  expect(saved["일괄11"]).toBe(null);
});

test("연달아 누르기: 기다리지 않고 눌러지며, 같은 사람을 여러 번 바꿔도 마지막 값이 남고, 다시 읽기는 한 번", async ({ page }) => {
  test.setTimeout(120000);
  const { gid, names } = await setup(page, "연타", 6);
  await page.goto("/#/priority");
  await expect(page.getByRole("heading", { name: "티어 배정" })).toBeVisible();
  const counter = countRequests(page);
  const button = (name: string, label: string) => page.getByRole("button", { name: `${name} ${label}`, exact: true });

  // 같은 사람을 1 → 2 → 5 → 3티어로, 다른 사람들도 이어서. 저장이 끝나기를 기다리지 않는다.
  const clicks: [string, string][] = [
    [names[0]!, "1티어"],
    [names[0]!, "2티어"],
    [names[1]!, "4티어"],
    [names[0]!, "5티어"],
    [names[2]!, "1티어"],
    [names[0]!, "3티어"],
    [names[3]!, "2티어"],
    [names[1]!, "미지정"],
    [names[4]!, "5티어"],
  ];
  for (const [name, label] of clicks) {
    await button(name, label).click({ timeout: 2000 });
    await expect(button(name, label)).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.locator(".priority-saving")).toBeHidden();
  // 화면과 서버 모두 마지막 값.
  await expect(button(names[0]!, "3티어")).toHaveAttribute("aria-pressed", "true");
  await expect(button(names[1]!, "미지정")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await savedGroups(page, gid)).toMatchObject({
    [names[0]!]: 3,
    [names[1]!]: null,
    [names[2]!]: 1,
    [names[3]!]: 2,
    [names[4]!]: 5,
    [names[5]!]: null,
  });
  // 쓰기는 누른 수 이하(같은 사람의 밀린 값은 마지막 것만 보낸다), 스냅숏 읽기는 마지막에 한 번.
  expect(counter.seen.patch).toBeGreaterThanOrEqual(5);
  expect(counter.seen.patch).toBeLessThanOrEqual(clicks.length);
  expect(counter.seen.snapshot).toBe(1);

  await page.reload();
  await expect(button(names[0]!, "3티어")).toHaveAttribute("aria-pressed", "true");
});
