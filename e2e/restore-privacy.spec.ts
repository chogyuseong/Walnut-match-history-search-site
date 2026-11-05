import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 백업 복원(검증 시나리오 36~38의 화면 쪽)과 개인정보 처리방침 화면을 실제 브라우저에서 확인한다.
// 경기는 API로 빠르게 만들고 화면은 복원 흐름만 누른다. 로컬 가짜 로그인(AUTH_MODE=fake)을 쓴다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `e2e-restore-${Date.now().toString(36)}-${requestCounter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

/** 12명 모임을 만들고 순환을 끈다(같은 명단을 반복해서 쓰기 위해). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-restore-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", { name: "복원 테스트 모임" });
  const names = Array.from({ length: 12 }, (_, i) => `복원${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(request, `/api/groups/${group.id}/participants`, { names });
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

async function play(request: APIRequestContext, s: Setup, winnerTeam: "A" | "B") {
  const snapshot = await getSnapshot(request, s.groupId);
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snapshot.group.liveVersion,
    roster: s.people.slice(0, 10).map((p, i) => ({
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
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("백업 내려받기 → 경기 추가 → 복원하면 백업 시점으로 돌아간다", async ({ page }) => {
  const s = await setup(page);
  await play(page.request, s, "A");
  await play(page.request, s, "B");

  // 1) 모임 탭에서 백업을 내려받는다.
  await page.goto("/#/group");
  const backupSection = page.getByRole("region", { name: "백업", exact: true });
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    backupSection.getByRole("button", { name: "백업 내려받기" }).click(),
  ]);
  const backupPath = await download.path();
  const backupText = await readFile(backupPath, "utf8");
  expect(JSON.parse(backupText).matchCount).toBe(2);

  // 2) 백업 뒤에 경기를 하나 더 넣는다.
  await play(page.request, s, "A");
  expect((await getSnapshot(page.request, s.groupId)).matches).toHaveLength(3);
  await page.reload();

  // 3) 손상된 파일은 검사에서 걸리고 아무것도 바뀌지 않는다.
  // 복원은 모임 탭 맨 아래 접힌 "위험한 작업" 묶음 안에 있다.
  await page.getByText("위험한 작업 · 복원 · 삭제").click();
  const restore = page.getByRole("region", { name: "백업에서 복원" });
  const broken = JSON.parse(backupText);
  broken.matchCount = 99;
  await restore.getByLabel("백업 파일 고르기").setInputFiles({
    name: "broken.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await expect(restore.getByText("이 파일로는 복원할 수 없어요.")).toBeVisible();
  await expect(restore.getByText(/경기 수가 맞지 않습니다/)).toBeVisible();
  expect((await getSnapshot(page.request, s.groupId)).matches).toHaveLength(3);

  // 4) 받아 둔 백업 파일을 고르면 바뀌는 내용을 요약해 보여준다.
  await restore.getByLabel("백업 파일 고르기").setInputFiles(backupPath);
  await expect(restore.getByText("이 모임의 백업입니다")).toBeVisible();
  const diff = restore.getByRole("table", { name: "복원으로 바뀌는 내용" });
  await expect(diff.getByRole("row", { name: /^경기/ })).toContainText("3경기");
  await expect(diff.getByRole("row", { name: /^경기/ })).toContainText("2경기");

  // 확인 문구를 넣기 전에는 실행할 수 없다.
  const run = restore.getByRole("button", { name: "지금 상태 내려받고 복원하기" });
  await expect(run).toBeDisabled();
  await restore.getByLabel(/확인을 위해 '복원'을 입력해 주세요/).fill("복원");
  await expect(run).toBeEnabled();

  // 5) 실행하면 지금 상태를 먼저 내려받고 복원한다.
  const [before] = await Promise.all([page.waitForEvent("download"), run.click()]);
  expect(before.suggestedFilename()).toMatch(/^naejeon-before-restore-/);
  expect(JSON.parse(await readFile(await before.path(), "utf8")).matchCount).toBe(3);
  await expect(page.getByText("복원했어요. 경기 2개, 참가자 12명입니다.")).toBeVisible();

  // 6) 이전 상태(2경기)로 돌아왔고, 화면의 기록 목록도 같다.
  const after = await getSnapshot(page.request, s.groupId);
  expect(after.matches).toHaveLength(2);
  expect(after.group.maintenance).toBe(false);
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" }).click();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { name: /전체 경기 · 2경기 확정/ })).toBeVisible();

  // 7) 복원 뒤에도 같은 탭에서 바로 저장할 수 있다(새 세대를 받아 둠).
  await page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "모임" }).click();
  await page.getByRole("textbox", { name: "모임 이름" }).fill("복원 뒤 이름");
  await page.getByRole("region", { name: "모임 이름" }).getByRole("button", { name: "저장" }).click();
  await expect(page.getByText("모임 이름을 바꿨어요.")).toBeVisible();
});

test("복원 전에 열어 둔 다른 탭의 저장은 거절되고 새로 고치라고 안내한다", async ({ page, context }) => {
  const s = await setup(page);
  await play(page.request, s, "A");
  const backup = await (await page.request.get(`/api/groups/${s.groupId}/export`)).json();

  // 다른 탭: 복원 전에 모임 탭을 열어 둔다.
  const oldTab = await context.newPage();
  await oldTab.goto("/#/group");
  await expect(oldTab.getByRole("textbox", { name: "모임 이름" })).toBeVisible();

  // 이 탭에서 API로 복원한다.
  const snapshot = await getSnapshot(page.request, s.groupId);
  await post(page.request, `/api/groups/${s.groupId}/restore`, {
    requestId: requestId(),
    confirm: "복원",
    baseGeneration: snapshot.group.generation,
    backup,
  });

  await oldTab.getByRole("textbox", { name: "모임 이름" }).fill("오래된 탭");
  await oldTab.getByRole("region", { name: "모임 이름" }).getByRole("button", { name: "저장" }).click();
  await expect(oldTab.getByText("이 모임이 백업에서 복원됐어요. 화면을 새로 고친 뒤 다시 해 주세요.")).toBeVisible();
  expect((await getSnapshot(page.request, s.groupId)).group.name).toBe("복원 테스트 모임");
});

test("개인정보 처리방침은 푸터에서 열리고 좁은 화면에서도 넘치지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await page.getByRole("contentinfo").getByRole("link", { name: "개인정보 처리방침" }).click();
  await expect(page).toHaveURL(/#\/privacy$/);
  await expect(page.getByRole("heading", { name: "개인정보 처리방침", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "무엇을 저장하나요" })).toBeVisible();
  await expect(page.getByText("받지 않는 것:")).toBeVisible();
  await noHorizontalOverflow(page);

  // 조회 링크 화면의 푸터에도 같은 링크가 있다.
  await page.goto("/#/v/no-such-token");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "개인정보 처리방침" })).toBeVisible();
});

test("로컬(가짜 로그인)에서는 키가 없는 실제 로그인 버튼이 보이지 않는다", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  expect(me.authMode).toBe("fake");
  await page.goto("/#/login-failed/denied");
  await expect(page.getByRole("heading", { name: "로그인하지 못했어요" })).toBeVisible();
  await expect(page.getByText("로그인을 취소했어요.")).toBeVisible();
  await page.getByRole("button", { name: "다시 로그인" }).click();
  const dialog = page.getByRole("dialog", { name: "로그인" });
  await expect(dialog.getByLabel("계정 이름")).toBeVisible();
  // .dev.vars에 카카오·Google 키를 넣지 않았다면 버튼이 없어야 한다.
  const providers = me.providers as string[];
  await expect(dialog.getByRole("link", { name: "카카오 로그인" })).toHaveCount(
    providers.includes("kakao") ? 1 : 0,
  );
  await expect(dialog.getByRole("link", { name: "Google 계정으로 로그인" })).toHaveCount(
    providers.includes("google") ? 1 : 0,
  );
});
