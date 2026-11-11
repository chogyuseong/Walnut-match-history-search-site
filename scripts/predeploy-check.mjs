// 배포 전 점검(npm run deploy:staging / deploy:production이 먼저 돌린다). 문제가 있으면 이유를 적고 exit 1.
//   node scripts/predeploy-check.mjs staging|production [--skip-build]
// (가) wrangler.jsonc의 env.<환경> 구역에 자리 표시값(REPLACE-WITH-…, [채워야 함])이 남아 있는지.
//     같은 구역에서 AUTH_MODE가 "oauth"인지, DEPLOY_ENV가 "production"인지도 본다(가짜 로그인 설정이 올라가는 것을 막는다).
// (나) production이면 src/web/legal.ts의 "[채워야 함]"(처리방침 운영자 이름·연락처·보호책임자·시행일)이 남아 있는지.
// (다) dist/web가 없거나 화면 소스(src/web·src/shared·public·vite.config.ts)보다 오래됐는지(빌드 누락).
//     npm 스크립트는 이 점검 바로 뒤에 vite build를 하므로 --skip-build로 (다)를 건너뛴다.
//     wrangler deploy를 손으로 할 때는 플래그 없이 돌려 빌드가 최신인지 함께 본다.
// (라) styles.css에 디자인 규칙(맨 위 CLAUDE.md) 밖의 간격·글자·반경·그라데이션 등이 있는지(scripts/design-audit.mjs).
// 경고(실패는 아님): SITE_ADMIN_ACCOUNT_IDS가 비어 있으면 사이트 현황(#/admin)을 아무도 못 본다.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ENVS = ["staging", "production"];
const envName = process.argv[2];
const skipBuild = process.argv.includes("--skip-build");
if (!ENVS.includes(envName)) {
  console.error(`사용법: node scripts/predeploy-check.mjs ${ENVS.join("|")} [--skip-build]`);
  process.exit(1);
}

const problems = [];
const warnings = [];

/** JSONC에서 주석과 꼬리 쉼표를 걷어 낸다(문자열 안의 // 는 그대로 둔다). */
function stripJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** 객체 안의 모든 문자열 값을 [경로, 값]으로. */
function* strings(value, path) {
  if (typeof value === "string") yield [path, value];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${path}[${i}]`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) yield* strings(v, `${path}.${k}`);
}

// (가) wrangler.jsonc
let config;
try {
  config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));
} catch (error) {
  console.error(`wrangler.jsonc를 읽지 못했어요: ${error.message}`);
  process.exit(1);
}
const section = config.env?.[envName];
if (!section) {
  problems.push(`wrangler.jsonc에 env.${envName} 구역이 없어요.`);
} else {
  for (const [path, value] of strings(section, `env.${envName}`)) {
    if (/REPLACE-WITH|\[채워야 함\]/.test(value)) problems.push(`wrangler.jsonc ${path}가 자리 표시값이에요: "${value}"`);
  }
  const vars = section.vars ?? {};
  if (vars.AUTH_MODE !== "oauth") problems.push(`wrangler.jsonc env.${envName}.vars.AUTH_MODE가 "oauth"가 아니에요: ${JSON.stringify(vars.AUTH_MODE)}`);
  if (vars.DEPLOY_ENV !== "production") {
    problems.push(`wrangler.jsonc env.${envName}.vars.DEPLOY_ENV가 "production"이 아니에요(운영 안전장치): ${JSON.stringify(vars.DEPLOY_ENV)}`);
  }
  // 비밀값은 vars(저장소에 남는 값)가 아니라 wrangler secret으로 넣는다. 로컬 전용 PASSWORD_PEPPER는 맨 위 vars에만 있다.
  for (const secret of ["SESSION_SECRET", "PASSWORD_PEPPER"]) {
    if (secret in vars) problems.push(`wrangler.jsonc env.${envName}.vars에 비밀값 ${secret}이 있어요. 지우고 wrangler secret put으로 넣어 주세요.`);
  }
  if (!vars.SITE_ADMIN_ACCOUNT_IDS) {
    warnings.push(`env.${envName}.vars.SITE_ADMIN_ACCOUNT_IDS가 비어 있어 사이트 현황(#/admin)을 아무도 못 봐요(docs/배포안내.md 14-1절).`);
  }
}

// (나) 처리방침(production만)
if (envName === "production") {
  const legal = readFileSync("src/web/legal.ts", "utf8");
  // 값 자리("이름: "[채워야 함]"")만 센다. 주석과 PRIVACY_IS_DRAFT 판별식에 있는 같은 글자는 세지 않는다.
  const unfilled = [...legal.matchAll(/^\s*(\w+):\s*["'`][^"'`\n]*\[채워야 함\]/gm)].map((m) => m[1]);
  if (unfilled.length > 0) problems.push(`src/web/legal.ts에 [채워야 함]이 남아 있어요: ${unfilled.join(", ")} (docs/배포안내.md 10절)`);
}

// (다) 빌드 결과
/** 폴더 안 파일들의 가장 늦은 수정 시각(ms). */
function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const name of readdirSync(path, { recursive: true })) {
    const s = statSync(join(path, name));
    if (s.isFile() && s.mtimeMs > newest) newest = s.mtimeMs;
  }
  return newest;
}
if (!skipBuild) {
  const builtIndex = join("dist", "web", "index.html");
  if (!existsSync(builtIndex)) {
    problems.push("dist/web/index.html이 없어요. 먼저 npm run build를 돌려 주세요.");
  } else {
    const builtAt = statSync(builtIndex).mtimeMs;
    const sources = ["src/web", "src/shared", "public", "vite.config.ts"];
    const stale = sources.filter((p) => newestMtime(p) > builtAt);
    if (stale.length > 0) problems.push(`dist/web가 ${stale.join(", ")}보다 오래됐어요. npm run build를 다시 돌려 주세요.`);
  }
}

// (라) 디자인 규칙. 감사 스크립트는 혼자서도 돌리므로 따로 띄워 종료 코드만 본다.
const audit = spawnSync(process.execPath, ["scripts/design-audit.mjs", "--brief"], { encoding: "utf8" });
if (audit.status !== 0) {
  const counts = audit.stdout
    .split("\n")
    .filter((line) => /: [1-9]\d*$/.test(line) && !line.startsWith("50%") && !line.startsWith("예외"))
    .join(", ");
  problems.push(`styles.css에 디자인 규칙 밖 값이 있어요(${counts || audit.stderr.trim()}). npm run audit:design으로 줄 번호를 확인해 주세요.`);
}

for (const w of warnings) console.warn(`경고: ${w}`);
if (problems.length > 0) {
  console.error(`배포 전 점검 실패(${envName}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`배포 전 점검 통과(${envName}${skipBuild ? ", 빌드 확인은 건너뜀" : ""}).`);
// 이 점검은 Cloudflare에 등록된 비밀값을 보지 못한다. 빠지면 배포 뒤 모든 API가 503(CONFIG_ERROR)이다.
console.log(`확인: 비밀값 SESSION_SECRET·PASSWORD_PEPPER를 --env ${envName}에 등록했는지(docs/배포안내.md 6절).`);
