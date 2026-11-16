// 링크 공유 미리보기 사진(public/og-image.png)을 다시 그린다. 카카오톡·문자·디스코드가 링크 카드에 띄우는 그림이다.
// index.html의 og:image가 이 파일을 가리킨다. 문구·색을 바꾸면 이 스크립트를 고치고 `node scripts/make-og-image.mjs`로 다시 만든다.
//
// 주의
// - 1200×630은 카카오톡·페이스북 권장 비율(1.91:1)이다. 크기를 바꾸면 index.html og:image:width/height도 바꾼다.
// - 카카오톡은 미리보기를 자기 서버에 오래 담아 둔다. 그림을 바꾼 뒤에는 카카오 개발자 사이트 "공유 디버거"에서 캐시를 지워야 새 그림이 보인다.
// - 색은 CLAUDE.md 5절 다크 테마 값 그대로다(바탕 #0F172A, 패널 #1E293B, 강조 골드 #E3B04B). 블루·레드는 진영 뜻으로만 쓴다.
// - 글꼴은 Pretendard CDN을 받아 그린다. 인터넷이 없으면 기본 글꼴로 그려지니 결과 그림을 눈으로 확인한다.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const OUT_FILE = fileURLToPath(new URL("../public/og-image.png", import.meta.url));
const WIDTH = 1200;
const HEIGHT = 630;

const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; background: #0F172A; color: #F8FAFC;
         font-family: Pretendard, system-ui, sans-serif; padding: 64px; display: flex; gap: 64px; align-items: center; }
  .copy { flex: 1; }
  .brand { font-size: 32px; font-weight: 600; color: #E3B04B; }
  h1 { font-size: 64px; font-weight: 600; line-height: 1.25; margin-top: 24px; }
  p { font-size: 28px; color: #CBD5E1; line-height: 1.5; margin-top: 24px; }
  .board { width: 400px; background: #1E293B; border: 1px solid #475569; border-radius: 8px; padding: 24px; }
  .side { display: flex; flex-direction: column; gap: 8px; }
  .side + .side { margin-top: 24px; padding-top: 24px; border-top: 1px solid #475569; }
  .head { font-size: 22px; font-weight: 600; }
  .blue .head { color: #60A5FA; } .red .head { color: #F87171; }
  .row { display: flex; justify-content: space-between; font-size: 22px; color: #CBD5E1; }
  .row b { font-weight: 500; color: #F8FAFC; }
</style></head><body>
  <div class="copy">
    <div class="brand">내전로그</div>
    <h1>내전 팀 짜기와<br>전적 관리</h1>
    <p>티어로 실력을 맞춰 팀을 짜고<br>모임의 승률 랭킹을 쌓아요</p>
  </div>
  <div class="board" aria-hidden="true">
    <div class="side blue"><div class="head">● 블루 · 승</div>
      <div class="row"><b>탑</b><span>플래티넘</span></div>
      <div class="row"><b>정글</b><span>골드</span></div>
      <div class="row"><b>미드</b><span>에메랄드</span></div></div>
    <div class="side red"><div class="head">■ 레드 · 패</div>
      <div class="row"><b>탑</b><span>골드</span></div>
      <div class="row"><b>정글</b><span>플래티넘</span></div>
      <div class="row"><b>미드</b><span>에메랄드</span></div></div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.setContent(html, { waitUntil: "networkidle" });
// 브라우저 안에서 도는 식이라 문자열로 넘긴다(이 파일은 Node 기준으로 린트된다).
await page.evaluate("document.fonts.ready");
await page.screenshot({ path: OUT_FILE });
await browser.close();
console.log(`그림을 저장했어요: ${OUT_FILE}`);
