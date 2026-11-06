import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

// docs/P4 P4-5의 화면 시나리오 중 앞 단계에서 미뤄 둔 것(7, 13, 19, 21, 29, 30, 39)을 실제 브라우저에서 확인한다.
// 경기는 API로 빠르게 만들고, 시나리오가 묻는 화면 동작만 누른다. 로컬 가짜 로그인(AUTH_MODE=fake)을 쓴다.

const POSITIONS = ["top", "jungle", "mid", "adc", "support"] as const;

interface Person {
  id: string;
  name: string;
}
interface Setup {
  groupId: string;
  people: Person[];
  user: string;
}

let counter = 0;
function requestId(): string {
  counter += 1;
  return `e2e-scn-${Date.now().toString(36)}-${counter}`;
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { data });
  expect(response.ok(), `${path} → ${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function getSnapshot(request: APIRequestContext, groupId: string) {
  const response = await request.get(`/api/groups/${groupId}/snapshot`);
  expect(response.ok()).toBe(true);
  return response.json();
}

/** 로그인하고 12명 모임을 만든다. rotation=false면 서포터 순환을 끈다. */
async function setup(page: Page, opts: { rotation?: boolean; names?: string[] } = {}): Promise<Setup> {
  const user = `e2e-scn-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await post(page.request, "/api/auth/fake-login", { subject: user });
  const group = await post(page.request, "/api/groups", { name: "시나리오 모임" });
  const names = opts.names ?? Array.from({ length: 12 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`);
  const ensured = await post(page.request, `/api/groups/${group.id}/participants`, { names });
  if (opts.rotation === false) {
    const snap = await getSnapshot(page.request, group.id);
    const response = await page.request.put(`/api/groups/${group.id}/settings`, {
      data: {
        requestId: requestId(),
        baseSettingsVersionId: snap.group.settingsVersionId,
        settings: { ...snap.group.settings, rotationEnabled: false },
      },
    });
    expect(response.ok()).toBe(true);
  }
  return { groupId: group.id, people: ensured.participants, user };
}

/** 10명으로 경기를 시작한다. 앞 5명이 팀 A이고 각 팀 다섯째가 서포터다. */
async function start(request: APIRequestContext, s: Setup, ten: Person[], ackRepeat: string[] = []) {
  const snap = await getSnapshot(request, s.groupId);
  const started = await post(request, `/api/groups/${s.groupId}/matches/start`, {
    requestId: requestId(),
    baseLiveVersion: snap.group.liveVersion,
    roster: ten.map((p, i) => ({ participantId: p.id, team: i < 5 ? "A" : "B", position: POSITIONS[i % 5] })),
    ackRepeat,
  });
  return started.match as { id: string; version: number; matchNo: number };
}

async function finish(
  request: APIRequestContext,
  s: Setup,
  match: { id: string; version: number },
  winnerTeam: "A" | "B",
  winnerSide: "blue" | "red" | "unknown",
) {
  const done = await post(request, `/api/groups/${s.groupId}/matches/${match.id}/result`, {
    requestId: requestId(),
    baseMatchVersion: match.version,
    winnerTeam,
    winnerSide,
  });
  return done.match as { id: string; version: number; matchNo: number };
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 요소 가운데 점에서 맨 위에 그려진 것이 그 요소(또는 그 안)인지. 고정 버튼·탭에 가려졌는지 본다. */
async function notCovered(locator: Locator, label: string, inVisualViewport = true) {
  // 사용자가 그 칸으로 이동했을 때처럼(초점 이동·Tab 키) 가장 가까운 위치로 스크롤한다.
  await locator.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  const result = await locator.evaluate((el, visual) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const vv = window.visualViewport;
    const visibleBottom = vv && visual ? vv.offsetTop + vv.height : window.innerHeight;
    const top = document.elementFromPoint(x, y);
    const by = top && !(el === top || el.contains(top) || (el instanceof HTMLLabelElement && el.control === top))
      ? `${top.tagName}.${(top as HTMLElement).className}`
      : null;
    return { inside: y >= 0 && y <= visibleBottom, by };
  }, inVisualViewport);
  expect(result.inside, `${label}: 보이는 영역 안`).toBe(true);
  expect(result.by, `${label}: 다른 요소에 가려짐`).toBeNull();
}

/** 다음 갱신 계기: 앱이 실제로 쓰는 visibilitychange(창으로 돌아옴)를 일으킨다. */
async function fireVisible(page: Page) {
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

test.use({ viewport: { width: 390, height: 844 } });

test("7: 결과 저장 응답이 끊기면 '확인하지 못했어요'와 [확인하기], 확인 뒤에만 저장됨, 이력 1행", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  const match = await start(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: `${match.matchNo}경기 결과` });
  await sheet.getByRole("radio", { name: /팀 A/ }).check();
  await sheet.getByRole("radio", { name: "블루" }).check();

  // 서버는 요청을 처리하지만 응답은 기기에 오지 않는다(같은 요청 ID로 다시 보내는 재시도도 모두).
  let delivered = 0;
  await page.route("**/matches/*/result", async (route) => {
    await route.fetch();
    delivered += 1;
    await route.abort("connectionreset");
  });
  await sheet.getByRole("button", { name: "저장" }).click();
  await expect(sheet.getByRole("alert")).toContainText("저장됐는지 확인하지 못했어요");
  const check = sheet.getByRole("button", { name: "확인하기" });
  await expect(check).toBeVisible();
  // 확인 전에는 "저장됨"을 쓰지 않는다. 입력은 그대로다.
  await expect(sheet.getByText(/저장됨/)).toHaveCount(0);
  await expect(sheet.getByRole("radio", { name: "블루" })).toBeChecked();
  expect(delivered).toBeGreaterThanOrEqual(1);

  // 서버에는 이미 저장돼 있다. 확인하기는 같은 요청 ID로 다시 묻고, 그 응답을 받은 뒤에만 "저장됨"이다.
  await page.unroute("**/matches/*/result");
  await check.click();
  await expect(sheet.getByText(`${match.matchNo}경기 저장됨 · 팀 A 승 · 블루`)).toBeVisible();

  const snap = await getSnapshot(page.request, s.groupId);
  const saved = snap.matches.find((m: { id: string }) => m.id === match.id);
  expect(saved.state).toBe("confirmed");
  expect(saved.winnerTeam).toBe("A");
  const results = snap.revisions.filter(
    (r: { matchId: string; kind: string }) => r.matchId === match.id && r.kind === "result",
  );
  expect(results).toHaveLength(1);
});

test("13: 입력 중 서버 갱신이 와도 초점·입력값·스크롤이 그대로다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 600 });
  const s = await setup(page, { rotation: false });
  for (let i = 0; i < 2; i++) await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "blue");

  // 참가자 고르기: 이름 칸에 일부 입력, 아래로 스크롤.
  await page.goto("/#/pick");
  const input = page.getByLabel("이름 검색 또는 새 이름 입력");
  await input.fill("선수");
  // 입력 칸이 화면 위쪽에 보일 만큼 내려 둔다(목록 일부가 보이는 상태).
  await page.evaluate(() => window.scrollTo(0, 120));
  await input.evaluate((el: HTMLTextAreaElement) => el.focus({ preventScroll: true }));
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(100);
  const inputTop = await input.evaluate((el) => el.getBoundingClientRect().top);
  expect(inputTop).toBeGreaterThan(0);

  // 다른 기기에서 참가자가 늘고 경기가 하나 더 저장됐다. 앱의 갱신 계기(창으로 돌아옴)를 일으킨다.
  await post(page.request, `/api/groups/${s.groupId}/participants`, { names: ["선수새로"] });
  await finish(page.request, s, await start(page.request, s, s.people.slice(2, 12)), "B", "red");
  const refreshed = page.waitForResponse((r) => r.url().includes("/snapshot") && r.ok());
  await fireVisible(page);
  await refreshed;
  // 갱신이 화면에 반영됐다(새 참가자가 목록에 보인다).
  await expect(page.getByRole("region", { name: "전체 참가자" })).toContainText("선수새로");

  const after = await page.evaluate(() => ({
    id: document.activeElement?.id,
    value: (document.activeElement as HTMLTextAreaElement | null)?.value,
    y: window.scrollY,
  }));
  expect(after.id).toBe("name-input");
  expect(after.value).toBe("선수");
  expect(Math.abs(after.y - before)).toBeLessThanOrEqual(1);
  expect(Math.abs((await input.evaluate((el) => el.getBoundingClientRect().top)) - inputTop)).toBeLessThanOrEqual(1);

  // 기록 화면의 랭킹 이름 검색도 같다.
  await page.goto("/#/records");
  const search = page.getByRole("region", { name: "소환사 랭킹" }).getByLabel("이름 검색");
  await search.fill("선수0");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await search.evaluate((el: HTMLInputElement) => el.focus({ preventScroll: true }));
  // 맨 아래까지 내렸다. 새 경기 카드가 목록 위에 끼어들어도 보고 있던 자리(입력 칸의 화면 위치)는 그대로여야 한다.
  const top0 = await search.evaluate((el) => el.getBoundingClientRect().top);
  await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "red");
  const again = page.waitForResponse((r) => r.url().includes("/snapshot") && r.ok());
  await fireVisible(page);
  await again;
  await expect(page.getByRole("heading", { name: /4경기 확정/ })).toBeVisible();
  const kept = await page.evaluate(() => ({
    label: (document.activeElement as HTMLInputElement | null)?.getAttribute("aria-label"),
    value: (document.activeElement as HTMLInputElement | null)?.value,
  }));
  expect(kept.value).toBe("선수0");
  expect(kept.label).toBe("이름 검색");
  const top1 = await search.evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs(top1 - top0)).toBeLessThanOrEqual(1);
});

test("19: 추첨 적용 → 좌우 바꾸기 → 두 팀 '적용됨' 유지 → 시작하면 서버 명단도 바뀐 대로", async ({ page }) => {
  const s = await setup(page);
  await page.goto("/#/pick");
  const all = page.getByRole("region", { name: "전체 참가자" });
  for (const p of s.people.slice(0, 10)) await all.getByRole("button", { name: new RegExp(p.name) }).click();
  await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();

  const teamA = page.getByRole("region", { name: "팀 A" });
  const teamB = page.getByRole("region", { name: "팀 B" });
  await page.getByRole("button", { name: "서포터만 바꾸기" }).click();
  await expect(teamA.getByText("서포터 바꾸기 적용됨")).toBeVisible();
  await expect(teamB.getByText("서포터 바꾸기 적용됨")).toBeVisible();

  const rows = (team: Locator) => team.getByRole("button").allInnerTexts();
  const beforeA = await rows(teamA);
  const beforeB = await rows(teamB);

  await page.getByRole("button", { name: "좌우 바꾸기" }).click();
  // 사람·포지션은 그대로 자리만 바뀌고, 두 팀 모두 추첨이 유지된다.
  expect(await rows(teamA)).toEqual(beforeB);
  expect(await rows(teamB)).toEqual(beforeA);
  await expect(teamA.getByText("서포터 바꾸기 적용됨")).toBeVisible();
  await expect(teamB.getByText("서포터 바꾸기 적용됨")).toBeVisible();
  await expect(page.getByText("서포터 바꾸기 다시 확인 필요")).toHaveCount(0);

  // 시작하면 서버에 저장된 명단의 팀도 바꾼 대로다.
  await page.getByRole("button", { name: "이 팀으로 시작" }).click();
  const confirm = page.getByRole("dialog", { name: "시작 전에 확인해 주세요" });
  const heading = page.getByRole("heading", { name: /경기 진행 중/ });
  await expect(confirm.or(heading)).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole("button", { name: /시작$/ }).click();
  await expect(heading).toBeVisible();

  const snap = await getSnapshot(page.request, s.groupId);
  const live = snap.matches.find((m: { state: string }) => m.state === "in_progress");
  const nameOf = new Map(s.people.map((p) => [p.id, p.name]));
  const serverA = live.roster
    .filter((r: { team: string }) => r.team === "A")
    .map((r: { participantId: string }) => nameOf.get(r.participantId));
  const lastWord = (t: string) => t.split("\n").map((x) => x.trim()).filter(Boolean).pop()!;
  for (const text of beforeB) {
    const name = s.people.map((p) => p.name).find((n) => text.includes(n))!;
    expect(serverA).toContain(name);
  }
  expect(serverA).toHaveLength(5);
  // 서버의 서포터는 화면에서 서포터였던 사람이다(추첨 결과 유지).
  const supportA = live.roster.find((r: { team: string; position: string }) => r.team === "A" && r.position === "support");
  const shownSupportA = beforeB.find((t) => t.includes("서폿"));
  expect(shownSupportA && lastWord(shownSupportA)).toBe(nameOf.get(supportA.participantId));
});

// 서포터 규칙(2026-11-06 개정): 새 서포터는 아직 안 간 사람(0회)만. 두 팀을 따로 판단해
// 안 간 사람이 없는 팀은 그대로 두고 다른 팀만 바로 바꾼다(예전의 "팀 A만 적용 / 취소" 선택은 없앴다).
test("21: 팀 B가 모두 서포터를 배정받았으면 팀 A만 바로 바꾸고 알린다 → 초기화 버튼이 켜지고, 누르면 다시 꺼진다", async ({
  page,
}) => {
  const s = await setup(page);
  const P = s.people;
  // 1~8경기: 팀 B의 서포터 자리에 선수06~09가 두 번씩 선다. 팀 A 서포터는 선수11로 반복.
  for (let k = 0; k < 8; k++) {
    // 팀 B 다섯째(서포터)가 선수06+(k%4)다. 앞 넷은 나머지 선수06~10으로 채운다.
    const sup = P[5 + (k % 4)]!;
    const others = [P[5]!, P[6]!, P[7]!, P[8]!, P[9]!].filter((p) => p.id !== sup.id);
    const roster = [P[0]!, P[1]!, P[2]!, P[3]!, P[10]!, ...others, sup];
    const ack = [...(k > 0 ? [P[10]!.id] : []), ...(k >= 4 ? [sup.id] : [])];
    const m = await start(page.request, s, roster, ack);
    await finish(page.request, s, m, "A", "blue");
  }
  // 9경기 진행 중: 팀 B 서포터는 선수10(이번이 1회), 선수06~09는 2회씩 → 팀 B 다섯 명 모두 1회 이상.
  // 팀 A는 선수05만 1회(이번 경기), 선수01~04는 0회.
  await start(page.request, s, [...P.slice(0, 5), ...P.slice(5, 10)]);

  await page.goto("/#/match");
  await page.getByRole("button", { name: "다음 경기 준비" }).click();
  await expect(page.getByRole("heading", { name: "다음 경기 준비" })).toBeVisible();
  await page.getByRole("button", { name: "포지션 유지" }).click();
  const teamA = page.getByRole("region", { name: "팀 A" });
  const teamB = page.getByRole("region", { name: "팀 B" });
  const reset = page.getByRole("button", { name: "서포터 횟수 초기화" });

  // 팀 B에 안 간 사람(선수01)을 넣으면 모두 배정받은 팀이 없어 초기화 버튼은 꺼져 있고 이유를 글로 보여준다.
  await teamB.getByRole("button", { name: /선수06/ }).click();
  await teamA.getByRole("button", { name: /선수01/ }).click();
  await expect(teamB.getByRole("button", { name: /선수01/ })).toBeVisible();
  await page.getByText(/^서포터 횟수: /).click();
  await expect(reset).toBeDisabled();
  await expect(page.getByText("아직 서포터를 안 간 사람이 있어요.", { exact: false })).toBeVisible();
  // 되돌리면(팀 B가 다시 모두 간 사람) 초안에서 바로 다시 계산해 켜진다.
  await page.getByRole("button", { name: "직전 편성으로" }).click();
  await expect(teamB.getByRole("button", { name: /선수06/ })).toBeVisible();
  await expect(reset).toBeEnabled();

  const rows = async () => [await teamA.getByRole("button").allInnerTexts(), await teamB.getByRole("button").allInnerTexts()];
  const before = await rows();

  // 서포터만 바꾸기: 묻지 않고 팀 A만 바뀐다. 팀 B는 그대로이고 알림이 뜬다.
  await page.getByRole("region", { name: "섞기" }).getByRole("button", { name: "서포터만 바꾸기" }).click();
  const note = page.getByRole("status").filter({ hasText: "모두 서포터를 배정받았어요" });
  await expect(note).toContainText("팀 B는 모두 서포터를 배정받았어요.");
  await expect(note).toContainText("서포터 횟수 초기화를 누르면 다시 처음부터 돌아가요.");
  await expect(note.getByRole("button")).toHaveCount(0);
  await expect(teamA.getByText("서포터 바꾸기 적용됨")).toBeVisible();
  await expect(teamB.getByText("서포터 바꾸기 적용됨")).toHaveCount(0);
  const after = await rows();
  expect(after[1]).toEqual(before[1]);
  expect(after[0]).not.toEqual(before[0]);
  await expect(page.getByText(/^팀 A: .+→서포터/)).toBeVisible();
  // 팀 A의 새 서포터는 아직 안 간 사람(서폿 표시 없음)이다.
  await expect(teamA.getByRole("button").nth(4)).not.toContainText(/서폿 \d회/);

  // 초기화 버튼이 켜져 있다 → 누르면 횟수 표시가 사라지고 버튼은 다시 꺼진다.
  await expect(reset).toBeEnabled();
  await reset.click();
  const dialog = page.getByRole("dialog", { name: "서포터 횟수 초기화" });
  await dialog.getByRole("button", { name: "초기화" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".teams").getByRole("button").filter({ hasText: /서폿 \d회/ })).toHaveCount(0);
  await page.getByText("서포터 횟수: 아직 없음").click();
  await expect(reset).toBeDisabled();
});

test("29: 클립보드가 거절되면 선택 가능한 글 상자, 진영 미확인이면 '팀 A·B'로만", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("거절", "NotAllowedError")) },
    });
  });
  const s = await setup(page, { rotation: false });
  await start(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await page.getByRole("button", { name: "명단 공유" }).click();
  const dialog = page.getByRole("dialog", { name: "명단 공유" });

  await dialog.getByRole("button", { name: "텍스트 복사" }).click();
  const box = dialog.getByRole("textbox");
  await expect(dialog.getByText("복사하지 못했어요. 아래 글을 길게 눌러 직접 복사해 주세요.")).toBeVisible();
  await expect(box).toHaveCount(1);
  const text = await box.inputValue();
  expect(text).toContain("팀 A");
  expect(text).toContain("팀 B");
  // 진영은 결과 저장 때 확인한다. 진행 중에는 블루·레드를 쓰지 않는다.
  expect(text).not.toMatch(/블루|레드/);
  for (const p of s.people.slice(0, 10)) expect(text).toContain(p.name);
  // 글 상자를 누르면 전체가 선택된다(직접 복사).
  await box.click();
  const selected = await box.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart);
  expect(selected).toBe(text.length);
  await expect(box).toHaveAttribute("readonly", "");

  // 링크 복사도 같은 대체 경로.
  await dialog.getByRole("button", { name: "링크 복사" }).click();
  await expect(dialog.getByRole("textbox")).toHaveCount(2);
  expect(await dialog.getByRole("textbox").first().inputValue()).toMatch(/#\/v\/.+\/now$/);
  await noHorizontalOverflow(page);
});

test("30: 변경 내역에 정정·전적 제외·복구가 경기·시각·항목·현재 결과·링크와 함께, 변경 주체 없이", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  let m = await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "unknown");
  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    const done = await post(page.request, `/api/groups/${s.groupId}/matches/${m.id}/${action}`, {
      requestId: requestId(),
      baseMatchVersion: m.version,
      ...extra,
    });
    m = done.match;
  };
  await act("correct", { field: "side", winnerSide: "red" });
  await act("exclude");
  await act("restore");

  await page.goto("/#/records");
  await page.getByText("변경 내역").click();
  const log = page.locator("details").filter({ has: page.getByText("변경 내역", { exact: true }) });
  const items = log.getByRole("listitem");
  await expect(items).toHaveCount(3);
  // 최근 것이 위: 복구 → 전적 제외 → 정정(진영).
  await expect(items.nth(0)).toContainText("1경기 · 복구");
  await expect(items.nth(1)).toContainText("1경기 · 전적 제외");
  await expect(items.nth(2)).toContainText("1경기 · 정정 (진영)");
  for (let i = 0; i < 3; i++) {
    await expect(items.nth(i)).toContainText("현재: ");
    await expect(items.nth(i)).toContainText(/\d{1,2}:\d{2}/);
  }
  await expect(items.nth(0)).toContainText("팀 A 승");
  // 변경 주체(계정)는 보이지 않는다.
  await expect(log).not.toContainText(s.user);
  // 각 줄은 그 경기로 가는 링크다.
  await items.nth(1).getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: "1경기" })).toBeVisible();
});

test("30·합치기: 많이 뛴 사람을 합쳐도 변경 내역은 한 줄로 묶이고 실제 정정은 남는다", async ({ page }) => {
  const s = await setup(page, { rotation: false, names: [...Array.from({ length: 11 }, (_, i) => `선수${String(i + 1).padStart(2, "0")}`), "부캐"] });
  const dup = s.people.find((p) => p.name === "부캐")!;
  let first = await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "unknown");
  first = (
    await post(page.request, `/api/groups/${s.groupId}/matches/${first.id}/correct`, {
      requestId: requestId(),
      baseMatchVersion: first.version,
      field: "side",
      winnerSide: "blue",
    })
  ).match;
  const withDup = [dup, ...s.people.slice(1, 10)];
  for (let i = 0; i < 3; i++) await finish(page.request, s, await start(page.request, s, withDup), "B", "red");
  await post(page.request, `/api/groups/${s.groupId}/merges`, {
    requestId: requestId(),
    sourceId: dup.id,
    targetId: s.people[0]!.id,
  });

  await page.goto("/#/records");
  await page.getByText("변경 내역").click();
  const log = page.locator("details").filter({ has: page.getByText("변경 내역", { exact: true }) });
  const items = log.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("부캐를 선수01에게 합침 (3경기)");
  await expect(items.nth(1)).toContainText("1경기 · 정정 (진영)");
  // 합친 사람의 개인 화면 주소로 들어오면 남은 사람으로 안내한다.
  await page.goto(`/#/p/${dup.id}`);
  await expect(page.getByText("부캐 님은 선수01 님에게 합쳐졌어요.")).toBeVisible();
  await page.getByRole("button", { name: "선수01 님 기록 보기" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "선수01" })).toBeVisible();
  // 모임 탭의 보관 목록에는 "○○에게 합쳐짐".
  await page.goto("/#/group");
  await page.getByLabel("보관한 참가자도 보기").check();
  // 참가자가 10명을 넘으면 처음에는 10명만 보이고 이름으로 찾을 수 있다.
  await expect(page.getByRole("region", { name: "참가자" }).getByRole("button", { name: /나머지 \d+명 더 보기/ })).toBeVisible();
  await page.getByLabel("참가자 이름으로 찾기").fill("부캐");
  await expect(page.getByRole("region", { name: "참가자" }).getByRole("listitem").filter({ hasText: "부캐" })).toContainText(
    "선수01에게 합쳐짐",
  );
  // 검색·참가자 고르기에는 나오지 않는다.
  await page.goto("/#/search");
  await page.getByLabel("플레이어 이름").fill("부캐");
  await expect(page.getByText("일치하는 이름이 없어요.")).toBeVisible();
  await page.goto("/#/pick");
  await expect(page.getByRole("region", { name: "전체 참가자" })).not.toContainText("부캐");
});

