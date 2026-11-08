import { expect, test, type Page } from "@playwright/test";

// 기존 사이트(v1) 기록 가져오기와 가로로 긴 시트. 서버가 바깥(Apps Script·구글 시트)을 부르므로 브라우저에서 가로챌 수 없다.
// 로컬 전용 응답 등록(/api/test/legacy-fixture, /api/test/sheet-fixture — AUTH_MODE=fake에서만 열림)으로 대신한다.
// 이름은 모두 합성 이름이다.

const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbE2eLegacyFixtureDeploymentId000000000000/exec";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1e2eLegacyAcrossSheetDocumentId00000000AA/edit#gid=0";
const NAMES = Array.from({ length: 12 }, (_, i) => `옛선수${String(i + 1).padStart(2, "0")}`);
const DAY = 86_400_000;
const kstDate = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const kstNoon = (date: string) => Date.parse(`${date}T12:00:00+09:00`);

/** v1 경기 n번째: 12명 중 10명, 라인 0~4, 홀수는 블루 승. */
function v1Match(no: number, date: string) {
  const ten = Array.from({ length: 10 }, (_, k) => NAMES[(no + k) % 12]!);
  return {
    id: `e2e-${no}`,
    time: kstNoon(date),
    blue: ten.slice(0, 5).map((name, lane) => ({ name, lane })),
    red: ten.slice(5).map((name, lane) => ({ name, lane })),
    winner: no % 2 === 1 ? "blue" : "red",
    source: "sheet",
    sidesKnown: true,
  };
}

/** 지난 6경기(이틀) + 아직 오지 않은 날짜 2경기(연도가 한 해 늦게 들어간 경기). */
function v1Response(): string {
  const past = kstDate(Date.now() - 30 * DAY);
  const past2 = kstDate(Date.now() - 29 * DAY);
  const soon = kstDate(Date.now() + 10 * DAY);
  const later = kstDate(Date.now() + 20 * DAY);
  const matches = [
    ...[1, 2, 3].map((n) => v1Match(n, past)),
    ...[4, 5, 6].map((n) => v1Match(n, past2)),
    v1Match(7, soon),
    v1Match(8, later),
  ];
  return JSON.stringify({
    ok: true,
    revision: 3,
    payload: { matches, resetAt: null, schemaVersion: 2, auditLog: [], featureOptions: { elite: [NAMES[0]] }, trash: [v1Match(99, past)] },
  });
}

/** 가로로 긴 표: 12행 날짜, 그 아래 10명(이름·승패), 경기가 옆으로. */
function acrossCsv(count: number): string {
  const width = 2 + count * 2;
  const rows: string[][] = Array.from({ length: 12 }, () => Array<string>(width).fill(""));
  const lanes = ["Top", "Jungle", "Mid", "AD", "Suport"];
  for (let k = 0; k < 10; k++) rows[k + 2]![1] = lanes[k % 5]!;
  for (let i = 0; i < count; i++) {
    const col = 2 + i * 2;
    if (i % 3 === 0) rows[1]![col] = `10월 ${1 + i / 3}일`;
    const ten = Array.from({ length: 10 }, (_, k) => NAMES[(i + k) % 12]!);
    ten.forEach((name, k) => {
      rows[k + 2]![col] = name;
      rows[k + 2]![col + 1] = (k < 5) === (i % 2 === 0) ? "승" : "패";
    });
  }
  return rows.map((r) => r.join(",")).join("\r\n");
}

