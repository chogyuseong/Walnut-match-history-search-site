import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 중복 참가자 합치기·되돌리기, 팀 추천 다양성 설정, 모임 삭제·탈퇴를 실제 브라우저에서 확인한다(작업 D).
// 경기는 API로 빠르게 만들고 화면은 합치기·삭제 흐름만 누른다. 로컬 가짜 로그인(AUTH_MODE=fake)을 쓴다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-merge-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

interface Person {
  id: string;
  name: string;
}
interface Setup {
  groupId: string;
  people: Person[];
  dup: Person;
}

/** 12명 + 같은 사람의 두 번째 이름("합치기01 부캐") 모임. 순환은 끈다(같은 명단 반복). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-merge-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { name: "합치기 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `합치기${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { names });
  const dup = await post(request, `/api/groups/${group.id}/participants`, { names: ["합치기01 부캐"] });
  const snapshot = await getSnapshot(request, group.id);
  await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: snapshot.group.settingsVersionId,
      settings: { ...snapshot.group.settings, rotationEnabled: false },
    },
  });
  return { groupId: group.id, people: ensured.participants, dup: dup.participants[0] };
}

async function play(request: APIRequestContext, s: Setup, people: Person[], winnerTeam: "A" | "B") {
  const snapshot = await getSnapshot(request, s.groupId);
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: people.slice(0, 10).map((p, i) => ({
      participantId: p.id,
      team: i < 5 ? "A" : "B",
      position: POSITIONS[i % 5],
    })),
  });
  await post(request, `/api/groups/${s.groupId}/matches/${started.match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: started.match.version,
    winnerTeam,
    winnerSide: "blue",
  });
  return started.match;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("모임 탭에서 중복 참가자를 미리보기 후 합치고, 기록에서 되돌린다", async ({ page }) => {
  const s = await setup(page);
  const withDup = [s.dup, ...s.people.slice(1, 10)];
  await play(page.request, s, withDup, "A");
  await play(page.request, s, withDup, "A");
  await play(page.request, s, s.people.slice(0, 10), "B");

  await page.goto("/#/group");
  await page.getByRole("button", { name: "중복 참가자 합치기" }).click();
  await expect(page.getByRole("heading", { name: "중복 참가자 합치기" })).toBeVisible();
  await page.getByLabel("없앨 이름").selectOption({ label: "합치기01 부캐" });
  await page.getByLabel("남길 이름").selectOption({ label: "합치기01" });
  await page.getByRole("button", { name: "합치면 어떻게 되는지 보기" }).click();

  const preview = page.getByRole("region", { name: "합치기 미리보기" });
  await expect(preview).toContainText("옮겨질 경기 2개");
  const table = preview.getByRole("table");
  await expect(table.getByRole("row", { name: /승·패/ })).toContainText("2승 0패");
  await expect(table.getByRole("row", { name: /승·패/ })).toContainText("2승 1패");
  await noHorizontalOverflow(page);

  await preview.getByRole("button", { name: "합치기", exact: true }).click();
  await expect(page.getByText("'합치기01 부캐'을(를) '합치기01'에 합쳤어요")).toBeVisible();
  const history = page.getByRole("region", { name: "합친 기록" });
  await expect(history).toContainText("합치기01 부캐 → 합치기01 · 2경기");

  // 서버 상태: 부캐는 보관되고 합쳐진 표시가 있다.
  let snap = await getSnapshot(page.request, s.groupId);
  expect(snap.participants.find((p: Person & { mergedInto?: string }) => p.id === s.dup.id).mergedInto).toBe(
    s.people[0]!.id,
  );

  // 되돌리기.
  await history.getByRole("button", { name: "되돌리기" }).click();
  const dialog = page.getByRole("dialog", { name: "합치기 되돌리기" });
  await dialog.getByRole("button", { name: "되돌리기" }).click();
  await expect(page.getByText("합치기를 되돌렸어요. 경기 2개를")).toBeVisible();
  await expect(history).toContainText("되돌림");
  snap = await getSnapshot(page.request, s.groupId);
  expect(snap.participants.find((p: Person) => p.id === s.dup.id).status).toBe("active");
});

test("같은 경기에 함께 나온 두 이름은 합칠 수 없고 겹친 경기로 갈 수 있다(320px)", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  const s = await setup(page);
  const both = [s.people[0]!, s.dup, ...s.people.slice(1, 9)];
  const m = await play(page.request, s, both, "A");

  await page.goto("/#/merge");
  await page.getByLabel("없앨 이름").selectOption({ label: "합치기01 부캐" });
  await page.getByLabel("남길 이름").selectOption({ label: "합치기01" });
  await page.getByRole("button", { name: "합치면 어떻게 되는지 보기" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("이 두 이름은 합칠 수 없어요");
  await expect(alert).toContainText(`${m.matchNo}경기`);
  await expect(page.getByRole("button", { name: "합치기", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await alert.getByRole("button", { name: `${m.matchNo}경기 보기` }).click();
  await expect(page).toHaveURL(new RegExp(`#/m/${m.id}$`));
});

test("팀 추천 다양성은 모임 탭에서 끄고 켤 수 있다", async ({ page }) => {
  const s = await setup(page);
  await page.goto("/#/group");
  const section = page.getByRole("region", { name: "팀 추천" });
  const toggle = section.getByRole("checkbox");
  await expect(toggle).toBeChecked();
  // 서버에 저장한 뒤 다시 읽은 값으로 그려지는 칸이라 check()/uncheck() 대신 누르고 결과를 기다린다.
  await toggle.click();
  await expect(page.getByText("팀 추천이 최근 조합을 따지지 않도록 했어요.")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  expect((await getSnapshot(page.request, s.groupId)).group.settings.teamDiversity).toBe(false);
  await toggle.click();
  await expect(page.getByText("팀 추천에서 최근 조합을 피하도록 했어요.")).toBeVisible();
  await expect(toggle).toBeChecked();
});

test("모임 삭제는 확인 문구를 넣어야 되고, 백업을 먼저 내려받은 뒤 지우며, 그다음 탈퇴할 수 있다", async ({ page }) => {
  const s = await setup(page);
  await play(page.request, s, s.people.slice(0, 10), "A");
  const viewToken = (await getSnapshot(page.request, s.groupId)).group.viewToken;

  await page.goto("/#/group");
  // 위험한 작업은 모임 탭 맨 아래 접힌 묶음 안에 있다.
  await page.getByText("위험한 작업 · 복원 · 삭제").click();
  await page.getByRole("button", { name: "모임 삭제 · 탈퇴로" }).click();
  await expect(page.getByRole("heading", { name: "모임 삭제 · 탈퇴" })).toBeVisible();

  // 운영 중인 모임이 있으면 탈퇴 버튼 대신 안내가 나온다.
  const account = page.getByRole("region", { name: "탈퇴(계정 삭제)" });
  await expect(account).toContainText("운영 중인 모임이 있어 지금은 탈퇴할 수 없어요");
  await expect(account).toContainText("합치기 테스트 모임");

  const groupBox = page.getByRole("region", { name: /모임 삭제: 합치기 테스트 모임/ });
  const run = groupBox.getByRole("button", { name: "백업 내려받고 모임 삭제" });
  await expect(run).toBeDisabled();
  await groupBox.getByLabel("확인을 위해 '삭제'를 입력해 주세요").fill("삭제");
  await expect(run).toBeEnabled();
  await noHorizontalOverflow(page);
  const [download] = await Promise.all([page.waitForEvent("download"), run.click()]);
  expect(download.suggestedFilename()).toMatch(/^naejeon-before-delete-\d{4}-\d{2}-\d{2}\.json$/);
  await page.waitForURL(/#\/$/);

  expect((await page.request.get(`/api/groups/${s.groupId}/snapshot`)).status()).toBe(404);
  expect((await page.request.get(`/api/view/${viewToken}`)).status()).toBe(404);

  // 이제 탈퇴할 수 있다.
  await page.goto("/#/delete");
  const accountAfter = page.getByRole("region", { name: "탈퇴(계정 삭제)" });
  await accountAfter.getByLabel("확인을 위해 '탈퇴'를 입력해 주세요").fill("탈퇴");
  await accountAfter.getByRole("button", { name: "탈퇴하기" }).click();
  await page.waitForURL(/#\/$/);
  const me = await (await page.request.get("/api/me")).json();
  expect(me.accountId).toBeNull();
});

test("조회 링크를 연 화면은 모임이 지워지면 '더 이상 열리지 않아요'를 보여준다", async ({ page }) => {
  const s = await setup(page);
  await play(page.request, s, s.people.slice(0, 10), "A");
  const viewToken = (await getSnapshot(page.request, s.groupId)).group.viewToken;
  await page.goto(`/#/v/${viewToken}/now`);
  await expect(page.getByRole("heading", { name: /1경기/ })).toBeVisible();
  await post(page.request, `/api/groups/${s.groupId}/delete`, { confirm: "삭제" });
  await page.reload();
  await expect(page.getByText("이 링크는 더 이상 열리지 않아요")).toBeVisible();
});