test("오류 안내: 429·503·409·로그인 만료는 쉬운 문구로, 입력은 그대로", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  const match = await start(page.request, s, s.people.slice(0, 10));
  await page.goto("/#/match");
  await page.getByRole("button", { name: "결과 입력" }).click();
  const sheet = page.getByRole("dialog", { name: `${match.matchNo}경기 결과` });
  await sheet.getByRole("radio", { name: /팀 B/ }).check();
  await sheet.getByRole("radio", { name: "레드" }).check();

  const cases = [
    { status: 429, code: "RATE_LIMITED", message: "요청이 너무 잦아요. 30초 뒤에 다시 시도해 주세요. 입력한 내용은 그대로 있어요.", shown: "요청이 너무 잦아요" },
    { status: 503, code: "MAINTENANCE", message: "모임을 점검하는 중입니다(백업 복원 중). 잠시 뒤 화면을 새로 고친 뒤 다시 시도해 주세요. 입력한 내용은 그대로 있어요.", shown: "모임을 점검하는 중입니다" },
    { status: 409, code: "VERSION_CONFLICT", message: "conflict", shown: "그 사이 내용이 바뀌었어요" },
    { status: 401, code: "UNAUTHENTICATED", message: "login", shown: "로그인이 만료됐어요" },
  ];
  for (const c of cases) {
    await page.route("**/matches/*/result", (route) =>
      route.fulfill({ status: c.status, contentType: "application/json", body: JSON.stringify({ error: { code: c.code, message: c.message } }) }),
    );
    await sheet.getByRole("button", { name: "저장" }).click();
    await expect(sheet.getByRole("alert")).toContainText(c.shown);
    await expect(sheet.getByRole("radio", { name: "레드" })).toBeChecked();
    await expect(sheet.getByText(/저장됨/)).toHaveCount(0);
    await page.unroute("**/matches/*/result");
  }
  // 로그인 만료: 그 자리에서 로그인 창을 열 수 있다.
  await sheet.getByRole("button", { name: "다시 로그인" }).click();
  await expect(page.getByRole("dialog", { name: "로그인" })).toBeVisible();
  await page.getByRole("dialog", { name: "로그인" }).getByRole("button", { name: "닫기" }).click();
  // 서버에는 아무것도 저장되지 않았다.
  const snap = await getSnapshot(page.request, s.groupId);
  expect(snap.matches.find((m: { id: string }) => m.id === match.id).state).toBe("in_progress");
});

