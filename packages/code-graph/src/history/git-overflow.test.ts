import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as RealGit from "./git.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GitHistoryError, runGitLargeResult } from "./git.js";
import { loadChurnEntries, loadChurnResult } from "./log.js";
import { loadFirstSeenResult } from "./first-seen.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./test-repo.js";

const squeeze = vi.hoisted(() => ({
  maxBuffer: undefined as number | undefined,
}));

// Real log sizes need tens of MiB of history; shrink the buffer the loaders ask for instead.
vi.mock("./git.js", async (importOriginal) => {
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

let repo: TestRepo;
beforeAll(async () => {
  repo = await makeTestRepo();
  await repo.write("a.ts", "one\ntwo\n");
  repo.commit("add a", { author: "ann", date: daysAgo(2) });
});
afterAll(async () => {
  squeeze.maxBuffer = undefined;
  await repo.cleanup();
});

describe("git log overflow versus a non-repo", () => {
  it("reports overflow when the log exceeds maxBuffer", () => {
    const result = runGitLargeResult(repo.dir, ["log", "--stat"], 8);
    expect(result).toMatchObject({ ok: false, reason: "overflow" });
  });

  it("returns the output when it fits", () => {
    expect(runGitLargeResult(repo.dir, ["log", "--format=%an"], 1024)).toEqual({
      ok: true,
      out: "ann\n",
    });
  });

  it("reports git-error when git exits non-zero", () => {
    expect(
      runGitLargeResult(repo.dir, ["log", "no-such-rev"], 1024)
    ).toMatchObject({ ok: false, reason: "git-error" });
  });

  it("surfaces an overflowed churn log instead of treating it as not-git", () => {
    squeeze.maxBuffer = 8;
    try {
      expect(
        loadChurnResult({ repoRoot: repo.dir, windowDays: 30 })
      ).toMatchObject({ ok: false, reason: "overflow" });
      expect(loadFirstSeenResult({ repoRoot: repo.dir })).toMatchObject({
        ok: false,
        reason: "overflow",
      });
      expect(() =>
        loadChurnEntries({ repoRoot: repo.dir, windowDays: 30 })
      ).toThrow(GitHistoryError);
    } finally {
      squeeze.maxBuffer = undefined;
    }
  });

  it("still reports not-git for a directory outside any repository", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-nogit-"));
    try {
      expect(loadChurnResult({ repoRoot: dir })).toMatchObject({
        ok: false,
        reason: "not-git",
      });
      expect(loadFirstSeenResult({ repoRoot: dir })).toMatchObject({
        ok: false,
        reason: "not-git",
      });
      expect(loadChurnEntries({ repoRoot: dir })).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
