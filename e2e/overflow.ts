import { expect, type Page } from "@playwright/test";

// 가로 넘침 검사. 실패하면 밖으로 나간 요소를 오류 글에 적는다: CI(리눅스)에서만 넘치는데 로컬에서 재현되지 않아,
// GitHub의 실패 요약(annotation, 로그인 없이 읽힘)만 보고 범인을 찾을 수 있게 하려는 것이다(2026-11-21).
// 아직 이 도우미를 쓰는 곳은 CI에서 넘침으로 실패하던 넷뿐이다. 다른 스펙의 같은 검사는 각자 복사본이다.

/** 오류 글에 적을 넘친 요소 수. 가장 안쪽 것만 고르므로 보통 몇 개면 범인이 보인다. */
const CULPRITS_SHOWN = 8;

export async function expectNoHorizontalOverflow(page: Page) {
  const report = await page.evaluate((shown) => {
    const client = document.documentElement.clientWidth;
    const outside = [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > client + 0.5;
    });
    // 넘친 자식이 있는 요소(감싼 상자)는 빼고 가장 안쪽만 남긴다.
    const innermost = outside.filter((el) => !outside.some((other) => other !== el && el.contains(other)));
    const describe = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const cls = [...el.classList].join(".");
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 24);
      const font = getComputedStyle(el).fontFamily.split(",")[0];
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} 오른쪽 끝 ${r.right.toFixed(1)} 폭 ${r.width.toFixed(1)} 글꼴 ${font} "${text}"`;
    };
    return {
      overflow: document.documentElement.scrollWidth - client,
      client,
      pretendard: document.fonts.check('16px "Pretendard Variable"', "가"),
      culprits: innermost.slice(0, shown).map(describe),
    };
  }, CULPRITS_SHOWN);
  expect(
    report.overflow,
    `가로 넘침 ${report.overflow}px (화면 폭 ${report.client}, Pretendard ${report.pretendard ? "받음" : "안 받음"})\n` +
      report.culprits.join("\n"),
  ).toBeLessThanOrEqual(0);
}