test("불러오기 실패: '기록이 없어요'가 아니라 실패 안내와 [다시 시도]", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "blue");
  await page.route("**/api/me", (route) => route.abort("internetdisconnected"));
  await page.goto("/#/records");
  await expect(page.getByRole("heading", { level: 1, name: "불러오지 못했어요" })).toBeVisible();
  await expect(page.getByText("아직 기록이 없어요.")).toHaveCount(0);
  await page.unroute("**/api/me");
  await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "기록" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /1경기 확정/ })).toBeVisible();
});

test("화면 이동: 검색에서 연 개인 통계의 '← 뒤로'는 검색으로, 바로 연 주소는 '← 기록'", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "blue");
  await page.goto("/#/search");
  await page.getByRole("searchbox", { name: "플레이어 이름" }).fill("선수03");
  await page.getByRole("region", { name: "검색 결과" }).getByRole("button").click();
  await expect(page.getByRole("heading", { level: 1, name: "선수03" })).toBeVisible();
  await page.getByRole("button", { name: "← 뒤로" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "전적 검색" })).toBeVisible();
  // 주소로 바로 들어오면 돌아갈 앞 화면이 없으므로 기록으로 간다.
  await page.goto("about:blank");
  await page.goto(`/#/p/${s.people[2]!.id}`);
  await page.getByRole("button", { name: "← 기록" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "기록" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "기록" })).toHaveAttribute("aria-current", "page");
});

