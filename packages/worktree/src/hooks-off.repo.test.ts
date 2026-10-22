import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeAllocator, type WorktreeRequest } from "./allocator.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";
const roots: string[] = [];
const worktreeStrategy = createWorktreeAllocator();
afterEach(() => {
  for (const dir of roots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: fixtureEnv(),
  }).trim();
function makeRepo(): string {
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "hooks-off-"))
  );
  roots.push(repo);
  seedRepo(repo);
  return repo;
}
const ctxFor = (
  cwd: string,
  overrides: Partial<WorktreeRequest> = {}
): WorktreeRequest => ({ baseCwd: cwd, agentName: "alice", ...overrides });
describe("worktree add runs no repository hook (CC-410)", () => {
  /** A repo whose hooks live in the tree under a relative path, as husky sets up. */
  function huskyRepo(): { repo: string; marker: string } {
    const repo = makeRepo();
    git(["config", "core.hooksPath", ".husky"], repo);
    return { repo, marker: path.join(repo, "HOOK_RAN") };
  }

  /** Each copy writes its own label, so the marker says which checkout's hook git ran. */
  const writeHook = (dir: string, label: string, marker: string): void => {
    fs.mkdirSync(path.join(dir, ".husky"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".husky", "post-checkout"),
      `#!/bin/sh\necho "${label} $PWD" >> '${marker}'\n`,
      {
        mode: 0o755,
      }
    );
  };

  const ran = (marker: string): string =>
    fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";

  it("does not run a hook sitting in the main checkout's working tree", async () => {
    const { repo, marker } = huskyRepo();
    writeHook(repo, "main", marker);

    const alloc = await worktreeStrategy.allocate(ctxFor(repo));

    expect(fs.existsSync(alloc.cwd)).toBe(true);
    expect(ran(marker)).toBe("");
  });

  it("does not run the hook on a branch it adopts", async () => {
    const { repo, marker } = huskyRepo();
    const ctx = ctxFor(repo, { agentName: "scout" });
    const first = await worktreeStrategy.allocate(ctx);
    writeHook(first.cwd, "branch", marker);
    git(["add", ".husky"], first.cwd);
    git(["commit", "-m", "add post-checkout"], first.cwd);
    fs.rmSync(first.cwd, { recursive: true, force: true });
    writeHook(repo, "main", marker);

    const second = await worktreeStrategy.allocate(ctx);

    expect(second.ref.reused).toBe("true");
    expect(ran(marker)).toBe("");
  });

  it("leaves the tree's own hooks working for the agent's later git commands", async () => {
    const { repo, marker } = huskyRepo();
    writeHook(repo, "tree", marker);
    git(["add", ".husky"], repo);
    git(["commit", "-m", "add post-checkout"], repo);
    fs.rmSync(marker, { force: true });
    const alloc = await worktreeStrategy.allocate(ctxFor(repo));

    git(["checkout", "-b", "probe"], alloc.cwd);

    expect(git(["config", "--get", "core.hooksPath"], alloc.cwd)).toBe(
      ".husky"
    );
    expect(ran(marker)).toBe(`tree ${alloc.cwd}`);
  });
});

describe("pinned add timeout target", () => {
  it("cleans the prefixed argv target after a late add without removing another path", async () => {
    const repo = makeRepo();
    const target = path.join(repo, ".worktrees", "late");
    const remove = fs.rmSync;
    const guard = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
      const candidate = path.resolve(String(file));
      if (!candidate.startsWith(repo + path.sep))
        throw new Error("cleanup escaped owned fixture");
      return remove(file, options);
    });
    try {
      const allocator = createWorktreeAllocator({
        addTimeoutMs: 50,
        runWorktreeAdd: async (args, cwd) => {
          expect(args.slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);
          await new Promise((resolve) => setTimeout(resolve, 150));
          return git(args, cwd);
        },
      });
      await expect(
        allocator.allocate(ctxFor(repo, { agentName: "late" }))
      ).rejects.toThrow("timed out");
      await vi.waitFor(() => expect(fs.existsSync(target)).toBe(false), {
        timeout: 2000,
      });
      await vi.waitFor(
        () =>
          expect(git(["worktree", "list", "--porcelain"], repo)).not.toContain(
            `worktree ${target}`
          ),
        { timeout: 2000 }
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(fs.existsSync(target)).toBe(false);
      expect(git(["worktree", "list", "--porcelain"], repo)).not.toContain(
        `worktree ${target}`
      );
    } finally {
      guard.mockRestore();
    }
  });
});
