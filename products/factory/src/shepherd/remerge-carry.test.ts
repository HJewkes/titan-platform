import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatedPathsFor, remerge, remergeFact, type RemergeResult } from "./remerge-carry.js";

const REPO = "acme/widgets";
const GENERATED = ["CAPABILITIES.md", "site/generated/**"];
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

function branchAt(name: string, at: string): void {
  git("checkout", "-q", "-B", name, at);
}

/** main and the reviewed head on `feature` both edit `file`, so merging main into the reviewed head conflicts there. */
function conflictingOn(file: string): string {
  commit(file, "base\n");
  commit("b.txt", "b0\n");
  branchAt("feature", "HEAD");
  const reviewed = commit(file, "feature\n");
  branchAt("main", "main");
  commit(file, "main\n");
  branchAt("feature", "feature");
  return reviewed;
}

/** Merges main, takes `resolution` for every conflicted file, and commits the merge. */
function resolveMerge(resolution: Record<string, string>): string {
  expect(() => git("merge", "-q", "main")).toThrow();
  for (const [file, text] of Object.entries(resolution)) write(file, text);
  git("commit", "-q", "--no-edit");
  return git("rev-parse", "HEAD");
}

/** The reviewed head on `feature`, with main moved on by one unrelated commit. */
function reviewedHead(): { m0: string; h1: string } {
  const m0 = commit("a.txt", "a0\n");
  commit("b.txt", "b0\n");
  branchAt("feature", "HEAD");
  const h1 = commit("a.txt", "a1\n");
  branchAt("main", "main");
  commit("b.txt", "b1\n");
  branchAt("feature", "feature");
  return { m0, h1 };
}

function mergeMain(): string {
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return git("rev-parse", "HEAD");
}

