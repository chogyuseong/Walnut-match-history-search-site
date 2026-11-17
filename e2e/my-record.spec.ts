import { expect, test, type APIRequestContext } from "@playwright/test";

// 조회 링크에서 "내 이름"을 한 번 고르면 경기 화면에서 검색 없이 내 전적으로 가고, 개인 통계 위쪽에서 최근 경기 5개를 본다(2026-11-17).
// 경기는 API로 만들고, 확인할 흐름은 로그인 없는 화면으로 한다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
/** 최근 경기 미리 보기(5줄)보다 많아야 "참여 경기 전체 보기"가 나온다. */
const GAMES_PLAYED = 6;
const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-me-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function playedGroup(request: APIRequestContext) {
  await post(request, "/api/auth/fake-login", { subject: `e2e-me-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}` });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "내 전적 모임" });
  const names = Array.from({ length: 10 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const { participants } = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  // 같은 10명으로 여러 번 뛰므로 서포터 순환을 끈다(켜 두면 두 번째 경기부터 서포터 중복으로 막힌다).
  const before = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  const settingsSaved = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: before.group.settingsVersionId,
      settings: { ...before.group.settings, rotationEnabled: false },
    },
  });
  expect(settingsSaved.ok()).toBe(true);
  const roster = participants.map((p: { id: string }, i: number) => ({
    participantId: p.id,
    team: i < 5 ? "A" : "B",
    position: POSITIONS[i % 5],
  }));
  for (let game = 0; game < GAMES_PLAYED; game++) {
    const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
    const { match } = await post(request, `/api/groups/${group.id}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster,
      teamASide: "blue",
    });
    const winnerTeam = game % 2 === 0 ? "A" : "B";
    await post(request, `/api/groups/${group.id}/matches/${match.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: match.version,
      winnerTeam,
      winnerSide: winnerTeam === "A" ? "blue" : "red",
    });
  }
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  return snapshot.group.viewToken as string;
}

test("조회 링크: 내 이름을 고르면 첫 화면에서 내 전적으로 가고, 최근 경기 5개가 위에 보인다", async ({ page, browser }) => {
  const token = await playedGroup(page.request);

  for (const viewport of WIDTHS) {
    const guestContext = await browser.newContext({ viewport });
    const guest = await guestContext.newPage();
    await guest.goto(`/#/v/${token}/now`);

    // 확정한 경기가 있으면 첫 화면은 마지막 경기다. 내 자리 줄 아래에 "내 전적 보기"가 생긴다.
    await guest.getByRole("button", { name: "내 이름 고르기" }).click();
    await guest.getByRole("dialog", { name: "내 이름 고르기" }).getByRole("button", { name: "선수01" }).click();
    await expect(guest.getByText("선수01 님 · 블루팀 · 탑")).toBeVisible();
    await guest.screenshot({ path: `test-results/my-record-now-${viewport.width}.png`, fullPage: true });

    await guest.getByRole("button", { name: "내 전적 보기 →" }).click();
    await expect(guest.getByRole("heading", { level: 1, name: "선수01" })).toBeVisible();
    const recent = guest.getByRole("region", { name: "최근 경기" });
    await expect(recent.getByRole("listitem")).toHaveCount(5);
    await expect(recent.getByRole("button", { name: "참여 경기 전체 보기 ↓" })).toBeVisible();
    await guest.screenshot({ path: `test-results/my-record-person-${viewport.width}.png`, fullPage: true });

    const overflow = await guest.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${viewport.width}px 가로 넘침`).toBeLessThanOrEqual(0);

    // 다시 열어도(같은 기기) 고른 이름이 남아 있다.
    await guest.goto(`/#/v/${token}/now`);
    await expect(guest.getByRole("button", { name: "내 전적 보기 →" })).toBeVisible();
    await guestContext.close();
  }
});
