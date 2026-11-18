import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, seedRepo } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { createWorktreeAllocator } from "./allocator.js";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (args: readonly string[], cwd: string): string =>
  execFileSync("git", [...args], { cwd, encoding: "utf8", env: fixtureEnv() }).trim();

function makeRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exclude-")));
  roots.push(repo);
  seedRepo(repo);
  return repo;
}

const excludeFile = (repo: string): string => path.join(repo, ".git", "info", "exclude");
const linesOf = (file: string): string[] => fs.readFileSync(file, "utf8").split("\n");

describe("allocation keeps the worktree base out of git status", () => {
  it("after allocation, git status in the primary shows no ?? .worktrees/", async () => {
    const repo = makeRepo();

    await createWorktreeAllocator().allocate({ baseCwd: repo, agentName: "alice" });

    expect(git(["status", "--porcelain"], repo)).not.toContain(".worktrees/");
  });

  it("a second allocation does not repeat the exclude line", async () => {
    const repo = makeRepo();
    const allocator = createWorktreeAllocator();

    await allocator.allocate({ baseCwd: repo, agentName: "alice" });
    await allocator.allocate({ baseCwd: repo, agentName: "bob" });

    expect(linesOf(excludeFile(repo)).filter((line) => line === "/.worktrees/")).toHaveLength(1);
  });

  it("keeps existing exclude lines and creates the file when absent", async () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, ".git", "info"), { recursive: true, force: true });
    await createWorktreeAllocator().allocate({ baseCwd: repo, agentName: "alice" });
    fs.writeFileSync(excludeFile(repo), "*.log");

    await createWorktreeAllocator().allocate({ baseCwd: repo, agentName: "bob" });

    expect(linesOf(excludeFile(repo))).toEqual(["*.log", "/.worktrees/", ""]);
  });

  it("writes the primary's exclude file when allocating from inside a worktree", async () => {
    const repo = makeRepo();
    const allocator = createWorktreeAllocator({ basePath: ".trees" });
    const first = await allocator.allocate({ baseCwd: repo, agentName: "alice" });

    await allocator.allocate({ baseCwd: first.cwd, agentName: "bob" });

    expect(linesOf(excludeFile(repo)).filter((line) => line === "/.trees/")).toHaveLength(1);
  });

  it.skipIf(process.getuid?.() === 0)(
    "allocation succeeds with a warning when the info dir is read-only",
    async () => {
      const repo = makeRepo();
      const info = path.join(repo, ".git", "info");
      fs.rmSync(excludeFile(repo), { force: true });
      fs.chmodSync(info, 0o555);
      try {
        const allocation = await createWorktreeAllocator().allocate({ baseCwd: repo, agentName: "alice" });

        expect(fs.existsSync(allocation.cwd)).toBe(true);
        expect(allocation.warnings?.some((w) => w.includes(excludeFile(repo)))).toBe(true);
      } finally {
        fs.chmodSync(info, 0o755);
      }
    }
  );
});
