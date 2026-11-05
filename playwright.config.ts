import { defineConfig } from "@playwright/test";

// 브라우저에서 실제 흐름을 확인한다. 로컬 Worker와 로컬 D1만 쓰고 운영 주소는 쓰지 않는다.
export default defineConfig({
  testDir: "e2e",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8787",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  },
  webServer: {
    command: "npm run dev -- --port 8787 --ip 127.0.0.1",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
