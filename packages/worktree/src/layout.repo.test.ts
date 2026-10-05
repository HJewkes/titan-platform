import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeWorktree } from "./layout.js";
import { fixtureEnv } from "./test-env.js";

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: fixtureEnv() }).trim();

/** A repository with one commit and a worktree on `agent-chat/alice` holding an untracked file. */
function treeWithUntrackedFile(): { repo: string; tree: string } {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "layout-")));
  tmpdirs.push(repo);
  git(["init", "-q", "-b", "main"], repo);
  git(["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "seed"], repo);
  const tree = path.join(repo, "tree");
  git(["worktree", "add", "-q", "-b", "agent-chat/alice", tree], repo);
  fs.writeFileSync(path.join(tree, "notes.txt"), "draft\n");
  return { repo, tree };
}

describe("removing a worktree", () => {
  it("lets git's own refusal stand when the caller did not force", async () => {
    const { repo, tree } = treeWithUntrackedFile();

    const refused = await removeWorktree(repo, tree, "agent-chat/alice");

    expect(refused).toMatch(/git would not remove .*tree/);
    expect(fs.existsSync(path.join(tree, "notes.txt"))).toBe(true);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toContain("agent-chat/alice");
  });

  it("removes the tree and its branch when the caller forced", async () => {
    const { repo, tree } = treeWithUntrackedFile();

    expect(await removeWorktree(repo, tree, "agent-chat/alice", { force: true })).toBeUndefined();

    expect(fs.existsSync(tree)).toBe(false);
    expect(git(["branch", "--list", "agent-chat/alice"], repo)).toBe("");
  });
});
