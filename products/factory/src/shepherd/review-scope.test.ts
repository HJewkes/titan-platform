import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewScope, scopeFromDiff, type ReviewScopeResult } from "./review-scope.js";

const REPO = "acme/widgets";
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let root: string;
let origin: string;
let stateDir: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", origin, ...args], { encoding: "utf8", env: TEST_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(file: string, text: string): string {
  mkdirSync(dirname(join(origin, file)), { recursive: true });
  writeFileSync(join(origin, file), text);
  git("add", file);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

const body = (count: number, tag: string): string => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n") + "\n";
const reviewedA = body(60, "a").replace("a 1\n", "a one\n");

/** A reviewed head on `feature` that changed src/a.ts; main has not moved since the branch point. */
function reviewed(): string {
  commit("src/a.ts", body(60, "a"));
  git("checkout", "-q", "-B", "feature", "HEAD");
  return commit("src/a.ts", reviewedA);
}

function mergeMain(file: string, text: string): void {
  git("checkout", "-q", "main");
  commit(file, text);
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-ff", "--no-edit", "main");
}

const scope = (sinceHead: string, head: string): Promise<ReviewScopeResult> =>
  reviewScope({ repo: REPO, baseRef: "main", sinceHead, head }, { stateDir, remote: () => origin });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "review-scope-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env: TEST_GIT_ENV });
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("reviewScope", { timeout: 30_000 }, () => {
  it("scopes a fix commit on top of the reviewed head to that file's changed ranges", async () => {
    const h1 = reviewed();
    const h2 = commit("src/a.ts", reviewedA.replace("a 2\n", "a two\n").replace("a 9\n", ""));

    const result = await scope(h1, h2);

    expect(result).toEqual({
      scoped: true,
      sinceHead: h1,
      mergedBase: false,
      paths: ["src/a.ts"],
      hunks: [
        { path: "src/a.ts", start: 3, count: 1 },
        { path: "src/a.ts", start: 9, count: 0 },
      ],
      changedLines: 3,
    });
  });

  it("leaves out main's files when the fixer merged main before the fix", async () => {
    const h1 = reviewed();
    mergeMain("other.txt", "main moved\n");
    const h2 = commit("src/a.ts", reviewedA.replace("a 2\n", "a two\n"));

    const result = await scope(h1, h2);

    expect(result).toMatchObject({ scoped: true, mergedBase: true, paths: ["src/a.ts"], changedLines: 2 });
  });

  it("reads a rebase of the reviewed head as a full review", async () => {
    const h1 = reviewed();
    git("checkout", "-q", "main");
    commit("other.txt", "main moved\n");
    git("checkout", "-q", "-B", "rebased", "main");
    git("cherry-pick", h1);
    const h2 = commit("src/a.ts", reviewedA.replace("a 2\n", "a two\n"));

    expect(await scope(h1, h2)).toEqual({ scoped: false, reason: expect.stringContaining("rebase") });
  });

  it("reads a fixer's hand-resolved merge conflict with main as a full review", async () => {
    const h1 = reviewed();
    git("checkout", "-q", "main");
    commit("src/a.ts", body(60, "a").replace("a 1\n", "a uno\n"));
    git("checkout", "-q", "feature");
    expect(() => git("merge", "-q", "main")).toThrow();
    writeFileSync(join(origin, "src/a.ts"), reviewedA);
    git("commit", "-q", "-a", "--no-edit");
    const h2 = commit("src/b.ts", "fix\n");

    expect(await scope(h1, h2)).toEqual({ scoped: false, reason: expect.stringContaining("conflicts") });
  });

  it("scopes a fix of exactly 400 changed lines", async () => {
    const h1 = reviewed();
    const h2 = commit("src/big.ts", body(400, "n"));

    expect(await scope(h1, h2)).toMatchObject({ scoped: true, changedLines: 400 });
  });

  it("reads a fix of 401 changed lines as a full review", async () => {
    const h1 = reviewed();
    const h2 = commit("src/big.ts", body(401, "n"));

    expect(await scope(h1, h2)).toEqual({ scoped: false, reason: "401 changed lines, over 400" });
  });

  it("reads a fix touching more than 40 files as a full review", async () => {
    const h1 = reviewed();
    for (let i = 0; i < 41; i++) writeFileSync(join(origin, `f${i}.txt`), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "many");

    expect(await scope(h1, git("rev-parse", "HEAD"))).toEqual({ scoped: false, reason: "41 changed paths, over 40" });
  });

  it("reads a fix whose path holds a shell-active character as a full review, without echoing the path", async () => {
    const h1 = reviewed();
    const h2 = commit("src/$(id).ts", "x\n");

    expect(await scope(h1, h2)).toEqual({ scoped: false, reason: "a changed path has a shell-active character" });
  });

  it("reads an unreadable repository as a full review with a fixed-vocabulary reason", async () => {
    const result = await reviewScope({ repo: REPO, baseRef: "main", sinceHead: "a".repeat(40), head: "b".repeat(40) }, { stateDir, remote: () => join(root, "missing") });

    expect(result).toEqual({ scoped: false, reason: expect.stringMatching(/^git fetch exited \d+$/) });
  });

  it("reads the reviewed head itself as invalid input, never a scope", async () => {
    const result = await reviewScope({ repo: REPO, baseRef: "main", sinceHead: "a".repeat(40), head: "a".repeat(40) }, { stateDir });

    expect(result).toEqual({ scoped: false, reason: expect.stringContaining("sinceHead must differ from head") });
  });
});

describe("scopeFromDiff", () => {
  it("files a deleted file's hunk under its old path and reads a removed '-- x' line as content", () => {
    const numstat = "0\t2\tsrc/gone.ts\0";
    const unified = ["diff --git a/src/gone.ts b/src/gone.ts", "deleted file mode 100644", "--- a/src/gone.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-keep", "--- x"].join("\n");

    expect(scopeFromDiff(numstat, unified)).toEqual({ paths: ["src/gone.ts"], hunks: [{ path: "src/gone.ts", start: 0, count: 0 }], changedLines: 2 });
  });

  it("refuses a diff header git had to quote", () => {
    const numstat = "1\t0\tsrc/odd.ts\0";
    const unified = ['diff --git "a/src/\\303\\251.ts" "b/src/\\303\\251.ts"', '--- "a/src/\\303\\251.ts"', '+++ "b/src/\\303\\251.ts"', "@@ -0,0 +1 @@", "+x"].join("\n");

    expect(scopeFromDiff(numstat, unified)).toEqual({ scoped: false, reason: "the fix diff has a header it cannot read" });
  });
});
