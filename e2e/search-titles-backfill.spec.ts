import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 전적 검색 메뉴, 칭호, 연도별 보기, 지난 경기 한 건 입력을 실제 브라우저에서 확인한다.
// 경기는 API로 빠르게 만들고 화면은 읽는 쪽과 입력 폼만 본다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-a-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

/** 12명 모임을 만들고 순환을 끈다(같은 명단을 반복해서 쓰기 위해). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-a-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "검색 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await getSnapshot(request, group.id);
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants };
}

function rosterOf(ten: { id: string }[]) {
  return ten.map((p, i) => ({
    participantId: p.id,
    team: i < 5 ? "A" : "B",
    position: POSITIONS[i % 5],
  }));
}

/** 주어진 10명으로 한 경기를 시작하고 결과를 확정한다. 앞 5명이 팀 A다. */
async function play(request: APIRequestContext, s: Setup, ten: { id: string }[], winnerTeam: "A" | "B") {
  const snapshot = await getSnapshot(request, s.groupId);
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: rosterOf(ten),
  });
  await post(request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.match.version,
    winnerTeam,
    winnerSide: "unknown",
  });
}

/** 지난 경기를 API로 넣는다. */
async function backfill(
  request: APIRequestContext,
  s: Setup,
  ten: { id: string }[],
  playedAt: string,
  winnerTeam: "A" | "B",
) {
  return post(request, `/api/groups/${s.groupId}/matches/backfill`, {
    requestId: requestId(),
    playedAt,
    roster: rosterOf(ten),
    winnerTeam,
    winnerSide: "unknown",
  });
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("검색 메뉴 → 개인 통계, 칭호가 검색·랭킹·개인·그래프·조회 링크에서 같다 (35)", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 선수01~05(팀 A) 7승 3패 = 70% → 기본 칭호 "전장의 지배자". 선수06~10은 30% → "불굴의 개척자".
  for (let i = 0; i < 10; i++) await play(page.request, s, first10, i < 7 ? "A" : "B");
  // 선수11은 1경기뿐이라 배치 진행 중이다.
  const mixed = [s.people[10]!, ...first10.slice(1, 5), ...first10.slice(5)];
  await backfill(page.request, s, mixed, "2026-01-10T12:00:00.000Z", "A");

  await page.goto("/#/");
  const menu = page.getByRole("navigation", { name: "주 메뉴" });
  await menu.getByRole("button", { name: "검색" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "전적 검색" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "검색" })).toHaveAttribute("aria-current", "page");

  const box = page.getByRole("searchbox");
  await box.fill("선수0");
  const results = page.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(results).toHaveCount(9);
  const row02 = results.filter({ hasText: "선수02" });
  await expect(row02).toContainText("73%"); // 11경기 8승
  await expect(row02).toContainText("전장의 지배자");
  await expect(row02).toContainText("누적 기준");
  await expect(results.filter({ hasText: "선수07" })).toContainText("불굴의 개척자");

  await box.fill("선수11");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("배치 진행 중 1/10 (누적 기준)");
  await expect(results.first()).not.toContainText("지배자");

  await box.fill("없는사람");
  await expect(page.getByText("일치하는 이름이 없어요.")).toBeVisible();

  // 결과를 누르면 개인 통계로 간다. 칭호는 요약에도 같게 나온다.
  await box.fill("선수02");
  await results.first().getByRole("button").click();
  await expect(page).toHaveURL(/#\/p\//);
  await expect(page.getByRole("heading", { level: 1, name: "선수02" })).toBeVisible();
  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary).toContainText("전장의 지배자");
  // 범위를 바꿔도 칭호는 그대로다(누적 기준). 2026년에는 선수02가 1경기뿐이다.
  await page.getByLabel("연도 선택").selectOption({ label: "2026년" });
  await expect(summary).toContainText("전장의 지배자");

  // 랭킹과 그래프에서도 같은 칭호다.
  await menu.getByRole("button", { name: "기록" }).click();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const ranking = page.getByRole("region", { name: "소환사 랭킹" }).getByRole("listitem");
  await expect(ranking.filter({ hasText: "선수02" })).toContainText("전장의 지배자");
  await expect(ranking.filter({ hasText: "선수11" })).toContainText("배치 진행 중 1/10");
  await menu.getByRole("button", { name: "분석" }).click();
  const bars = page.getByRole("region", { name: "개인별 승률" }).getByRole("listitem");
  await expect(bars.filter({ hasText: "선수02" })).toContainText("전장의 지배자");
  await expect(bars.filter({ hasText: "선수11" })).toContainText("배치 진행 중");

  // 조회 링크에서도 같은 검색 화면을 쓴다.
  const snapshot = await getSnapshot(page.request, s.groupId);
  await page.goto(`/#/v/${snapshot.group.viewToken}/now`);
  await page.getByRole("navigation", { name: "조회 메뉴" }).getByRole("button", { name: "검색" }).click();
  await page.getByRole("searchbox").fill("선수02");
  const viewerRow = page.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(viewerRow).toContainText("전장의 지배자");
  await viewerRow.getByRole("button").click();
  await expect(page).toHaveURL(new RegExp(`#/v/${snapshot.group.viewToken}/p/`));
  await expect(page.getByRole("region", { name: "요약" })).toContainText("전장의 지배자");
});

