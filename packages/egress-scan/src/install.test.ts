import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOOK_MARKER, hookBody, installHook } from "./install.js";
import { makeTestRepo, tempDir, type TestRepo } from "./test-repo.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function newRepo(): TestRepo {
  const repo = makeTestRepo();
  dirs.push(repo.dir);
  repo.commit("base");
  return repo;
}

function linkedWorktree(repo: TestRepo): string {
  const worktree = path.join(tempDir("egress-wt-"), "wt");
  dirs.push(path.dirname(worktree));
  repo.git(["worktree", "add", "-q", worktree]);
  return worktree;
}

const LOCAL = { HOME: "/nonexistent" };

describe("installHook", () => {
  it("installs into git's hooks directory once and leaves it alone on a second run", () => {
    const repo = newRepo();
    const hookPath = path.join(repo.dir, ".git", "hooks", "pre-push");

    const first = installHook(repo.dir, LOCAL);
    const second = installHook(repo.dir, LOCAL);

    expect(first).toEqual({ outcome: "installed", hookPath });
    expect(second).toEqual({ outcome: "unchanged", hookPath });
    expect(fs.readFileSync(hookPath, "utf-8")).toBe(hookBody());
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0);
  });

  it("never overwrites a pre-push hook it did not write", () => {
    const repo = newRepo();
    const hookPath = path.join(repo.dir, ".git", "hooks", "pre-push");
    fs.writeFileSync(hookPath, "#!/bin/sh\necho someone else's hook\n");

    const result = installHook(repo.dir, LOCAL);

    expect(result.outcome).toBe("foreign-hook");
    expect(fs.readFileSync(hookPath, "utf-8")).not.toContain(HOOK_MARKER);
  });

  it("refreshes an older copy of its own hook", () => {
    const repo = newRepo();
    const hookPath = path.join(repo.dir, ".git", "hooks", "pre-push");
    fs.writeFileSync(hookPath, `#!/bin/sh\n${HOOK_MARKER}; old\n`);

    expect(installHook(repo.dir, LOCAL).outcome).toBe("updated");
    expect(fs.readFileSync(hookPath, "utf-8")).toBe(hookBody());
  });

  it("writes to the shared hooks directory when run from a linked worktree", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);

    const result = installHook(worktree, LOCAL);

    expect(result.hookPath).toBe(path.join(repo.dir, ".git", "hooks", "pre-push"));
  });

  it("installs into core.hooksPath when the repo sets one", () => {
    const repo = newRepo();
    repo.git(["config", "core.hooksPath", ".githooks"]);

    const result = installHook(repo.dir, LOCAL);

    expect(result.hookPath).toBe(path.join(repo.dir, ".githooks", "pre-push"));
    expect(fs.existsSync(path.join(repo.dir, ".githooks", "pre-push"))).toBe(true);
  });

  it("does nothing in CI", () => {
    const repo = newRepo();

    expect(installHook(repo.dir, { CI: "true" })).toEqual({ outcome: "skipped-in-ci" });
    expect(fs.existsSync(path.join(repo.dir, ".git", "hooks", "pre-push"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the installed hook", () => {
  function runHook(cwd: string, hookPath: string): ReturnType<typeof spawnSync> {
    return spawnSync("sh", [hookPath, "origin", "git@example.com:o/r.git"], { cwd, input: "stdin-line\n" });
  }

  it("fails closed with an install message when the worktree has no scanner", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);

    const result = runHook(worktree, hookPath);

    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain("run pnpm install");
  });

  it("runs the pushing worktree's scanner with the remote name and git's stdin", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const fakeBin = path.join(worktree, "node_modules", ".bin", "titan-egress-scan");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '#!/bin/sh\necho "args:$*"\ncat\nexit 3\n', { mode: 0o755 });

    const result = runHook(worktree, hookPath);

    expect(result.status).toBe(3);
    expect(String(result.stdout)).toBe("args:pre-push origin\nstdin-line\n");
  });

  it("falls back to the package's built script when pnpm left no .bin link", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const script = path.join(worktree, "node_modules", "@titan-design", "egress-scan", "dist", "bin.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, 'console.log("args:" + process.argv.slice(2).join(" "));\nprocess.exitCode = 4;\n');

    const result = runHook(worktree, hookPath);

    expect(result.status).toBe(4);
    expect(String(result.stdout)).toBe("args:pre-push origin\n");
  });
});
