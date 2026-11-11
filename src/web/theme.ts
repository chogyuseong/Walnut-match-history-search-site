/** 화면 테마 둘. <html data-theme>로 적용하고 이 기기에만 기억한다. */
export type Theme = "dark" | "light";

export const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "dark", label: "다크" },
  { value: "light", label: "라이트" },
];

const THEME_KEY = "naejeon.theme";
const DEFAULT_THEME: Theme = "dark";
/** 없앤 바이올렛 테마의 저장값(violet, 그 전 이름 deeplol). 남아 있으면 다크로 고쳐 쓴다.
 *  고쳐 쓴 뒤에는 바이올렛이 있던 판으로 되돌려 배포해도 그 기기는 다크로 열린다. */
const RETIRED_THEMES: readonly string[] = ["violet", "deeplol"];

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (THEMES.some((t) => t.value === stored)) return stored as Theme;
    if (stored !== null && RETIRED_THEMES.includes(stored)) localStorage.setItem(THEME_KEY, DEFAULT_THEME);
  } catch {
    // 보관소를 읽지 못하면 기본 테마를 쓴다.
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: Theme, remember = false): void {
  document.documentElement.dataset.theme = theme;
  if (!remember) return;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // 보관하지 못하면 이번 방문에만 적용된다.
  }
}
