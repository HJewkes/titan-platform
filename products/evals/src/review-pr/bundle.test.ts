import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localCloneGit, materializeBundle, type BundleGit } from "./bundle.js";

const FIX_MARKER = "later-fix-7f3a";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? [path, ...walk(path)] : [path];
  });
}

describe("materializeBundle", () => {
  let scratch: string;
  let clone: string;
  let base: string;
  let head: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "review-pr-bundle-"));
    clone = join(scratch, "clone");
    mkdirSync(clone);
    git(clone, "init", "-q");
    base = commit(clone, { "src/add.ts": "export const add = (a: number, b: number) => a + b;\n" }, "base");
    head = commit(clone, { "src/add.ts": "export const add = (a: number, b: number) => a - b;\n", "src/add.test.ts": "it('adds', () => {});\n" }, "head");
    commit(clone, { "src/add.ts": `export const add = (a: number, b: number) => a + b; // ${FIX_MARKER}\n` }, "fix");
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("writes head and base trees with no .git, the exact base..head diff, and nothing of the later fix", async () => {
    const dir = join(scratch, "bundle-a");

    const bundle = await materializeBundle(localCloneGit(clone), { head, base }, dir);

    const files = walk(dir);
    expect(files.some((path) => path.split("/").includes(".git"))).toBe(false);
    expect(readFileSync(join(bundle.head, "src/add.ts"), "utf8")).toContain("a - b");
    expect(readFileSync(join(bundle.base, "src/add.ts"), "utf8")).toContain("a + b");
    expect(readFileSync(bundle.diff, "utf8")).toBe(execFileSync("git", ["-C", clone, "diff", base, head], { encoding: "utf8" }));
    expect(files.filter((path) => statSync(path).isFile() && readFileSync(path, "utf8").includes(FIX_MARKER))).toEqual([]);
  });

  it("runs only local git reads through its port: never gh, a fetch, a remote or a push", async () => {
    const calls: string[][] = [];
    const real = localCloneGit(clone);
    const recording: BundleGit = { git: (args) => (calls.push([...args]), real.git(args)) };

    await materializeBundle(recording, { head, base }, join(scratch, "bundle-b"));

    expect(calls.map((args) => args[0])).toEqual(["cat-file", "cat-file", "archive", "archive", "diff"]);
    expect(calls.flat().join(" ")).not.toMatch(/\b(gh|fetch|remote|push|pull|clone)\b/);
  });

  it("refuses a ref name, which could move, in place of a full sha", async () => {
    await expect(materializeBundle(localCloneGit(clone), { head: "HEAD", base }, join(scratch, "bundle-c"))).rejects.toThrow(/40-hex/);
  });
});
