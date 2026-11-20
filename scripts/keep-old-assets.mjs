// 배포 직전에 지금 떠 있는 사이트의 화면 조각(/assets/*)을 새 빌드에 함께 넣어, 옛 파일이 한 배포 동안 살아 있게 한다.
//   node scripts/keep-old-assets.mjs staging|production   (npm run deploy:* 가 vite build 다음에 돌린다)
//
// 왜: 조각 이름에는 내용 해시가 붙고, 배포하면 /assets/ 전체가 새 빌드 것으로 바뀐다. 배포 직후 한동안 옛 index.html을 받은
// 사람(열어 둔 탭, 아직 새 판이 안 퍼진 곳)은 옛 이름으로 조각을 요청한다. 그 파일이 없으면 not_found_handling
// (single-page-application) 때문에 index.html이 200 text/html로 와서 화면이 "문제가 생겼어요"가 됐다
// (2026-11-20~21 배포 세 번 연속, 배포-이어하기.txt). chunkReload.ts의 새로 고침 한 번은 그 뒤의 안전망이다.
//
// 어떻게: 빌드마다 dist/web/asset-list.json에 "이 빌드의 /assets/ 파일"만 적는다. 다음 배포 때 그 목록을 사이트에서 받아,
// 새 빌드에 없는 파일을 내려받아 dist/web/assets에 더한다. 목록에는 넣은 옛 파일을 적지 않으므로 옛 파일은 딱 한 배포만 남는다.
// 무엇이든 실패하면(첫 배포라 목록이 없음, 네트워크) 경고만 하고 배포는 그대로 진행한다. 남기기는 덤이라 배포를 막지 않는다.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readWranglerConfig } from "./wranglerConfig.mjs";

const ENVS = ["staging", "production"];
const ASSETS_DIR = join("dist", "web", "assets");
const LIST_FILE = join("dist", "web", "asset-list.json");
/** 한 번에 내려받는 파일 수. 조각이 100개 남짓이라 이 정도면 몇 초 안에 끝난다. */
const PARALLEL = 8;
const FETCH_TIMEOUT_MS = 15_000;
/** 목록에서 받아들이는 파일 이름. 하위 폴더나 ../ 같은 것은 받지 않는다(목록은 사이트에서 오는 글이다). */
const SAFE_NAME = /^[\w.-]+$/;

const envName = process.argv[2];
if (!ENVS.includes(envName)) {
  console.error(`사용법: node scripts/keep-old-assets.mjs ${ENVS.join("|")}`);
  process.exit(1);
}
if (!existsSync(ASSETS_DIR)) {
  console.error(`${ASSETS_DIR}가 없어요. vite build 다음에 돌려 주세요.`);
  process.exit(1);
}

// 소스맵(.map)은 .assetsignore로 올리지 않으므로 목록에도 넣지 않는다.
const own = readdirSync(ASSETS_DIR).filter((name) => !name.endsWith(".map"));
const ownSet = new Set(own);
writeFileSync(LIST_FILE, JSON.stringify({ files: own }), "utf8");

const origin = readWranglerConfig().env?.[envName]?.vars?.PUBLIC_ORIGIN;
if (!origin) {
  console.warn(`경고: wrangler.jsonc env.${envName}.vars.PUBLIC_ORIGIN이 없어 옛 자산을 남기지 못해요.`);
  process.exit(0);
}

/** 받은 응답이 진짜 파일인지. 없는 주소는 index.html(200, text/html)이 오므로 상태 코드만으로는 모른다. */
function isRealFile(response) {
  return response.ok && !(response.headers.get("content-type") ?? "").includes("text/html");
}

async function fetchWithTimeout(url) {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
}

let previous;
try {
  const response = await fetchWithTimeout(`${origin}/asset-list.json`);
  if (!isRealFile(response)) throw new Error(`목록 응답 ${response.status} ${response.headers.get("content-type")}`);
  previous = (await response.json()).files;
  if (!Array.isArray(previous)) throw new Error("목록 모양이 달라요");
} catch (error) {
  console.warn(`경고: ${origin}/asset-list.json을 받지 못해 옛 자산을 남기지 않아요(${error.message}). 첫 배포면 정상이에요.`);
  process.exit(0);
}

const missing = previous.filter((name) => typeof name === "string" && SAFE_NAME.test(name) && !ownSet.has(name));
let kept = 0;
const failed = [];
for (let i = 0; i < missing.length; i += PARALLEL) {
  await Promise.all(
    missing.slice(i, i + PARALLEL).map(async (name) => {
      try {
        const response = await fetchWithTimeout(`${origin}/assets/${name}`);
        if (!isRealFile(response)) throw new Error(String(response.status));
        writeFileSync(join(ASSETS_DIR, name), Buffer.from(await response.arrayBuffer()));
        kept += 1;
      } catch {
        failed.push(name);
      }
    }),
  );
}
console.log(`옛 자산 남기기(${envName}): 이번 빌드 ${own.length}개 + 지난 배포에서 ${kept}개를 함께 올려요.`);
if (failed.length > 0) console.warn(`경고: 옛 자산 ${failed.length}개는 받지 못했어요: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? " …" : ""}`);
