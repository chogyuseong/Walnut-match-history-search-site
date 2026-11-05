import { expect, test, type Page } from "@playwright/test";

// 구글 시트에서 가져오기(작업 F). 서버가 구글을 직접 부르므로 브라우저에서 가로챌 수 없다.
// 로컬 전용 시트 내용 등록(/api/test/sheet-fixture, AUTH_MODE=fake에서만 열림)으로 시트 응답을 대신한다.

const DOC = "1e2eFixtureSheetDocumentIdForTests0000000AA";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=777`;
const LANES = ["TOP", "JG", "MID", "ADC", "SUP"];
const NAMES = Array.from({ length: 12 }, (_, i) => `시트선수${String(i + 1).padStart(2, "0")}`);

/** 한 줄 = 선수 한 명. 날짜 칸은 병합된 것처럼 경기 첫 줄에만 있다. 연도 없는 날짜. */
function playerSheet(count: number): string {
  const lines = ["경기,날짜,팀,닉네임,라인,승패"];
  for (let no = 1; no <= count; no++) {
    const ten = Array.from({ length: 10 }, (_, k) => NAMES[(no + k) % 12]!);
    ten.forEach((name, k) => {
      const winA = no % 2 === 1;
      lines.push([no, k === 0 ? `10/${no}` : "", k < 5 ? "A" : "B", name, LANES[k % 5], (k < 5) === winA ? "승" : "패"].join(","));
    });
  }
  return lines.join("\r\n");
}

async function setup(page: Page): Promise<string> {
  const user = `e2e-sheet-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.request.post("/api/auth/fake-login", { data: { subject: user } });
  const group = await (await page.request.post("/api/groups", { data: { name: "시트 모임" } })).json();
  return group.id as string;
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("시트 주소로 읽어 열을 맞추고 가져온 뒤, 다시 가져오면 새 경기만 넣는다", async ({ page }) => {
  const groupId = await setup(page);
  await page.request.post("/api/test/sheet-fixture", { data: { url: SHEET_URL, csv: playerSheet(3) } });

  await page.goto("/#/group");
  await page.getByRole("button", { name: "구글 시트에서 가져오기" }).click();
  await expect(page.getByRole("heading", { name: "구글 시트에서 가져오기", level: 1 })).toBeVisible();

  // 1 링크: 구글 시트가 아닌 주소는 바로 안내하고 읽기 버튼을 막는다.
  const urlBox = page.getByLabel("구글 시트 주소");
  await urlBox.fill("https://example.com/sheet");
  await expect(page.getByText("구글 시트 주소가 아니에요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "시트 읽기" })).toBeDisabled();
  await urlBox.fill(SHEET_URL);
  await page.getByRole("button", { name: "시트 읽기" }).click();

  // 2 열 맞추기: 표 모양과 열을 자동으로 맞췄다. 연도 없는 날짜는 추정했다고 알려준다.
  const mapping = page.getByRole("region", { name: "열 맞추기" });
  await expect(mapping).toBeVisible();
  await expect(page.getByRole("radio", { name: "한 줄에 선수 한 명" })).toBeChecked();
  await expect(mapping).toContainText("지금 설정으로 3경기를 읽었어요");
  await expect(mapping).toContainText("연도가 없는 날짜가 3경기 있어요");
  await expect(mapping).toContainText("2026년으로 추정했어요");
  await expect(page.getByLabel(/열 D · 닉네임/)).toHaveValue("name");
  await expect(page.getByLabel(/열 E · 라인/)).toHaveValue("lane");
  await expect(mapping).toContainText("그 밖에 11줄이 더 있어요");
  await noPageOverflow(page);
  await page.getByRole("button", { name: "다음: 확인" }).click();

  // 3 확인
  const confirm = page.getByRole("region", { name: "확인" });
  await expect(confirm).toContainText("새로 넣을 경기");
  await expect(confirm).toContainText("3경기");
  await expect(confirm).toContainText("새로 만들 참가자 12명");
  await expect(page.getByRole("button", { name: "3경기 가져오기" })).toBeDisabled();
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "3경기 가져오기" }).click();
  await expect(page.getByText("3경기 저장됨 · 진영 미상")).toBeVisible();

  const snap = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snap.matches).toHaveLength(3);
  expect(snap.matches.every((m: { roster: { position: string | null }[] }) => m.roster.every((r) => r.position !== null))).toBe(true);
  expect(snap.matches.map((m: { playedAt: string }) => m.playedAt.slice(0, 10)).sort()).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  expect(snap.session).toBeNull();
  expect(snap.importBatches[0]).toMatchObject({ kind: "sheet", count: 3 });

  // 모임 탭의 기록에서 시트에서 가져온 묶음으로 구분된다.
  await page.getByRole("button", { name: "모임으로" }).click();
  await expect(page.getByText(/3경기 · 구글 시트/)).toBeVisible();

  // 시트에 경기 하나를 더 적고 다시 가져온다: 기억한 설정을 그대로 쓰고 새 경기만 넣는다.
  await page.request.post("/api/test/sheet-fixture", { data: { url: SHEET_URL, csv: playerSheet(4) } });
  await page.getByRole("button", { name: "구글 시트에서 가져오기" }).click();
  await page.getByLabel("구글 시트 주소").fill(SHEET_URL);
  await page.getByRole("button", { name: "시트 읽기" }).click();
  await expect(page.getByText("이 기기에 기억한 설정을 적용했어요.")).toBeVisible();
  await page.getByRole("button", { name: "다음: 확인" }).click();
  const again = page.getByRole("region", { name: "확인" });
  await expect(again.getByRole("listitem").filter({ hasText: "이미 들어간 경기" })).toContainText("3경기");
  await expect(again.getByRole("listitem").filter({ hasText: "새로 넣을 경기" })).toContainText("1경기");
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await page.getByRole("button", { name: "1경기 가져오기" }).click();
  await expect(page.getByText("1경기 저장됨 · 진영 미상")).toBeVisible();
  const after = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(after.matches).toHaveLength(4);
  expect(after.participants).toHaveLength(12);

  // 같은 시트를 또 가져오면 넣을 경기가 없다.
  await page.getByRole("button", { name: "모임으로" }).click();
  await page.getByRole("button", { name: "구글 시트에서 가져오기" }).click();
  await page.getByLabel("구글 시트 주소").fill(SHEET_URL);
  await page.getByRole("button", { name: "시트 읽기" }).click();
  await page.getByRole("button", { name: "다음: 확인" }).click();
  await expect(page.getByText("새로 넣을 경기가 없어요.")).toBeVisible();
  await expect(page.getByRole("button", { name: /경기 가져오기/ })).toHaveCount(0);
});