test("조회 링크: 모든 화면에 같은 메뉴(지금 화면 표시)와 점검 안내", async ({ page }) => {
  const s = await setup(page, { rotation: false });
  const m = await finish(page.request, s, await start(page.request, s, s.people.slice(0, 10)), "A", "blue");
  const token = (await getSnapshot(page.request, s.groupId)).group.viewToken as string;
  // 점검 중(복원 진행 중) 응답을 흉내 낸다.
  await page.route("**/api/view/**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.group.maintenance = true;
    await route.fulfill({ response, json: body });
  });
  const pages: [string, string][] = [
    ["now", "현재 경기"],
    ["home", "요약"],
    ["search", "검색"],
    ["records", "기록"],
    [`p/${s.people[0]!.id}`, "기록"],
    [`d/${m.id}`, "기록"],
    ["graphs", "기록"],
    [`compare/${s.people[0]!.id}/${s.people[5]!.id}`, "기록"],
  ];
  for (const [path, current] of pages) {
    await page.goto(`/#/v/${token}/${path}`);
    const nav = page.getByRole("navigation", { name: "조회 메뉴" });
    await expect(nav, path).toBeVisible();
    await expect(nav.getByRole("button", { name: current }), path).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("운영자가 모임 기록을 점검하는 중이에요"), path).toBeVisible();
    await noHorizontalOverflow(page);
  }
  // 처리방침도 조회 링크 안에서 열고 조회 화면으로 돌아온다.
  await page.goto(`/#/v/${token}/records`);
  await page.getByRole("contentinfo").getByRole("link", { name: "개인정보 처리방침" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "개인정보 처리방침" })).toBeVisible();
  await page.getByRole("button", { name: "← 조회 화면" }).first().click();
  await expect(page.getByRole("navigation", { name: "조회 메뉴" })).toBeVisible();
});

