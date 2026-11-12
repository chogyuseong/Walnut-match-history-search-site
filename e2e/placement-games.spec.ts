import { expect, test, type APIRequestContext } from "@playwright/test";

// 배치 경기 수 설정(모임 탭 > 기록 관리): 값을 바꿔 저장하면 개인 통계의 배치 문구가 그 수를 따른다.
// 모임·경기는 API로 만들고(rating.spec.ts와 같은 방식), 설정 저장과 확인은 화면으로 한다.

test.use({ viewport: { width: 390, height: 844 } });

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const NAMES = Array.from({ length: 10 }, (_, i) => `배치${String(i + 1).padStart(2, "0")}`);

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-placement-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

async function play(request: APIRequestContext, groupId: string, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, groupId);
  const started = (
    await post(request, `/api/groups/${groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
      teamASide: "blue",
    })
  ).match;
  await post(request, `/api/groups/${groupId}/matches/${started.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.version,
    winnerTeam: "A",
    winnerSide: "blue",
  });
}

test("배치 경기 수를 바꾸면 개인 통계의 배치 문구가 그 수를 따른다", async ({ page }) => {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-placement-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "배치모임" });
  const ensured = await post(request, `/api/groups/${group.id}/participants`, {
    requestId: crypto.randomUUID(),
    names: NAMES,
  });
  const people = ensured.participants as { id: string; name: string }[];
  // 같은 열 명으로 두 판 하려고 서포터 순환은 끈다.
  const snapshot = await snapshotOf(request, group.id);
  const off = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(off.ok()).toBe(true);
  await play(request, group.id, people);
  await play(request, group.id, people);
  const first = people.find((p) => p.name === NAMES[0])!;

  const summary = page.getByRole("region", { name: "요약" });
  await page.goto(`/#/p/${first.id}`);
  await expect(summary).toContainText("배치 진행 중 · 2/10경기 (누적 기준)");

  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "MMR 설정" });
  const input = section.getByRole("spinbutton", { name: "배치 경기 수" });
  const save = section.getByRole("button", { name: "저장" });
  await expect(input).toHaveValue("10");
  await input.fill("0");
  await expect(section.getByRole("alert")).toContainText("배치 경기 수는 1~30 사이 정수");
  await expect(save).toBeDisabled();
  await input.fill("3");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "MMR 설정을 저장했어요" })).toBeVisible();
  expect((await snapshotOf(request, group.id)).group.settings.placementGames).toBe(3);

  await page.goto(`/#/p/${first.id}`);
  await expect(summary).toContainText("배치 진행 중 · 2/3경기 (누적 기준)");

  // 2로 낮추면 지난 두 경기만으로 배치가 끝난다.
  await page.goto("/#/group");
  await input.fill("2");
  await save.click();
  await expect(page.getByRole("status").filter({ hasText: "MMR 설정을 저장했어요" })).toBeVisible();
  await page.goto(`/#/p/${first.id}`);
  await expect(summary).toContainText("배치 완료 · 누적 2경기 (누적 기준)");
});

// 두 판 모두 팀 A 승(기본 시작 1200): 전체 기록 일괄 계산(rating.ts)으로 이긴 팀 ≈ 1290.5(실버), 진 팀 ≈ 1109.5.
// 시작 점수를 1500으로 바꾸면 모두 +300: 1590(골드)·1410(실버).
test("MMR 시작 점수를 바꾸면 랭킹 숫자와 티어가 다시 계산된다", async ({ page }) => {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-placement-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "시작점수모임" });
  const ensured = await post(request, `/api/groups/${group.id}/participants`, {
    requestId: crypto.randomUUID(),
    names: NAMES,
  });
  const people = ensured.participants as { id: string; name: string }[];
  const snapshot = await snapshotOf(request, group.id);
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false, placementGames: 2 },
    },
  });
  expect(res.ok()).toBe(true);
  await play(request, group.id, people);
  await play(request, group.id, people);

  const rows = page.getByRole("region", { name: "MMR 순위표" }).getByRole("listitem");
  await page.goto("/#/ranking");
  await expect(rows.first()).toContainText("1290");
  await expect(rows.first()).toContainText("실버");

  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "MMR 설정" });
  await section.getByRole("spinbutton", { name: "MMR 시작 점수" }).fill("1500");
  await section.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("status").filter({ hasText: "MMR 설정을 저장했어요" })).toBeVisible();
  expect((await snapshotOf(request, group.id)).group.settings.ratingStart).toBe(1500);

  await page.goto("/#/ranking");
  await expect(page.getByText("시작 1500", { exact: false }).first()).toBeVisible();
  await expect(rows.first()).toContainText("1590");
  await expect(rows.first()).toContainText("골드");
  await expect(rows.last()).toContainText("1410");
  // 티어 분포는 요약 카드에서 순위표 아래 한 줄로 내렸다(디자인 4단계).
  await expect(page.locator(".mmr-tier-counts")).toHaveText("티어 분포 10명 · 골드 5 · 실버 5");
});
