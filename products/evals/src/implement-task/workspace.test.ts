import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localCloneGit } from "../review-pr/bundle.js";
import { buildMergedPr, git, type MergedPr } from "./test-fixture.js";
import { assertNoLaterHistory, seedWorkspace, writeBaseTree } from "./workspace.js";

let root: string;
let clone: string;
let pr: MergedPr;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "implement-workspace-"));
  clone = join(root, "clone");
  mkdirSync(clone);
  pr = buildMergedPr(clone);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("base tree", () => {
  it("archives the merge's first parent with no .git and none of the PR's files", async () => {
    const out = join(root, "out");

    const tree = await writeBaseTree(localCloneGit(clone), { base: pr.base, merge: pr.merge }, out, "case-1");

    expect(tree.path).toBe("trees/case-1");
    expect(tree.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(out, tree.path, "src/a.ts"))).toBe(true);
    expect(existsSync(join(out, tree.path, "src/x.test.ts"))).toBe(false);
    expect(existsSync(join(out, tree.path, ".git"))).toBe(false);
  });

  it("refuses a base that is not the merge's first parent", async () => {
    const out = join(root, "out");

    const writing = writeBaseTree(localCloneGit(clone), { base: pr.merge, merge: pr.merge }, out, "case-1");

    await expect(writing).rejects.toThrow(/is not the first parent/);
  });
});

describe("seeded workspace", () => {
  it("holds exactly one commit and cannot reach the accepted merge", async () => {
    const out = join(root, "out");
    const tree = await writeBaseTree(localCloneGit(clone), { base: pr.base, merge: pr.merge }, out, "case-1");
    const workspace = join(root, "workspace");

    await seedWorkspace(join(out, tree.path), workspace);

    expect(git(workspace, "rev-list", "--all", "--count")).toBe("1");
    expect(() => git(workspace, "cat-file", "-e", `${pr.merge}^{commit}`)).toThrow();
    expect(existsSync(join(workspace, "src/x.test.ts"))).toBe(false);
    await expect(assertNoLaterHistory(workspace, pr.merge)).resolves.toBeUndefined();
  });

  it("gives the same commit sha for two seeds of one tree", async () => {
    const out = join(root, "out");
    const tree = await writeBaseTree(localCloneGit(clone), { base: pr.base, merge: pr.merge }, out, "case-1");

    const first = await seedWorkspace(join(out, tree.path), join(root, "first"));
    const second = await seedWorkspace(join(out, tree.path), join(root, "second"));

    expect(first).toMatch(/^[0-9a-f]{40}$/);
    expect(second).toBe(first);
  });

  it("refuses a workspace that is a clone of the source history", async () => {
    const copy = join(root, "copy");
    git(root, "clone", "-q", clone, copy);

    const asserting = assertNoLaterHistory(copy, pr.merge);

    await expect(asserting).rejects.toThrow(/holds \d+ commits/);
  });

  it("refuses a one-commit workspace that still holds the merge object", async () => {
    const workspace = join(root, "workspace");
    await seedWorkspace(join(clone, "src"), workspace);
    git(workspace, "fetch", "-q", clone, pr.merge);

    const asserting = assertNoLaterHistory(workspace, pr.merge);

    await expect(asserting).rejects.toThrow(/holds the accepted merge/);
  });
});
