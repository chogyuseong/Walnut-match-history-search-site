import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 구현 6번(이름 검색, 소환사 랭킹, 개인 통계, 시즌)을 실제 브라우저에서 확인한다.
// 경기는 API로 빠르게 만들고 화면은 읽는 쪽만 본다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-req-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

/** 12명 모임을 만들고 순환을 끈다(같은 명단을 반복해서 쓰기 위해). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-rec-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: "기록 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants };
}

/** 주어진 10명으로 한 경기를 시작하고 결과를 확정한다. 앞 5명이 팀 A다. */
async function play(
  request: APIRequestContext,
  s: Setup,
  ten: { id: string }[],
  winnerTeam: "A" | "B",
  winnerSide: "blue" | "red" | "unknown",
) {
  const snapshot = await (await request.get(`/api/groups/${s.groupId}/snapshot`)).json();
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: ten.map((p, i) => ({
      participantId: p.id,
      team: i < 5 ? "A" : "B",
      position: POSITIONS[i % 5],
    })),
  });
  await post(request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.match.version,
    winnerTeam,
    winnerSide,
  });
}

test.use({ viewport: { width: 390, height: 844 } });

test("랭킹·검색·개인 통계·시즌", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 선수01~10이 10경기: 팀 A(선수01~05)가 7승 3패. 진영은 블루 4, 레드 3, 미상 3.
  for (let i = 0; i < 10; i++) {
    const winner = i < 7 ? "A" : "B";
    const side = i < 4 ? "blue" : i < 7 ? "red" : "unknown";
    await play(page.request, s, first10, winner, side);
  }
  // 11번째 경기: 선수11·12가 선수01·06 대신 들어와 팀 A가 이긴다. 두 사람은 배치 1/10이고 승률은 100%·0%다.
  const mixed = [s.people[10]!, ...first10.slice(1, 5), s.people[11]!, ...first10.slice(6)];
  await play(page.request, s, mixed, "A", "blue");

  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { name: /전체 경기 · 11경기 확정/ })).toBeVisible();

  // 순위: 배치 완료자가 먼저다. 승률 100%인 선수11(1경기)은 배치 완료자들 뒤에 온다. (35)
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  const rows = ranking.getByRole("listitem");
  await expect(rows).toHaveCount(12);
  const texts = await rows.allInnerTexts();
  const indexOf = (name: string) => texts.findIndex((t) => t.includes(name));
  expect(indexOf("선수11")).toBeGreaterThan(indexOf("선수10"));
  expect(indexOf("선수02")).toBeLessThan(indexOf("선수07"));
  await expect(rows.filter({ hasText: "선수11" })).toContainText("배치 진행 중 1/10 (누적 기준)");
  await expect(rows.filter({ hasText: "선수02" })).not.toContainText("배치 진행 중");

  // 이름 검색: 일치하는 사람만 보이고 순위 숫자는 검색 전과 같다.
  const rankBefore = (await rows.filter({ hasText: "선수07" }).innerText()).trim().split(/\s+/)[0];
  await ranking.getByLabel("이름 검색").fill("선수07");
  await expect(rows).toHaveCount(1);
  const rankAfter = (await rows.first().innerText()).trim().split(/\s+/)[0];
  expect(rankAfter).toBe(rankBefore);
  await ranking.getByLabel("이름 검색").fill("없는사람");
  await expect(ranking.getByText("일치하는 이름이 없어요.")).toBeVisible();

  // 개인 통계: 선수02는 팀 A에서 11경기 8승 3패.
  await ranking.getByLabel("이름 검색").fill("선수02");
  await rows.first().getByRole("button").click();
  await expect(page.getByRole("heading", { name: "선수02", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "요약" })).toContainText("73% · 8승 3패 (11경기)");
  await expect(page.getByRole("region", { name: "요약" })).toContainText(
    "배치 완료 · 누적 11경기 (누적 기준)",
  );
  await expect(page.getByRole("region", { name: "최근" })).toContainText("최근 10경기");
  await expect(page.getByRole("region", { name: "최근" })).toContainText("최근 11경기");

  // 라인별: 선수02는 정글만 했다. 다른 라인은 0%가 아니라 "기록 없음"이다. (33)
  const lines = page.getByRole("region", { name: "라인별" });
  await expect(lines.getByRole("listitem").filter({ hasText: "정글" })).toContainText("11경기");
  await expect(lines.getByRole("listitem").filter({ hasText: "서폿" })).toContainText("기록 없음");
  await expect(lines.getByRole("listitem").filter({ hasText: "서폿" })).not.toContainText("0%");

  // 진영별: 미상 3경기는 제외하고 그 수를 알려준다.
  const sides = page.getByRole("region", { name: "진영별" });
  await expect(sides.getByRole("listitem").filter({ hasText: "블루" })).toContainText("(5경기)");
  await expect(sides.getByRole("listitem").filter({ hasText: "레드" })).toContainText("(3경기)");
  await expect(sides).toContainText("진영 미상 3경기는 제외했습니다.");

  // 비교 지표: 선수02는 누적 11경기라 동료·상대·같은 팀·상대 팀 자리에 값 대신 안내가 나온다.
  // (누적 30경기 이상일 때의 목록·"자료 적음" 검사는 person-visual.spec.ts에 있다.)
  const locked = "누적 30경기부터 보여줘요 (지금 11경기)";
  const synergy = page.getByRole("region", { name: "시너지" });
  await expect(synergy).toContainText(locked);
  await expect(synergy.getByRole("listitem")).toHaveCount(0);
  const versus = page.getByRole("region", { name: "상대 전적" });
  await expect(versus).toContainText(locked);
  await expect(versus.getByRole("listitem")).toHaveCount(0);
  const tiles = page.getByRole("region", { name: "세부 기록" }).locator(".ps-tiles");
  await expect(tiles.locator("div").filter({ hasText: "잘 맞는 동료" })).toContainText(locked);
  await expect(tiles.locator("div").filter({ hasText: "어려운 상대" })).toContainText(locked);
  await expect(page.getByRole("group", { name: "시너지·상대 전적 순서" })).toHaveCount(0);

  // 화면 순서: 요약 → 최근 → 라인별 → 진영별 → 시너지 → 상대 전적 → 다른 플레이어와 비교(2026-11-07, 2026-11-08 이름 바꿈) → 참여 경기(맨 아래).
  const order = await page
    .getByRole("region")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  expect(order).toEqual(["요약", "세부 기록", "최근", "라인별", "진영별", "시너지", "상대 전적", "다른 플레이어와 비교", "맞라인 상대", "참여 경기"]);
  // 참여 경기는 최근 10경기만 먼저 그리고 "더 보기"로 나머지를 연다.
  const played = page.getByRole("region", { name: "참여 경기" });
  await expect(played.getByRole("listitem")).toHaveCount(10);
  await played.getByRole("button", { name: "나머지 1경기 중 1경기 더 보기" }).click();
  await expect(played.getByRole("listitem")).toHaveCount(11);

  // 참여 경기에서 경기 상세로 이어진다.
  await page.getByRole("region", { name: "참여 경기" }).getByRole("button").first().click();
  await expect(page.getByRole("heading", { name: "11경기", level: 1 })).toBeVisible();

  // 시즌: 오늘을 포함하는 시즌과 지난 시즌을 만든다.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "모임" }).click();
  const seasonSection = page.getByRole("region", { name: "시즌" });
  await seasonSection.getByLabel("시즌 이름").fill("이번 시즌");
  await seasonSection.getByLabel("시작일").fill(today);
  await seasonSection.getByLabel("종료일").fill(today);
  await seasonSection.getByRole("button", { name: "시즌 만들기" }).click();
  await expect(seasonSection.getByText("이번 시즌")).toBeVisible();

  // 겹치는 시즌은 거절하고 이유를 알려준다.
  await seasonSection.getByLabel("시즌 이름").fill("겹치는 시즌");
  await seasonSection.getByLabel("시작일").fill(today);
  await seasonSection.getByLabel("종료일").fill(today);
  await seasonSection.getByRole("button", { name: "시즌 만들기" }).click();
  await expect(page.getByText("다른 시즌과 날짜가 겹칩니다.")).toBeVisible();

  await seasonSection.getByLabel("시즌 이름").fill("지난 시즌");
  await seasonSection.getByLabel("시작일").fill("2025-01-01");
  await seasonSection.getByLabel("종료일").fill("2025-01-31");
  await seasonSection.getByRole("button", { name: "시즌 만들기" }).click();
  await expect(seasonSection.getByText("지난 시즌")).toBeVisible();

  // 시즌 필터: 이번 시즌에는 11경기, 지난 시즌에는 기록이 없다. 배치 표시는 시즌과 무관하다. (34)
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" }).click();
  await page.getByLabel("시즌 선택").selectOption({ label: "이번 시즌" });
  await expect(page.getByRole("heading", { name: /이번 시즌 경기 · 11경기 확정/ })).toBeVisible();
  await page.getByLabel("시즌 선택").selectOption({ label: "지난 시즌" });
  await expect(page.getByText("이 범위에는 기록이 없어요.")).toBeVisible();
  await expect(page.getByText("이 범위에는 확정된 경기가 없어요.")).toBeVisible();

  // 좁은 화면에서도 랭킹과 개인 통계가 가로로 넘치지 않는다.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // 랭킹 구역의 첫 버튼은 정렬 고르기이므로 첫 순위 줄의 버튼을 누른다.
  await page
    .getByRole("region", { name: "소환사 랭킹" })
    .getByRole("listitem")
    .first()
    .getByRole("button")
    .click();
  await expect(page.getByRole("region", { name: "요약" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);

  // 홈의 전적 검색: 이름을 넣으면 전체 누적 전적이 나오고, 누르면 개인 통계로 간다.
  const menu = page.getByRole("navigation", { name: "주 메뉴" });
  await menu.getByRole("button", { name: "오늘" }).click();
  const finder = page.getByRole("region", { name: "전적 검색" });
  await finder.getByLabel("플레이어 이름으로 전적 검색").fill("선수07");
  await expect(finder.getByRole("button")).toHaveCount(1);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await finder.getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: /선수07/ })).toBeVisible();

  // 주 메뉴의 분석 탭으로 그래프 화면에 바로 간다.
  await menu.getByRole("button", { name: "분석" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "그래프 분석" })).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test("그래프 분석", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 팀 A(선수01~05) 7승 3패. 팀 A의 진영: 블루 4(전승), 레드 3(전승), 미상 3(전패).
  for (let i = 0; i < 10; i++) {
    await play(page.request, s, first10, i < 7 ? "A" : "B", i < 4 ? "blue" : i < 7 ? "red" : "unknown");
  }
  const mixed = [s.people[10]!, ...first10.slice(1, 5), s.people[11]!, ...first10.slice(6)];
  await play(page.request, s, mixed, "A", "blue");

  await page.goto("/#/records");
  await page.getByRole("button", { name: "그래프 분석" }).click();
  await expect(page.getByRole("heading", { name: "그래프 분석", level: 1 })).toBeVisible();
  await expect(page.getByText(/전체 · 확정 11경기 · 참가자 12명/)).toBeVisible();

  // 요약 칸 셋: 확정 경기·참가자·블루:레드. 자료 적음(5경기 미만: 선수11·12)은 위 한 줄로 내렸다(디자인 4단계).
  await expect(page.getByText(/자료 적음\(5경기 미만\) 2명/)).toBeVisible();
  const summary = page.getByRole("region", { name: "분석 요약" });
  await expect(summary.locator(".ps-tiles > div")).toHaveCount(3);
  await expect(summary.locator(".ps-tiles > div").nth(0)).toContainText("11경기");
  await expect(summary.locator(".ps-tiles > div").nth(1)).toContainText("12명");

  // 보기 전환: 기본은 개인별 승률 하나만 그린다.
  const views = page.getByRole("group", { name: "분석 보기" });
  await expect(views.getByRole("button", { name: "개인별 승률" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "플레이어 × 라인" })).toHaveCount(0);

  // 개인별 승률: 배치 완료자가 먼저, 값은 글자로도 보인다.
  const people = page.getByRole("region", { name: "개인별 승률" });
  await expect(people.getByRole("listitem")).toHaveCount(12);
  // 묶음 머리글이 보이고 자료 적음 묶음이 맨 아래다.
  const groupHeads = await people.getByRole("heading", { level: 3 }).allInnerTexts();
  expect(groupHeads[groupHeads.length - 1]).toContain("자료 적음(5경기 미만)");
  await expect(people.locator(".bar-group").last().getByRole("listitem").filter({ hasText: "선수11" })).toHaveCount(1);
  await expect(people.getByRole("listitem").filter({ hasText: "선수02" })).toContainText(
    "73% · 8승 3패 (11경기)",
  );
  const order = await people.getByRole("listitem").allInnerTexts();
  expect(order.findIndex((t) => t.includes("선수11"))).toBeGreaterThan(
    order.findIndex((t) => t.includes("선수10")),
  );
  await expect(people.getByRole("listitem").filter({ hasText: "선수11" })).toContainText(
    "배치 진행 중",
  );

  // 라인 필터: 정글을 맡은 사람만 남는다(선수02, 선수07).
  await page.getByLabel("라인", { exact: true }).selectOption({ label: "정글" });
  await expect(people.getByRole("listitem")).toHaveCount(2);
  await expect(people).toContainText("선수02");
  await expect(people).toContainText("선수07");
  await page.getByLabel("라인", { exact: true }).selectOption({ label: "전체 라인" });

  // 진영(요약 타일 아래 한 줄): 진영을 아는 8경기 중 블루 5승, 레드 3승. 미상 3경기는 제외하고 알려준다.
  await expect(summary).toContainText("블루 63% · 5승 3패 (8경기)");
  await expect(summary).toContainText("레드 38% · 3승 5패 (8경기)");
  await expect(summary).toContainText("진영 미상 3경기는 제외했습니다.");
  await expect(summary.locator(".ps-tiles > div").nth(2)).toContainText("63% : 37%");

  // 라인별 승률: 플레이어를 고르기 전에는 고르기 안내만 둔다(전체 합은 항상 50%, 이유는 제목 옆 i 설명에).
  const lines = page.getByRole("region", { name: "라인별 승률" });
  await expect(lines).toHaveCount(0);
  await views.getByRole("button", { name: "라인별 승률" }).click();
  await lines.getByRole("button", { name: "라인별 승률 설명" }).click();
  await expect(lines.getByRole("note")).toContainText("항상 50%");
  await expect(lines).toContainText("한 사람을 고르면");
  await expect(lines.getByRole("listitem")).toHaveCount(0);

  // 플레이어를 고르면(2026-11-09) 요약 타일 자리가 그 사람 묶음으로 바뀌고 주소에 남는다. 아래 보기는 그대로다.
  await page.getByLabel("플레이어", { exact: true }).selectOption({ label: "선수02" });
  const profile = page.getByRole("region", { name: "고른 플레이어" });
  await expect(profile).toContainText("73% · 8승 3패 (11경기)");
  // 승률 추이는 개인 통계와 같은 부품(.trend). 11경기면 5경기째부터 그려져 선이 있다.
  await expect(profile.locator(".trend svg")).toHaveAttribute("aria-label", /누적 승률 추이/);
  await expect(summary).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/graphs/${s.people[1]!.id}$`));
  await expect(views.getByRole("button", { name: "라인별 승률" })).toHaveAttribute("aria-pressed", "true");
  await expect(lines.getByRole("listitem").filter({ hasText: "정글" })).toContainText(
    "73% · 8승 3패 (11경기)",
  );
  await expect(lines.getByRole("listitem").filter({ hasText: "서폿" })).toContainText("기록 없음");

  // 새 보기: 순위 변동(11경기, 배치 마친 10명) · 라인 모양 · 활동(오늘 범위가 아니면 달력).
  await views.getByRole("button", { name: "순위 변동" }).click();
  const race = page.getByRole("region", { name: "순위 변동" });
  await expect(race.locator(".race-series.picked")).toHaveCount(1);
  await views.getByRole("button", { name: "라인 모양" }).click();
  await expect(page.getByRole("region", { name: "라인 모양" }).getByRole("img")).toHaveAttribute("aria-label", /정글 73%/);
  await views.getByRole("button", { name: "활동" }).click();
  await expect(page.getByRole("region", { name: "활동" })).toContainText("참석한 날 1일");

  // 고르기 해제: 모임 전체 요약으로 바로 돌아간다.
  await profile.getByRole("button", { name: "고르기 해제" }).click();
  await expect(summary).toBeVisible();
  await expect(profile).toHaveCount(0);
  await page.getByLabel("플레이어", { exact: true }).selectOption({ label: "선수02" });

  // 플레이어 × 라인: 표로 읽을 수 있고 기록 없는 칸은 —, 5경기 미만은 색을 칠하지 않는다.
  await views.getByRole("button", { name: "플레이어 × 라인" }).click();
  const matrixRegion = page.getByRole("region", { name: "플레이어 × 라인" });
  const matrix = matrixRegion.getByRole("table").first();
  const row02 = matrix.getByRole("row").filter({ hasText: "선수02" });
  await expect(row02.getByRole("cell").nth(1)).toContainText("73%");
  await expect(row02.getByRole("cell").nth(1)).toContainText("11");
  await expect(row02.getByRole("cell").nth(0)).toHaveText("—");
  // 5경기 미만인 사람은 "자료 적음" 접힘 안에 있다(2026-11-08). 펼친 뒤 찾는다.
  const few = matrixRegion.locator("details.matrix-few > summary");
  if (await few.count()) await few.click();
  const row11 = matrixRegion.getByRole("table").last().getByRole("row").filter({ hasText: "선수11" });
  await expect(row11.getByRole("cell").nth(0)).toHaveClass(/band-none/);
  // 72.7%: 승률 색 단계의 가장 붉은 단계(70% 이상).
  await expect(row02.getByRole("cell").nth(1)).toHaveClass(/heat-h4/);

  // 범위를 오늘로 바꿔도 같은 경기다(모두 오늘 세션). 지난 시즌이 없으니 전체와 같다.
  await page.getByLabel("범위", { exact: true }).selectOption({ label: "오늘" });
  await expect(page.getByText(/오늘 · 확정 11경기/)).toBeVisible();

  // 막대를 누르면 개인 통계로 간다. 고른 플레이어(선수02)의 막대 줄은 강조한다.
  await views.getByRole("button", { name: "개인별 승률" }).click();
  await expect(people.locator(".bar-row.picked")).toHaveCount(1);
  await expect(people.locator(".bar-row.picked")).toContainText("선수02");
  // 제목 옆 i 버튼이 구역의 첫 버튼이라 막대 줄로 좁혀 고른다.
  await people.locator("button.bar-row").first().click();
  await expect(page.getByRole("region", { name: "요약" })).toBeVisible();

  // 320px에서도 가로로 넘치지 않는다(표 포함).
  await page.goBack();
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(page.getByRole("heading", { name: "그래프 분석", level: 1 })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/graphs-320.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/graphs-390.png`, fullPage: true });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: `${process.env.SHOT_DIR}/graphs-390-dark.png`, fullPage: true });
  }
});

