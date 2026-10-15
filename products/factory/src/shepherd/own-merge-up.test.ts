import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownMergeUp, type OwnMergeUpResult } from "./own-merge-up.js";

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

const body = (tag: string, count = 40): string => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n") + "\n";
const head = (): string => git("rev-parse", "HEAD");

/** main holds two files; `feature` changes src/a.ts and is returned as the approved head, with the checkout on feature. */
function approvedFeature(): string {
  commit("src/a.ts", body("a"));
  commit("src/b.ts", body("b"));
  git("checkout", "-q", "-B", "feature", "HEAD");
  return commit("src/a.ts", body("a").replace("a 1\n", "a one\n"));
}

function mainCommit(file: string, text: string): string {
  git("checkout", "-q", "main");
  const sha = commit(file, text);
  git("checkout", "-q", "feature");
  return sha;
}

const mergeMain = (): string => {
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return head();
};

const probe = (fromHead: string, to: string): Promise<OwnMergeUpResult> => ownMergeUp({ repo: REPO, baseRef: "main", fromHead, head: to }, { stateDir, remote: () => origin });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "own-merge-up-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env: TEST_GIT_ENV });
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ownMergeUp", { timeout: 30_000 }, () => {
  it("carries the approved head merged with main commits that touch none of the PR's files", async () => {
    const h1 = approvedFeature();
    mainCommit("other.txt", "main moved\n");
    mainCommit("src/b.ts", body("b").replace("b 5\n", "b five\n"));

    const result = await probe(h1, mergeMain());

    expect(result).toMatchObject({ carries: true, rule: "own-merge-up", prPaths: ["src/a.ts"], mainPaths: ["other.txt", "src/b.ts"] });
    expect(result.mergeTree).toBe(result.headTree);
  });

  it.each(["packages/authority/src/table.json", "packages/tool-guard/src/x.ts", ".github/workflows/ci.yml"])("refuses a merge-up whose main side changes the carry-fenced %s", async (path) => {
    const h1 = approvedFeature();
    mainCommit("other.txt", "main moved\n");
    mainCommit(path, "fenced\n");

    const result = await probe(h1, mergeMain());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining(`carry-fenced path(s): ${path}`), mainPaths: expect.arrayContaining([path]) });
  });

  it("refuses a case-folded workflows path on main's side", async () => {
    const h1 = approvedFeature();
    mainCommit(".GitHub/Workflows/release.yml", "fenced\n");

    expect(await probe(h1, mergeMain())).toMatchObject({ carries: false, reason: expect.stringContaining(".GitHub/Workflows/release.yml") });
  });

  it("refuses a main-side rename out of a fenced directory, which still lists the old path", async () => {
    commit("packages/authority/a.ts", body("fenced"));
    const h1 = approvedFeature();
    git("checkout", "-q", "main");
    mkdirSync(join(origin, "lib"));
    git("mv", "packages/authority/a.ts", "lib/a.ts");
    git("commit", "-q", "-m", "move a out of authority");
    git("checkout", "-q", "feature");

    const result = await probe(h1, mergeMain());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("packages/authority/a.ts"), mainPaths: ["lib/a.ts", "packages/authority/a.ts"] });
  });

  it("carries when main's side only nears a fenced prefix", async () => {
    const h1 = approvedFeature();
    mainCommit("packages/authority-x/a.ts", "near\n");
    mainCommit("docs/tool-guard.md", "near\n");

    expect(await probe(h1, mergeMain())).toMatchObject({ carries: true, mainPaths: ["docs/tool-guard.md", "packages/authority-x/a.ts"] });
  });

  it("carries a second merge-up from the head the first one made", async () => {
    const h1 = approvedFeature();
    mainCommit("other.txt", "one\n");
    const h2 = mergeMain();
    mainCommit("third.txt", "two\n");

    expect(await probe(h1, h2)).toMatchObject({ carries: true });
    expect(await probe(h2, mergeMain())).toMatchObject({ carries: true, prPaths: ["src/a.ts"] });
  });

  it("refuses a head that is not a merge commit", async () => {
    const h1 = approvedFeature();
    const h2 = commit("src/a.ts", body("a").replace("a 2\n", "a two\n"));

    expect(await probe(h1, h2)).toMatchObject({ carries: false, reason: expect.stringContaining("1 parent(s)") });
  });

  it("refuses a merge whose first parent is not the approved head", async () => {
    const h1 = approvedFeature();
    commit("src/a.ts", body("a").replace("a 3\n", "a three\n"));
    mainCommit("other.txt", "main moved\n");

    const result = await probe(h1, mergeMain());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("is not the approved head") });
  });

  it("refuses a merge whose second parent is not on main", async () => {
    const h1 = approvedFeature();
    git("checkout", "-q", "-B", "topic", "main");
    commit("side.txt", "side\n");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "topic");

    const result = await probe(h1, head());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("is not on main") });
  });

  it("refuses a merge whose tree is not git's merge-tree of its parents", async () => {
    const h1 = approvedFeature();
    mainCommit("other.txt", "main moved\n");
    git("merge", "-q", "--no-ff", "--no-commit", "main");
    write("src/a.ts", body("a").replace("a 1\n", "a one\n").replace("a 9\n", "a smuggled\n"));
    git("commit", "-q", "--no-edit");

    const result = await probe(h1, head());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("differs from") });
  });

  it("refuses a merge whose main side touches a file the PR changed, even when git merges it cleanly", async () => {
    const h1 = approvedFeature();
    mainCommit("src/a.ts", body("a").replace("a 30\n", "a thirty\n"));

    const result = await probe(h1, mergeMain());

    expect(result).toMatchObject({ carries: false, reason: expect.stringContaining("1 file(s) the PR changes"), prPaths: ["src/a.ts"] });
  });

  it("refuses when main renamed a file the PR changed", async () => {
    const h1 = approvedFeature();
    git("checkout", "-q", "main");
    git("mv", "src/a.ts", "src/renamed.ts");
    git("commit", "-q", "-m", "rename");
    git("checkout", "-q", "feature");

    const result = await probe(h1, mergeMain());

    expect(result.carries).toBe(false);
  });

  it("refuses a merge whose conflict was resolved by hand", async () => {
    commit("src/a.ts", "base\n");
    git("checkout", "-q", "-B", "feature", "HEAD");
    const h1 = commit("src/a.ts", "feature\n");
    mainCommit("src/a.ts", "main\n");
    expect(() => git("merge", "-q", "main")).toThrow();
    write("src/a.ts", "resolved\n");
    git("commit", "-q", "--no-edit");

    expect(await probe(h1, head())).toMatchObject({ carries: false });
  });

  it("refuses input that is not a repo, a branch and two full shas", async () => {
    expect(await ownMergeUp({ repo: "nope", baseRef: "main", fromHead: "a", head: "b" })).toMatchObject({ carries: false, reason: expect.stringContaining("invalid own-merge-up input") });
  });
});
