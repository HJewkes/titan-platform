import { defineConfig } from "vitest/config";

// For a local run from this directory; capped so parallel agents on one machine do not exhaust it. CI uses the root config.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
  },
});
