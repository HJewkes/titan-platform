import { defineConfig } from "vitest/config";

const probes = ["a.probe.mjs", "b.probe.mjs"];

// One worker, files in order: the counter module survives between files only when isolation is off.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    // The default reporter drops console output of passing tests in vitest 4.
    reporters: ["verbose"],
    maxWorkers: 1,
    fileParallelism: false,
    sequence: { shuffle: false },
    projects: [
      { extends: true, test: { name: "shared", include: probes, isolate: false } },
      { extends: true, test: { name: "default", include: probes } },
    ],
  },
});
