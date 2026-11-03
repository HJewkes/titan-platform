import type { TimingArtifact, TimingFile, TimingRun } from "./artifact.js";

// Synthetic values only: example hosts, repos and shas, never a real run.
export function timingRun(overrides: Partial<TimingRun> = {}): TimingRun {
  return {
    id: "gha:1001:1:1",
    runner: "gha",
    host: "runner-a",
    repo: "example/repo",
    commit: "a".repeat(40),
    mergeSha: "b".repeat(40),
    baseSha: "c".repeat(40),
    branch: "feat/example",
    pr: 7,
    event: "pull_request",
    scope: { mode: "full", filters: [] },
    shard: null,
    cpus: 4,
    maxWorkers: 3,
    node: "v22.0.0",
    vitest: "4.0.0",
    startedAt: "2026-01-01T00:00:00.000Z",
    load: { start: 1, mean: 1.5, max: 2 },
    wallMs: 60_000,
    exit: "passed",
    ...overrides,
  };
}

export function timingFile(overrides: Partial<TimingFile> = {}): TimingFile {
  return {
    project: "unit",
    file: "packages/example/src/a.test.ts",
    state: "passed",
    environmentMs: 1,
    prepareMs: 2,
    collectMs: 100,
    setupMs: 10,
    testMs: 400,
    totalMs: 510,
    tests: 5,
    ...overrides,
  };
}

export function timingArtifact(run: Partial<TimingRun> = {}, files: TimingFile[] = [timingFile(), timingFile({ file: "packages/example/src/b.test.ts" })]): TimingArtifact {
  return { schema: "titan.test-timing/v1", run: timingRun(run), files };
}
