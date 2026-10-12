import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGitHub, successRun } from "./fake.js";
import { gitMergeTree } from "./git-merge-tree.js";
import { githubPort } from "./port.js";
import { premerge } from "./premerge.js";

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

describe("premerge --clone over a real clone", () => {
  /** A topic head, a clean old base it branched from, and a newer base tip that conflicts with it. */
  function staleClone(): { head: string; oldBase: string; tip: string } {
    const oldBase = git("rev-parse", "HEAD");
    git("checkout", "-qb", "topic");
    const head = commitFile("shared.txt", "topic\n");
    git("checkout", "-q", "main");
    const tip = commitFile("shared.txt", "base\n");
    git("update-ref", "refs/remotes/origin/main", oldBase);
    return { head, oldBase, tip };
  }

  async function gate(head: string, tip: string) {
    const fake = fakeGitHub({ baseSha: tip });
    fake.rules = { contexts: ["validate"], strict: false };
    fake.addPr({ headSha: head, mergeableState: "unknown" });
    fake.setRuns(head, [successRun("validate", 1)]);
    return premerge(githubPort(fake.wire), { repo: "o/r", number: 1, headSha: head, approvedHead: head, cleanMergeTree: gitMergeTree(clone) });
  }

  it("fails a head that conflicts only with the real base tip when the clone's origin/<base> is stale", async () => {
    const { head, tip } = staleClone();

    expect(await gate(head, tip)).toMatchObject({ ok: false, reasons: [`merge-tree conflict vs main tip ${tip}`] });
  });

  it("is not fooled by a local branch named origin/<base> pointing at a clean base", async () => {
    const { head, oldBase, tip } = staleClone();
    git("branch", "origin/main", oldBase);

    expect(await gate(head, tip)).toMatchObject({ ok: false, reasons: [`merge-tree conflict vs main tip ${tip}`] });
  });

  it("fails when the clone was never fetched and lacks the base tip", async () => {
    const { head } = staleClone();
    const unfetched = "e".repeat(40);

    const result = await gate(head, unfetched);

    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(new RegExp(`^merge-tree of ${head} and main tip ${unfetched} failed: git merge-tree exited`));
  });

  it("is ok when the head merges cleanly into the real base tip", async () => {
    const oldBase = git("rev-parse", "HEAD");
    git("checkout", "-qb", "topic");
    const head = commitFile("topic.txt", "topic\n");
    git("checkout", "-q", "main");
    const tip = commitFile("base.txt", "base\n");
    git("update-ref", "refs/remotes/origin/main", oldBase);

    expect(await gate(head, tip)).toMatchObject({ ok: true, reasons: [] });
  });
});