test("모임 탭에서 칭호 이름·경계를 바꾸면 모든 화면에 바로 적용된다", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 팀 A 6승 4패 = 60%: 기본 구간에서는 "승리 설계자".
  for (let i = 0; i < 10; i++) await play(page.request, s, first10, i < 6 ? "A" : "B");

  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "칭호" });
  await expect(section).toContainText("지금 이름은 임시 기본값입니다.");
  await expect(section).toContainText("승리 설계자");
  await section.getByRole("button", { name: "칭호 바꾸기" }).click();
  const dialog = page.getByRole("dialog", { name: "칭호 바꾸기" });
  // 맨 위 구간의 경계를 60%로 낮추고 이름을 바꾼다. 정확히 60%면 그 구간이다(이상).
  await dialog.getByLabel("1번째 칭호 이름").fill("우리 모임 에이스");
  await dialog.getByLabel("1번째 칭호 경계(% 이상)").fill("60");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toBeHidden();
  await expect(section).toContainText("우리 모임 에이스");
  await expect(section).not.toContainText("임시 기본값");

  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "검색" }).click();
  // 모임 탭에도 참가자 찾기 칸이 있으므로 검색 화면이 열린 뒤 그 화면의 칸에 넣는다.
  await expect(page.getByRole("heading", { level: 1, name: "전적 검색" })).toBeVisible();
  await page.getByRole("searchbox", { name: "플레이어 이름" }).fill("선수01");
  await expect(page.getByRole("region", { name: "검색 결과" })).toContainText("우리 모임 에이스");

  // 틀린 값(같은 경계 두 개)은 저장하지 않고 이유를 알려준다.
  await page.goto("/#/group");
  await section.getByRole("button", { name: "칭호 바꾸기" }).click();
  await dialog.getByLabel("2번째 칭호 경계(% 이상)").fill("60");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog.getByRole("alert")).toContainText("같은 경계");
  await dialog.getByRole("button", { name: "닫기" }).click();
});

test("연도 필터: 경기가 있는 해만 고를 수 있고 모임 시간대로 해를 나눈다", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 2025년 2경기, 2026년 1경기. 마지막 경기는 UTC로는 2025년이지만 한국 시간 2026-01-01 00:30이다.
  await backfill(page.request, s, first10, "2025-03-01T12:00:00.000Z", "A");
  await backfill(page.request, s, first10, "2025-12-31T14:30:00.000Z", "A");
  await backfill(page.request, s, first10, "2025-12-31T15:30:00.000Z", "B");

  await page.goto("/#/records");
  const years = page.getByLabel("연도 선택");
  await expect(years.getByRole("option")).toHaveText(["연도", "2026년", "2025년"]);
  await years.selectOption({ label: "2025년" });
  await expect(page.getByRole("heading", { name: /2025년 경기 · 2경기 확정/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /소환사 랭킹 \(2025년\)/ })).toBeVisible();
  await years.selectOption({ label: "2026년" });
  await expect(page.getByRole("heading", { name: /2026년 경기 · 1경기 확정/ })).toBeVisible();

  // 개인 통계: 2025년 선수01은 2승, 2026년은 1패. 배치는 누적 3/10 그대로다.
  await page.getByRole("region", { name: "소환사 랭킹" }).getByRole("button", { name: /선수01/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "선수01" })).toBeVisible();
  await page.getByLabel("연도 선택").selectOption({ label: "2025년" });
  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary).toContainText("100% · 2승 0패 (2경기)");
  await expect(summary).toContainText("배치 진행 중 · 3/10경기 (누적 기준)");

  // 그래프: 범위 목록에 연도가 있다.
  await page.goto("/#/graphs");
  await page.getByLabel("범위", { exact: true }).selectOption({ label: "2025년" });
  await expect(page.getByText(/2025년 · 확정 2경기/)).toBeVisible();

  // 320px에서 범위 고르기가 넘치지 않는다.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/#/records");
  await noHorizontalOverflow(page);
});

