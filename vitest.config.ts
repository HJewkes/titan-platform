import { setFlagsFromString } from "node:v8";
import { defineConfig } from "vitest/config";

// These stub HOME (os.homedir() ignores that in a worker thread) or call process.chdir (unsupported in one).
const needsProcess = [
  "packages/code-graph/src/extractors/ts-morph-extractor-type-roots.test.ts",
  "packages/session-read/src/discover-roots.test.ts",
  "products/factory/src/shepherd/reviewer-dispatch.test.ts",
];

// A worker's heap cap, so a runaway test dies with an out-of-memory error instead of filling swap; with 4 threads and
// 1 fork, test workers stay under 10 GB. Worker threads reject heap flags in execArgv but take V8 flags set before
// the pool starts; forks are child processes and take execArgv.
const workerHeapMb = 2048;
setFlagsFromString(`--max-old-space-size=${workerHeapMb}`);
const forksHeap = [`--max-old-space-size=${workerHeapMb}`];
// The heap cap probe allocates until it hits that cap, so it runs only on request.
const heapProbe = process.env.VITEST_HEAP_PROBE ? ["scripts/heap-cap.probe.mjs"] : [];

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
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 4 },
      forks: { minForks: 1, maxForks: 1, execArgv: forksHeap },
    },
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
            "apps/*/server/**/*.test.ts",
            "scripts/**/*.test.mjs",
            ...heapProbe,
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
