import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "test-only-session-secret",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
      // 대량 점검(draft-fuzz)과 로컬 D1 통합 테스트는 부하가 걸린 PC에서 기본 5초를 넘긴다.
      // CI 설정(--testTimeout=30000)과 같은 값으로 `npm test`만으로도 통과하게 둔다.
      testTimeout: 30000,
      // 테마 대비 검사(test/theme-contrast.test.ts)가 styles.css를 `?raw`로 읽는다. vitest는 기본으로 CSS를
      // 빈 문자열로 바꾸므로 이 파일만 처리 대상에 넣는다.
      css: { include: [/src[\\/]web[\\/]styles\.css/] },
    },
  };
});
