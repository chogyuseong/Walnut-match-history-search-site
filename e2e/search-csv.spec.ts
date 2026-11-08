import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 검색 강화·CSV 내보내기(2026-11-08)를 휴대폰 폭(390px)에서 확인한다.
// 초성 검색 → 개인 통계, 주소(#/search?q=)와 뒤로 가기, 최근 검색어 칩, 날짜·메모로 경기 찾기, 단축키 "/",
// 기록·랭킹·개인 CSV 내려받기(파일 이름·머리 줄), 조회 링크에서도 같은 기능.
// 모임·참가자·경기는 API로 빠르게 만들고(convenience.spec.ts와 같은 방식), 확인할 흐름은 화면으로 한다.

test.use({ viewport: { width: 390, height: 844 } });

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const GROUP_NAME = "검색CSV모임";
const NAMES = ["김선우", "홍진호", "강서준", ...Array.from({ length: 9 }, (_, i) => `선수${String(i + 4).padStart(2, "0")}`)];
const BOM = String.fromCharCode(0xfeff);

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
  viewToken: string;
}

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-search-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

async function play(
  request: APIRequestContext,
  groupId: string,
  ten: { id: string }[],
  winnerTeam: "A" | "B",
  memo?: string,
) {
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
    winnerTeam,
    winnerSide: winnerTeam === "A" ? "blue" : "red",
    ...(memo ? { memo } : {}),
  });
}

/** 12명 모임 + 오늘 확정 경기 2개(두 번째에 메모). 서포터 순환은 끈다(같은 명단을 다시 쓰려고). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-search-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  // 같은 날 서버 작업으로 만들기 요청에도 요청 ID를 보낸다(다른 e2e와 같은 모양).
  const group = await post(request, "/api/groups", { requestId: crypto.randomUUID(), name: GROUP_NAME });
  const ensured = await post(request, `/api/groups/${group.id}/participants`, {
    requestId: crypto.randomUUID(),
    names: NAMES,
  });
  const snapshot = await snapshotOf(request, group.id);
  const res = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  expect(res.ok()).toBe(true);
  const people = ensured.participants as { id: string; name: string }[];
  await play(request, group.id, people.slice(0, 10), "A");
  await play(request, group.id, people.slice(0, 10), "B", "결승 역전승");
  return { groupId: group.id, people, viewToken: (await snapshotOf(request, group.id)).group.viewToken };
}

/** 모임 시간대(서울)의 오늘을 "11/8" 꼴로. */
function todayShort(): string {
  const [, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()).split("-");
  return `${Number(m)}/${Number(d)}`;
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

/** 내려받은 CSV의 파일 이름과 첫 줄(BOM 뺀 머리 줄). */
async function downloadCsv(page: Page, click: () => Promise<void>) {
  const waiting = page.waitForEvent("download");
  await click();
  const download = await waiting;
  const text = await readFile((await download.path())!, "utf8");
  expect(text.startsWith(BOM), "UTF-8 BOM").toBe(true);
  return { fileName: download.suggestedFilename(), header: text.slice(1).split("\r\n")[0]!, text };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCH_HEADER =
  "경기 번호,날짜·시각,상태,팀1_탑,팀1_정글,팀1_미드,팀1_원딜,팀1_서폿,팀2_탑,팀2_정글,팀2_미드,팀2_원딜,팀2_서폿,승리 팀,비고,메모";

test("초성 검색 → 개인 통계, 주소 반영과 뒤로 가기, 최근 검색어 칩", async ({ page }) => {
  await setup(page);
  await page.goto("/#/search");
  const box = page.getByRole("searchbox", { name: "플레이어 이름" });
  await expect(box).toBeVisible();
  // 입력 칸에 저절로 초점을 주지 않는다(모바일 키보드).
  await expect(box).not.toBeFocused();

  await box.fill("ㄱㅅㅇ");
  const results = page.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("김선우");
  await expect(page).toHaveURL(new RegExp(`#/search\\?q=${escapeRe(encodeURIComponent("ㄱㅅㅇ"))}$`));
  await noHorizontalOverflow(page, "검색 결과");

  // 섞은 질의(완성형 + 초성)와 공백 무시.
  await box.fill("홍 ㅈ");
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText("홍진호");

  // 없는 이름: 초성 힌트.
  await box.fill("없는사람");
  await expect(page.getByText("일치하는 이름이 없어요.")).toBeVisible();
  await expect(page.getByText("초성(ㄱㅅ)으로도 찾을 수 있어요", { exact: false })).toBeVisible();

  // 결과를 누르면 개인 통계, 뒤로 가면 같은 질의의 검색 화면.
  await box.fill("ㄱㅅㅇ");
  await results.first().getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: "김선우" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { level: 1, name: "전적 검색" })).toBeVisible();
  await expect(box).toHaveValue("ㄱㅅㅇ");
  await expect(results).toHaveCount(1);

  // 주소로 바로 연 검색(링크 공유).
  await page.goto(`/#/search?q=${encodeURIComponent("ㅎㅈㅎ")}`);
  await expect(box).toHaveValue("ㅎㅈㅎ");
  await expect(results.first()).toContainText("홍진호");

  // 최근 검색어: 입력 칸이 비면 칩으로 보이고, 누르면 다시 찾는다.
  await box.fill("");
  const chips = page.getByRole("list", { name: "최근 검색어" });
  await expect(chips.getByRole("button", { name: "ㄱㅅㅇ" })).toBeVisible();
  await noHorizontalOverflow(page, "최근 검색어");
  await chips.getByRole("button", { name: "ㄱㅅㅇ" }).click();
  await expect(box).toHaveValue("ㄱㅅㅇ");
  await expect(results.first()).toContainText("김선우");
  await expect(page).toHaveURL(/#\/search\?q=/);

  // 지우기: 다시 들어와도 없다(이 기기 저장에서도 지움).
  await box.fill("");
  await page.getByRole("button", { name: "최근 검색어 지우기" }).click();
  await expect(chips).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "전적 검색" })).toBeVisible();
  await expect(page.getByRole("list", { name: "최근 검색어" })).toHaveCount(0);
});