test.describe("39: 화면 키보드 열림과 200% 확대", () => {
  /**
   * 화면 키보드 흉내 두 가지.
   * - visual: 보이는 영역(visualViewport)만 줄어드는 기기. 창 크기는 그대로.
   * - layout: 창(innerHeight) 자체가 줄어드는 기기. 입력 칸에 초점을 둔 뒤 창 높이를 줄인다.
   */
  async function fakeVisualViewport(page: Page) {
    await page.addInitScript(() => {
      const fake = new EventTarget();
      let height: number | null = null;
      // Object.assign은 getter를 값으로 복사하므로 defineProperty로 단다.
      Object.defineProperties(fake, {
        height: { get: () => height ?? window.innerHeight },
        width: { get: () => window.innerWidth },
        offsetTop: { value: 0 },
        offsetLeft: { value: 0 },
        pageTop: { get: () => window.scrollY },
        pageLeft: { value: 0 },
        scale: { value: 1 },
      });
      const target = fake;
      Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
      (window as unknown as { __keyboard: (h: number | null) => void }).__keyboard = (h) => {
        height = h;
        target.dispatchEvent(new Event("resize"));
      };
    });
  }
  const openKeyboard = (page: Page, height: number | null) =>
    page.evaluate((h) => (window as unknown as { __keyboard: (h: number | null) => void }).__keyboard(h), height);

  /** 초점 칸과 확인 버튼이 가려지지 않고, 하단 탭이 숨고, 가로로 넘치지 않는다. */
  async function checkFocused(page: Page, field: Locator, buttons: Locator[], label: string) {
    await field.focus();
    await field.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await notCovered(field, `${label} 입력 칸`);
    // 키보드가 열린 동안 버튼까지 내려 보는 것처럼, 보이는 영역 가운데로 옮겨 가려졌는지 본다.
    for (const [i, b] of buttons.entries()) {
      await b.evaluate((el) => el.scrollIntoView({ block: "center" }));
      // 흉내 낸 보이는 영역은 실제 기기처럼 창 안에서 움직이지 않으므로, 버튼은 창 기준으로 본다.
      await notCovered(b, `${label} 버튼 ${i + 1}`, false);
    }
    await noHorizontalOverflow(page);
  }

  async function playedGroup(page: Page) {
    const s = await setup(page, { rotation: false, names: [...Array.from({ length: 11 }, (_, i) => `가나다라마바사아자차${String(i + 1).padStart(2, "0")}카타파하가나다라`), "부캐"] });
    const m = await start(page.request, s, s.people.slice(0, 10));
    return { s, m };
  }

  for (const mode of ["visual", "layout"] as const) {
    test(`키보드 열림(${mode}): 준비·결과 입력·참가자 고르기·지난 경기·합치기·복원 확인`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      if (mode === "visual") await fakeVisualViewport(page);
      const { s } = await playedGroup(page);
      const keyboard = async (on: boolean) => {
        if (mode === "visual") await openKeyboard(page, on ? 844 - 336 : null);
        else await page.setViewportSize({ width: 390, height: on ? 844 - 336 : 844 });
      };
      // 키보드가 열리면 하단 탭을 숨긴다(입력 칸·확인 버튼을 가리지 않게).
      const tabsHidden = () => expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeHidden();

      // 참가자 고르기: 이름 칸 + 팀 짜기 버튼(본문 안으로 옮겨짐).
      await page.goto("/#/pick");
      const name = page.getByLabel("이름 검색 또는 새 이름 입력");
      await name.focus();
      await keyboard(true);
      await tabsHidden();
      await checkFocused(page, name, [page.getByRole("button", { name: "추가", exact: true })], "참가자 고르기");
      await expect(page.locator(".action-inline")).toHaveCount(1);
      await keyboard(false);

      // 결과 입력 창(확인 창): 저장 버튼이 탭·고정 버튼에 가리지 않는다. 창 안에는 글자 칸이 없으므로 키보드 없이 본다.
      await page.goto("/#/match");
      await page.getByRole("button", { name: "결과 입력" }).click();
      const sheet = page.getByRole("dialog", { name: /경기 결과/ });
      await sheet.getByRole("radio", { name: /팀 A/ }).check();
      await sheet.getByRole("radio", { name: "블루" }).check();
      await notCovered(sheet.getByRole("button", { name: "저장" }), "결과 입력 저장");
      await notCovered(sheet.getByRole("button", { name: "닫기" }), "결과 입력 닫기");
      await sheet.getByRole("button", { name: "닫기" }).click();

      // 준비: 교체 창의 검색 칸은 없으므로 준비 화면의 시작 버튼이 탭에 가리지 않는지 본다.
      await page.getByRole("button", { name: "다음 경기 준비" }).click();
      await notCovered(page.getByRole("button", { name: "이 팀으로 시작" }), "준비 시작");
      await notCovered(page.getByRole("button", { name: "좌우 바꾸기" }), "준비 좌우 바꾸기");

      // 지난 경기 입력: 마지막 이름 칸에 초점, 저장 버튼.
      await page.goto("/#/backfill");
      const lastName = page.getByLabel("팀 B 5번 이름");
      await lastName.focus();
      await keyboard(true);
      await tabsHidden();
      await checkFocused(page, lastName, [page.getByRole("button", { name: "이 경기 저장" })], "지난 경기 입력");
      await keyboard(false);

      // 합치기: 미리보기의 합치기 버튼.
      await page.goto("/#/merge");
      await page.getByLabel("없앨 이름").selectOption({ label: "부캐" });
      await page.getByLabel("남길 이름").selectOption({ index: 1 });
      await page.getByRole("button", { name: "합치면 어떻게 되는지 보기" }).click();
      await notCovered(page.getByRole("button", { name: "합치기", exact: true }), "합치기 실행");
      await noHorizontalOverflow(page);

      // 복원 확인: 확인 문구 칸과 실행 버튼.
      const backup = await (await page.request.get(`/api/groups/${s.groupId}/export`)).text();
      await page.goto("/#/group");
      await page.getByText("위험한 작업 · 복원 · 삭제").click();
      const restore = page.getByRole("region", { name: "백업에서 복원" });
      await restore.getByLabel("백업 파일 고르기").setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(backup),
      });
      const confirmField = restore.getByLabel(/확인을 위해 '복원'을 입력해 주세요/);
      await confirmField.focus();
      await keyboard(true);
      await tabsHidden();
      await checkFocused(page, confirmField, [restore.getByRole("button", { name: "지금 상태 내려받고 복원하기" })], "복원 확인");
      await keyboard(false);
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    });
  }

  // 200% 확대: CSS 픽셀 기준 너비·높이가 절반이 된다. 1280×800 → 640×400, 1440×900 → 720×450.
  // 휴대폰(390px)의 200%는 195px이지만 docs/P4 시나리오 39의 최소 너비가 320px이므로 320px로 본다.
  for (const size of [
    { width: 640, height: 400 },
    { width: 720, height: 450 },
    { width: 320, height: 422 },
  ]) {
    test(`200% 확대 ${size.width}×${size.height}: 넘침 없음, 고정 버튼이 입력·확인 창 버튼을 가리지 않음`, async ({ page }) => {
      await page.setViewportSize(size);
      const { s } = await playedGroup(page);

      await page.goto("/#/pick");
      await noHorizontalOverflow(page);
      const name = page.getByLabel("이름 검색 또는 새 이름 입력");
      await notCovered(name, "참가자 고르기 이름 칸");
      await page.getByRole("region", { name: "전체 참가자" }).getByRole("listitem").last().scrollIntoViewIfNeeded();
      await notCovered(page.getByRole("region", { name: "전체 참가자" }).getByRole("button").last(), "마지막 참가자");

      await page.goto("/#/match");
      await noHorizontalOverflow(page);
      await page.getByRole("button", { name: "결과 입력" }).click();
      const sheet = page.getByRole("dialog", { name: /경기 결과/ });
      await sheet.getByRole("radio", { name: /팀 B/ }).check();
      await sheet.getByRole("radio", { name: "레드" }).check();
      await notCovered(sheet.getByRole("button", { name: "저장" }), "결과 저장");
      await noHorizontalOverflow(page);
      await sheet.getByRole("button", { name: "닫기" }).click();

      await page.getByRole("button", { name: "다음 경기 준비" }).click();
      await noHorizontalOverflow(page);
      await notCovered(page.getByRole("button", { name: "이 팀으로 시작" }), "준비 시작");
      await notCovered(page.getByRole("button", { name: "참가자 다시 고르기" }), "준비 마지막 링크");

      await page.goto("/#/backfill");
      await noHorizontalOverflow(page);
      await notCovered(page.getByLabel("팀 B 5번 이름"), "지난 경기 마지막 이름 칸");
      await notCovered(page.getByRole("button", { name: "이 경기 저장" }), "지난 경기 저장");

      await page.goto("/#/merge");
      await page.getByLabel("없앨 이름").selectOption({ label: "부캐" });
      await page.getByLabel("남길 이름").selectOption({ index: 1 });
      await page.getByRole("button", { name: "합치면 어떻게 되는지 보기" }).click();
      await noHorizontalOverflow(page);
      await notCovered(page.getByRole("button", { name: "합치기", exact: true }), "합치기 실행");

      const backup = await (await page.request.get(`/api/groups/${s.groupId}/export`)).text();
      await page.goto("/#/group");
      await noHorizontalOverflow(page);
      await page.getByText("위험한 작업 · 복원 · 삭제").click();
      const restore = page.getByRole("region", { name: "백업에서 복원" });
      await restore.getByLabel("백업 파일 고르기").setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(backup),
      });
      await notCovered(restore.getByLabel(/확인을 위해 '복원'을 입력해 주세요/), "복원 확인 칸");
      await notCovered(restore.getByRole("button", { name: "지금 상태 내려받고 복원하기" }), "복원 실행");
      await noHorizontalOverflow(page);
    });
  }
});
