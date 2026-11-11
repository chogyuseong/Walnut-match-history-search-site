// styles.css에서 CLAUDE.md 디자인 규칙 밖의 값을 세고 줄 번호를 보여 준다. 하나라도 있으면 exit 1.
//   npm run audit:design            항목별 개수 + 값별 줄 번호
//   npm run audit:design -- --brief 항목별 개수만
// 배포 전 점검(scripts/predeploy-check.mjs)과 CI(check 작업)가 이 스크립트를 부른다. 규칙 밖 값을 꼭 써야 하면
// 값을 숨기지 말고 CLAUDE.md에 예외를 먼저 적은 뒤 아래 EXCEPTIONS에 이유와 함께 더한다.
// 색은 여기서 보지 않는다. 대비는 test/theme-contrast.test.ts가 보고, 장식색인지는 사람이 판단한다.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS_PATH = fileURLToPath(new URL("../src/web/styles.css", import.meta.url));
const brief = process.argv.includes("--brief");

/**
 * CLAUDE.md가 명시한 예외. 선택자에 이 글자가 들어 있으면 해당 항목에서 빼고 따로 센다.
 * 예외를 늘릴 때는 CLAUDE.md에 같은 예외가 적혀 있는지 먼저 확인한다.
 */
const EXCEPTIONS = [
  // 5절: 카카오 로그인 버튼은 카카오 가이드의 반경 12px을 따른다.
  { rule: "radius", selector: ".login-kakao", why: "카카오 버튼 반경 12px(5절 예외)" },
  // 1절: 데이터 좌표를 옮기는 translate는 정렬 보정이 아니다. 레이더 축 글자, MMR 기준선 글자.
  { rule: "translate", selector: ".radar-label", why: "레이더 좌표에 글자 중심 맞춤(데이터 좌표)" },
  { rule: "translate", selector: ".mmr-axis-start", why: "기준선 위치(--at)에 맞춘 글자(데이터 좌표)" },
  // 6절: 키보드 포커스 표시는 2px outline이 규칙 값이다.
  { rule: "thick-line", selector: ":focus-visible", why: "키보드 포커스 2px outline(6절)" },
  // 1절: 폭은 간격 척도 대상이 아니다. 머리 칸 눈금을 아래 줄의 막대 칸에 맞추려고 옆 칸 폭(순위 2rem, 펼치기 44px)만큼 띄운다.
  { rule: "spacing", selector: ".mmr-head .c-bar", why: "줄의 순위·펼치기 칸 폭 + 틈에 맞춘 눈금 위치(칸 폭)" },
  // 4절은 장식·제목 전용 글꼴을 막는다. 복구 코드는 0과 O, 1과 l을 가려 읽어야 해서 기기에 있는 고정폭 글꼴을 쓴다(내려받지 않음).
  { rule: "font-family", selector: ".recovery-code code", why: "복구 코드 글자 구별용 시스템 고정폭 글꼴" },
];
// 50% 반경은 원(아바타·상태 점·원형 그래프)에만 허용된다(3절). 원인지는 기계가 못 가리므로 50%는 통과시키고
// 개수만 따로 보여 준다. 일반 상자에 50%가 붙어 있지 않은지는 사람이 확인한다.
// 라인 5색(--pos-*)·승패 색 같은 색 예외는 색을 세지 않는 이 스크립트와 관계없다.

const SPACE_OK = new Set(["0", "4px", "8px", "12px", "16px", "24px", "32px", "48px", "64px", "auto"]);
const FONT_SIZE_OK = new Set(["0.75rem", "0.875rem", "1rem", "1.25rem", "1.5rem", "2rem", "inherit"]);
const FONT_WEIGHT_OK = new Set(["400", "500", "600", "normal", "inherit"]);
const RADIUS_OK = new Set(["0", "4px", "6px", "8px", "50%", "inherit"]);
const RADIUS_VAR_OK = /^var\(--radius-(badge|control|panel)\)$/;
// transition은 색 바꿈에만 건다(6절). transform·opacity 같은 속성이 끼면 위반이다.
const TRANSITION_PROP_OK = new Set(["background-color", "border-color", "color"]);
const DIALOG_SHADOW = "0 8px 24px rgb(0 0 0 / 0.12)";
// 반응형 기준(2절)은 768·1200 둘이다(max-width는 그 1px 아래 767·1199). 나머지는 좁은 폰에서 팀 상자·경기 카드·순위 줄이
// 넘치지 않게 남긴 부품 보정 값이라, 여기 없는 폭을 새로 쓰려면 먼저 768·1200으로 풀 수 없는지 본다.
// @container 폭은 부품 자신의 폭이라 세지 않는다.
const MEDIA_WIDTH_OK = new Set([767, 768, 1199, 1200, 359, 419, 479, 480, 481, 599]);
// 글꼴은 Pretendard + 시스템 대체 글꼴 하나(4절, :root의 --ih-font-sans).
const FONT_FAMILY_OK = new Set(["var(--ih-font-sans)", "inherit"]);

