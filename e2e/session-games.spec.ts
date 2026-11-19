import { expect, test, type APIRequestContext } from "@playwright/test";

// 그날 경기(두 사람 비교, 2026-11-19).
// 같은 회차 네 경기: 1경기 가람·지수 같은 팀 → 2경기 가람 쉼 → 3경기 둘이 상대(가람 패) → 4경기 지수 쉼.
// 개인 통계 → "함께 뛴 사람별로 보기" → 지수 고르기 → 3경기 상세 → 뒤로 오면 같은 회차·같은 사람이 그대로다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const NAMES = ["가람", "지수", "선수03", "선수04", "선수05", "선수06", "선수07", "선수08", "선수09", "선수10", "선수11"];

let counter = 0;
const requestId = () => `e2e-session-${Date.now().toString(36)}-${++counter}`;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

for (const width of [390, 1440]) {
  test(`그날 경기: 같은 팀 → 상대 팀 → 함께 안 뜀을 순서대로 보고 상세에 다녀온다 (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const request = page.request;
    await post(request, "/api/auth/fake-login", {
      subject: `e2e-session-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
    });
    const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "그날 경기 모임" });
    const { participants } = await post(request, `/api/groups/${group.id}/participants`, {
      requestId: crypto.randomUUID(),
      names: NAMES,
    });
    const id = (n: number) => (participants as { id: string }[])[n]!.id;
    // 같은 사람을 되풀이해 넣으려고 서포터 순환을 끈다.
    const before = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
    const saved = await request.put(`/api/groups/${group.id}/settings`, {
      data: {
        requestId: requestId(),
        baseSettingsVersionId: before.group.settingsVersionId,
        settings: { ...before.group.settings, rotationEnabled: false },
      },
    });
    expect(saved.ok()).toBe(true);

    const play = async (people: number[], teamA: number[], winnerTeam: "A" | "B") => {
      let a = 0;
      let b = 0;
      const roster = people.map((n) => {
        const team = teamA.includes(n) ? "A" : "B";
        return { participantId: id(n), team, position: POSITIONS[(team === "A" ? a++ : b++) % 5] };
      });
      const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
      const { match } = await post(request, `/api/groups/${group.id}/matches/start`, {
        requestId: requestId(),
        baseLiveVersion: snapshot.group.liveVersion,
        roster,
        teamASide: "blue",
      });
      await post(request, `/api/groups/${group.id}/matches/${match.id}/result`, {
        requestId: requestId(),
        baseMatchVersion: match.version,
        winnerTeam,
        winnerSide: winnerTeam === "A" ? "blue" : "red",
      });
    };
    const without = (skip: number) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].filter((n) => n !== skip);
    await play(without(10), [0, 1, 2, 3, 4], "A");
    await play(without(0), [1, 2, 3, 4, 5], "A");
    await play(without(10), [0, 2, 3, 4, 5], "B");
    await play(without(1), [0, 2, 3, 4, 5], "A");

    await page.goto(`/#/p/${id(0)}`);
    const entry = page.getByRole("button", { name: /함께 뛴 사람별로 보기/ });
    if (process.env.SHOT_DIR) {
      await entry.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SHOT_DIR}/session-entry-${width}.png` });
    }
    await entry.click();
    await expect(page).toHaveURL(/#\/compare\/[^/]+\/-\?session=/);

    const panel = page.getByRole("region", { name: "그날 경기" });
    // 가람이 쉰 2경기는 줄이 없다.
    await expect(panel.getByRole("listitem")).toHaveCount(3);
    await expect(panel).toContainText("그날 모임 4경기 중 가람 출전 3경기");

    await panel.getByLabel("함께 뛴 사람").selectOption({ label: "지수" });
    await expect(page).toHaveURL(new RegExp(`#/compare/${id(0)}/${id(1)}\\?session=`));
    await expect(panel).toContainText("지수: 같은 팀 1 · 상대 팀 1 · 함께 안 뜀 1");
    const rows = panel.getByRole("button");
    await expect(rows.nth(0)).toContainText("1경기");
    await expect(rows.nth(0)).toContainText("승 · 같은 팀");
    await expect(rows.nth(1)).toContainText("3경기");
    await expect(rows.nth(1)).toContainText("패 · 상대 팀");
    await expect(rows.nth(2)).toContainText("4경기");
    await expect(rows.nth(2)).toContainText("함께 안 뜀");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "가로 넘침").toBeLessThanOrEqual(0);

    if (process.env.SHOT_DIR) {
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.SHOT_DIR}/session-games-${width}.png` });
    }

    // 키보드만으로 3경기 상세에 들어간다.
    await rows.nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/m\//);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`#/compare/${id(0)}/${id(1)}\\?session=`));
    await expect(panel).toContainText("지수: 같은 팀 1 · 상대 팀 1 · 함께 안 뜀 1");
  });
}
