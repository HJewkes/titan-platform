import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ctxFor, git, makeRepo, removeTempDirs } from "./fixtures/git-repo.js";
import { createWorktreeStrategy } from "./index.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(removeTempDirs);

describe("worktree removal deadline", () => {
  it("does not cut off a worktree remove that outlasts git's 60 s default", async () => {
    const repo = makeRepo();
    const ctx = ctxFor(repo);
    const slowRemoveMs = 120_000;
    const deadlines: number[] = [];
    const strategy = createWorktreeStrategy({
      ghTimeoutMs: 120_000,
      removeRunner: (timeoutMs) => async (args, cwd) => {
        deadlines.push(timeoutMs);
        if (timeoutMs < slowRemoveMs) return null;
        git([...args], cwd);
        return "";
      },
    });
    const alloc = await strategy.allocate(ctx);

    expect(await strategy.release(ctx, alloc)).toBe(true);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThan(slowRemoveMs);
    expect(fs.existsSync(alloc.cwd)).toBe(false);
  });
});
