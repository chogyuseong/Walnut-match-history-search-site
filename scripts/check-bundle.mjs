// 빌드한 화면 JS의 크기·구성 검사(npm run check:bundle). `npm run build` 뒤에 돌린다. CI에서도 쓴다.
//
// 실패 조건:
//  1. 첫 화면 우리 코드(진입 + 정적 import, React 조각·rolldown 런타임 제외)의 brotli 크기가 MAX_SHELL_BR_KB를 넘는다.
//  2. 첫 화면 전체(1 + React + 런타임 + 주소 미리 받기 파일 + index.html이 거는 CSS)의 brotli 크기가 MAX_INITIAL_BR_KB를 넘는다.
//  3. 첫 화면에 허용 목록(scripts/shell-modules.mjs) 밖의 우리 원본 파일이 들어 있다.
//  4. 가장 큰 JS 파일 하나가 압축 전 MAX_CHUNK_KB를 넘는다(화면 분할이 풀려 한 파일로 다시 뭉치는 것을 막는다).
//  5. 화면 조각이나 주소 미리 받기 대응표(scripts/route-preload-plugin.mjs)가 가리키는 파일을 빌드 결과에서 못 찾는다.
//  6. 검색 노출 설정(noindex 메타·X-Robots-Tag·sitemap.xml, scripts/search-index-plugin.mjs)이 엇갈리거나 robots.txt가 전체를 막는다.
// 1~3에 걸리면 첫 화면 파일의 소스맵을 풀어 원본 파일별 크기 상위 15개를 출력한다(어디가 커졌는지 바로 보이게).
//
// 왜 brotli인가: 실제로 받는 양은 압축된 크기다(Cloudflare가 brotli로 보낸다). 압축 전 크기는 같은 코드라도 압축이 잘 되는
// 문자열(한국어 문구·SVG)에 따라 크게 달라 예산 기준으로 쓰기 어렵다. 압축 전 크기는 참고로 함께 출력한다.
// brotli는 Node 기본 품질(11)로 계산한다. Cloudflare가 실제로 쓰는 수준과 조금 다를 수 있어 예산에 여유를 둔다.
// 크기 단위: 1KB = 1000바이트(vite 출력과 같다).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { ROUTE_PRELOAD_NAME } from "./route-preload-plugin.mjs";
import { SHELL_MODULES } from "./shell-modules.mjs";

const MAX_CHUNK_KB = 250;
// 2026-11-10 경계 정리(ui.tsx·Login.tsx·draft·merge) 뒤 첫 화면 우리 코드는 brotli 15.1KB(압축 전 46.9KB, 주소 미리 받기
// 파일 포함)였다. 정리 전에는 30.8KB(압축 전 110.0KB)였다. 화면 부품이나 통계 계산 하나를 껍데기에 잘못 붙이면 2~5KB씩
// 늘어나므로 여유는 2KB 남짓(약 13%)만 둔다. 기능이 늘어 정당하게 넘으면 먼저 떼어 낼 것이 없는지 실패 출력으로 본다.
const MAX_SHELL_BR_KB = 17;
// 같은 날 첫 화면 전체는 brotli 93.2KB(React 58.1 + 우리 코드 15.1 + CSS 19.9 + 런타임 0.2)였다. 정리 전 108.9KB.
// React·CSS가 크게 바뀌지 않는 한 넘지 않을 값(약 4% 여유)으로 둔다. 넘으면 CSS(상한 없이 커지기 쉬움)부터 본다.
const MAX_INITIAL_BR_KB = 97;

const DIST = "dist/web";
const ASSETS = join(DIST, "assets");
/** 첫 화면 "우리 코드"에서 빼는 조각(라이브러리·번들러가 만든 것). vite.config.ts의 vendor-react와 rolldown 런타임. */
const NOT_OURS = /^(vendor-react|rolldown-runtime)-/;

let all;
try {
  all = readdirSync(ASSETS);
} catch {
  console.error(`${ASSETS}가 없어요. 먼저 npm run build를 돌려 주세요.`);
  process.exit(1);
}
const files = all.filter((f) => f.endsWith(".js"));
const source = new Map(files.map((f) => [f, readFileSync(join(ASSETS, f))]));
const brCache = new Map();
const raw = (f) => source.get(f)?.length ?? readFileSync(join(ASSETS, f)).length;
const br = (f) => {
  if (!brCache.has(f)) brCache.set(f, brotliCompressSync(source.get(f) ?? readFileSync(join(ASSETS, f))).length);
  return brCache.get(f);
};
const kb = (bytes) => `${(bytes / 1000).toFixed(1)}KB`;
const sum = (set, size) => [...set].reduce((n, f) => n + size(f), 0);
const both = (set) => `${kb(sum(set, raw)).padStart(8)} (brotli ${kb(sum(set, br))})`;