test("지난 경기 한 건 입력: 폼으로 넣고 세션·순환·진행 상태는 그대로다", async ({ page }) => {
  const s = await setup(page);
  const before = await getSnapshot(page.request, s.groupId);

  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 경기 한 건 넣기" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "지난 경기 입력" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "모임" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await noHorizontalOverflow(page);

  // 비어 있으면 저장하지 않고 이유를 알려준다.
  await page.getByRole("button", { name: "이 경기 저장" }).click();
  await expect(page.getByRole("alert")).toContainText("이름이 빈 칸이 10개 있어요.");

  await page.getByLabel("날짜").fill("2025-06-01");
  await page.getByLabel("시각").fill("20:00");
  for (let i = 0; i < 5; i++) {
    await page.getByLabel(`팀 A ${i + 1}번 이름`).fill(`선수${String(i + 1).padStart(2, "0")}`);
    await page.getByLabel(`팀 B ${i + 1}번 이름`).fill(i < 3 ? `선수${String(i + 6).padStart(2, "0")}` : `새사람${i}`);
  }
  await page.getByLabel("팀 A 1번 포지션").selectOption({ label: "탑" });
  await expect(page.getByText("새로 만들 참가자 2명: 새사람3, 새사람4")).toBeVisible();
  await page.getByRole("radio", { name: "팀 B 승" }).check();
  await page.getByRole("radio", { name: /^팀 A가 레드/ }).check();
  await page.getByRole("button", { name: "이 경기 저장" }).click();
  // 팀 A가 레드였으므로 이긴 팀 B는 블루팀이다.
  await expect(page.getByRole("status").filter({ hasText: "경기 저장됨" })).toContainText("블루팀 승");

  const after = await getSnapshot(page.request, s.groupId);
  expect(after.session).toEqual(before.session);
  expect(after.rotation).toEqual(before.rotation);
  expect(after.group.liveVersion).toBe(before.group.liveVersion);
  const saved = after.matches.find((m: { source: string }) => m.source === "backfill");
  expect(saved.sessionId).toBeNull();
  expect(saved.teamASide).toBe("red");
  expect(saved.playedAt).toBe("2025-06-01T11:00:00.000Z"); // 한국 20:00

  // 경기 상세: 지난 경기 입력 표시, 이긴 팀 B는 블루.
  await page.getByRole("button", { name: "이 경기 보기" }).click();
  await expect(page.getByText("지난 경기 입력", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("승리 팀의 진영: 블루")).toBeVisible();

  // 기록 화면에서도 들어갈 수 있다.
  await page.goto("/#/records");
  await page.getByRole("button", { name: "지난 경기 입력" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "지난 경기 입력" })).toBeVisible();
});

test("주 메뉴 6개(랭킹 포함): 320px에서 넘치지 않고 터치 대상 44px 이상", async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/#/search");
  const menu = page.getByRole("navigation", { name: "주 메뉴" });
  await expect(menu.getByRole("button")).toHaveCount(6);
  await noHorizontalOverflow(page);
  const boxes = await menu
    .getByRole("button")
    .evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect()).map((r) => [r.left, r.right, r.height]));
  for (const [left, right, height] of boxes) {
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(320);
    expect(height).toBeGreaterThanOrEqual(44);
  }
});
