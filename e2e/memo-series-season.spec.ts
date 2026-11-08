import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 경기 메모 · 시리즈 묶음 · 시즌 요약과 시상(2026-11-06)을 실제 브라우저에서 확인한다.
// 모임·참가자·지난 경기는 API로 빠르게 만들고, 확인할 흐름은 화면으로 한다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-msr-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, s: Setup) {
  return (await request.get(`/api/groups/${s.groupId}/snapshot`)).json();
}

/** 12명 모임, 서포터 순환 끔(같은 명단을 반복해서 쓰려고). */
async function setup(page: Page, name: string): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-msr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name });
  const names = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names });
  const snapshot = await (await request.get(`/api/groups/${group.id}/snapshot`)).json();
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(res.ok()).toBe(true);
  return { groupId: group.id, people: ensured.participants };
}

function rosterOf(ten: { id: string }[]) {
  return ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] }));
}

async function startApi(request: APIRequestContext, s: Setup, ten: { id: string }[]) {
  const snapshot = await snapshotOf(request, s);
  return (
    await post(request, `/api/groups/${s.groupId}/matches/start`, {
      requestId: requestId(),
      baseLiveVersion: snapshot.group.liveVersion,
      roster: rosterOf(ten),
      teamASide: "blue",
    })
  ).match;
}