const probe = (fromHead: string, head: string, remote = origin): Promise<RemergeResult> =>
  remerge({ repo: REPO, baseRef: "main", fromHead, head, generated: GENERATED }, { stateDir, remote: () => remote });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "remerge-carry-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env: TEST_GIT_ENV });
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("remerge", { timeout: 30_000 }, () => {
  it("carries a merge of main whose remerge-diff is empty", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    const result = await probe(h1, h2);

    expect(result).toMatchObject({ carries: true, rule: "remerge-empty", base: git("rev-parse", "main"), paths: [] });
    expect(result.remergeTree).toBe(git("rev-parse", `${h2}^{tree}`));
  });

  it("carries a merge whose only resolution is in a declared generated file", async () => {
    const reviewed = conflictingOn("CAPABILITIES.md");
    const head = resolveMerge({ "CAPABILITIES.md": "regenerated\n" });

    expect(await probe(reviewed, head)).toMatchObject({ carries: true, rule: "remerge-generated-only", paths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] });
  });

  it("carries a merge that regenerated files under a declared glob", async () => {
    const reviewed = conflictingOn("site/generated/widgets.md");
    const head = resolveMerge({ "site/generated/widgets.md": "regenerated\n" });

    expect(await probe(reviewed, head)).toMatchObject({ carries: true, rule: "remerge-generated-only", paths: ["site/generated/widgets.md"] });
  });

  it.each(["site/reference/widgets.md", ".codewatch/check.json"])("does not carry a titan-platform merge that resolved hand-written %s", async (file) => {
    const reviewed = conflictingOn(file);
    const head = resolveMerge({ [file]: "resolved\n" });

    const result = await remerge({ repo: REPO, baseRef: "main", fromHead: reviewed, head, generated: generatedPathsFor("HJewkes/titan-platform") }, { stateDir, remote: () => origin });

    expect(result).toMatchObject({ carries: false, paths: [file], generatedPaths: [] });
  });

  it("does not carry a merge that resolved a conflict in a reviewed file", async () => {
    const reviewed = conflictingOn("a.txt");
    const head = resolveMerge({ "a.txt": "resolved\n" });

    expect(await probe(reviewed, head)).toMatchObject({ carries: false, paths: ["a.txt"], generatedPaths: [], reason: expect.stringContaining("outside the declared generated files") });
  });

  it("does not carry a merge that resolved a generated file and a reviewed one", async () => {
    const reviewed = conflictingOn("a.txt");
    const head = resolveMerge({ "a.txt": "resolved\n", "CAPABILITIES.md": "regenerated\n" });

    expect(await probe(reviewed, head)).toMatchObject({ carries: false, paths: ["CAPABILITIES.md", "a.txt"], generatedPaths: ["CAPABILITIES.md"] });
  });

  it("does not carry a merge that committed conflict markers in a reviewed file", async () => {
    const reviewed = conflictingOn("a.txt");
    expect(() => git("merge", "-q", "main")).toThrow();
    git("commit", "-q", "-a", "--no-edit");
    const head = git("rev-parse", "HEAD");

    expect(await probe(reviewed, head)).toMatchObject({ carries: false, paths: ["a.txt"] });
  });

  it("does not carry a clean merge that also changed a reviewed file", async () => {
    const { h1 } = reviewedHead();
    git("merge", "-q", "--no-ff", "--no-commit", "main");
    write("a.txt", "slipped in\n");
    git("commit", "-q", "--no-edit");
    const head = git("rev-parse", "HEAD");

    expect(await probe(h1, head)).toMatchObject({ carries: false, paths: ["a.txt"] });
  });

  it("does not carry when the merged-in second parent is not on the base branch", async () => {
    const { m0, h1 } = reviewedHead();
    branchAt("side", m0);
    commit("d.txt", "unreviewed\n");
    branchAt("feature", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const head = git("rev-parse", "HEAD");

    expect(await probe(h1, head)).toMatchObject({ carries: false, reason: expect.stringContaining("is not on main") });
  });

  it("does not carry when the first parent is not the reviewed head", async () => {
    const { h1 } = reviewedHead();
    commit("a.txt", "a2\n");
    const head = mergeMain();

    expect(await probe(h1, head)).toMatchObject({ carries: false, reason: `${head} is not ${h1} plus one merge` });
  });

  it("does not carry a rebase, which has one parent", async () => {
    const { h1 } = reviewedHead();
    git("rebase", "-q", "main");

    expect(await probe(h1, git("rev-parse", "HEAD"))).toMatchObject({ carries: false, reason: expect.stringContaining("plus one merge") });
  });

  it("does not carry a generated-file resolution in a repo that declares none", async () => {
    const reviewed = conflictingOn("CAPABILITIES.md");
    const head = resolveMerge({ "CAPABILITIES.md": "regenerated\n" });

    const result = await remerge({ repo: REPO, baseRef: "main", fromHead: reviewed, head, generated: [] }, { stateDir, remote: () => origin });

    expect(result).toMatchObject({ carries: false, paths: ["CAPABILITIES.md"] });
  });

  it("does not carry when the fetch fails, and never throws", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    expect(await probe(h1, h2, join(root, "missing"))).toMatchObject({ carries: false, reason: expect.stringContaining("git fetch") });
  });

  it("does not carry malformed input and touches no git", async () => {
    const result = await remerge({ repo: "../escape", baseRef: "--upload-pack=x", fromHead: "abc", head: "def", generated: [] }, { stateDir });

    expect(result.carries).toBe(false);
    expect(existsSync(join(stateDir, "git-cache"))).toBe(false);
  });
});

describe("generatedPathsFor", () => {
  it("reads titan-platform's declared generated files from data, whatever the repo's case", () => {
    expect(generatedPathsFor("HJewkes/titan-platform")).toEqual(["CAPABILITIES.md", "site/guides/capabilities.md", "site/reference/index.md", "site/.vitepress/reference-sidebar.json"]);
  });

  it("declares nothing for a repo it does not list", () => {
    expect(generatedPathsFor(REPO)).toEqual([]);
  });
});

describe("remergeFact", () => {
  const from = "b".repeat(40);
  const head = "a".repeat(40);

  it("names the rule and both path lists for the authority", () => {
    const result: RemergeResult = { carries: true, rule: "remerge-generated-only", headTree: "t1", remergeTree: "t2", paths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] };

    expect(remergeFact(from, head, result)).toEqual({ fromHead: from, head, headTree: "t1", mergeTree: "t2", rule: "remerge-generated-only", remergePaths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] });
  });

  it("makes no fact from an answer that does not carry", () => {
    expect(remergeFact(from, head, { carries: false, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] })).toBeUndefined();
  });
});
