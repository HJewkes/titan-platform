import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureEnv, seedRepo } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { inspectForRelease } from "./release-safety.js";
import { sweepWorktrees } from "./sweep.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: fixtureEnv() }).trim();

/** A clean tree on an agent branch whose .gitignore hides a generated doc and a scratch note. */
function repoWithIgnored(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ignored-files-")));
  roots.push(repo);
  seedRepo(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), "docs/generated/\nnotes.txt\n");
  git(["add", ".gitignore"], repo);
  git(["commit", "-m", "ignore"], repo);
  git(["checkout", "-b", "agent-chat/bob"], repo);
  fs.mkdirSync(path.join(repo, "docs/generated"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs/generated/cli-reference.md"), "generated\n");
  fs.writeFileSync(path.join(repo, "notes.txt"), "mine\n");
  return repo;
}

const inspect = (repo: string, ignoredFiles?: { disposable: string[] }) =>
  inspectForRelease(repo, repo, "agent-chat/bob", "HEAD", "git", undefined, ignoredFiles);

describe("ignored-file policy on release inspection", () => {
  it("refuses an ignored file outside the built-in list when no policy is given", async () => {
    const repo = repoWithIgnored();
    fs.rmSync(path.join(repo, "notes.txt"));
    const safety = await inspect(repo);
    expect(safety.dirty).toBe(true);
    expect(safety.checked[0]?.detail).toContain("docs/generated/");
  });

  it("lets an ignored file through when a caller pattern names it", async () => {
    const repo = repoWithIgnored();
    fs.rmSync(path.join(repo, "notes.txt"));
    expect((await inspect(repo, { disposable: ["docs/generated"] })).dirty).toBe(false);
  });

  it("matches a glob pattern across directories", async () => {
    const repo = repoWithIgnored();
    fs.rmSync(path.join(repo, "notes.txt"));
    expect((await inspect(repo, { disposable: ["docs/**"] })).dirty).toBe(false);
  });

  it("still refuses an ignored file the caller patterns do not match", async () => {
    const repo = repoWithIgnored();
    const safety = await inspect(repo, { disposable: ["docs/generated"] });
    expect(safety.dirty).toBe(true);
    expect(safety.checked[0]?.detail).toContain("notes.txt");
  });

  it("does not let a pattern match a longer sibling name", async () => {
    const repo = repoWithIgnored();
    fs.rmSync(path.join(repo, "notes.txt"));
    expect((await inspect(repo, { disposable: ["docs/gen"] })).dirty).toBe(true);
  });
});

describe("ignored-file policy on the sweep", () => {
  const classify = async (repo: string, ignoredFiles?: { disposable: string[] }) => {
    const list = async () => `worktree ${repo}\nbranch refs/heads/agent-chat/bob\n`;
    return (await sweepWorktrees({ roots: [repo], list, ...(ignoredFiles ? { ignoredFiles } : {}) }))[0]?.status;
  };

  it("holds the work by default and reclaims it when the policy covers the ignored files", async () => {
    const repo = repoWithIgnored();
    expect(await classify(repo)).toBe("holds-work");
    expect(await classify(repo, { disposable: ["docs/generated", "notes.txt"] })).toBe("reclaimable");
  });

  it("keeps holding when the policy covers only some ignored files", async () => {
    expect(await classify(repoWithIgnored(), { disposable: ["docs/generated"] })).toBe("holds-work");
  });
});
