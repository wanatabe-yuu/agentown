import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    // Server integration tests share one Postgres database.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
