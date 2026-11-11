import { describe, expect, it } from "vitest";
import css from "../src/web/styles.css?raw";

// 두 테마(dark·light)의 색 토큰이 WCAG 대비 기준을 지키는지 styles.css를 직접 읽어 검사한다.
// 기준은 저장소 맨 위 CLAUDE.md 5절: 글자 4.5:1, 컨트롤 경계와 승률 막대 3:1. 반투명(rgba) 틴트는 검사하지 않는다.
// 칭호·MMR 티어·순위는 4단계(2026-11-11)에서 본문·보조 글자 색으로 중립화해 따로 검사할 색이 없다(위 본문 글자 검사에 든다).
// light는 dark 토큰(:root 블록)을 물려받고 바뀐 값만 덮어쓴다.

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

// 테마 토큰과 라인·이야기 카드 색은 맨 위 `:root, [data-theme="dark"]` 블록에 함께 있다. 같은 선택자 블록이 더 생겨도 모두 모인다.
const dark = tokensOf(/^:root,\s*\[data-theme="dark"\]$/);
const light = new Map([...dark, ...tokensOf(/^\[data-theme="light"\]$/)]);
// 막대 바탕: .viz-root(다크)과 [data-theme="light"] .viz-root.
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

/** 승률 3단(CLAUDE.md 5절)이 가리키는 토큰: 높음 강조색 · 기준 주요 글자 · 낮음 보조 글자. */
const HEAT_TIERS = { high: "--ih-accent", mid: "--ih-text", low: "--ih-text-secondary" } as const;

/** `.heat-h1, .heat-h2 … { --heat: var(--토큰); }`처럼 선택자 묶음에 heat 클래스가 든 블록의 --heat 값을 클래스별로 모은다. */
function heatTokenOf(): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = /--heat\s*:\s*var\((--[\w-]+)\)/.exec(match[2]!)?.[1];
    if (!value) continue;
    for (const cls of match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.(heat-[\w]+)/g)) out.set(cls[1]!, value);
  }
  return out;
}
const heatTokens = heatTokenOf();
const THEMES = [
  { name: "dark", t: dark, viz: vizDark },
  { name: "light", t: light, viz: vizLight },
] as const;

