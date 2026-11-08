// 빌드한 화면 JS의 크기 검사(npm run check:bundle). `npm run build` 뒤에 돌린다. CI에서도 쓴다.
// - 가장 큰 JS 파일 하나가 MAX_CHUNK_KB를 넘으면 실패한다(화면 분할이 풀려 한 파일로 다시 뭉치는 것을 막는다).
// - 첫 화면에서 받는 JS(index.html이 부르는 진입 파일 + 그 파일이 정적으로 import하는 파일)가 MAX_INITIAL_KB를 넘으면 실패한다.
// 화면별로 받는 양(진입 + 그 화면 조각 + 그 조각이 정적으로 import하는 조각)도 함께 출력한다. 화면 조각을 못 찾으면 실패한다.
// CSS 합계는 출력만 한다(상한 없음).
// 크기는 압축 전 바이트(1KB = 1000바이트, vite 출력과 같은 단위)다.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_CHUNK_KB = 250;
const MAX_INITIAL_KB = 330;

const DIST = "dist/web";
const ASSETS = join(DIST, "assets");

let files;
try {
  files = readdirSync(ASSETS).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`${ASSETS}가 없어요. 먼저 npm run build를 돌려 주세요.`);
  process.exit(1);
}

const size = (f) => statSync(join(ASSETS, f)).size;
const kb = (bytes) => `${(bytes / 1000).toFixed(1)}KB`;
const source = new Map(files.map((f) => [f, readFileSync(join(ASSETS, f), "utf8")]));

/** 파일 하나가 정적으로 import하는 같은 폴더의 JS 파일(동적 import()는 제외). */
function staticImports(file) {
  const out = new Set();
  for (const m of source.get(file).matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) out.add(m[1]);
  return out;
}

/** 시작 파일들에서 정적 import를 따라간 모든 파일. */
function closure(starts) {
  const seen = new Set();
  const stack = [...starts];
  while (stack.length > 0) {
    const f = stack.pop();
    if (seen.has(f) || !source.has(f)) continue;
    seen.add(f);
    for (const dep of staticImports(f)) stack.push(dep);
  }
  return seen;
}

const total = (set) => [...set].reduce((n, f) => n + size(f), 0);
const chunk = (prefix) => files.find((f) => f.startsWith(`${prefix}-`));

const html = readFileSync(join(DIST, "index.html"), "utf8");
const entries = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
if (entries.length === 0) {
  console.error("index.html에서 진입 JS를 찾지 못했어요.");
  process.exit(1);
}
const initial = closure(entries);

let failed = false;

console.log("화면별로 받는 JS(압축 전):");
console.log(`  첫 화면 껍데기(진입 + React)        ${kb(total(initial))}`);
const routes = [
  ["#/ 첫 화면(오늘·처음 온 사람 소개)", ["Today"]],
  ["#/ 운영자(오늘 + 미리 받는 운영 묶음)", ["Today", "operator"]],
  ["#/join/… 참가 신청", ["Join"]],
  ["#/v/… 조회 링크", ["Viewer"]],
  ["#/v/…/live 참가자 편성", ["ViewerLive"]],
  ["#/demo 예시 모임", ["Demo"]],
  ["#/privacy 개인정보 처리방침", ["Privacy"]],
];
for (const [label, prefixes] of routes) {
  const starts = prefixes.map(chunk);
  if (starts.some((s) => s === undefined)) {
    // 화면 조각 이름이 바뀌었거나(lazyScreens.ts) 분할이 풀렸다. 크기 검사를 조용히 건너뛰지 않게 실패로 본다.
    const missing = prefixes.filter((p) => chunk(p) === undefined);
    console.error(`  ${label.padEnd(34)} 실패: 조각을 찾지 못함(${missing.join(", ")}-*.js)`);
    failed = true;
    continue;
  }
  console.log(`  ${label.padEnd(34)} ${kb(total(new Set([...initial, ...closure(starts)])))}`);
}

const largest = files.map((f) => [f, size(f)]).sort((a, b) => b[1] - a[1]);
console.log("가장 큰 JS 5개:");
for (const [f, n] of largest.slice(0, 5)) console.log(`  ${f.padEnd(40)} ${kb(n)}`);

// CSS는 상한 없이 크기만 본다(첫 화면에 한 번에 받는 styles.css가 대부분).
const cssFiles = readdirSync(ASSETS).filter((f) => f.endsWith(".css"));
const cssTotal = cssFiles.reduce((n, f) => n + statSync(join(ASSETS, f)).size, 0);
console.log(`CSS 합계(압축 전, 상한 없음): ${kb(cssTotal)} (${cssFiles.length}개 파일)`);

if (largest[0][1] > MAX_CHUNK_KB * 1000) {
  console.error(`실패: 가장 큰 JS ${largest[0][0]}이(가) ${kb(largest[0][1])}로 상한 ${MAX_CHUNK_KB}KB를 넘었어요.`);
  failed = true;
}
if (total(initial) > MAX_INITIAL_KB * 1000) {
  console.error(`실패: 첫 화면 JS가 ${kb(total(initial))}로 상한 ${MAX_INITIAL_KB}KB를 넘었어요.`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`통과: 가장 큰 JS ≤ ${MAX_CHUNK_KB}KB, 첫 화면 JS ≤ ${MAX_INITIAL_KB}KB`);
