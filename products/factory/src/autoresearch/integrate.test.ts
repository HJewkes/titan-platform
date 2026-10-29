import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedRepoWithOrigin, withHistory } from "@titan-design/test-kit/git";
import { afterEach, describe, expect, it } from "vitest";
import { execDatedGit, mergeOnto } from "./integrate.js";

const IDENTITY = ["-c", "user.name=integrate fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execDatedGit([...IDENTITY, ...args], cwd);
const AT = "2026-10-21T00:00:00Z";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

/** An integration tree with a bare `origin`: the round's new head, a winner that merges cleanly and one that conflicts. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ar-integrate-"));
  roots.push(root);
  const [bare, work] = [join(root, "origin.git"), join(root, "work")];
  seedRepoWithOrigin(work, bare, { "a.txt": "a\n", "b.txt": "b\n" });
  const pin = await git(work, "rev-parse", "HEAD");
  const [base, clean, clash] = withHistory(work, [
    { branch: "first", from: "main", files: { "a.txt": "a first\n" }, message: "first winner" },
    { branch: "later", from: "main", files: { "b.txt": "b later\n" }, message: "later winner" },
    { branch: "clash", from: "main", files: { "a.txt": "a later\n" }, message: "clashing winner" },
  ]);
  return { bare, work, pin, base: base!, clean: clean!, clash: clash! };
}

const remoteRefs = (bare: string) => git(bare, "for-each-ref", "--format=%(refname) %(objectname)");

describe("merging a later winner onto the round's new head", () => {
  it("builds a merge commit with the new head and the winner as parents and pushes nothing", async () => {
    const { bare, work, base, clean } = await fixture();
    const before = await remoteRefs(bare);

    const result = await mergeOnto(execDatedGit, { tree: work, base, head: clean, message: "ar: merge i-later onto base", at: AT });

    expect(result).toEqual({ merged: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const merged = "merged" in result ? result.merged : "";
    expect((await git(work, "rev-list", "--parents", "-n", "1", merged)).split(" ").slice(1)).toEqual([base, clean]);
    expect(await remoteRefs(bare)).toBe(before);
  });

  it("dates the merge with the step's first start, so a second call rebuilds the same sha", async () => {
    const { work, base, clean } = await fixture();
    const input = { tree: work, base, head: clean, message: "ar: merge i-later onto base", at: AT };

    const first = await mergeOnto(execDatedGit, input);
    const again = await mergeOnto(execDatedGit, input);

    expect(again).toEqual(first);
    const merged = "merged" in first ? first.merged : "";
    expect((await git(work, "log", "-1", "--format=%aI %cI", merged)).split(" ").map((date) => Date.parse(date))).toEqual([Date.parse(AT), Date.parse(AT)]);
  });

  it("names the conflicting files and leaves the tree clean at the new head", async () => {
    const { work, base, clash } = await fixture();

    const result = await mergeOnto(execDatedGit, { tree: work, base, head: clash, message: "ar: merge i-clash onto base", at: AT });

    expect(result).toEqual({ conflict: ["a.txt"] });
    expect(await git(work, "status", "--porcelain")).toBe("");
    expect(await git(work, "rev-parse", "HEAD")).toBe(base);
  });

  it("checks out the new head first, whatever an earlier step left in the tree", async () => {
    const { work, pin, base, clean } = await fixture();
    await git(work, "checkout", "--quiet", "--detach", pin);

    const result = await mergeOnto(execDatedGit, { tree: work, base, head: clean, message: "ar: merge i-later onto base", at: AT });

    const merged = "merged" in result ? result.merged : "";
    expect(await git(work, "rev-parse", `${merged}^1`)).toBe(base);
  });

  it("refuses a short sha or a missing first start by their own codes, before touching the tree", async () => {
    const { work, base, clean } = await fixture();
    const head = await git(work, "rev-parse", "HEAD");

    await expect(mergeOnto(execDatedGit, { tree: work, base: base.slice(0, 12), head: clean, message: "m", at: AT })).rejects.toThrow("[integrate-sha]");
    await expect(mergeOnto(execDatedGit, { tree: work, base, head: clean, message: "m" })).rejects.toThrow("[integrate-at]");
    expect(await git(work, "rev-parse", "HEAD")).toBe(head);
  });
});
