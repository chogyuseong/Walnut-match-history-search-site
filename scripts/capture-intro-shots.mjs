// 첫 화면 소개(src/web/screens/Intro.tsx)의 기능 목록 옆에 붙는 예시 사진을 찍는다.
// 결과는 public/intro/{prep,ranking,join,season}-{dark,light}.jpg. 화면 모양이 바뀌면 다시 찍어 함께 커밋한다.
//
// 쓰는 법: 로컬 서버를 띄운 뒤(npm run dev) `npm run shots:intro`. 다른 주소면 `npm run shots:intro -- http://127.0.0.1:8790`.
// 로컬 전용이다. 참가 신청 사진은 개발용 가짜 로그인(/api/auth/fake-login, 운영에서는 404)으로 로컬 D1에 시험 모임을
// 만들어 신청 링크를 받는다. 예시 화면이 로컬 코드와 같아야 사진과 실제 화면이 어긋나지 않는다.
//
// 이름은 예시 모임(src/shared/demo.ts)에 나오는 가짜 이름만 쓴다. 실제 사람 이름을 넣지 않는다.
// 사진에 챔피언 초상화(라이엇 자산)가 들어가지 않는 화면만 고른다. 바꿀 때 이 조건을 다시 본다.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:8787";
const OUT_DIR = join(import.meta.dirname, "..", "public", "intro");

/** 휴대폰 폭으로 찍는다. 소개에서 사진이 이보다 넓게 보일 일은 없다(styles.css .intro-shot). */
const PHONE_WIDTH = 390;
/** 화면 아래 고정 메뉴가 잘라 낼 범위에 들어오지 않도록 창을 길게 연다. 폭 기준 반응형이라 모양은 그대로다. */
const TALL_VIEWPORT = 3000;
/** 2배로 찍어 고해상도 화면에서도 글자가 번지지 않게 한다. */
const PIXEL_RATIO = 2;
/** JPEG 품질. 80 아래로 내리면 작은 글자 둘레에 얼룩이 보인다. */
const JPEG_QUALITY = 80;
/** 잘라 낸 범위 위에 남길 여백(px). 간격 규칙의 space-4와 같은 값. */
const EDGE = 16;
/** 아래는 마지막 요소에서 바로 자른다. 여백을 두면 다음 카드·줄의 테두리가 조금 걸려 잘린 것처럼 보인다. */
const BOTTOM_EDGE = 0;
/** 예시 화면이 다 그려질 때까지 기다리는 시간. 예시 모임은 브라우저 안에서 기록을 만든다. */
const SETTLE_MS = 1500;

const PREP_NAMES = ["밤송이", "솔방울", "구름빵", "바람개비", "주전자", "징검다리", "새벽별", "보름달", "모래성", "도토리"];
/** 참가 신청 사진에서 이미 신청해 둔 사람 수. 많으면 "오늘 참가" 버튼이 사진 밖으로 밀린다. */
const JOINED_BEFORE_SHOT = 2;
/** 참가 신청 사진에 보이는 명단 줄 수(신청함 표시 줄과 "오늘 참가" 버튼 줄이 섞여 보이게). */
const JOIN_ROWS_SHOWN = 3;

/**
 * 로컬 서버에 시험 모임을 만들고 참가 신청 링크 토큰을 돌려준다. 두 테마가 같은 링크를 쓰도록 한 번만 부른다.
 * 서버는 다른 출처의 쓰기를 막으므로 Origin을 같은 주소로 붙인다.
 */
