import { expect, test, type Page } from "@playwright/test";

// 공동 운영자: 대표가 초대 링크를 만들고, 다른 계정이 수락해 경기 결과를 저장하고, 대표가 내보낸다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];

function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
}

async function apiLogin(page: Page, prefix: string): Promise<void> {
  const response = await page.request.post("/api/auth/fake-login", { data: { subject: uniqueUser(prefix) } });
  expect(response.ok()).toBe(true);
}

test("초대 링크로 공동 운영자가 되어 경기 결과를 저장하고, 내보내면 바로 막힌다", async ({ browser }) => {
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ownerContext.grantPermissions(["clipboard-read", "clipboard-write"]);
  const owner = await ownerContext.newPage();
  await apiLogin(owner, "e2e-owner");
  const gid = ((await (await owner.request.post("/api/groups", { data: { name: "공동 운영 모임" } })).json()) as {
    id: string;
  }).id;

  // 대표가 경기 하나를 시작해 둔다(결과는 공동 운영자가 넣는다).
  const names = Array.from({ length: 10 }, (_, i) => `공동선수${i + 1}`);
  const people = ((await (await owner.request.post(`/api/groups/${gid}/participants`, { data: { names } })).json()) as {
    participants: { id: string }[];
  }).participants;
  const snap = (await (await owner.request.get(`/api/groups/${gid}/snapshot`)).json()) as { group: { liveVersion: number } };
  const started = await owner.request.post(`/api/groups/${gid}/matches/start`, {
    data: {
      requestId: uniqueUser("req"),
      baseLiveVersion: snap.group.liveVersion,
      roster: people.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    },
  });
  expect(started.ok()).toBe(true);

  // 대표: 모임 탭에서 초대 링크를 만든다.
  await owner.goto("/#/group");
  const section = owner.getByRole("region", { name: "공동 운영자" });
  await expect(section.getByText("아직 공동 운영자가 없어요.")).toBeVisible();
  await section.getByRole("button", { name: "초대 링크 만들기" }).click();
  const dialog = owner.getByRole("dialog", { name: "공동 운영자 초대" });
  await expect(dialog).toContainText("한 번만 쓸 수 있고 24시간 뒤 만료");
  await dialog.getByRole("button", { name: "초대 링크 만들기" }).click();
  await dialog.getByRole("button", { name: "초대 링크 복사" }).click();
  await expect(dialog.getByRole("button", { name: "복사했어요" })).toBeVisible();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#\/co-invite\/[\w-]+$/);
  await dialog.getByRole("button", { name: "닫기" }).first().click();

  // 받는 사람: 링크를 열고 로그인한 뒤 수락한다.
  const coContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const co = await coContext.newPage();
  await co.goto(link);
  await expect(co.getByRole("heading", { name: "공동 운영자 초대" })).toBeVisible();
  await expect(co.getByText("공동 운영 모임")).toBeVisible();
  await co.getByRole("button", { name: "로그인하고 계속" }).click();
  const login = co.getByRole("dialog", { name: "로그인" });
  await login.getByLabel("계정 이름").fill(uniqueUser("e2e-co"));
  await login.getByRole("button", { name: "개발용 로그인" }).click();
  await co.getByRole("button", { name: "공동 운영자 되기" }).click();

  // 공동 운영자: 홈에 모임이 열리고, 진행 중 경기의 결과를 저장한다.
  await expect(co.getByRole("heading", { name: "공동 운영 모임", level: 1 })).toBeVisible();
  await co.getByRole("button", { name: "현재 경기 보기" }).click();
  await expect(co.getByRole("heading", { name: "1경기 진행 중" })).toBeVisible();
  await co.getByRole("button", { name: "결과 입력" }).click();
  const sheet = co.getByRole("dialog", { name: "1경기 결과" });
  // API로 진영 없이 시작한 경기: 고를 때는 "팀 B", 저장해 진영이 정해지면 "블루팀".
  await sheet.getByRole("radio", { name: /팀 B/ }).check();
  await sheet.getByRole("radio", { name: "블루", exact: true }).check();
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByText("1경기 저장됨 · 블루팀 승")).toBeVisible();

  // 공동 운영자의 모임 탭: 대표 전용 작업은 보이지 않고 나가기가 있다.
  await co.goto("/#/group");
  const coSection = co.getByRole("region", { name: "공동 운영자" });
  await expect(coSection.getByRole("button", { name: "공동 운영자에서 나가기" })).toBeVisible();
  await expect(co.getByRole("region", { name: "운영자 넘기기" })).toHaveCount(0);
  // 화면에서 숨긴 것과 별개로 서버도 거절한다.
  expect((await co.request.post(`/api/groups/${gid}/transfer`)).status()).toBe(403);

  // 대표: 저장된 결과가 보이고, 공동 운영자를 내보낸다.
  const confirmed = (await (await owner.request.get(`/api/groups/${gid}/snapshot`)).json()) as {
    matches: { state: string; winnerTeam: string }[];
  };
  expect(confirmed.matches[0]).toMatchObject({ state: "confirmed", winnerTeam: "B" });
  await owner.reload();
  await expect(section.getByRole("list", { name: "공동 운영자 목록" }).getByRole("listitem")).toHaveCount(1);
  await expect(section).toContainText("개발용 계정");
  await section.getByRole("button", { name: "내보내기" }).click();
  await owner.getByRole("dialog", { name: "공동 운영자 내보내기" }).getByRole("button", { name: "내보내기" }).click();
  await expect(section.getByText("아직 공동 운영자가 없어요.")).toBeVisible();

  // 내보낸 계정의 다음 요청은 바로 거절된다.
  expect((await co.request.get(`/api/groups/${gid}/snapshot`)).status()).toBe(404);
  expect(
    (await co.request.post(`/api/groups/${gid}/participants`, { data: { names: ["늦은 사람"] } })).status(),
  ).toBe(404);

  // 같은 링크는 다시 쓸 수 없다.
  const thirdContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const third = await thirdContext.newPage();
  await third.goto(link);
  await expect(third.getByText("이 초대 링크는 이미 썼거나 만료됐어요.")).toBeVisible();

  await ownerContext.close();
  await coContext.close();
  await thirdContext.close();
});