async function setup(page: Page): Promise<void> {
  const user = `e2e-legacy-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await page.request.post("/api/auth/fake-login", { data: { subject: user } });
  await page.request.post("/api/groups", { data: { requestId: crypto.randomUUID(), name: "기존 사이트 모임" } });
  await page.request.post("/api/test/legacy-fixture", { data: { url: SCRIPT_URL, json: v1Response() } });
}

async function noPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.use({ viewport: { width: 390, height: 844 } });

test("기존 사이트 주소로 읽어 미래 날짜를 한 해 앞으로 옮겨 넣고, 다시 가져오면 0건이다", async ({ page }) => {
  await setup(page);
  await page.goto("/#/group");
  await expect(page.getByText("script.google.com/macros/s/…/exec").first()).toBeVisible();
  await page.getByRole("button", { name: "기존 사이트 기록 가져오기" }).click();
  await expect(page.getByRole("heading", { name: "기존 사이트 기록 가져오기", level: 1 })).toBeVisible();

  const box = page.getByLabel("기존 사이트 연결 주소");
  // 구글 시트 주소를 넣으면 시트 가져오기로 안내한다.
  await box.fill(SHEET_URL);
  await expect(page.getByText("구글 시트 주소예요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "기존 기록 읽기" })).toBeDisabled();
  await box.fill(SCRIPT_URL);
  await page.getByRole("button", { name: "기존 기록 읽기" }).click();

  const confirm = page.getByRole("region", { name: "확인" });
  await expect(confirm).toContainText("기존 사이트의 경기8경기");
  await expect(confirm).toContainText("참가자12명");
  await expect(confirm).toContainText("가져오지 않는 것: 휴지통의 1경기, 상위권 이름 1개");
  await expect(confirm).toContainText("오늘 이후 날짜의 경기가 2경기 있어요");
  // 권장(한 해 앞으로 옮기기)이 기본으로 골라져 있고, 옮긴 날짜 범위를 보여 준다.
  await expect(page.getByRole("radio", { name: /한 해 앞으로 옮겨 넣기/ })).toBeChecked();
  const soonLast = kstDate(Date.now() + 20 * DAY);
  await expect(confirm).toContainText(`→ ${Number(soonLast.slice(0, 4)) - 1}`);
  // 빼고 넣기를 고르면 6경기, 다시 옮기기로.
  await page.getByRole("radio", { name: /빼고 넣기/ }).check();
  await expect(page.getByRole("button", { name: "6경기 가져오기" })).toBeVisible();
  await page.getByRole("radio", { name: /한 해 앞으로 옮겨 넣기/ }).check();
  // 진영은 미리 골라 두지 않는다.
  const go = page.getByRole("button", { name: "8경기 가져오기" });
  await expect(go).toBeDisabled();
  await expect(confirm).toContainText("진영을 어떻게 넣을지 골라 주세요.");
  await page.setViewportSize({ width: 320, height: 800 });
  await noPageOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: /진영 미상으로 넣기/ }).check();
  await go.click();
  await expect(page.getByText("8경기 저장됨 · 진영 미상")).toBeVisible();

  await page.getByRole("button", { name: "모임으로" }).click();
  await expect(page.getByText(/8경기\s*· 기존 사이트/)).toBeVisible();

  // 같은 주소로 다시 가져오면 0건. 고른 날짜 처리를 기억해 기본으로 보여 준다.
  await page.getByRole("button", { name: "기존 사이트 기록 가져오기" }).click();
  await page.getByLabel("기존 사이트 연결 주소").fill(SCRIPT_URL);
  await page.getByRole("button", { name: "기존 기록 읽기" }).click();
  await expect(page.getByRole("region", { name: "확인" })).toContainText("새로 넣을 경기0경기");
  await expect(page.getByText("새로 넣을 경기가 없어요.")).toBeVisible();
  await expect(page.getByRole("radio", { name: /한 해 앞으로 옮겨 넣기/ })).toBeChecked();
});

test("시트 가져오기 칸에 기존 사이트 주소를 넣으면 알아보고 넘겨 준다", async ({ page }) => {
  await setup(page);
  await page.goto("/#/sheet-import");
  await page.getByLabel("구글 시트 주소").fill(SCRIPT_URL);
  await expect(page.getByText("기존 사이트의 연결 주소로 보여요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "시트 읽기" })).toHaveCount(0);
  await page.getByRole("button", { name: "기존 사이트 기록 가져오기로" }).click();
  await expect(page.getByRole("heading", { name: "기존 사이트 기록 가져오기", level: 1 })).toBeVisible();
  await expect(page.getByLabel("기존 사이트 연결 주소")).toHaveValue(SCRIPT_URL);
});

test("가로로 긴 시트는 표 모양을 알아보고 열 고르기 없이 경기로 읽는다", async ({ page }) => {
  await setup(page);
  await page.request.post("/api/test/sheet-fixture", { data: { url: SHEET_URL, csv: acrossCsv(60) } });
  await page.goto("/#/sheet-import");
  await page.getByLabel("구글 시트 주소").fill(SHEET_URL);
  await page.getByRole("button", { name: "시트 읽기" }).click();
  const mapping = page.getByRole("region", { name: "열 맞추기" });
  await expect(mapping).toContainText("가로로 긴 표로 보여요.");
  await expect(page.getByRole("radio", { name: /가로로 긴 표/ })).toBeChecked();
  await expect(mapping).toContainText("지금 설정으로 60경기를 읽었어요");
  // 122개 열마다 고르는 칸을 그리지 않는다.
  await expect(page.locator(".sheet-col")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /탑→정글→미드→원딜→서폿/ })).toBeChecked();
  await page.setViewportSize({ width: 320, height: 800 });
  await noPageOverflow(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "다음: 확인" }).click();
  await expect(page.getByRole("region", { name: "확인" })).toContainText("새로 넣을 경기60경기");
});
