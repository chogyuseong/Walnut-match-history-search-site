import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// 원격 D1(wrangler.spike.jsonc의 naejeon-spike)에서 원자성 스파이크만 다시 돌린다.
// 실행: npx vitest run --config vitest.spike.config.ts   (먼저 npx wrangler login 필요)
// 주의: 운영 DB를 가리키지 말 것. 테스트가 행을 쓴다. 이 설정은 저장소 주인이 아직 실제로 돌려 보지 않았다.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.spike.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: "spike-only-session-secret",
          },
        },
      }),
    ],
    test: {
      include: ["test/spike-atomicity.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
