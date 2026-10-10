import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SMALL_FIX_LIMITS, fixCarry, type FixCarryResult } from "./fix-carry.js";

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

function write(file: string, text: string): void {
  mkdirSync(dirname(join(origin, file)), { recursive: true });
  writeFileSync(join(origin, file), text);
  git("add", file);
}

function commit(file: string, text: string): string {
  write(file, text);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

const body = (count: number, tag: string): string => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n") + "\n";

/** An approved head on `feature` that changed src/a.ts and src/b.ts, with main moved on by an unrelated commit and merged in. */
function approvedAndMergedUp(): { h1: string; h2: string } {
  commit("src/a.ts", body(60, "a"));
  commit("src/b.ts", body(60, "b"));
  commit("src/untouched.ts", body(10, "u"));
  git("checkout", "-q", "-B", "feature", "HEAD");
  commit("src/a.ts", body(60, "a").replace("a 1\n", "a one\n"));
  const h1 = commit("src/b.ts", body(60, "b").replace("b 1\n", "b one\n"));
  git("checkout", "-q", "-B", "main", "main");
  commit("other.txt", "main moved\n");
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return { h1, h2: git("rev-parse", "HEAD") };
}

const probe = (fromHead: string, head: string): Promise<FixCarryResult> =>
  fixCarry({ repo: REPO, baseRef: "main", fromHead, head }, { stateDir, remote: () => origin });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fix-carry-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env: TEST_GIT_ENV });
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("fixCarry", { timeout: 30_000 }, () => {
  it("carries a head that is the approved head merged with the base and nothing else", async () => {
    const { h1, h2 } = approvedAndMergedUp();

    const result = await probe(h1, h2);

    expect(result).toMatchObject({ carries: true, rule: "merge-up", changedLines: 0 });
    expect(result.mergeTree).toBe(git("rev-parse", `${h2}^{tree}`));
  });

  it("asks again when the merge-up was resolved by hand", async () => {
    commit("src/a.ts", "base\n");
    git("checkout", "-q", "-B", "feature", "HEAD");
    const h1 = commit("src/a.ts", "feature\n");
    git("checkout", "-q", "-B", "main", "main");
    commit("src/a.ts", "main\n");
    git("checkout", "-q", "feature");
    expect(() => git("merge", "-q", "main")).toThrow();
    write("src/a.ts", "resolved\n");
    git("commit", "-q", "--no-edit");

    const result = await probe(h1, git("rev-parse", "HEAD"));

    expect(result.carries).toBe(false);
  });

  it("carries a 12-line fix to a file the PR already changed, on top of the merge-up", async () => {
    const { h1 } = approvedAndMergedUp();
    const fixed = body(60, "a").replace("a 1\n", "a one\n").split("\n").map((line, i) => (i >= 20 && i < 26 ? `${line} fixed` : line)).join("\n");
    const h2 = commit("src/a.ts", fixed);

    const result = await probe(h1, h2);

    expect(result).toMatchObject({ carries: true, rule: "small-fix", changedLines: 12, paths: ["src/a.ts"] });
  });

  it("carries the fix when it follows the merge-up rather than precedes it", async () => {
    const { h1, h2 } = approvedAndMergedUp();
    const fixed = commit("src/b.ts", body(60, "b").replace("b 1\n", "b one\n").replace("b 2\n", "b two\n"));

    expect(await probe(h1, fixed)).toMatchObject({ carries: true, rule: "small-fix", changedLines: 2 });
    expect(h2).not.toBe(fixed);
  });

  it("asks again at a fix of 41 changed lines and carries one of exactly 40", async () => {
    const { h1 } = approvedAndMergedUp();
    const edit = (count: number): string => body(60, "a").replace("a 1\n", "a one\n").split("\n").map((line, i) => (i >= 10 && i < 10 + count ? `${line} x` : line)).join("\n");
    const forty = commit("src/a.ts", edit(SMALL_FIX_LIMITS.maxChangedLines / 2));
    const fortyOne = commit("src/a.ts", `${edit(SMALL_FIX_LIMITS.maxChangedLines / 2)}appended\n`);

    expect(await probe(h1, forty)).toMatchObject({ carries: true, rule: "small-fix", changedLines: SMALL_FIX_LIMITS.maxChangedLines });
    expect(await probe(h1, fortyOne)).toMatchObject({ carries: false, reason: expect.stringContaining("41 lines") });
  });

  it("asks again when the fix adds a file", async () => {
    const { h1 } = approvedAndMergedUp();

    expect((await probe(h1, commit("src/new.ts", "x\n"))).carries).toBe(false);
  });

  it("asks again when the fix touches a file the PR had not changed", async () => {
    const { h1 } = approvedAndMergedUp();

    const result = await probe(h1, commit("src/untouched.ts", body(10, "u").replace("u 1\n", "u one\n")));

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("did not change") });
  });

  it("asks again when the fix touches a .github file the PR already changed", async () => {
    commit("a.txt", "a\n");
    git("checkout", "-q", "-B", "feature", "HEAD");
    const h1 = commit(".github/workflows/ci.yml", "on: push\n");

    expect(await probe(h1, commit(".github/workflows/ci.yml", "on: pull_request\n"))).toMatchObject({ carries: false, reason: "the fix changes .github" });
  });

  it("asks again when the fix changes a lockfile or a package.json dependency, and carries a package.json script edit", async () => {
    commit("a.txt", "a\n");
    git("checkout", "-q", "-B", "feature", "HEAD");
    commit("pnpm-lock.yaml", "lock: 1\n");
    const h1 = commit("package.json", JSON.stringify({ scripts: { test: "a" }, dependencies: { x: "1.0.0" } }, null, 2) + "\n");
    const lock = commit("pnpm-lock.yaml", "lock: 2\n");
    const dep = commit("package.json", JSON.stringify({ scripts: { test: "a" }, dependencies: { x: "2.0.0" } }, null, 2) + "\n");
    git("checkout", "-q", "-B", "script", h1);
    const script = commit("package.json", JSON.stringify({ scripts: { test: "b" }, dependencies: { x: "1.0.0" } }, null, 2) + "\n");

    expect(await probe(h1, lock)).toMatchObject({ carries: false, reason: "the fix changes a lockfile" });
    expect(await probe(h1, dep)).toMatchObject({ carries: false, reason: "the fix changes package.json dependencies" });
    expect(await probe(h1, script)).toMatchObject({ carries: true, rule: "small-fix" });
  });

  it("asks again when more than three files change", async () => {
    commit("a.txt", "a\n");
    git("checkout", "-q", "-B", "feature", "HEAD");
    for (const name of ["1", "2", "3", "4"]) commit(`f${name}.txt`, "x\n");
    const h1 = git("rev-parse", "HEAD");
    for (const name of ["1", "2", "3", "4"]) commit(`f${name}.txt`, "y\n");

    expect(await probe(h1, git("rev-parse", "HEAD"))).toMatchObject({ carries: false, reason: expect.stringContaining("4 files") });
  });

  it("asks again when git cannot be read", async () => {
    const result = await fixCarry({ repo: REPO, baseRef: "main", fromHead: "a".repeat(40), head: "b".repeat(40) }, { stateDir, remote: () => join(root, "missing") });

    expect(result.carries).toBe(false);
  });
});
