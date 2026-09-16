import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          MASTER_KEY: "a".repeat(64),
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
        compatibilityDate: "2026-08-15",
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false,
    testTimeout: 30000,
  },
});
