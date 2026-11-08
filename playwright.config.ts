import { defineConfig } from "@playwright/test";

// 브라우저에서 실제 흐름을 확인한다. 로컬 Worker와 로컬 D1만 쓰고 운영 주소는 쓰지 않는다.
// E2E_PORT로 다른 포트의 로컬 서버를 쓸 수 있다(기본 8787). 예: 떠 있는 8787 서버를 건드리지 않고
// 새 빌드를 8790에서 확인할 때 `$env:E2E_PORT="8790"; npx playwright test e2e/prep-walkthrough.spec.ts`.
const PORT = process.env.E2E_PORT ?? "8787";
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  // CI에서는 실패한 테스트를 한 번 더 돌려 일시적인 지연을 걸러 낸다(두 번 다 실패해야 실패).
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    // 자리 바뀜 애니메이션(TeamBoards FLIP) 등을 끈다. 위치·넘침을 재는 테스트가 움직이는 중간 상태를 보지 않게.
    reducedMotion: "reduce",
    // 실패한 테스트만 추적(trace.zip: 단계별 화면·네트워크·콘솔)과 스크린숏을 test-results/에 남긴다(CI는 실패 때 올린다).
    // `npx playwright show-trace test-results/<테스트>/trace.zip`으로 연다.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // 화면 빌드 → 로컬 D1 마이그레이션 → wrangler dev. 이미 떠 있으면 그 서버를 그대로 쓴다.
    // 가짜 로그인에는 .dev.vars의 SESSION_SECRET이 필요하다(CI는 워크플로가 만들어 둔다).
    command: `npm run dev -- --port ${PORT} --ip 127.0.0.1`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
