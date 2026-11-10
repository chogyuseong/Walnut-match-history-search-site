import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// 결과 기반 MMR(2026-11-08)을 휴대폰 폭(390px)에서 확인한다.
// 랭킹 "MMR 순" 정렬(MMR 내림차순)·안내 문구, 개인 통계의 MMR 한 줄과 "MMR 추이",
// 두 사람 비교의 MMR·MMR 차, 랭킹 CSV의 "MMR" 열.
// 모임·참가자·경기는 API로 빠르게 만들고(search-csv.spec.ts와 같은 방식), 확인할 흐름은 화면으로 한다.
//
// 경기 두 개로 MMR이 정해진다(기본 시작 1200, 배치 중 K=50):
//  1경기 선수01~05(팀 A) 승 vs 선수06~10 → 01~05: 1225, 06~10: 1175
//  2경기 선수01·06·07·08·09(평균 1185) 승 vs 선수02·03·04·05·10(평균 1215)
//        → 이긴 쪽 +50×(1−E) = +27.15, 진 쪽 −27.15 (E = 1/(1+10^(30/400)) ≈ 0.4569)
//  결과: 선수01 1252, 선수06~09 1202, 선수02~05 1198, 선수10 1148. 선수11·12는 경기 없음.

test.use({ viewport: { width: 390, height: 844 } });

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
const GROUP_NAME = "MMR모임";
const NAMES = Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
const BOM = String.fromCharCode(0xfeff);

interface Setup {
  groupId: string;
  people: { id: string; name: string }[];
}

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-rating-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function snapshotOf(request: APIRequestContext, groupId: string) {
  return (await request.get(`/api/groups/${groupId}/snapshot`)).json();
}

/** ten의 앞 다섯 명이 팀 A, 뒤 다섯 명이 팀 B. */
async function play(request: APIRequestContext, groupId: string, ten: { id: string }[], winnerTeam: "A" | "B") {
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
  });
}

/** 12명 모임 + 확정 경기 2개. 서포터 순환은 끈다(같은 사람을 다시 쓰려고). */
async function setup(page: Page): Promise<Setup> {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-rating-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
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
  const p = (n: number) => people.find((x) => x.name === NAMES[n - 1])!;
  await play(request, group.id, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(p), "A");
  await play(request, group.id, [1, 6, 7, 8, 9, 2, 3, 4, 5, 10].map(p), "A");
  return { groupId: group.id, people };
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

test("랭킹 MMR 순 · 개인 통계 MMR · 두 사람 비교 MMR 차 · 랭킹 CSV MMR 열", async ({ page }) => {
  const s = await setup(page);
  const idOf = (name: string) => s.people.find((p) => p.name === name)!.id;

  await page.goto("/#/records");
  await page.getByRole("button", { name: "전체", exact: true }).click();
  const ranking = page.getByRole("region", { name: "소환사 랭킹" });
  const rows = ranking.getByRole("listitem");
  await expect(rows).toHaveCount(10);
  // 기본 정렬은 그대로 승률이고, 안내 문구는 MMR 순일 때만 보인다.
  await expect(ranking.getByRole("button", { name: "승률", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(ranking.getByText("MMR은 상대 팀의 평균 MMR을 감안해", { exact: false })).toHaveCount(0);
  // 줄마다 작은 MMR 숫자(배치 진행 중이라 흐리게).
  await expect(rows.filter({ hasText: "선수01" }).locator(".rating-num")).toContainText("MMR 1252");
  await expect(rows.filter({ hasText: "선수01" }).locator(".rating-num")).toHaveClass(/hint/);

  await ranking.getByRole("button", { name: "MMR", exact: true }).click();
  await expect(ranking.getByRole("button", { name: "MMR", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(
    ranking.getByText(
      "MMR은 상대 팀의 평균 MMR을 감안해 승패마다 오르내리는 점수예요(시작 1200). 확정 경기만 세고 범위와 무관하게 누적입니다.",
    ),
  ).toBeVisible();
  const texts = await rows.allInnerTexts();
  const values = texts.map((t) => Number(t.match(/MMR (\d+)/)?.[1] ?? Number.NaN));
  expect(values.every((v) => Number.isFinite(v))).toBe(true);
  expect(values).toEqual([...values].sort((a, b) => b - a));
  expect(texts[0]).toContain("선수01");
  expect(texts[texts.length - 1]).toContain("선수10");
  expect(values[0]).toBe(1252);
  expect(values[values.length - 1]).toBe(1148);
  // 순위 숫자는 1부터 이어진다.
  expect(texts.map((t) => Number(t.trim().split(/\s+/)[0]))).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
  await noHorizontalOverflow(page, "랭킹 MMR 순");

  // 랭킹 CSV: 머리 줄 끝에 "MMR", 첫 줄은 지금 순서(MMR 순)의 1위.
  const waiting = page.waitForEvent("download");
  await ranking.getByRole("button", { name: "CSV 내려받기" }).click();
  const download = await waiting;
  const text = await readFile((await download.path())!, "utf8");
  expect(text.startsWith(BOM)).toBe(true);
  const lines = text.slice(1).trim().split("\r\n");
  expect(lines[0]).toBe("순위,이름,경기,승,패,승률(%),배치,칭호,MMR");
  expect(lines[1]).toBe("1,선수01,2,2,0,100,배치 중,,1252");
  expect(lines[lines.length - 1]).toMatch(/^10,선수10,2,0,2,0,배치 중,,1148$/);

  // 개인 통계: 요약에 MMR 한 줄, 승률 추이와 따로 "MMR 추이".
  await page.goto(`/#/p/${idOf("선수01")}`);
  await expect(page.getByRole("heading", { level: 1, name: "선수01" })).toBeVisible();
  const summary = page.getByRole("region", { name: "요약" });
  await expect(summary).toContainText("MMR 1252 · 최고 1252 · 최근 2경기 +52");
  const ratingTrend = summary.getByRole("img", { name: /^MMR 추이/ });
  await expect(ratingTrend).toBeVisible();
  await expect(ratingTrend).toHaveAttribute("aria-label", /^MMR 추이: 시작 1200에서 2경기째 1252/);
  await expect(summary.getByRole("img", { name: /승률 추이/ })).toHaveCount(0); // 승률 추이는 6경기부터
  await noHorizontalOverflow(page, "개인 통계");

  // 범위를 바꿔도 MMR은 누적 그대로다.
  await page.getByRole("group", { name: "범위" }).getByRole("button", { name: "오늘", exact: true }).click();
  await expect(summary).toContainText("MMR 1252");

  // 두 사람 비교: 두 사람의 MMR과 MMR 차(첫 번째 사람 기준).
  await page.goto(`/#/compare/${idOf("선수01")}/${idOf("선수10")}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("선수01 vs 선수10");
  const side = page.getByRole("region", { name: "나란히 보기" });
  const ratingRow = side.getByRole("row").filter({ hasText: "MMR (누적)" });
  await expect(ratingRow).toContainText("1252");
  await expect(ratingRow).toContainText("1148");
  await expect(side.getByRole("row").filter({ hasText: "MMR 차" })).toContainText("+104");
  // 기존 "승률" 줄은 하나 그대로다(새 줄이 겹치지 않는다).
  await expect(side.getByRole("row").filter({ hasText: "승률" })).toHaveCount(1);
  // 기대 승률 문구는 쓰지 않는다.
  await expect(side).not.toContainText("기대 승률");
  await noHorizontalOverflow(page, "두 사람 비교");
});
