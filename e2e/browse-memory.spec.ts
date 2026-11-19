import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

// 전적을 오가도 조건이 남는지(2026-11-18).
// ① 기록 화면에서 사람·라인으로 거른 뒤 경기 상세에 다녀와도 조건과 스크롤 위치가 그대로다(주소 ?who=…&pos=…).
// ② 개인 통계에서 고른 기간이 두 사람 비교로 이어진다(?scope=).
// ③ 검색에서 사람을 찾으면 "참가 경기 보기"로 기록 화면이 그 사람 조건으로 열린다.
// ④ 결과 입력 창을 닫거나 새로 고쳐도 작성하던 메모·승리 팀을 이어 쓰고, 저장하면 임시 내용이 지워진다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"];
/** 390px에서 경기 카드가 화면보다 길어져 스크롤이 생길 만큼. */
const GAMES_PLAYED = 8;
/** 검색 결과가 한 쪽(20경기)을 넘어 "더 보기"가 생기고, 23번째 경기를 열 수 있을 만큼. */
const SEARCH_GAMES = 25;

let counter = 0;
const requestId = () => `e2e-memory-${Date.now().toString(36)}-${++counter}`;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(
    response.ok(),
    `${path} → ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return response.json();
}

async function setup(page: Page) {
  const request = page.request;
  await post(request, "/api/auth/fake-login", {
    subject: `e2e-memory-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`,
  });
  const group = await post(request, "/api/groups", {
    requestId: crypto.randomUUID(),
    name: "조건 기억 모임",
  });
  const names = Array.from(
    { length: 10 },
    (_, i) => `선수${String(i + 1).padStart(2, "0")}`,
  );
  const { participants } = await post(
    request,
    `/api/groups/${group.id}/participants`,
    {
      requestId: crypto.randomUUID(),
      names,
    },
  );
  // 같은 명단을 되풀이해 시작하려고 서포터 순환을 끈다.
  const before = await (
    await request.get(`/api/groups/${group.id}/snapshot`)
  ).json();
  const saved = await request.put(`/api/groups/${group.id}/settings`, {
    data: {
      requestId: requestId(),
      baseSettingsVersionId: before.group.settingsVersionId,
      settings: { ...before.group.settings, rotationEnabled: false },
    },
  });
  expect(saved.ok()).toBe(true);
  const roster = participants.map((p: { id: string }, i: number) => ({
    participantId: p.id,
    team: i < 5 ? "A" : "B",
    position: POSITIONS[i % 5],
  }));
  const start = async () => {
    const snapshot = await (
      await request.get(`/api/groups/${group.id}/snapshot`)
    ).json();
    return (
      await post(request, `/api/groups/${group.id}/matches/start`, {
        requestId: requestId(),
        baseLiveVersion: snapshot.group.liveVersion,
        roster,
        teamASide: "blue",
      })
    ).match;
  };
  return {
    groupId: group.id as string,
    people: participants as { id: string; name: string }[],
    start,
  };
}

async function playGames(
  s: Awaited<ReturnType<typeof setup>>,
  request: APIRequestContext,
) {
  for (let game = 0; game < GAMES_PLAYED; game++) {
    const match = await s.start();
    const winnerTeam = game % 3 === 0 ? "B" : "A";
    await post(request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
      requestId: requestId(),
      baseMatchVersion: match.version,
      winnerTeam,
      winnerSide: winnerTeam === "A" ? "blue" : "red",
    });
  }
}

const SHOT_DIR = process.env.SHOT_DIR;
async function shot(page: Page, name: string) {
  if (SHOT_DIR)
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

async function noHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow, `${where} 가로 넘침`).toBeLessThanOrEqual(0);
}

for (const width of [390, 1440]) {
  test(`${width}px: 기록 조건·스크롤이 경기 상세에 다녀와도 남고, 기간이 비교로 이어지고, 검색에서 참가 경기로 간다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page);
    await playGames(s, page.request);
    const first = s.people[0]!;

    // ① 기록 화면에서 선수01 + 탑으로 거른다.
    await page.goto("/#/records");
    await page.getByRole("button", { name: "전체", exact: true }).click();
    await page.getByLabel("거를 사람 추가").selectOption({ label: "선수01" });
    await page.getByLabel("라인", { exact: true }).selectOption("top");
    await expect(page).toHaveURL(new RegExp(`who=${first.id}`));
    await expect(page).toHaveURL(/pos=top/);
    const summary = page.locator(".filter-summary");
    await expect(summary).toContainText("선수01 참가");
    await expect(
      summary.getByRole("button", { name: "이 조건으로 공유" }),
    ).toBeVisible();
    await noHorizontalOverflow(page, "기록 화면 거른 뒤");
    await summary.scrollIntoViewIfNeeded();
    await shot(page, `records-filter-${width}`);

    const cards = page.locator(".match-cards .mc-main");
    await expect(cards).toHaveCount(GAMES_PLAYED);
    const target = cards.nth(GAMES_PLAYED - 2);
    await target.scrollIntoViewIfNeeded();
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(
      scrolled,
      "경기 카드가 화면 아래까지 있어야 스크롤 복원을 확인할 수 있다",
    ).toBeGreaterThan(width === 390 ? 200 : 0);
    await target.click();
    await expect(page).toHaveURL(/#\/m\//);
    await page.getByRole("button", { name: "← 뒤로" }).click();

    await expect(page).toHaveURL(new RegExp(`#/records\\?.*who=${first.id}`));
    await expect(summary).toContainText("선수01 참가");
    await expect(page.getByLabel("라인", { exact: true })).toHaveValue("top");
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(scrolled - 50);

    // ② 개인 통계에서 "오늘"을 고르고 비교로 가면 비교도 "오늘"이다.
    await page.goto(`/#/p/${first.id}`);
    await page
      .getByRole("group", { name: "범위" })
      .getByRole("button", { name: "오늘" })
      .click();
    await expect(page).toHaveURL(/scope=today/);
    await page.getByRole("button", { name: "다른 사람과 비교" }).click();
    await expect(page).toHaveURL(/#\/compare\/.*scope=today/);
    // 두 번째 사람을 고르면 주소가 바뀌어도 기간이 남는다.
    await page.getByLabel("두 번째 사람").selectOption({ label: "선수06" });
    await expect(page).toHaveURL(/#\/compare\/.*\/.*scope=today/);
    await expect(
      page
        .getByRole("group", { name: "범위" })
        .getByRole("button", { name: "오늘" }),
    ).toHaveAttribute("aria-pressed", "true");

    // ③ 검색 → 참가 경기 보기 → 기록 화면이 그 사람·전체 기간으로 열린다.
    await page.goto("/#/search?q=선수02");
    await shot(page, `search-${width}`);
    await page.getByRole("button", { name: "선수02 참가 경기 보기 →" }).click();
    await expect(page).toHaveURL(/#\/records\?scope=all&who=/);
    await expect(summary).toContainText("선수02 참가");
    await expect(summary).toContainText(`${GAMES_PLAYED}경기`);
    await noHorizontalOverflow(page, "검색에서 연 기록 화면");
  });

  test(`${width}px: 결과 입력 중 닫고 새로 고쳐도 이어 쓰고, 저장하면 임시 내용이 지워진다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page);
    await s.start();

    // 진행 중인 경기의 결과 입력은 오늘 화면 주 버튼에서 연다.
    const openResult = async () => {
      await page
        .getByRole("region", { name: "지금 할 일" })
        .getByRole("button", { name: "1경기 결과 입력" })
        .click();
    };
    await page.goto("/#/");
    await openResult();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /블루팀 승/ }).click();
    await dialog.getByLabel("메모 (선택)").fill("바론 한타 역전");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    await page.reload();
    await openResult();
    await expect(
      dialog.getByText("작성하던 내용이 이 기기에 남아 있어요"),
    ).toBeVisible();
    await noHorizontalOverflow(page, "이어 쓰기 안내");
    await shot(page, `result-draft-${width}`);
    await dialog
      .getByRole("button", { name: "작성하던 내용 이어 쓰기" })
      .click();
    await expect(dialog.getByLabel("메모 (선택)")).toHaveValue(
      "바론 한타 역전",
    );
    await expect(
      dialog.getByRole("button", { name: /블루팀 승/ }),
    ).toHaveAttribute("aria-pressed", "true");

    await dialog.getByRole("button", { name: "결과 저장" }).click();
    await expect(dialog.getByText(/1경기 저장됨/)).toBeVisible();
    const left = await page.evaluate(() =>
      Object.keys(localStorage).filter((key) =>
        key.startsWith("naejeon.result-draft"),
      ),
    );
    expect(left).toEqual([]);
  });

  test(`${width}px: 망가진 임시 내용으로 열어도 메모는 이어 쓰고 이긴 팀은 다시 고르게 한다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page);
    await s.start();

    const openResult = async () => {
      await page
        .getByRole("region", { name: "지금 할 일" })
        .getByRole("button", { name: "1경기 결과 입력" })
        .click();
    };
    await page.goto("/#/");
    await openResult();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /블루팀 승/ }).click();
    await dialog.getByLabel("메모 (선택)").fill("용 싸움 패배");
    await page.keyboard.press("Escape");

    // 다른 판의 코드가 남긴 것처럼 챔피언 칸을 지우고 이긴 팀을 허용값 밖으로 바꾼다.
    await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) =>
        k.startsWith("naejeon.result-draft"),
      )!;
      const draft = JSON.parse(localStorage.getItem(key)!);
      delete draft.champions;
      draft.winner = "C";
      localStorage.setItem(key, JSON.stringify(draft));
    });
    await page.reload();
    await openResult();
    await expect(dialog.getByText(/이긴 팀 기록은 읽을 수 없어/)).toBeVisible();
    await dialog
      .getByRole("button", { name: "작성하던 내용 이어 쓰기" })
      .click();

    // 이긴 팀은 비어 있어 저장할 수 없고, 고르면 남아 있던 메모가 그대로 보인다.
    await expect(
      dialog.getByRole("button", { name: "결과 저장" }),
    ).toBeDisabled();
    await dialog.getByRole("button", { name: /레드팀 승/ }).click();
    await expect(dialog.getByLabel("메모 (선택)")).toHaveValue("용 싸움 패배");
    await noHorizontalOverflow(page, "망가진 임시 내용 이어 쓰기");
  });

  test(`${width}px: 검색에서 더 보기로 연 23번째 경기에 다녀와도 펼친 목록·위치·초점이 남는다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page);
    // 한 쪽(20경기)을 넘기려면 같은 메모의 경기가 21개 이상 있어야 한다.
    for (let game = 0; game < SEARCH_GAMES; game++) {
      const match = await s.start();
      await post(page.request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
        requestId: requestId(),
        baseMatchVersion: match.version,
        winnerTeam: "A",
        winnerSide: "blue",
        memo: `용 싸움 ${game + 1}`,
      });
    }

    await page.goto(`/#/search?q=${encodeURIComponent("용 싸움")}`);
    const found = page.getByRole("region", { name: "찾은 경기" });
    const cards = found.locator(".mc-main");
    await expect(cards).toHaveCount(20);
    await found.getByRole("button", { name: /경기 더 보기/ }).click();
    await expect(cards).toHaveCount(SEARCH_GAMES);

    const target = cards.nth(22);
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await expect(page).toHaveURL(/#\/m\//);
    await page.goBack();

    await expect(page.getByRole("searchbox")).toHaveValue("용 싸움");
    await expect(cards).toHaveCount(SEARCH_GAMES);
    await expect(target).toBeInViewport();
    await expect(target).toBeFocused();

    // 질의를 바꾸면 앞 검색의 펼침은 따라오지 않는다.
    await page.getByRole("searchbox").fill("용 싸움 2");
    await expect(page).not.toHaveURL(/[?&]n=/);
  });

  test(`${width}px: 기기 저장소가 막혀도 결과를 입력·저장하고, 남기지 못한다는 안내는 한 줄만 뜬다`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const s = await setup(page);
    await s.start();
    await page.goto("/#/");
    // 저장소가 가득 찬 브라우저처럼 결과 임시 내용 쓰기만 거절한다(로그인·편성 등 다른 저장은 그대로 둔다).
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith("naejeon.result-draft")) {
          throw new DOMException("full", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await page
      .getByRole("region", { name: "지금 할 일" })
      .getByRole("button", { name: "1경기 결과 입력" })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /블루팀 승/ }).click();
    await dialog.getByLabel("메모 (선택)").fill("저장소 없음");
    await expect(dialog.getByText(/작성 중인 내용을 남기지 못했어요/)).toHaveCount(1);
    await noHorizontalOverflow(page, "임시 보관 실패 안내");
    await dialog.getByRole("button", { name: "결과 저장" }).click();
    await expect(dialog.getByText(/1경기 저장됨/)).toBeVisible();
  });
}
