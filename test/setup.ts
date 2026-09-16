import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("@cloudflare/vitest-pool-workers").D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  // Test-only reset of the isolated local database; never used by the Worker.
  await env.DB.batch(
    [
      "DELETE FROM data",
      "DELETE FROM changes",
      "DELETE FROM devices",
      "DELETE FROM sqlite_sequence WHERE name='changes'",
    ].map((sql) => env.DB.prepare(sql)),
  );
});