async function playApi(request: APIRequestContext, s: Setup, ten: { id: string }[], winnerTeam: "A" | "B") {
  const started = await startApi(request, s, ten);
  return (
    await post(request, `/api/groups/${s.groupId}/matches/${started.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: started.version,
      winnerTeam,
      winnerSide: winnerTeam === "A" ? "blue" : "red",
    })
  ).match;
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

/** 진행 중 화면에서 결과 입력 창을 열어 블루팀 승으로 고른다(진영은 시작 때 정해 미리 골라져 있다). */
async function chooseBlueWin(page: Page, matchNo: number) {
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: `${matchNo}경기 결과` });
  // 결과 입력 2버튼(2026-11-07): "블루팀 승" 큰 버튼. 진영 정정은 접힘 영역 안에 있다.
  await sheet.getByRole("button", { name: /블루팀 승/ }).click();
  await sheet.getByText("진영이 시작할 때와 달랐나요?").click();
  await expect(sheet.getByRole("radio", { name: "블루", exact: true })).toBeChecked();
  return sheet;
}

test.use({ viewport: { width: 390, height: 844 } });

test("결과 입력의 메모가 카드·상세·조회 링크에 글 그대로 보인다", async ({ page }) => {
  const s = await setup(page, "메모 테스트 모임");
  await startApi(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await expect(page.getByRole("heading", { name: "1경기 진행 중" })).toBeVisible();

  const sheet = await chooseBlueWin(page, 1);
  const memo = sheet.getByLabel("메모 (선택)");
  await expect(memo).toBeVisible();
  await expect(sheet.getByText("조회 링크에서도 보여요", { exact: false })).toBeVisible();
  await memo.fill("바론 스틸로 역전\n<b>굿</b>");
  await expect(sheet.getByText("18/200자")).toBeVisible();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();
  await noHorizontalOverflow(page, "결과 입력 창");

  // 기록의 경기 카드: 한 줄 메모(줄바꿈은 " · "로).
  await page.goto("/#/records");
  const cards = page.getByRole("region", { name: "경기 목록" });
  await expect(cards.getByText("바론 스틸로 역전 · <b>굿</b>")).toBeVisible();
  await noHorizontalOverflow(page, "기록");

  // 경기 상세: 줄바꿈 그대로, HTML로 해석하지 않는다.
  await cards.getByRole("button", { name: /1경기 · 블루팀 승/ }).click();
  const memoRegion = page.getByRole("region", { name: "메모" });
  await expect(memoRegion.getByText("<b>굿</b>", { exact: false })).toBeVisible();
  expect(await memoRegion.locator("b").count()).toBe(0);
  expect(await memoRegion.locator(".memo-text").innerText()).toBe("바론 스틸로 역전\n<b>굿</b>");

  // 상세에서 고친다.
  await memoRegion.getByRole("button", { name: "메모 고치기" }).click();
  await memoRegion.getByLabel("메모", { exact: true }).fill("바론 스틸로 역전\n마지막 한타 굿");
  await memoRegion.getByRole("button", { name: "메모 저장" }).click();
  await expect(memoRegion.locator(".memo-text")).toHaveText("바론 스틸로 역전\n마지막 한타 굿");
  await noHorizontalOverflow(page, "경기 상세");

  // 조회 링크: 카드와 상세에 같은 메모.
  const token = (await snapshotOf(page.request, s)).group.viewToken;
  await page.goto(`/#/v/${token}/records`);
  const viewerCards = page.getByRole("region", { name: "경기 목록" });
  await expect(viewerCards.getByText("바론 스틸로 역전 · 마지막 한타 굿")).toBeVisible();
  await viewerCards.getByRole("button", { name: /1경기 · 블루팀 승/ }).click();
  await expect(page.getByRole("region", { name: "메모" }).locator(".memo-text")).toHaveText(
    "바론 스틸로 역전\n마지막 한타 굿",
  );
  // 조회자는 메모를 고칠 수 없다.
  await expect(page.getByRole("button", { name: "메모 고치기" })).toHaveCount(0);
  await noHorizontalOverflow(page, "조회 링크 상세");
});

test("같은 팀으로 시리즈 이어가기 2판이면 2:0, 구성이 다른 경기는 넣을 수 없다", async ({ page }) => {
  const s = await setup(page, "시리즈 테스트 모임");
  const ten = s.people.slice(0, 10);
  await startApi(page.request, s, ten);
  await page.goto("/#/match");

  // 1경기 결과 → "시리즈로 이어가기" → 준비 화면에 시리즈 구역이 켜져 있다.
  let sheet = await chooseBlueWin(page, 1);
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();
  await sheet.getByRole("button", { name: "시리즈로 이어가기" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  const seriesBox = page.getByRole("region", { name: "시리즈" });
  await expect(seriesBox.getByRole("checkbox", { name: "시리즈로 이어가기" })).toBeChecked();
  await expect(seriesBox.getByLabel("시리즈 형식")).toHaveValue("bo3");
  await seriesBox.getByLabel("시리즈 이름").fill("결승");
  await expect(seriesBox.getByText("1경기와 이번 경기를 새 시리즈로 묶어요.")).toBeVisible();
  await noHorizontalOverflow(page, "준비 화면");

  // 2경기 시작 → 같은 팀(블루팀) 승.
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  await expect(page.getByRole("heading", { name: "2경기 진행 중" })).toBeVisible();
  sheet = await chooseBlueWin(page, 2);
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("2경기 저장됨 · 블루팀 승")).toBeVisible();

  // 기록: 시리즈 보기와 카드 배지.
  await page.goto("/#/records");
  const list = page.getByRole("region", { name: "시리즈" });
  await expect(list.getByText("결승 · 3판 2선승 · 2:0")).toBeVisible();
  await expect(list.getByText(/시리즈 승리/)).toBeVisible();
  await expect(page.getByRole("region", { name: "경기 목록" }).getByText("결승 · 2:0")).toHaveCount(2);
  await noHorizontalOverflow(page, "기록(시리즈)");

  // 구성이 다른 경기(두 사람을 맞바꿈)는 넣을 수 없다.
  const mixed = [ten[5]!, ...ten.slice(1, 5), ten[0]!, ...ten.slice(6)];
  const other = await playApi(page.request, s, mixed, "A");
  // API로 넣은 경기라 화면을 새로 읽는다.
  await page.goto(`/#/m/${other.id}`);
  await page.reload();
  const detailSeries = page.getByRole("region", { name: "시리즈" });
  await detailSeries.getByRole("button", { name: "시리즈에 넣기" }).click();
  const dialog = page.getByRole("dialog", { name: "3경기를 시리즈에 넣기" });
  const option = dialog.getByRole("button", { name: /결승 · 3판 2선승 · 2:0/ });
  await expect(option).toBeDisabled();
  await expect(option).toContainText("팀 구성이 달라 넣을 수 없어요");
  await noHorizontalOverflow(page, "시리즈에 넣기 창");
  await dialog.getByRole("button", { name: "닫기" }).click();

  // 1경기 상세: 시리즈 요약과 각 판 링크.
  const first = (await snapshotOf(page.request, s)).matches.find((m: { matchNo: number }) => m.matchNo === 1);
  await page.goto(`/#/m/${first.id}`);
  const summary = page.getByRole("region", { name: "시리즈" });
  await expect(summary.getByText("결승 · 3판 2선승 · 2:0")).toBeVisible();
  await summary.getByRole("button", { name: /2판 · 2경기/ }).click();
  await expect(page.getByRole("heading", { name: "2경기", level: 1 })).toBeVisible();

  // 조회 링크에서도 보인다.
  const token = (await snapshotOf(page.request, s)).group.viewToken;
  await page.goto(`/#/v/${token}/records`);
  await expect(page.getByRole("region", { name: "시리즈" }).getByText("결승 · 3판 2선승 · 2:0")).toBeVisible();
  await expect(page.getByRole("button", { name: "새 시리즈 만들기" })).toHaveCount(0);
  await noHorizontalOverflow(page, "조회 링크 기록(시리즈)");
});

test("시즌 요약과 시상이 근거 숫자와 함께 열리고, 조회 링크에서도 열린다", async ({ page }) => {
  const s = await setup(page, "시즌 테스트 모임");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const shift = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const season = await post(page.request, `/api/groups/${s.groupId}/seasons`, {
    requestId: crypto.randomUUID(),
    name: "가을 시즌",
    startsOn: shift(-10),
    endsOn: shift(10),
  });
  const ten = s.people.slice(0, 10);
  // 선수01~05(팀 A)가 10경기 7승 3패.
  for (let i = 0; i < 10; i++) await playApi(page.request, s, ten, i < 7 ? "A" : "B");

  await page.goto("/#/records");
  await page.getByLabel("시즌 선택").selectOption({ label: "가을 시즌" });
  await page.getByRole("button", { name: "가을 시즌 요약과 시상 보기" }).click();
  await expect(page.getByRole("heading", { name: "가을 시즌 요약", level: 1 })).toBeVisible();
  await expect(page.getByText("진행 중", { exact: true })).toBeVisible();

  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary).toContainText("10경기");
  await expect(summary).toContainText("10명");
  const awards = page.getByRole("region", { name: "시상" });
  // 최고 승률은 누적 50경기 이상만: 10경기라 해당 없음. 해당 없는 상은 맨 아래 한 줄로 모이고 까닭은 접힌 도움말에 있다.
  // 공동 수상은 최다 승(선수01~05 7승)으로 확인한다.
  await expect(awards.getByText(/^기준 미달: 최고 승률/)).toBeVisible();
  await awards.getByText("기준 미달 까닭").click();
  const best = awards.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "최고 승률", exact: true }) });
  await expect(best).toContainText("해당 없음 · 이 범위에 뛴 사람 중 누적 50경기 이상인 사람이 없어요.");
  const wins = awards.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "최다 승", exact: true }) });
  await expect(wins).toContainText("70% · 7승 3패 (10경기)");
  await expect(wins).toContainText("(공동)");
  await expect(awards.getByRole("listitem").filter({ hasText: "최장 연승" })).toContainText("7연승");
  await expect(awards.getByRole("listitem").filter({ hasText: "헌신상" })).toContainText("서포터 10경기");
  await expect(awards.getByRole("listitem").filter({ hasText: "천적 관계" })).toContainText("상대 전적 70%");
  // 직전 시즌이 없어 "가장 많이 성장"은 없다. 놀리는 상도 없다.
  await expect(awards.getByRole("heading", { name: "가장 많이 성장" })).toHaveCount(0);
  await expect(awards.getByText("직전 시즌이 없어 '가장 많이 성장'은 넣지 않았어요.", { exact: false })).toBeVisible();
  await expect(awards.getByText(/최저|최다 패/)).toHaveCount(0);
  await noHorizontalOverflow(page, "시즌 요약");

  // 이미지로 공유: 만든 이미지가 보인다.
  await page.getByRole("button", { name: "요약 이미지" }).click();
  const imageDialog = page.getByRole("dialog", { name: "가을 시즌 요약 이미지" });
  await expect(imageDialog.getByRole("img", { name: /미리보기/ })).toBeVisible();
  await imageDialog.getByRole("button", { name: "닫기" }).click();

  // 조회 링크에서도 같은 화면.
  const token = (await snapshotOf(page.request, s)).group.viewToken;
  await page.goto(`/#/v/${token}/season/${season.id}`);
  await expect(page.getByRole("heading", { name: "가을 시즌 요약", level: 1 })).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "시상" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: "최다 승", exact: true }) }),
  ).toContainText("70% · 7승 3패 (10경기)");
  await noHorizontalOverflow(page, "조회 링크 시즌 요약");

  // 연도 범위도 열린다.
  await page.goto(`/#/v/${token}/season/year/${today.slice(0, 4)}`);
  await expect(page.getByRole("heading", { name: `${today.slice(0, 4)}년 요약`, level: 1 })).toBeVisible();
});
