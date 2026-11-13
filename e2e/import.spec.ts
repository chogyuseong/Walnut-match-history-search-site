import { expect, test, type Page } from "@playwright/test";

// 표 일괄 입력: 시트에서 복사한 표를 붙여 넣어 지난 경기를 한꺼번에 넣는다.

const HEADER = "날짜\tA탑\tA정글\tA미드\tA원딜\tA서폿\tB탑\tB정글\tB미드\tB원딜\tB서폿\t승리팀";

/** 12명 중 10명이 번갈아 나오는 경기 표를 만든다. 짝수 번째는 A 승, 홀수 번째는 B 승. */
function table(count: number): string[] {
  const names = Array.from({ length: 12 }, (_, i) => `옛선수${String(i + 1).padStart(2, "0")}`);
  return Array.from({ length: count }, (_, i) => {
    const ten = Array.from({ length: 10 }, (_, k) => names[(i + k) % 12]!);
    const day = String(1 + (i % 28)).padStart(2, "0");
    return [`2026-07-${day}`, ...ten, i % 2 === 0 ? "A" : "B"].join("\t");
  });
}

async function openImport(page: Page): Promise<string> {
  const user = `e2e-imp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.request.post("/api/auth/fake-login", { data: { subject: user } });
  const group = await (await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "이관 모임" } })).json();
  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 기록 한꺼번에 넣기" }).click();
  await expect(page.getByRole("heading", { name: "표 일괄 입력", level: 1 })).toBeVisible();
  return group.id as string;
}

test.use({ viewport: { width: 390, height: 844 } });

test("틀린 줄이 있으면 넣지 않고, 고친 뒤 진영을 골라야 넣을 수 있다", async ({ page }) => {
  const groupId = await openImport(page);
  const rows = table(120);

  // 틀린 줄(승리팀을 읽을 수 없음)이 하나 있으면 줄 번호와 이유를 알려주고 넣기 버튼이 없다.
  const broken = [...rows];
  broken[4] = broken[4]!.replace(/\t[AB]$/, "\t무승부");
  await page.getByLabel("붙여 넣을 표").fill([HEADER, ...broken].join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await expect(page.getByText("틀린 줄이 1개 있어요.")).toBeVisible();
  await expect(page.getByText(/6번째 줄: 승리팀 '무승부'를 읽지 못했어요/)).toBeVisible();
  await expect(page.getByRole("button", { name: /경기 넣기/ })).toHaveCount(0);
  const none = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(none.matches).toHaveLength(0);

  // 고쳐서 다시 읽으면 미리보기가 나온다.
  await page.getByLabel("붙여 넣을 표").fill([HEADER, ...rows].join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  const preview = page.getByRole("region", { name: "미리보기" });
  await expect(preview).toContainText("120경기");
  await expect(preview).toContainText("2026-07-01 ~ 2026-07-28");
  await expect(preview).toContainText("12명 (새로 만들 12명)");

  // 진영은 미리 골라져 있지 않고, 고르기 전에는 넣을 수 없다.
  await expect(page.getByRole("radio", { name: /진영 미상으로 넣기/ })).not.toBeChecked();
  await expect(page.getByRole("radio", { name: /팀 A는 블루/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "120경기 넣기" })).toBeDisabled();

  await page.getByRole("radio", { name: /팀 A는 블루/ }).check();
  await page.getByRole("button", { name: "120경기 넣기" }).click();
  await expect(page.getByText("120경기 저장됨 · 팀 A → 블루팀, 팀 B → 레드팀")).toBeVisible();

  // 서버에 120경기가 확정 경기로 들어갔고 진영은 팀 A가 블루다. 세션과 순환은 생기지 않았다.
  const snapshot = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snapshot.matches).toHaveLength(120);
  expect(
    snapshot.matches.every(
      (m: { state: string; source: string; teamASide: string; roster: unknown[] }) =>
        m.state === "confirmed" && m.source === "import" && m.teamASide === "blue" && m.roster.length === 10,
    ),
  ).toBe(true);
  expect(snapshot.participants).toHaveLength(12);
  expect(snapshot.session).toBeNull();
  expect(snapshot.group.liveVersion).toBe(0);

  // 기록과 그래프에 바로 반영된다. 팀 A가 60승이므로 블루 50%.
  await page.getByRole("button", { name: "기록 보기" }).click();
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await expect(page.getByRole("heading", { name: /전체 경기 · 120경기 확정/ })).toBeVisible();
  await page.getByRole("button", { name: "그래프 분석" }).click();
  const sides = page.getByRole("region", { name: "분석 요약" });
  await expect(sides).toContainText("블루 50% · 60승 60패 (120경기)");
});

test("진영 미상으로 넣으면 승패는 세고 진영 통계에서만 빠진다", async ({ page }) => {
  const groupId = await openImport(page);
  await page.getByLabel("붙여 넣을 표").fill(table(3).join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "3경기 넣기" }).click();
  await expect(page.getByText("3경기 저장됨 · 진영 미상")).toBeVisible();

  const snapshot = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snapshot.matches.every((m: { teamASide: string }) => m.teamASide === "unknown")).toBe(true);

  await page.getByRole("button", { name: "그래프 분석" }).click();
  const sides = page.getByRole("region", { name: "분석 요약" });
  await expect(sides.locator(".ps-tiles > div").nth(0)).toContainText("3경기");
  await expect(sides).toContainText("진영을 아는 경기가 없어요.");
  await expect(sides).toContainText("진영 기록 없음");
  await expect(sides).toContainText("진영 미상 3경기는 제외했습니다.");
  // 개인별 승률에는 들어간다.
  await expect(page.getByRole("region", { name: "개인별 승률" }).locator(".people-bars > li")).toHaveCount(12);
});

test("이미 들어간 경기는 건너뛰고, 아직 오지 않은 날짜는 줄 번호와 함께 알린다", async ({ page }) => {
  const groupId = await openImport(page);
  await page.getByLabel("붙여 넣을 표").fill(table(3).join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "3경기 넣기" }).click();
  await expect(page.getByText("3경기 저장됨 · 진영 미상")).toBeVisible();

  // 같은 표에 한 줄을 더해 다시 넣으면 이미 들어간 3경기는 건너뛰고 1경기만 넣는다.
  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 기록 한꺼번에 넣기" }).click();
  await page.getByLabel("붙여 넣을 표").fill(table(4).join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  const preview = page.getByRole("region", { name: "미리보기" });
  await expect(preview).toContainText("이미 들어간 경기(건너뜀)3경기");
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "1경기 넣기" }).click();
  await expect(page.getByText("1경기 저장됨 · 진영 미상")).toBeVisible();
  await expect(page.getByText("이미 들어간 3경기는 건너뛰었어요.")).toBeVisible();
  const snapshot = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snapshot.matches).toHaveLength(4);

  // 모두 들어간 표는 넣을 경기가 없다고 알린다.
  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 기록 한꺼번에 넣기" }).click();
  await page.getByLabel("붙여 넣을 표").fill(table(4).join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await expect(page.getByText("새로 넣을 경기가 없어요. 이 표의 경기는 이미 모두 들어가 있어요.")).toBeVisible();
  await expect(page.getByRole("button", { name: /경기 넣기/ })).toHaveCount(0);

  // 내일 날짜 줄은 넣지 않고 줄 번호와 함께 알린다.
  const tomorrow = new Date(Date.now() + 2 * 24 * 3600_000).toISOString().slice(0, 10);
  const future = table(1)[0]!.replace(/^\S+/, tomorrow);
  await page.getByLabel("붙여 넣을 표").fill([HEADER, future].join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await expect(page.getByText(`2번째 줄: ${tomorrow}는 아직 오지 않은 날짜예요.`, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /경기 넣기/ })).toHaveCount(0);
});

test("같은 날 같은 10명·같은 결과의 두 번째 경기만 따로 붙여 넣으면 '이미 들어간 경기'로 잡히고, 골라서 다른 경기로 넣을 수 있다", async ({ page }) => {
  const groupId = await openImport(page);
  const one = table(1);
  await page.getByLabel("붙여 넣을 표").fill(one.join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "1경기 넣기" }).click();
  await expect(page.getByText("1경기 저장됨 · 진영 미상")).toBeVisible();

  // 같은 줄을 다시 붙여 넣으면 건너뛴다. 한 번 더 한 경기라고 고르면 새 경기로 들어간다.
  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 기록 한꺼번에 넣기" }).click();
  await page.getByLabel("붙여 넣을 표").fill(one.join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await expect(page.getByText("새로 넣을 경기가 없어요.", { exact: false })).toBeVisible();
  await page.getByText("한 번 더 한 경기라면 골라서 넣기").click();
  await page.getByRole("checkbox", { name: /다른 경기로 넣기/ }).check();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "1경기 넣기" }).click();
  await expect(page.getByText("1경기 저장됨 · 진영 미상")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  const snapshot = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snapshot.matches.filter((m: { state: string }) => m.state === "confirmed")).toHaveLength(2);
});
