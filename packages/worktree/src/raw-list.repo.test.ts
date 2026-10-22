import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { listWorktreesPorcelain } from "./index.js";
import { seedRepo } from "./git-fixture.js";
import { fixtureEnv } from "./test-env.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: fixtureEnv() });

function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "raw-worktrees-")));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("exposes every raw record and preserves Git's exact whitespace from the public API", async () => {
  const repo = directory();
  seedRepo(repo);
  const foreign = path.join(repo, "foreign tree ");
  const detached = path.join(repo, "detached tree");
  git(repo, "worktree", "add", "-b", "foreign/topic", foreign);
  git(repo, "worktree", "lock", "--reason", "keep this checkout", foreign);
  git(repo, "worktree", "add", "--detach", detached);

  const expected = git(repo, "worktree", "list", "--porcelain");
  const actual = await listWorktreesPorcelain(repo);

  expect(actual).toBe(expected);
  expect(actual.startsWith("worktree " + repo + "\n")).toBe(true);
  expect(actual.endsWith("\n\n")).toBe(true);
  expect(actual).toContain("branch refs/heads/foreign/topic\n");
  expect(actual).toContain("locked keep this checkout\n");
  expect(actual).toContain("detached\n");
  expect(fs.existsSync(foreign)).toBe(true);
  expect(fs.existsSync(detached)).toBe(true);
});

it("rejects a Git refusal rather than treating empty stdout as a successful listing", async () => {
  const plainDirectory = directory();

  await expect(listWorktreesPorcelain(plainDirectory)).rejects.toMatchObject({
    status: 128,
    stdout: "",
    stderr: expect.stringContaining("not a git repository"),
  });

  expect(fs.existsSync(plainDirectory)).toBe(true);
});

it("returns a rejected Promise when Git cannot enter the requested directory", async () => {
  const missing = path.join(directory(), "missing");
  const request = listWorktreesPorcelain(missing);

  expect(request).toBeInstanceOf(Promise);
  await expect(request).rejects.toMatchObject({ code: "ENOENT" });
});
