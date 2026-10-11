import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitMergeTree } from "./git-merge-tree.js";

let clone: string;

const git = (...args: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf-8" }).trim();

function commitFile(name: string, content: string): string {
  fs.writeFileSync(path.join(clone, name), content);
  git("add", name);
  git("commit", "-qm", name);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  clone = fs.mkdtempSync(path.join(os.tmpdir(), "git-merge-tree-"));
  git("init", "-q", "-b", "main");
  commitFile("shared.txt", "one\n");
});

afterEach(() => fs.rmSync(clone, { recursive: true, force: true }));

describe("gitMergeTree", () => {
  it("returns the tree of a clean merge, the same tree git merge records", async () => {
    git("checkout", "-qb", "topic");
    const reviewed = commitFile("topic.txt", "topic\n");
    git("checkout", "-q", "main");
    const baseParent = commitFile("base.txt", "base\n");
    git("checkout", "-q", "topic");
    git("merge", "-q", "--no-edit", "main");

    expect(await gitMergeTree(clone)(baseParent, reviewed)).toBe(git("rev-parse", "HEAD^{tree}"));
  });

  it("returns null when the two commits conflict", async () => {
    git("checkout", "-qb", "topic");
    const reviewed = commitFile("shared.txt", "topic\n");
    git("checkout", "-q", "main");
    const baseParent = commitFile("shared.txt", "base\n");

    expect(await gitMergeTree(clone)(baseParent, reviewed)).toBeNull();
  });

  it("rejects when a commit is not in the clone", async () => {
    const head = git("rev-parse", "HEAD");

    await expect(gitMergeTree(clone)("0".repeat(40), head)).rejects.toThrow(/git merge-tree exited/);
  });
});