test("날짜·메모로 경기 찾기", async ({ page }) => {
  await setup(page);
  await page.goto("/#/search");
  const box = page.getByRole("searchbox", { name: "플레이어 이름" });

  await box.fill(todayShort());
  const found = page.getByRole("region", { name: "찾은 경기" });
  await expect(found.getByRole("heading")).toContainText("2경기");
  await expect(found.locator("li.match-card")).toHaveCount(2);
  // 날짜 질의에는 "일치하는 이름이 없어요"를 보이지 않는다.
  await expect(page.getByText("일치하는 이름이 없어요.")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`q=${escapeRe(encodeURIComponent(todayShort()))}$`));
  await noHorizontalOverflow(page, "날짜로 찾은 경기");

  // 메모(공백 무시).
  await box.fill("역전 승");
  await expect(found.locator("li.match-card")).toHaveCount(1);
  await expect(found).toContainText("결승 역전승");

  // 경기 카드를 누르면 경기 상세.
  await found.locator("li.match-card").first().locator(".mc-main").click();
  await expect(page.getByRole("heading", { level: 1, name: "2경기" })).toBeVisible();
});

test('단축키 "/": 입력 칸 밖에서 누르면 검색 화면으로 가서 초점, 입력 중이면 그대로', async ({ page }) => {
  await setup(page);
  await page.goto("/#/records");
  await expect(page.getByRole("heading", { level: 1, name: "기록" })).toBeVisible();

  // 입력 칸에서 친 "/"는 글자일 뿐이다.
  const rankSearch = page.getByRole("region", { name: "소환사 랭킹" }).getByLabel("이름 검색");
  await rankSearch.click();
  await page.keyboard.press("/");
  await expect(rankSearch).toHaveValue("/");
  await expect(page).toHaveURL(/#\/records$/);

  await rankSearch.blur();
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/#\/search$/);
  const box = page.getByRole("searchbox", { name: "플레이어 이름" });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("");

  // 검색 화면에서 초점을 빼고 다시 누르면 같은 칸에 초점만 준다.
  await page.locator("h1").click();
  await page.keyboard.press("/");
  await expect(box).toBeFocused();
});

test("CSV 내려받기: 기록·랭킹·개인 참여 경기", async ({ page }) => {
  await setup(page);
  await page.goto("/#/records");
  const list = page.getByRole("region", { name: "경기 목록" });
  await expect(list.locator("li.match-card")).toHaveCount(2);
  await noHorizontalOverflow(page, "기록");

  const matches = await downloadCsv(page, () => list.getByRole("button", { name: "CSV 내려받기" }).click());
  expect(matches.fileName).toMatch(new RegExp(`^내전기록-${GROUP_NAME}-\\d{8}\\.csv$`));
  expect(matches.header).toBe(MATCH_HEADER);
  // 최근 경기가 먼저, 블루팀(팀1) 탑은 김선우, 메모 칸.
  const lines = matches.text.slice(1).trim().split("\r\n");
  expect(lines).toHaveLength(3);
  expect(lines[1]).toMatch(/^2,\d{4}-\d{2}-\d{2} \d{2}:\d{2},결과 확정,김선우,홍진호,강서준,/);
  expect(lines[1]).toMatch(/,레드팀,,결승 역전승$/);

  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  const rank = await downloadCsv(page, () => ranking.getByRole("button", { name: "CSV 내려받기" }).click());
  expect(rank.fileName).toMatch(new RegExp(`^내전랭킹-${GROUP_NAME}-\\d{8}\\.csv$`));
  expect(rank.header).toBe("순위,이름,경기,승,패,승률(%),배치,칭호");

  await ranking.getByRole("button", { name: /김선우/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "김선우" })).toBeVisible();
  const played = page.getByRole("region", { name: "참여 경기" });
  const person = await downloadCsv(page, () => played.getByRole("button", { name: "CSV 내려받기" }).click());
  expect(person.fileName).toMatch(new RegExp(`^내전기록-${GROUP_NAME}-김선우-\\d{8}\\.csv$`));
  expect(person.header.startsWith("경기 번호,날짜·시각,상태,본인 팀,본인 라인,본인 결과,팀1_탑")).toBe(true);
  // 티어(실력 그룹)는 어느 파일에도 없다.
  for (const text of [matches.text, rank.text, person.text]) expect(text).not.toMatch(/티어|skillGroup/);
});