/** 파일 하나가 정적으로 import하는 같은 폴더의 JS 파일(동적 import()는 제외). */
function staticImports(file) {
  const out = new Set();
  for (const m of source.get(file).toString("utf8").matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)) out.add(m[1]);
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

const chunk = (prefix) => files.find((f) => f.startsWith(`${prefix}-`));

const html = readFileSync(join(DIST, "index.html"), "utf8");
const entries = [...html.matchAll(/<script[^>]+src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
if (entries.length === 0) {
  console.error("index.html에서 진입 JS를 찾지 못했어요.");
  process.exit(1);
}
const initial = closure(entries);
const ours = new Set([...initial].filter((f) => !NOT_OURS.test(f)));
const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/([^"]+\.css)"/g)].map((m) => m[1]);
const initialAll = new Set([...initial, ...css]);

let failed = false;
const fail = (message) => {
  console.error(`실패: ${message}`);
  failed = true;
};

console.log("첫 화면에서 받는 파일(압축 전 / brotli):");
for (const f of [...initialAll].sort()) console.log(`  ${f.padEnd(40)} ${kb(raw(f)).padStart(8)} / ${kb(br(f))}`);
console.log(`  우리 코드(React·런타임 제외)          ${both(ours)}`);
console.log(`  전체(JS + CSS)                        ${both(initialAll)}`);

console.log("화면별로 받는 JS(첫 화면 JS + 그 화면 조각과 정적 import, CSS 제외):");
const routes = [
  ["#/ 첫 화면(오늘·처음 온 사람 소개)", ["Today"]],
  ["#/ 운영자(오늘 + 미리 받는 운영 묶음)", ["Today", "operator"]],
  ["#/join/… 참가 신청", ["Join"]],
  ["#/v/… 조회 링크", ["Viewer"]],
  ["#/v/…/live 참가자 편성", ["ViewerLive"]],
  ["#/demo 예시 모임", ["Demo"]],
  ["#/privacy 개인정보 처리방침", ["Privacy"]],
  ["로그인 창", ["Login"]],
];
for (const [label, prefixes] of routes) {
  const missing = prefixes.filter((p) => chunk(p) === undefined);
  if (missing.length > 0) {
    // 화면 조각 이름이 바뀌었거나(lazyScreens.ts) 분할이 풀렸다. 크기 검사를 조용히 건너뛰지 않게 실패로 본다.
    console.error(`  ${label.padEnd(34)} 실패: 조각을 찾지 못함(${missing.join(", ")}-*.js)`);
    failed = true;
    continue;
  }
  console.log(`  ${label.padEnd(34)} ${both(new Set([...initial, ...closure(prefixes.map(chunk))]))}`);
}

// 주소 미리 받기 대응표: 가리키는 파일이 모두 있어야 한다(없는 파일이면 브라우저가 헛요청을 한다).
const preloadFile = files.find((f) => f.startsWith(`${ROUTE_PRELOAD_NAME}-`));
if (!preloadFile || !entries.includes(preloadFile)) {
  fail(`주소 미리 받기 파일(${ROUTE_PRELOAD_NAME}-*.js)이 없거나 index.html이 부르지 않아요(vite.config.ts routePreload).`);
} else {
  const line = source.get(preloadFile).toString("utf8").match(/const ROUTE_CHUNKS = (\{.*\});/);
  const table = line ? JSON.parse(line[1]) : null;
  if (!table) fail(`${preloadFile}에서 ROUTE_CHUNKS를 읽지 못했어요.`);
  else {
    for (const [key, list] of Object.entries(table)) {
      const absent = list.filter((f) => !source.has(f));
      if (list.length === 0 || absent.length > 0) fail(`주소 미리 받기 ${key}: 빈 목록이거나 없는 파일(${absent.join(", ")})`);
    }
    console.log(`주소 미리 받기: ${Object.entries(table).map(([k, l]) => `${k} ${l.length}개`).join(", ")}`);
  }
}

// 검색 노출(scripts/search-index-plugin.mjs): 운영 빌드는 noindex 메타·X-Robots-Tag 없음 + sitemap.xml, 그 밖은 셋 다 반대.
// robots.txt는 어느 빌드든 전체를 막지 않는다(막으면 검색엔진이 noindex를 읽지 못한다).
{
  const noindex = /<meta name="robots" content="noindex"/.test(html);
  const header = /X-Robots-Tag: noindex/.test(readFileSync(join(DIST, "_headers"), "utf8"));
  const robots = existsSync(join(DIST, "robots.txt")) ? readFileSync(join(DIST, "robots.txt"), "utf8") : null;
  const sitemap = existsSync(join(DIST, "sitemap.xml"));
  if (robots === null) fail("robots.txt가 없어요(vite.config.ts searchIndex).");
  else if (/^Disallow: \/$/m.test(robots)) fail("robots.txt가 전체를 막고 있어요. 검색엔진이 noindex를 읽지 못해요.");
  else if (noindex !== header || noindex === sitemap) {
    fail(`검색 노출 설정이 엇갈려요: noindex 메타 ${noindex}, X-Robots-Tag ${header}, sitemap.xml ${sitemap}`);
  } else console.log(`검색 노출: ${noindex ? "막힘(운영이 아닌 빌드)" : "열림(운영 빌드)"}`);
}

const largest = files.map((f) => [f, raw(f)]).sort((a, b) => b[1] - a[1]);
console.log("가장 큰 JS 5개(압축 전):");
for (const [f, n] of largest.slice(0, 5)) console.log(`  ${f.padEnd(40)} ${kb(n)}`);
const cssFiles = all.filter((f) => f.endsWith(".css"));
console.log(`CSS 합계(상한 없음, 첫 화면 전체 예산에는 포함): ${both(new Set(cssFiles))} (${cssFiles.length}개 파일)`);

if (largest[0][1] > MAX_CHUNK_KB * 1000) fail(`가장 큰 JS ${largest[0][0]}이(가) ${kb(largest[0][1])}로 상한 ${MAX_CHUNK_KB}KB를 넘었어요.`);
let explain = false;
if (sum(ours, br) > MAX_SHELL_BR_KB * 1000) {
  fail(`첫 화면 우리 코드가 brotli ${kb(sum(ours, br))}로 예산 ${MAX_SHELL_BR_KB}KB를 넘었어요.`);
  explain = true;
}
if (sum(initialAll, br) > MAX_INITIAL_BR_KB * 1000) {
  fail(`첫 화면 전체가 brotli ${kb(sum(initialAll, br))}로 예산 ${MAX_INITIAL_BR_KB}KB를 넘었어요.`);
  explain = true;
}

// 껍데기 허용 목록: 첫 화면 파일의 소스맵에 나오는 우리 원본(src/…)이 모두 목록에 있어야 한다.
const bySource = sourceSizes([...initial]);
const outsiders = [...bySource.keys()].filter((s) => s.startsWith("src/") && !(s in SHELL_MODULES));
if (outsiders.length > 0) {
  const parents = shellImportGraph();
  fail("첫 화면에 허용 목록(scripts/shell-modules.mjs) 밖의 모듈이 들어왔어요:");
  for (const s of outsiders.sort((a, b) => bySource.get(b) - bySource.get(a))) {
    console.error(`  ${s} ${kb(bySource.get(s))}  ← ${pathTo(parents, s)}`);
  }
  explain = true;
}
const listed = Object.keys(SHELL_MODULES).filter((s) => !bySource.has(s));
if (listed.length > 0) console.log(`참고: 허용 목록에 있지만 첫 화면에 없는 모듈(지워도 됨): ${listed.join(", ")}`);

if (explain) {
  console.error("첫 화면 원본 파일별 크기(압축 전, 상위 15개):");
  const top = [...bySource].sort((a, b) => b[1] - a[1]);
  for (const [s, n] of top.slice(0, 15)) console.error(`  ${kb(n).padStart(8)}  ${s}`);
}

if (failed) process.exit(1);
console.log(
  `통과: 첫 화면 우리 코드 brotli ≤ ${MAX_SHELL_BR_KB}KB, 첫 화면 전체 brotli ≤ ${MAX_INITIAL_BR_KB}KB, ` +
    `허용 목록 밖 모듈 없음, 가장 큰 JS ≤ ${MAX_CHUNK_KB}KB`,
);

/**
 * 소스맵으로 생성 코드의 바이트를 원본 파일별로 합친다(새 라이브러리 없이 mappings를 직접 푼다).
 * 원본 경로는 저장소 기준(src/web/App.tsx), 라이브러리는 node_modules/<패키지>로 묶는다. 소스맵이 없는 파일은 알리고 넘어간다.
 */
function sourceSizes(list) {
  const sizes = new Map();
  const B64 = new Map([..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"].map((c, i) => [c, i]));
  for (const file of list) {
    const mapPath = join(ASSETS, `${file}.map`);
    if (!existsSync(mapPath)) {
      // 주소 미리 받기 파일은 빌드가 직접 만든 글이고, rolldown 런타임도 소스맵이 없다.
      // 우리 코드 JS인데 소스맵이 없으면 허용 목록 검사가 그 파일을 못 보고 조용히 통과하므로 실패로 둔다
      // (vite.config.ts build.sourcemap을 끄거나 .map을 지우는 배포 단계가 생기면 여기서 걸린다).
      if (file.endsWith(".js") && !file.startsWith(`${ROUTE_PRELOAD_NAME}-`) && !NOT_OURS.test(file)) {
        fail(`${file}의 소스맵(.map)이 없어 허용 목록 검사를 할 수 없어요. vite.config.ts build.sourcemap을 확인해 주세요.`);
      }
      continue;
    }
    const map = JSON.parse(readFileSync(mapPath, "utf8"));
    const names = map.sources.map((s) => {
      const repoPath = relative(process.cwd(), resolve(ASSETS, map.sourceRoot ?? "", s)).replaceAll("\\", "/");
      const lib = repoPath.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
      return lib ? `node_modules/${lib[1]}` : repoPath;
    });
    const lines = source.get(file).toString("utf8").split("\n");
    let src = 0;
    const add = (name, text) => sizes.set(name, (sizes.get(name) ?? 0) + Buffer.byteLength(text));
    map.mappings.split(";").forEach((segments, lineIndex) => {
      const line = lines[lineIndex] ?? "";
      let col = 0;
      let open = null; // [시작 열, 원본 이름]
      for (const segment of segments.split(",")) {
        if (segment === "") continue;
        const nums = [];
        let value = 0;
        let shift = 0;
        for (const ch of segment) {
          const digit = B64.get(ch);
          value += (digit & 31) << shift;
          if (digit & 32) shift += 5;
          else {
            nums.push(value & 1 ? -(value >>> 1) : value >>> 1);
            value = 0;
            shift = 0;
          }
        }
        col += nums[0];
        if (open) add(open[1], line.slice(open[0], col));
        open = null;
        if (nums.length >= 4) {
          src += nums[1];
          open = [col, names[src]];
        }
      }
      if (open) add(open[1], line.slice(open[0]));
    });
  }
  return sizes;
}

/**
 * 진입(src/web/main.tsx)부터 우리 원본 파일의 정적 import를 따라간 그래프. 값: 그 파일을 처음 부른 파일.
 * 허용 목록 밖 모듈이 "어느 import 때문에" 들어왔는지 보여 주는 데만 쓴다(정규식으로 읽는 근사치).
 * import type과 이름이 모두 type인 import는 빌드에서 사라지므로 따라가지 않는다.
 */
function shellImportGraph() {
  const start = "src/web/main.tsx";
  const parents = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift();
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const specs = [];
    for (const m of text.matchAll(/^(?:import|export)\s+([^;]*?)\s+from\s+["']([^"']+)["']/gm)) {
      const clause = m[1].trim();
      if (clause.startsWith("type ")) continue;
      const named = clause.match(/\{([^}]*)\}/);
      const items = named ? named[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
      const defaultOrStar = clause.replace(/\{[^}]*\}/, "").replace(/,/g, "").trim();
      if (!defaultOrStar && items.length > 0 && items.every((x) => x.startsWith("type "))) continue;
      specs.push(m[2]);
    }
    for (const m of text.matchAll(/^import\s+["']([^"']+)["']/gm)) specs.push(m[1]);
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      const base = relative(process.cwd(), resolve(file, "..", spec)).replaceAll("\\", "/");
      const found = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => /\.tsx?$/.test(p) && existsSync(p));
      if (found && !parents.has(found)) {
        parents.set(found, file);
        queue.push(found);
      }
    }
  }
  return parents;
}

function pathTo(parents, target) {
  if (!parents.has(target)) return "정적 import 경로를 찾지 못함(소스맵에는 있음)";
  const chain = [];
  for (let at = target; at; at = parents.get(at)) chain.unshift(at.replace(/^src\/(web\/)?/, ""));
  return chain.join(" → ");
}
