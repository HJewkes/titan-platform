import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOOK_MARKER, hookBody, installHook } from "./install.js";
import { makeTestRepo, tempDir, withoutInjectedHooksPath, type TestRepo } from "./test-repo.js";

const dirs: string[] = [];
const originalEnv = { ...process.env };

// installHook reads the parent env, so an agent-injected core.hooksPath would redirect every fixture install.
beforeAll(() => {
  replaceProcessEnv(withoutInjectedHooksPath(originalEnv));
});

afterAll(() => {
  replaceProcessEnv(originalEnv);
});

function replaceProcessEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

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

  it("still honours a core.hooksPath injected through the parent env", () => {
    const repo = newRepo();
    const injected = tempDir("egress-injected-");
    dirs.push(injected);
    replaceProcessEnv({
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: injected,
    });

    try {
      expect(installHook(repo.dir, LOCAL).hookPath).toBe(path.join(injected, "pre-push"));
    } finally {
      replaceProcessEnv(withoutInjectedHooksPath(originalEnv));
    }
  });

  it("does nothing in CI", () => {
    const repo = newRepo();

    expect(installHook(repo.dir, { CI: "true" })).toEqual({ outcome: "skipped-in-ci" });
    expect(fs.existsSync(path.join(repo.dir, ".git", "hooks", "pre-push"))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the installed hook", () => {
  function fakeScanner(file: string, exitCode: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    installExecutable(file, `#!/bin/sh\necho "args:$*"\ncat\nexit ${exitCode}\n`);
  }

  // cp writes in a process that has exited before the first exec, so a concurrent fork never holds the target open for writing (ETXTBSY).
  function installExecutable(file: string, contents: string): void {
    const staging = `${file}.staging`;
    fs.writeFileSync(staging, contents);
    fs.chmodSync(staging, 0o755);
    execFileSync("cp", ["-p", staging, file]);
    fs.rmSync(staging);
  }

  /** Runs the hook with a PATH holding only the tools it needs, so a global scanner never leaks in. */
  function runHook(cwd: string, hookPath: string, extraPathDir?: string): ReturnType<typeof spawnSync> {
    const toolDir = path.join(tempDir("egress-tools-"), "bin");
    dirs.push(path.dirname(toolDir));
    fs.mkdirSync(toolDir, { recursive: true });
    for (const tool of ["sh", "git", "dirname", "cat", "node"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      fs.symlinkSync(found, path.join(toolDir, tool));
    }
    const env = { ...process.env, PATH: [extraPathDir, toolDir].filter((part) => part !== undefined).join(path.delimiter) };
    return spawnSync("sh", [hookPath, "origin", "git@example.com:o/r.git"], { cwd, env, input: "stdin-line\n" });
  }

  it("runs the pushing worktree's scanner with the remote name and git's stdin", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const fakeBin = path.join(worktree, "node_modules", ".bin", "titan-egress-scan");
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    installExecutable(fakeBin, '#!/bin/sh\necho "args:$*"\ncat\nexit 3\n');

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

  it("refuses the push and names all three places it looked when no scanner exists", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);

    const result = runHook(worktree, hookPath);
    const err = String(result.stderr);

    expect(result.status).toBe(1);
    expect(err).toContain(`${worktree}/node_modules`);
    expect(err).toContain(`${repo.dir}/node_modules`);
    expect(err).toContain("PATH");
    expect(err).toContain("pnpm install && pnpm build");
    expect(err).toContain("npm i -g @titan-design/egress-scan");
  });

  it("uses the main checkout's scanner from a linked worktree with no node_modules", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    fakeScanner(path.join(repo.dir, "node_modules", ".bin", "titan-egress-scan"), 5);

    const result = runHook(worktree, hookPath);

    expect(result.status).toBe(5);
    expect(String(result.stdout)).toBe("args:pre-push origin\nstdin-line\n");
  });

  it("uses the main checkout's built script when it has no .bin link", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const script = path.join(repo.dir, "node_modules", "@titan-design", "egress-scan", "dist", "bin.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "process.exitCode = 6;\n");

    expect(runHook(worktree, hookPath).status).toBe(6);
  });

  it("uses a scanner on PATH when neither checkout has one", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const pathDir = path.join(tempDir("egress-path-"), "bin");
    dirs.push(path.dirname(pathDir));
    fakeScanner(path.join(pathDir, "titan-egress-scan"), 7);

    const result = runHook(worktree, hookPath, pathDir);

    expect(result.status).toBe(7);
    expect(String(result.stdout)).toBe("args:pre-push origin\nstdin-line\n");
  });

  it("prefers the worktree's scanner over the main checkout's", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    fakeScanner(path.join(worktree, "node_modules", ".bin", "titan-egress-scan"), 3);
    fakeScanner(path.join(repo.dir, "node_modules", ".bin", "titan-egress-scan"), 5);

    expect(runHook(worktree, hookPath).status).toBe(3);
  });

  it("prefers the main checkout's scanner over PATH", () => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    const pathDir = path.join(tempDir("egress-path-"), "bin");
    dirs.push(path.dirname(pathDir));
    fakeScanner(path.join(pathDir, "titan-egress-scan"), 7);
    fakeScanner(path.join(repo.dir, "node_modules", ".bin", "titan-egress-scan"), 5);

    expect(runHook(worktree, hookPath, pathDir).status).toBe(5);
  });

  it.each([
    ["a dot segment", "."],
    ["a leading empty segment", ""],
    ["a middle empty segment", "/nonexistent-a::/nonexistent-b"],
  ])("fails closed when PATH has %s that would resolve a scanner planted in the pushed tree", (_name, extraPath) => {
    const repo = newRepo();
    const worktree = linkedWorktree(repo);
    const { hookPath = "" } = installHook(worktree, LOCAL);
    fakeScanner(path.join(worktree, "titan-egress-scan"), 0);

    const result = runHook(worktree, hookPath, extraPath);

    expect(result.status).toBe(1);
    expect(String(result.stdout)).toBe("");
    expect(String(result.stderr)).toContain("It looked in:");
  });

  it("never exits 0 when no scanner is found (kills the exit-0-when-none-found mutant)", () => {
    const repo = newRepo();
    const { hookPath = "" } = installHook(repo.dir, LOCAL);

    expect(runHook(repo.dir, hookPath).status).not.toBe(0);
  });
});
