// 사이트 아이콘을 다시 그린다. 브라우저 탭·즐겨찾기(favicon)와 아이폰 "홈 화면에 추가" 아이콘(apple-touch-icon)이다.
// index.html의 <link rel="icon">·<link rel="apple-touch-icon">이 이 파일들을 가리킨다. `node scripts/make-icons.mjs`로 다시 만든다.
//
// 주의
// - 앱 설치 정보 파일(manifest)은 넣지 않는다. 라이엇 개발자 포털 답을 받기 전에는 앱 출시를 보류했다(배포-이어하기.txt).
// - apple-touch-icon은 투명 없이 꽉 채워야 한다. iOS가 모서리를 알아서 둥글게 깎는다.
// - favicon.ico는 브라우저·검색엔진이 링크 태그 없이도 /favicon.ico로 찾아서 둔다. 안에는 PNG 한 장을 그대로 담는다(ICO는 PNG를 품을 수 있다).
// - 사파리·카카오톡은 아이콘을 오래 담아 둔다. 바꾼 뒤 바로 안 바뀌면 방문 기록·홈 화면 아이콘을 지우고 다시 확인한다.
// - 색은 CLAUDE.md 5절 다크 테마 값(바탕 #0F172A, 강조 골드 #E3B04B). 라이엇 로고·게임 그림은 쓰지 않는다.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const publicFile = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/**
 * 파일 이름 → 한 변 px·글자·글자 크기(한 변의 비율). 180은 iOS 홈 화면 권장 크기, 32는 탭 아이콘이다.
 * "내" 한 글자는 크게 그리면 영문 LH처럼 읽혀서 홈 화면 아이콘은 "내전"으로 쓴다. 32px은 두 글자가 뭉개져 "내"만 둔다.
 */
const ICONS = {
  "apple-touch-icon.png": { size: 180, glyph: "내전", ratio: 0.34 },
  "favicon-32.png": { size: 32, glyph: "내", ratio: 0.62 },
};

const iconHtml = ({ size, glyph, ratio }) => `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
<style>
  * { margin: 0; }
  body { width: ${size}px; height: ${size}px; background: #0F172A; color: #E3B04B; display: grid; place-items: center;
         font-family: Pretendard, system-ui, sans-serif; font-weight: 600; font-size: ${Math.round(size * ratio)}px; line-height: 1; }
</style></head><body>${glyph}</body></html>`;

const browser = await chromium.launch();
for (const [name, icon] of Object.entries(ICONS)) {
  const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  await page.setContent(iconHtml(icon), { waitUntil: "networkidle" });
  // 브라우저 안에서 도는 식이라 문자열로 넘긴다(이 파일은 Node 기준으로 린트된다).
  await page.evaluate("document.fonts.ready");
  await page.screenshot({ path: publicFile(name) });
  await page.close();
}
await browser.close();

// favicon.ico: 머리(6바이트) + 그림 목록 한 줄(16바이트) + PNG 원본.
const png = readFileSync(publicFile("favicon-32.png"));
const ICO_HEADER_BYTES = 6 + 16;
const ico = Buffer.alloc(ICO_HEADER_BYTES);
ico.writeUInt16LE(0, 0); // 예약
ico.writeUInt16LE(1, 2); // 종류: 아이콘
ico.writeUInt16LE(1, 4); // 그림 수
ico.writeUInt8(32, 6); // 폭
ico.writeUInt8(32, 7); // 높이
ico.writeUInt16LE(1, 10); // 색 평면
ico.writeUInt16LE(32, 12); // 픽셀당 비트
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(ICO_HEADER_BYTES, 18);
writeFileSync(publicFile("favicon.ico"), Buffer.concat([ico, png]));

console.log("아이콘을 저장했어요: public/apple-touch-icon.png, public/favicon-32.png, public/favicon.ico");