test("붙여 넣은 표의 열 순서가 다르면 열 맞추기로 넘어가 틀린 줄을 빼고, 비슷한 이름을 기존 참가자와 잇는다", async ({ page }) => {
  const groupId = await setup(page);
  // 기존 참가자: 띄어쓰기만 다른 '다 온'
  await page.request.post(`/api/groups/${groupId}/participants`, { data: { names: ["다 온"] } });

  const A = ["가람", "나래", "다온", "라온", "마루"];
  const B = ["바다", "사랑", "아라", "자람", "차오"];
  const header = ["날짜", "승리", "탑", "정글", "미드", "원딜", "서폿", "탑", "정글", "미드", "원딜", "서폿"].join("\t");
  const rows = [
    ["2026.10.1", "블루", ...A, ...B].join("\t"),
    ["2026.10.1", "무승부", ...B, ...A].join("\t"),
    ["2026.10.2", "레드", ...B, ...A].join("\t"),
  ];

  await page.goto("/#/group");
  await page.getByRole("button", { name: "지난 기록 한꺼번에 넣기" }).click();
  await page.getByLabel("붙여 넣을 표").fill([header, ...rows].join("\n"));
  await page.getByRole("button", { name: "표 읽기" }).click();
  await expect(page.getByText("열 순서가 기본 형식과 달라 보여요.")).toBeVisible();
  await page.getByRole("button", { name: "열 맞추기로 계속" }).click();

  const mapping = page.getByRole("region", { name: "열 맞추기" });
  await expect(page.getByRole("radio", { name: "한 줄에 한 경기(10명이 옆으로)" })).toBeChecked();
  await expect(page.getByLabel(/열 B · 승리/)).toHaveValue("winner");
  await expect(mapping).toContainText("지금 설정으로 2경기를 읽었어요 · 틀린 줄 1개");
  await page.setViewportSize({ width: 320, height: 800 });
  await noPageOverflow(page);
  // 표는 상자 안에서만 가로로 움직인다.
  const scroll = page.getByRole("region", { name: "표 미리보기" });
  const widths = await scroll.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(widths[0]).toBeGreaterThan(widths[1]!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "다음: 확인" }).click();

  const confirm = page.getByRole("region", { name: "확인" });
  await expect(confirm).toContainText("틀린 줄이 1개 있어요.");
  await expect(confirm).toContainText("3번째 줄: 이긴 팀 '무승부'");
  await expect(confirm).toContainText("비슷한 이름 1개");
  await page.getByRole("radio", { name: /팀 A는 블루/ }).check();
  await expect(page.getByRole("button", { name: "2경기 가져오기" })).toBeDisabled();
  await page.getByLabel("표의 '다온'").selectOption({ label: "기존 '다 온'와 같은 사람" });
  await expect(page.getByRole("button", { name: "2경기 가져오기" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "틀린 줄 1개는 빼고 넣기" }).check();
  await page.getByRole("button", { name: "2경기 가져오기" }).click();
  await expect(page.getByText("2경기 저장됨 · 팀 A 블루 / 팀 B 레드")).toBeVisible();

  const snap = await (await page.request.get(`/api/groups/${groupId}/snapshot`)).json();
  expect(snap.matches).toHaveLength(2);
  const names = snap.participants.map((p: { name: string }) => p.name).sort();
  expect(names).toContain("다 온");
  expect(names).not.toContain("다온");
  expect(snap.participants).toHaveLength(10);
  expect(snap.matches.map((m: { winnerTeam: string; teamASide: string }) => [m.winnerTeam, m.teamASide]).sort()).toEqual([
    ["A", "blue"],
    ["B", "blue"],
  ]);
  expect(snap.importBatches[0]).toMatchObject({ kind: "paste", count: 2 });
});
