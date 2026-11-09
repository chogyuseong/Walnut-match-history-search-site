import { describe, expect, it } from "vitest";
import css from "../src/web/styles.css?raw";

// 세 테마(dark·deeplol·light)의 색 토큰이 WCAG 대비 기준을 지키는지 styles.css를 직접 읽어 검사한다.
// 글자는 바탕 대비 4.5:1, 승률 막대는 막대 바탕(--viz-track) 대비 3:1. 반투명(rgba) 테두리·틴트는 검사하지 않는다.
// deeplol은 dark 토큰을 물려받고 바뀐 값만 덮어쓴다.

/** 선택자 묶음(예: `:root,\n[data-theme="dark"]`)으로 시작하는 블록 안의 `--이름: #hex;` 선언을 모두 모은다. */
function tokensOf(selectorPattern: RegExp): Map<string, string> {
  const out = new Map<string, string>();
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of css.matchAll(blockRe)) {
    const selector = match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selectorPattern.test(selector)) continue;
    for (const decl of match[2]!.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) out.set(decl[1]!, decl[2]!.toLowerCase());
  }
  return out;
}

const darkSel = /^:root,\s*\[data-theme="dark"\]$/;
// 라인 색·신호 색은 dark·deeplol이 함께 쓰는 블록(`:root, [data-theme="dark"], [data-theme="deeplol"]`)에 있다.
const sharedDark = tokensOf(/^:root,\s*\[data-theme="dark"\],\s*\[data-theme="deeplol"\]$/);
const dark = new Map([...tokensOf(darkSel), ...sharedDark]);
const deeplol = new Map([...dark, ...tokensOf(/^\[data-theme="deeplol"\]$/)]);
const light = new Map([...dark, ...tokensOf(/^\[data-theme="light"\]$/)]);
// 막대 바탕: .viz-root(다크·바이올렛)과 [data-theme="light"] .viz-root.
const vizDark = tokensOf(/^\.viz-root$/);
const vizLight = new Map([...vizDark, ...tokensOf(/^\[data-theme="light"\] \.viz-root$/)]);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HEAT = ["h4", "h3", "h2", "h1", "0", "0h", "0l", "l1", "l2", "l3", "l4"];
const THEMES = [
  { name: "dark", t: dark, viz: vizDark },
  { name: "deeplol", t: deeplol, viz: vizDark },
  { name: "light", t: light, viz: vizLight },
] as const;

describe("테마 색 대비", () => {
  it("토큰을 읽었다", () => {
    expect(dark.get("--ih-bg-canvas")).toBe("#121316");
    expect(deeplol.get("--ih-bg-canvas")).toBe("#131219");
    expect(light.get("--ih-bg-canvas")).toBe("#f5f3ee");
    expect(vizDark.get("--viz-track")).toMatch(/^#/);
    expect(vizLight.get("--viz-track")).toMatch(/^#/);
  });

  for (const { name, t, viz } of THEMES) {
    describe(name, () => {
      const get = (key: string) => {
        const v = t.get(key);
        if (!v) throw new Error(`${name}: ${key} 없음`);
        return v;
      };
      /** 글자 대비가 기준 이상인지. 실패 메시지에 토큰 이름과 값을 남긴다. */
      const atLeast = (fg: string, bg: string, min: number) => {
        const ratio = contrast(get(fg), get(bg));
        expect(ratio, `${name}: ${fg} ${get(fg)} / ${bg} ${get(bg)} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      };

      it("본문·보조 글자 vs 바탕·카드 4.5:1", () => {
        for (const fg of ["--ih-text-primary", "--ih-text-secondary"])
          for (const bg of ["--ih-bg-canvas", "--ih-bg-surface"]) atLeast(fg, bg, 4.5);
      });

      it("링크·승·패·저장됨·주의 글자 vs 카드 4.5:1", () => {
        for (const fg of ["--ih-link", "--ih-win-text", "--ih-loss-text", "--ih-ok-text", "--ih-warn-line"])
          atLeast(fg, "--ih-bg-surface", 4.5);
      });

      it("채운 버튼 글자 vs 채움 4.5:1, 승리 색 칸 글자 vs 승리 색 4.5:1", () => {
        atLeast("--ih-on-brand-fill", "--ih-brand-fill", 4.5);
        atLeast("--ih-on-brand-fill", "--ih-brand-fill-hover", 4.5);
        atLeast("--ih-on-win", "--ih-win-accent", 4.5);
        atLeast("--ih-on-loss", "--ih-loss-accent", 4.5);
      });

      it("라인 색 글자 vs 바탕·카드 4.5:1", () => {
        for (const pos of ["top", "jungle", "mid", "adc", "support"])
          for (const bg of ["--ih-bg-canvas", "--ih-bg-surface"]) atLeast(`--pos-${pos}`, bg, 4.5);
      });

      it("신호 색 칠 위 글자 4.5:1, 신호 색 vs 카드 3:1", () => {
        for (const sig of ["--sig-good", "--sig-warn", "--sig-bad"]) {
          atLeast("--on-sig", sig, 4.5);
          atLeast(sig, "--ih-bg-surface", 3);
        }
      });

      it("승률 글자 h1~h4·0·l1~l4 vs 카드 4.5:1", () => {
        for (const k of ["h4", "h3", "h2", "h1", "0", "l1", "l2", "l3", "l4"]) atLeast(`--heat-text-${k}`, "--ih-bg-surface", 4.5);
      });

      it("승률 막대 vs 막대 바탕 3:1, 열 단계가 서로 다른 색", () => {
        const track = viz.get("--viz-track")!;
        for (const k of HEAT) {
          const bar = get(`--heat-bar-${k}`);
          const ratio = contrast(bar, track);
          expect(ratio, `${name}: --heat-bar-${k} ${bar} / track ${track} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
        }
        // 0과 0l은 같은 파랑(기준 구간)이라 하나로 센다.
        const bars = HEAT.filter((k) => k !== "0l").map((k) => get(`--heat-bar-${k}`));
        expect(new Set(bars).size).toBe(bars.length);
      });

      it("칭호 등급 1~8 vs 카드 4.5:1", () => {
        for (let g = 1; g <= 8; g++) atLeast(`--grade-${g}`, "--ih-bg-surface", 4.5);
      });
    });
  }
});