test("조회 링크: 주소로 연 검색, 단축키, CSV 내려받기(로그인 없음)", async ({ page, browser }) => {
  const s = await setup(page);
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();

  await guest.goto(`/#/v/${s.viewToken}/search?q=${encodeURIComponent("ㅎㅈ")}`);
  const box = guest.getByRole("searchbox", { name: "플레이어 이름" });
  await expect(box).toHaveValue("ㅎㅈ");
  const results = guest.getByRole("region", { name: "검색 결과" }).getByRole("listitem");
  await expect(results.first()).toContainText("홍진호");
  await noHorizontalOverflow(guest, "조회 링크 검색");

  // 결과 → 개인 통계 → 뒤로 가기.
  await results.first().getByRole("button").click();
  await expect(guest.getByRole("heading", { level: 1, name: "홍진호" })).toBeVisible();
  await guest.goBack();
  await expect(box).toHaveValue("ㅎㅈ");

  // 단축키: 조회 기록 화면에서 "/" → 조회 검색 화면.
  await guest.goto(`/#/v/${s.viewToken}/records`);
  await expect(guest.getByRole("region", { name: "경기 목록" })).toBeVisible();
  await guest.locator("h1").first().click();
  await guest.keyboard.press("/");
  await expect(guest).toHaveURL(new RegExp(`#/v/${s.viewToken}/search$`));
  await expect(box).toBeFocused();

  // 조회 화면에서도 CSV를 내려받는다.
  await guest.goto(`/#/v/${s.viewToken}/records`);
  const list = guest.getByRole("region", { name: "경기 목록" });
  const csv = await downloadCsv(guest, () => list.getByRole("button", { name: "CSV 내려받기" }).click());
  expect(csv.fileName).toMatch(new RegExp(`^내전기록-${GROUP_NAME}-\\d{8}\\.csv$`));
  expect(csv.header).toBe(MATCH_HEADER);
  await guestContext.close();
});