test("랭킹 탭: MMR 랭킹 → 추이 펼치기 → 이름으로 개인 통계, 예시 모임 랭킹", async ({ page }) => {
  const s = await setup(page);
  const first10 = s.people.slice(0, 10);
  // 선수01~10은 11경기(배치 완료), 선수11·12는 1경기(배치 진행 중).
  for (let i = 0; i < 10; i++) await play(page.request, s, first10, i < 7 ? "A" : "B", "blue");
  const mixed = [s.people[10]!, ...first10.slice(1, 5), s.people[11]!, ...first10.slice(6)];
  await play(page.request, s, mixed, "A", "blue");

  // 기록 화면의 소환사 랭킹에서도 들어갈 수 있다.
  await page.goto("/#/records");
  await page.getByRole("region", { name: "소환사 랭킹" }).getByRole("button", { name: "MMR 랭킹 전체 보기 →" }).click();
  await expect(page).toHaveURL(/#\/ranking$/);
  await page.goto("/#/");
  const menu = page.getByRole("navigation", { name: "주 메뉴" });
  await menu.getByRole("button", { name: "랭킹" }).click();
  await expect(page).toHaveURL(/#\/ranking$/);
  await expect(page.getByRole("heading", { level: 1, name: "MMR 랭킹" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "랭킹" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("누적 기준 · 확정 경기만")).toBeVisible();

  const table = page.getByRole("region", { name: "MMR 순위표" });
  await expect(table.getByRole("listitem")).toHaveCount(12);
  await expect(table).toContainText("배치 완료 · 50경기 미만 · 10명");
  await expect(table).toContainText("배치 진행 중 · 2명");
  // 배치 진행 중 두 사람은 맨 아래이고 MMR 대신 배치 판수를 보여 준다.
  await expect(table.getByRole("listitem").nth(10)).toContainText("배치 1/10");
  await expect(table.getByRole("listitem").nth(11)).toContainText("배치 1/10");
  // 요약 카드 줄: 1위 · 최근 상승 · 최고 기록. 후보는 누적 50경기 이상뿐이라 여기서는 셋 다 비고,
  // 까닭은 1위 카드에만 한 번 적는다. 티어 분포는 순위표 아래 한 줄로 내렸다(요약은 셋까지, 디자인 4단계).
  const cards = page.getByRole("region", { name: "랭킹 요약" }).locator(".stat-card");
  await expect(cards).toHaveCount(3);
  await expect(page.getByRole("region", { name: "MMR 순위표" })).toContainText("티어 분포");
  await expect(cards.first()).toContainText("누적 50경기를 채운 사람부터 요약 카드 셋에 올라요");
  await expect(cards.locator(".stat-card-value")).toHaveText(["—", "—", "—"]);
  await expect(page.getByRole("region", { name: "랭킹 요약" })).not.toContainText("선수");

  // 추이는 한 번에 하나만 펼친다.
  const firstRow = table.getByRole("listitem").first();
  await firstRow.getByRole("button", { name: /MMR 추이/ }).click();
  await expect(firstRow.locator(".trend svg")).toHaveAttribute("aria-label", /MMR 추이/);
  await table.getByRole("listitem").nth(1).getByRole("button", { name: /MMR 추이/ }).click();
  await expect(table.locator(".mmr-trend")).toHaveCount(1);

  // 이름 검색: 순위 숫자는 그대로.
  const rankOf11 = await table.getByRole("listitem").filter({ hasText: "선수11" }).locator(".rank").innerText();
  // 이름 검색 칸은 순위표 위 필터 줄에 있다.
  await page.getByRole("group", { name: "순위표 찾기" }).getByLabel("이름 검색").fill("선수11");
  await expect(table.getByRole("listitem")).toHaveCount(1);
  await expect(table.getByRole("listitem").locator(".rank")).toHaveText(rankOf11);

  // 이름을 누르면 개인 통계.
  await table.getByRole("button", { name: "선수11", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/p/${s.people[10]!.id}$`));
  await expect(page.getByRole("heading", { level: 1, name: /선수11/ })).toBeVisible();

  // 예시 모임에도 랭킹 메뉴가 있다.
  await page.goto("/#/demo/ranking");
  await expect(page.getByRole("heading", { level: 1, name: "MMR 랭킹" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "예시 모임 메뉴" }).getByRole("button", { name: "랭킹" }),
  ).toHaveAttribute("aria-current", "page");
  expect(await page.getByRole("region", { name: "MMR 순위표" }).getByRole("listitem").count()).toBeGreaterThanOrEqual(5);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
