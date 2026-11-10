/** 디자인 키트의 세 가지 테마. <html data-theme>로 적용하고 이 기기에만 기억한다. */
export type Theme = "dark" | "violet" | "light";

export const THEMES: readonly { value: Theme; label: string }[] = [
  { value: "dark", label: "다크" },
  { value: "violet", label: "바이올렛" },
  { value: "light", label: "라이트" },
];

const THEME_KEY = "naejeon.theme";
const DEFAULT_THEME: Theme = "dark";

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    // 바이올렛 테마의 예전 식별자(2026-11-10 이전). 남의 서비스 이름이라 violet으로 바꿨고, 이미 저장해 둔 기기는
    // 여기서 한 번 옮겨 적는다. 옛 값을 가진 기기가 없어졌다고 판단되면 이 분기를 지워도 된다.
    if (stored === "deeplol") {
      localStorage.setItem(THEME_KEY, "violet");
      return "violet";
    }
    if (THEMES.some((t) => t.value === stored)) return stored as Theme;
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
