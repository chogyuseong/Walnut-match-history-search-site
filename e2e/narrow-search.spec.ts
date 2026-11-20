import { test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./overflow";

// 기록·랭킹·챔피언 티어의 검색 칸(.filter-search)이 320px에서 화면 밖으로 나가지 않는다.
// 입력 칸의 원래 폭(글자 20자 × 평균 글자 폭)을 리눅스 크롬은 윈도보다 넓게 셈해서, CI에서만 칸이 332px이 되어 넘쳤다
// (11-18~11-21 CI E2E 넷 실패). 윈도에서도 같은 조건을 만들려고 size를 40자로 키워 원래 폭을 늘린다.
// CSS의 min-width: 0(11-frame-tables-ranking.css)을 지우면 이 테스트가 넘침으로 실패한다.

/** 리눅스에서 잰 칸 폭(332px)보다 원래 폭이 넓어지는 글자 수. */
const WIDE_INPUT_CHARS = 40;

for (const path of ["/#/demo/records", "/#/demo/ranking", "/#/demo/champions"]) {
  test(`320px 검색 칸: 원래 폭이 넓어도 넘치지 않는다 ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(path);
    await page.locator("input.filter-search").first().waitFor();
    await page.evaluate((chars) => {
      for (const input of document.querySelectorAll<HTMLInputElement>("input.filter-search")) input.size = chars;
    }, WIDE_INPUT_CHARS);
    await expectNoHorizontalOverflow(page);
  });
}