describe("테마 색 대비", () => {
  it("토큰을 읽었다", () => {
    expect(dark.get("--ih-bg")).toBe("#0f172a");
    expect(light.get("--ih-bg")).toBe("#f8fafc");
    expect(dark.get("--pos-top")).toMatch(/^#/);
    expect(vizDark.get("--viz-track")).toMatch(/^#/);
    expect(vizLight.get("--viz-track")).toMatch(/^#/);
  });

  it("바이올렛 테마는 없다", () => {
    expect(css).not.toMatch(/data-theme="violet"/);
  });

  it("승률 색은 3단뿐이다: 높음 h1~h4 강조색, 기준 0 주요 글자, 낮음 l1~l4 보조 글자", () => {
    for (const k of ["h1", "h2", "h3", "h4"]) expect(heatTokens.get(`heat-${k}`)).toBe(HEAT_TIERS.high);
    expect(heatTokens.get("heat-0")).toBe(HEAT_TIERS.mid);
    for (const k of ["l1", "l2", "l3", "l4"]) expect(heatTokens.get(`heat-${k}`)).toBe(HEAT_TIERS.low);
  });

  it("장식 그라데이션·칭호 등급 색·금은동 토큰이 없다", () => {
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/--grade-\d\s*:/);
    expect(css).not.toMatch(/--ih-accent-(medal-gold|silver|bronze)\s*:/);
  });

  it("저장됨·주의·신호 전용 색 토큰이 없다(중립색 + 아이콘·명도로 표시)", () => {
    expect(css).not.toMatch(/--(ih-)?(ok|warn)-(bg|text|line)\s*:/);
    expect(css).not.toMatch(/--(sig-[a-z]+|on-sig)\s*:/);
  });

  for (const { name, t, viz } of THEMES) {
    describe(name, () => {
      const get = (key: string) => {
        const v = t.get(key);
        if (!v) throw new Error(`${name}: ${key} 없음`);
        return v;
      };
      /** 대비가 기준 이상인지. 실패 메시지에 토큰 이름과 값을 남긴다. */
      const atLeast = (fg: string, bg: string, min: number) => {
        const ratio = contrast(get(fg), get(bg));
        expect(ratio, `${name}: ${fg} ${get(fg)} / ${bg} ${get(bg)} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(min);
      };

      it("본문·보조 글자 vs 화면 배경·패널·보조 면 4.5:1", () => {
        for (const fg of ["--ih-text", "--ih-text-secondary"])
          for (const bg of ["--ih-bg", "--ih-panel", "--ih-subtle"]) atLeast(fg, bg, 4.5);
      });

      it("강조 글자(링크·고른 칸) vs 화면 배경·패널·선택 배경 4.5:1", () => {
        for (const bg of ["--ih-bg", "--ih-panel", "--ih-selected"]) atLeast("--ih-accent", bg, 4.5);
      });

      it("주 버튼 글자 vs 채움·호버 4.5:1", () => {
        atLeast("--ih-on-primary", "--ih-primary", 4.5);
        atLeast("--ih-on-primary", "--ih-primary-hover", 4.5);
      });

      it("컨트롤 경계 vs 패널·화면 배경 3:1", () => {
        for (const bg of ["--ih-panel", "--ih-bg"]) atLeast("--ih-control-border", bg, 3);
      });

      // 저장됨·주의는 5단계부터 중립색 + 아이콘이라 따로 검사할 색이 없다(본문 글자 검사에 든다).
      it("승·패·오류 글자 vs 패널 4.5:1, 승패 색 칸 위 글자 4.5:1", () => {
        for (const fg of ["--ih-win-text", "--ih-loss-text", "--ih-danger"])
          atLeast(fg, "--ih-panel", 4.5);
        atLeast("--ih-on-win", "--ih-win-accent", 4.5);
        atLeast("--ih-on-loss", "--ih-loss-accent", 4.5);
      });

      it("라인 색 글자 vs 바탕·패널 4.5:1", () => {
        for (const pos of ["top", "jungle", "mid", "adc", "support"])
          for (const bg of ["--ih-bg", "--ih-panel"]) atLeast(`--pos-${pos}`, bg, 4.5);
      });

      it("섞기 공정성 띠: 채운 두 구간(본문·보조 글자색) 위 숫자(화면 배경색) 4.5:1", () => {
        for (const fill of ["--ih-text", "--ih-text-secondary"]) atLeast("--ih-bg", fill, 4.5);
      });

      it("승률 3단 글자 vs 패널·표 칸 바탕(보조 면)·고른 사람 줄 바탕(선택 배경) 4.5:1, 세 단이 서로 다른 색", () => {
        for (const token of Object.values(HEAT_TIERS))
          for (const bg of ["--ih-panel", "--ih-subtle", "--ih-selected"]) atLeast(token, bg, 4.5);
        expect(new Set(Object.values(HEAT_TIERS).map(get)).size).toBe(3);
      });

      it("승률 막대 세 색·속 빈 막대 테두리 vs 막대 바탕 3:1", () => {
        const track = viz.get("--viz-track")!;
        for (const token of Object.values(HEAT_TIERS)) {
          const bar = get(token);
          const ratio = contrast(bar, track);
          expect(ratio, `${name}: ${token} ${bar} / track ${track} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(3);
        }
      });

      it("이야기 카드 라벨 색 vs 카드 바탕·고른 카드 바탕 4.5:1", () => {
        for (const kind of ["streak", "upset", "pair", "attendance"])
          for (const bg of ["--ih-subtle", "--ih-selected"]) atLeast(`--story-${kind}`, bg, 4.5);
      });
    });
  }
});
