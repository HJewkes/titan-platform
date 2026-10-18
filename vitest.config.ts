import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { defineConfig } from "vitest/config";
import { strayDependency } from "./scripts/own-node-modules.mjs";
import { forceRerunTriggers, REPO_TIER_INCLUDE } from "./scripts/test-affected.mjs";

// Refuse rather than run a parent checkout's vitest, which can be a major version behind this lockfile.
const strayVitest = strayDependency(fileURLToPath(new URL(".", import.meta.url)), "vitest");
if (strayVitest) throw new Error(strayVitest);

// These stub HOME (os.homedir() ignores that in a worker thread), call process.chdir (unsupported in one) or set TZ
// (a worker thread keeps the host zone).
const needsProcess = [
  "packages/code-graph/src/extractors/ts-morph-extractor-type-roots.test.ts",
  "packages/session-read/src/discover-roots.test.ts",
  "products/factory/src/shepherd/reviewer-dispatch.test.ts",
  "products/session-miner/src/commands/memory.test.ts",
  "products/session-miner/src/insights/blocked-flow.test.ts",
  "products/session-miner/src/insights/define.test.ts",
  "products/session-miner/src/memory/discover.test.ts",
];

// A worker's heap cap, so a runaway test dies with an out-of-memory error instead of filling swap; with at most 4
// workers, test workers stay under 10 GB. Worker threads reject heap flags in execArgv but take V8 flags set before
// the pool starts; forks are child processes and take execArgv.
const workerHeapMb = 2048;
setFlagsFromString(`--max-old-space-size=${workerHeapMb}`);
const forksHeap = [`--max-old-space-size=${workerHeapMb}`];
// A "Reached heap limit" line in a CI log is not proof a worker hit this cap: scripts/dag-check-lock.test.mjs aborts a
// 32 MB child on purpose and its V8 report reaches the log (TP-3487; TP-2565 was the earlier load-timeout red). A real
// runaway fails its own file with a worker exit, so look for that before raising the cap.
// The heap cap probe allocates until it hits that cap, so it runs only on request.
const heapProbe = process.env.VITEST_HEAP_PROBE ? ["scripts/heap-cap.probe.mjs"] : [];

export default defineConfig({
  // Apps render @titan-design/react-ui, which is written against React Native primitives; no package imports react-native.
  resolve: { alias: { "react-native": "react-native-web" } },
  test: {
    // The speech loaders refuse an uncached model before any network call, so no test can download weights.
    env: { TITAN_SPEECH_OFFLINE: "1" },
    // Inlined so the alias above applies; left external, Node would load react-native's Flow source.
    server: { deps: { inline: [/@titan-design\/react-ui/] } },
    globalSetup: ["scripts/vitest-tmpdir.mjs"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}", "products/*/src/**/*.{ts,tsx}", "apps/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/index.ts"],
    },
    maxWorkers: 4,
    forceRerunTriggers: forceRerunTriggers(),
    projects: [
      {
        extends: true,
        test: {
          name: "threads",
          // Threads die with their parent; forks workers survive it as orphans holding gigabytes.
          pool: "threads",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            "packages/*/scripts/**/*.test.ts",
            "products/*/src/**/*.test.{ts,tsx}",
            "apps/*/src/**/*.test.{ts,tsx}",
            "apps/*/scripts/**/*.test.ts",
            "apps/*/server/**/*.test.ts",
            "scripts/**/*.test.mjs",
            ...heapProbe,
          ],
          exclude: ["**/node_modules/**", ...REPO_TIER_INCLUDE, ...needsProcess],
        },
      },
      {
        extends: true,
        test: {
          name: "repo",
          pool: "threads",
          include: REPO_TIER_INCLUDE,
        },
      },
      {
        extends: true,
        test: {
          name: "forks",
          pool: "forks",
          // One fork, run apart from the threads, as its own sequential group.
          maxWorkers: 1,
          execArgv: forksHeap,
          include: needsProcess,
        },
      },
    ],
  },
});
