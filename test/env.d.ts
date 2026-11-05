import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env } from "../src/server/env";

declare global {
  namespace Cloudflare {
    interface Env extends ServerEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
  type ServerEnv = Env;
}
