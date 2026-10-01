import { defineConfig } from "vitest/config";

// These stub HOME, which os.homedir() ignores inside a worker thread, so they need a real process.
const needsProcess = [
  "packages/session-read/src/discover-roots.test.ts",
  "products/factory/src/shepherd/reviewer-dispatch.test.ts",
];

export default defineConfig({
  // Apps render @titan-design/react-ui, which is written against React Native primitives; no package imports react-native.
  resolve: { alias: { "react-native": "react-native-web" } },
  test: {
    // Inlined so the alias above applies; left external, Node would load react-native's Flow source.
    server: { deps: { inline: [/@titan-design\/react-ui/] } },
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "products/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts"],
    },
    // Pool options are global in vitest 3; per-project values are ignored. minThreads is set because its default exceeds the cap.
    poolOptions: { threads: { minThreads: 1, maxThreads: 4 }, forks: { minForks: 1, maxForks: 1 } },
    projects: [
      {
        extends: true,
        test: {
          name: "threads",
          // Threads die with their parent; forks workers survive it as orphans holding gigabytes.
          pool: "threads",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            "products/*/src/**/*.test.{ts,tsx}",
            "apps/*/src/**/*.test.{ts,tsx}",
            "apps/*/scripts/**/*.test.ts",
            "scripts/**/*.test.mjs",
          ],
          exclude: ["**/node_modules/**", ...needsProcess],
        },
      },
      {
        extends: true,
        test: {
          name: "forks",
          pool: "forks",
          include: needsProcess,
        },
      },
    ],
  },
});
