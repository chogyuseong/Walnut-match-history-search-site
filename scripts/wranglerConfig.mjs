// wrangler.jsonc 읽기. 배포 전 점검(predeploy-check.mjs)과 옛 자산 남기기(keep-old-assets.mjs)가 같이 쓴다.
import { readFileSync } from "node:fs";

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

/** wrangler.jsonc 전체. 읽거나 해석하지 못하면 예외를 그대로 던진다(부르는 쪽이 이유를 적고 끝낸다). */
export function readWranglerConfig() {
  return JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8")));
}
