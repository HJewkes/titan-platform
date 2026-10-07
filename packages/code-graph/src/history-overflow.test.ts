import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as RealGit from "./history/git.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadHistoryMetrics } from "./history-metrics.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./history/test-repo.js";

const squeeze = vi.hoisted(() => ({
  maxBuffer: undefined as number | undefined,
}));

vi.mock("./history/git.js", async (importOriginal) => {
  const real = await importOriginal<typeof RealGit>();
  return {
    ...real,
    runGitLargeResult: (
      cwd: string,
      args: readonly string[],
      maxBuffer: number
    ) => real.runGitLargeResult(cwd, args, squeeze.maxBuffer ?? maxBuffer),
  };
});

const nodes = [{ id: "a.ts", kind: "file" as const, name: "a.ts" }];
let repo: TestRepo;
beforeAll(async () => {
  repo = await makeTestRepo();
  await repo.write("a.ts", "one\n");
  repo.commit("add a", { author: "ann", date: daysAgo(2) });
});
afterAll(async () => {
  squeeze.maxBuffer = undefined;
  await repo.cleanup();
});

describe("loadHistoryMetrics failure reporting", () => {
  it("warns, with no metrics, when the churn log overflows", () => {
    squeeze.maxBuffer = 8;
    try {
      const loaded = loadHistoryMetrics(nodes, repo.dir, {
        churnWindows: [30],
      });
      expect(loaded?.metrics).toEqual([]);
      expect(loaded?.warnings.join()).toContain("churn log overflow");
    } finally {
      squeeze.maxBuffer = undefined;
    }
  });

  it("has no warnings when history loads", () => {
    expect(
      loadHistoryMetrics(nodes, repo.dir, { churnWindows: [30] })?.warnings
    ).toEqual([]);
  });

  it("stays null without a warning outside a git checkout", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-nogit-"));
    try {
      expect(loadHistoryMetrics(nodes, dir)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
