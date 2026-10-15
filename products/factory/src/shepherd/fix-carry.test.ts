import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixCarry, type FixCarryResult } from "./fix-carry.js";

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

  it("asks again at a small fix on top of the approved head, the tp#1516 shape", async () => {
    const { h1 } = approvedAndMergedUp();
    const fixed = body(60, "a").replace("a 1\n", "a one\n").replace("a 2\n", "a two\n");
    const fix = commit("src/a.ts", fixed);

    expect(await probe(h1, fix)).toMatchObject({ carries: false, reason: expect.stringContaining("differs") });
  });

  it("asks again when a fix commit is followed by a pure merge-up of the base", async () => {
    const { h1 } = approvedAndMergedUp();
    commit("src/a.ts", body(60, "a").replace("a 1\n", "a one\n").replace("a 2\n", "a two\n"));
    git("checkout", "-q", "main");
    commit("other.txt", "main moved again\n");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "main");

    expect(await probe(h1, git("rev-parse", "HEAD"))).toMatchObject({ carries: false });
  });

  it("carries a pure merge-up of a later base commit onto the approved head", async () => {
    const { h1 } = approvedAndMergedUp();
    git("checkout", "-q", "main");
    commit("other.txt", "main moved again\n");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "main");

    expect(await probe(h1, git("rev-parse", "HEAD"))).toMatchObject({ carries: true, rule: "merge-up" });
  });

  it("asks again at a rebase of the approved head onto the moved base, even with an identical tree", async () => {
    commit("src/a.ts", body(60, "a"));
    git("checkout", "-q", "-B", "feature", "HEAD");
    const h1 = commit("src/a.ts", body(60, "a").replace("a 1\n", "a one\n"));
    git("checkout", "-q", "-B", "main", "main");
    commit("other.txt", "main moved\n");
    git("checkout", "-q", "-B", "rebased", "main");
    git("cherry-pick", h1);

    const result = await probe(h1, git("rev-parse", "HEAD"));

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("rebase") });
  });

  it("asks again when git cannot be read", async () => {
    const result = await fixCarry({ repo: REPO, baseRef: "main", fromHead: "a".repeat(40), head: "b".repeat(40) }, { stateDir, remote: () => join(root, "missing") });

    expect(result.carries).toBe(false);
  });
});
