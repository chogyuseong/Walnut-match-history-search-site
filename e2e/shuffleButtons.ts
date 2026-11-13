import type { Page } from "@playwright/test";

// 자주 쓰는 섞기 버튼 둘은 폭에 따라 자리가 다르다(src/web/screens/prep/ShuffleSection.tsx QuickShuffleButtons):
// 휴대폰(768px 미만)은 화면 아래 고정 줄에 짧은 이름으로, 그 밖은 섞기 구역에 긴 이름으로. 어느 폭이든 한 곳에만 있다.
// 아주 좁은 폰(QUICK_BAR_NARROW_MAX 이하)은 "라인만 섞기"가 섞기 구역에 남는다.

export const teamShuffleButton = (page: Page) => page.getByRole("button", { name: /^(팀·라인 모두 섞기|다 섞기)$/ });
export const lineShuffleButton = (page: Page) => page.getByRole("button", { name: /^(라인만 섞기|라인 섞기)$/ });