async function createJoinLink(browser) {
  const operator = await browser.newContext({ baseURL: BASE_URL });
  const headers = { Origin: BASE_URL };
  const post = async (path, data) => {
    const response = await operator.request.post(path, { data, headers });
    if (!response.ok()) throw new Error(`${path} ${response.status()} ${await response.text()}`);
    return response.json();
  };
  await post("/api/auth/fake-login", { subject: `intro-shots-${Date.now()}` });
  const group = await post("/api/groups", { requestId: crypto.randomUUID(), name: "수요일 내전" });
  await post(`/api/groups/${group.id}/participants`, { requestId: crypto.randomUUID(), names: PREP_NAMES });
  const { token } = await post(`/api/groups/${group.id}/join/link`, {});
  for (const name of PREP_NAMES.slice(0, JOINED_BEFORE_SHOT)) await post(`/api/join/${token}`, { name });
  await operator.close();
  return token;
}

/** 두 요소의 위·아래 끝을 잇는 범위로 자른다. 좌우는 화면 전체 폭이다. */
async function clipBetween(page, top, bottom) {
  const a = await top.boundingBox();
  const b = await bottom.boundingBox();
  const y = Math.max(0, a.y - EDGE);
  return { x: 0, y, width: PHONE_WIDTH, height: b.y + b.height + BOTTOM_EDGE - y };
}

const SHOTS = [
  {
    name: "prep",
    async clip(page) {
      await page.goto("/#/pick");
      await page.getByRole("main").getByRole("textbox").first().fill(PREP_NAMES.join("\n"));
      await page.getByRole("button", { name: "추가", exact: true }).click();
      await page.getByRole("button", { name: "팀 짜기 (10/10)" }).click();
      const heading = page.getByRole("heading", { name: "다음 경기 준비" });
      await heading.waitFor();
      const tools = page.getByRole("region", { name: "섞기" });
      return clipBetween(page, heading, tools.getByRole("button").nth(1));
    },
  },
  {
    name: "ranking",
    async clip(page) {
      await page.goto("/#/demo/ranking");
      const table = page.getByRole("region", { name: "MMR 순위표" });
      await table.waitFor();
      await page.waitForTimeout(SETTLE_MS);
      // 목록의 첫 li는 "누적 50경기 이상 · n명" 머리 줄이라 nth(2)가 2위 줄이다.
      return clipBetween(page, table, table.locator(".mmr-list > li").nth(2));
    },
  },
  {
    name: "join",
    async clip(page, joinToken) {
      // 참가자 쪽 화면이라 로그인하지 않은 새 문맥에서 연다.
      await page.goto(`/#/join/${joinToken}`);
      const heading = page.getByRole("heading", { level: 1 });
      await heading.waitFor();
      const roster = page.getByRole("region", { name: "명단에서 신청" }).locator(".search-results > li");
      await roster.nth(JOIN_ROWS_SHOWN - 1).waitFor();
      return clipBetween(page, heading, roster.nth(JOIN_ROWS_SHOWN - 1));
    },
  },
  {
    name: "season",
    async clip(page) {
      await page.goto("/#/demo/season");
      const summary = page.getByRole("region", { name: "요약" });
      await summary.waitFor();
      await page.waitForTimeout(SETTLE_MS);
      return clipBetween(page, summary, page.locator(".award-list-main > li").first());
    },
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  const joinToken = await createJoinLink(browser);
  for (const theme of ["dark", "light"]) {
    for (const shot of SHOTS) {
      // 찍을 때마다 새 문맥이라 이전 편성·테마 기억이 섞이지 않는다.
      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: { width: PHONE_WIDTH, height: TALL_VIEWPORT },
        deviceScaleFactor: PIXEL_RATIO,
        locale: "ko-KR",
        timezoneId: "Asia/Seoul",
        reducedMotion: "reduce",
      });
      await context.addInitScript((t) => localStorage.setItem("naejeon.theme", t), theme);
      const page = await context.newPage();
      const clip = await shot.clip(page, joinToken);
      const path = join(OUT_DIR, `${shot.name}-${theme}.jpg`);
      await page.screenshot({ path, clip, type: "jpeg", quality: JPEG_QUALITY });
      console.log(`${path} (${Math.round(clip.width)}×${Math.round(clip.height)})`);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
