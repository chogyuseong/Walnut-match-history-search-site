import { applyD1Migrations, env } from "cloudflare:test";

// 테스트용 로컬 D1에 마이그레이션을 적용한다. 이미 적용된 것은 건너뛴다.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