/** 주석을 같은 길이의 공백으로 바꾼다(줄 번호를 그대로 두려고). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, " "));
}

/** 선언마다 { line, selector, prop, value, important }. 중괄호 깊이를 따라가며 바로 바깥 블록의 선택자를 붙인다. */
function declarations(text) {
  const out = [];
  const stack = [];
  let line = 1;
  let buf = "";
  let bufLine = 1;
  for (const ch of text) {
    if (ch === "\n") line++;
    if (ch === "{") {
      stack.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
    } else if (ch === "}") {
      flush();
      stack.pop();
      buf = "";
    } else if (ch === ";") {
      flush();
      buf = "";
    } else {
      if (buf.trim() === "" && !/\s/.test(ch)) bufLine = line;
      buf += ch;
    }
  }
  function flush() {
    const m = buf.match(/^\s*([-\w]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) {
      const important = /\s*!important$/.test(m[2]);
      out.push({ line: bufLine, selector: stack.at(-1) ?? "", prop: m[1], value: m[2].replace(/\s*!important$/, ""), important });
    }
  }
  return out;
}

/** 괄호 안 공백은 나누지 않고 값을 낱말로 나눈다. `calc(4px + env(x)) 8px` → 두 개. */
function words(value) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function spaceWordOk(w) {
  // --page-gutter는 폭에 따라 --space-4·5·6 중 하나를 가리키는 본문 좌우 여백이다(styles.css :root).
  // --bleed-inline은 창 폭 전체로 그은 줄 안 글자를 본문 정렬선(--page-gutter)에 맞추는 여백이다(--page-gutter + 남는 폭의 반).
  if (SPACE_OK.has(w) || /^var\(--space-\d\)$/.test(w) || w === "var(--page-gutter)" || w === "var(--bleed-inline)" || /^env\(safe-area-inset-[a-z]+\)$/.test(w)) return true;
  // 안전 영역을 더하는 calc: env()를 빼고 남은 px가 모두 척도 값이면 통과.
  if (/^(calc|max)\(/.test(w) && w.includes("env(safe-area")) {
    const rest = w.replace(/env\([^)]*\)/g, "").match(/-?[\d.]+px/g) ?? [];
    return rest.every((px) => SPACE_OK.has(px));
  }
  return false;
}

const durationsOf = (value) => value.match(/(?<![\w-])[\d.]+m?s\b/g) ?? [];
const isMotionOk = (d) => d === "120ms" || d === "0.12s" || d === "0s" || d === "0ms";

const css = stripComments(readFileSync(CSS_PATH, "utf8"));
const decls = declarations(css);

/** 항목 이름 → 값 → 줄 번호 목록 */
const found = new Map();
const excused = [];
let circleRadius = 0;
function hit(rule, value, line) {
  if (!found.has(rule)) found.set(rule, new Map());
  const byValue = found.get(rule);
  if (!byValue.has(value)) byValue.set(value, []);
  byValue.get(value).push(line);
}
function excuse(rule, d) {
  const e = EXCEPTIONS.find((x) => x.rule === rule && d.selector.includes(x.selector));
  if (e) excused.push(`${d.line}: ${rule} ${d.value} — ${e.why}`);
  return Boolean(e);
}

/** 주석을 지운 글에서 위치 → 줄 번호. */
const lineAt = (index) => css.slice(0, index).split("\n").length;
for (const m of css.matchAll(/@media[^{]*/g)) {
  for (const w of m[0].matchAll(/(min|max)-width\s*:\s*(\d+)px/g)) {
    if (!MEDIA_WIDTH_OK.has(Number(w[2]))) hit("media-width", `${w[1]}-width: ${w[2]}px`, lineAt(m.index));
  }
}
// 글꼴 추가(4절): 웹 글꼴 선언이나 외부 CSS 불러오기.
for (const m of css.matchAll(/@(font-face|import)\b/g)) hit("font-family", `@${m[1]}`, lineAt(m.index));

for (const d of decls) {
  const { prop, value, line } = d;
  // !important는 순서·명시도 대신 힘으로 덮는 것이라 다음 사람이 원인을 찾기 어렵다. 지금 0개라 예외 없이 막는다.
  if (d.important) hit("important", prop, line);
  if (prop === "font-family" && !FONT_FAMILY_OK.has(value) && !excuse("font-family", d)) hit("font-family", value, line);
  if (/^(margin|padding)(-[a-z-]+)?$|^(row-|column-)?gap$/.test(prop)) {
    for (const w of words(value)) {
      if (prop.startsWith("margin") && w.startsWith("-")) hit("negative-margin", w, line);
      else if (!spaceWordOk(w) && !excuse("spacing", d)) hit("spacing", w, line);
    }
  } else if (prop === "font-size") {
    if (!FONT_SIZE_OK.has(value) && !/^var\(--text-[a-z]+\)$/.test(value)) hit("font-size", value, line);
  } else if (prop === "font-weight") {
    if (!FONT_WEIGHT_OK.has(value)) hit("font-weight", value, line);
  } else if (/^border(-[a-z]+)*-radius$/.test(prop)) {
    for (const w of words(value)) {
      if (w === "50%") circleRadius++;
      if (RADIUS_OK.has(w) || RADIUS_VAR_OK.test(w)) continue;
      if (!excuse("radius", d)) hit("radius", w, line);
    }
  } else if (prop === "box-shadow") {
    if (value !== "none" && value !== DIALOG_SHADOW) hit("box-shadow", value, line);
  } else if (prop === "text-shadow") {
    if (value !== "none") hit("text-shadow", value, line);
  } else if (prop === "backdrop-filter" || prop === "-webkit-backdrop-filter") {
    if (value !== "none") hit("backdrop-filter", `${prop}: ${value}`, line);
  } else if (prop === "transition" || prop === "transition-duration") {
    if (value === "none") continue;
    for (const dur of durationsOf(value)) if (!isMotionOk(dur)) hit("transition", dur, line);
    if (prop === "transition")
      for (const part of value.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (!TRANSITION_PROP_OK.has(name)) hit("transition", name, line);
      }
  } else if (prop === "animation" || prop === "animation-name") {
    // 자동 재생 장식 애니메이션 금지(6절). 상태를 알리는 로딩 표시가 생기면 EXCEPTIONS에 이유와 함께 넣는다.
    if (value !== "none") hit("animation", value, line);
  } else if (prop === "transform" && /translate/.test(value)) {
    // @keyframes 안의 translate는 자동 애니메이션 쪽 문제라 여기서 세지 않는다(2단계에서 애니메이션째 지운다).
    if (/^(from|to|\d+%)/.test(d.selector)) continue;
    if (!excuse("translate", d)) hit("translate", value, line);
  }
  // 기본 테두리는 1px(3절). SVG stroke-width는 데이터 선이라 보지 않는다.
  if (/^(border|outline)(-(top|right|bottom|left|width|block|inline))*$/.test(prop)) {
    const thick = words(value).find((w) => /^([2-9]|\d{2,})(\.\d+)?px$/.test(w) || w === "thick" || w === "medium");
    if (thick && !excuse("thick-line", d)) hit("thick-line", `${prop}: ${thick}`, line);
  }
  if (/(linear|radial|conic)-gradient\(/.test(value)) hit("gradient", value.match(/[\w-]*gradient/)[0], line);
}

const ORDER = [
  // 간격은 선언 수가 아니라 값 수다(`padding: 6px 10px`은 2).
  ["spacing", "간격(margin·padding·gap) 값"],
  ["negative-margin", "음수 여백"],
  ["font-size", "글자 크기"],
  ["font-weight", "굵기"],
  ["radius", "반경"],
  ["gradient", "그라데이션"],
  ["box-shadow", "box-shadow"],
  ["text-shadow", "text-shadow"],
  ["backdrop-filter", "backdrop-filter"],
  ["transition", "transition(시간·속성)"],
  ["animation", "animation"],
  ["thick-line", "2px 이상 테두리·외곽선"],
  ["translate", "translate 보정"],
  ["media-width", "반응형 기준 밖 @media 폭"],
  ["font-family", "글꼴 추가"],
  ["important", "!important"],
];

let total = 0;
console.log(`design-audit: ${CSS_PATH.split(/[\\/]/).slice(-3).join("/")}, 선언 ${decls.length}개`);
for (const [key, label] of ORDER) {
  const byValue = found.get(key) ?? new Map();
  const count = [...byValue.values()].reduce((n, lines) => n + lines.length, 0);
  total += count;
  console.log(`${label}: ${count}`);
  if (brief) continue;
  const sorted = [...byValue.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [value, lines] of sorted) console.log(`  ${value} ×${lines.length}  줄 ${lines.join(" ")}`);
}
console.log(`합계: ${total}`);
console.log(`50% 반경(원 용도인지 사람이 확인): ${circleRadius}`);
console.log(`예외로 뺀 것: ${excused.length}`);
if (!brief) for (const e of excused) console.log(`  ${e}`);

if (total > 0) {
  console.error(`디자인 규칙 밖 값 ${total}개. 위 줄을 고치거나, 꼭 필요한 예외면 CLAUDE.md와 EXCEPTIONS에 이유를 적는다.`);
  process.exit(1);
}
