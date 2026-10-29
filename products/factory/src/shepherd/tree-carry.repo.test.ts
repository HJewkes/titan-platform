import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_STEPS } from "./review.js";
import { CARRY_STEP, carry, carryCacheDir, localMergeTree, type CarryResult } from "./tree-carry.js";

const REPO = "acme/widgets";

let root: string;
let origin: string;
let stateDir: string;

function git(...args: string[]): string {
  return gitIn(origin)(...args);
}

function commit(file: string, text: string): string {
  writeFileSync(join(origin, file), text);
  git("add", file);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

function branchAt(name: string, at: string): void {
  git("checkout", "-q", "-B", name, at);
}

function mergeMain(): string {
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return git("rev-parse", "HEAD");
}

/** main at m0 and the reviewed head H1 on `feature`, with main moved on by one unrelated commit. */
function reviewedHead(): { m0: string; h1: string } {
  const [m0 = "", , , h1 = ""] = withHistory(origin, [
    { files: { "a.txt": "a0\n" }, message: "edit a.txt" },
    { files: { "b.txt": "b0\n" }, message: "edit b.txt" },
    { files: { "b.txt": "b1\n" }, message: "edit b.txt" },
    { branch: "feature", from: ":2", files: { "a.txt": "a1\n" }, message: "edit a.txt" },
  ]);
  return { m0, h1 };
}

const probe = (fromHead: string, head: string, remote = origin): Promise<CarryResult> =>
  carry({ repo: REPO, baseRef: "main", fromHead, head }, { stateDir, remote: () => remote });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tree-carry-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("carry", { timeout: 30_000 }, () => {
  it("answers equal for a clean update-branch merge of main into the reviewed head", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    const result = await probe(h1, h2);

    expect(result).toMatchObject({ equal: true, base: git("rev-parse", "main") });
    expect(result.mergeTree).toBe(git("rev-parse", `${h2}^{tree}`));
  });

  it("answers equal across a chain of two update merges", async () => {
    const { h1 } = reviewedHead();
    mergeMain();
    branchAt("main", "main");
    commit("c.txt", "c1\n");
    branchAt("feature", "feature");
    const h3 = mergeMain();

    expect(await probe(h1, h3)).toMatchObject({ equal: true });
  });

  it("reads the PR diff as unchanged across a merge-up over an unreviewed merge-up (TP-3725)", async () => {
    const { h1 } = reviewedHead();
    mergeMain();
    branchAt("main", "main");
    commit("c.txt", "c1\n");
    branchAt("feature", "feature");
    const h3 = mergeMain();

    expect(await probe(h1, h3)).toMatchObject({ equal: true, firstParent: git("rev-parse", `${h3}^1`), patchEqual: true });
  });

  it("reads the PR diff as unchanged when main moved the lines above the PR's hunk", async () => {
    const numbered = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`);
    commit("a.txt", numbered.join(""));
    branchAt("feature", "HEAD");
    const h1 = commit("a.txt", numbered.join("").replace("15\n", "fifteen\n"));
    branchAt("main", "main");
    commit("b.txt", "b1\n");
    branchAt("feature", "feature");
    mergeMain();
    branchAt("main", "main");
    commit("a.txt", `0\n${numbered.join("")}`);
    branchAt("feature", "feature");
    const h3 = mergeMain();

    expect(await probe(h1, h3)).toMatchObject({ equal: true, patchEqual: true });
  });

  it("reads the PR diff as changed when main already landed the PR's own hunk, though the trees are equal", async () => {
    const { h1 } = reviewedHead();
    mergeMain();
    branchAt("main", "main");
    commit("a.txt", "a1\n");
    branchAt("feature", "feature");
    const h3 = mergeMain();

    expect(await probe(h1, h3)).toMatchObject({ equal: true, patchEqual: false });
  });

  it("reads no PR diff for a merge-up straight onto the reviewed head", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    expect(await probe(h1, h2)).not.toHaveProperty("patchEqual");
  });

  it("answers not equal when the implementer committed between the reviewed head and the update", async () => {
    const { h1 } = reviewedHead();
    commit("a.txt", "a2\n");
    const h2 = mergeMain();

    expect(await probe(h1, h2)).toMatchObject({ equal: false, reason: expect.stringContaining("differs") });
  });

  it("answers not equal for a rebase update, which has one parent", async () => {
    const { h1 } = reviewedHead();
    git("rebase", "-q", "main");
    const h2 = git("rev-parse", "HEAD");

    expect(await probe(h1, h2)).toMatchObject({ equal: false, reason: expect.stringContaining("1 parents") });
  });

  it("answers not equal when the merged-in second parent is not on the base branch", async () => {
    const { m0, h1 } = reviewedHead();
    branchAt("side", m0);
    commit("d.txt", "unreviewed\n");
    branchAt("feature", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const h2 = git("rev-parse", "HEAD");

    expect(await probe(h1, h2)).toMatchObject({ equal: false, reason: expect.stringContaining("is not on main") });
  });

  it("answers not equal when the update merge had to resolve a conflict", async () => {
    const { h1 } = reviewedHead();
    branchAt("main", "main");
    commit("a.txt", "a-main\n");
    branchAt("feature", "feature");
    expect(() => git("merge", "-q", "main")).toThrow();
    writeFileSync(join(origin, "a.txt"), "resolved\n");
    git("add", "a.txt");
    git("commit", "-q", "--no-edit");
    const h2 = git("rev-parse", "HEAD");

    expect(await probe(h1, h2)).toMatchObject({ equal: false, reason: expect.stringContaining("conflicts") });
  });

  it("answers not equal with a reason when the fetch fails, and never throws", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    expect(await probe(h1, h2, join(root, "missing"))).toMatchObject({ equal: false, reason: expect.stringContaining("git fetch") });
  });

  it("keeps neither a URL nor a token from git's stderr or a thrown error in the reason", async () => {
    const leaky = "https://db.example.invalid/x tok_FAKE0000SECRET";
    const input = { repo: REPO, baseRef: "main", fromHead: "a".repeat(40), head: "b".repeat(40) };
    const failing = async () => ({ code: 128, stdout: "", stderr: `fatal: ${leaky}` });
    const throwing = async () => Promise.reject(new Error(leaky));

    const refused = await carry(input, { stateDir, git: failing });
    const thrown = await carry(input, { stateDir, git: throwing });

    expect(refused).toEqual({ equal: false, reason: "git init exited 128" });
    expect(thrown).toEqual({ equal: false, reason: "carry probe failed: Error" });
  });

  it("answers not equal for malformed input without touching git", async () => {
    const result = await carry({ repo: "../escape", baseRef: "--upload-pack=x", fromHead: "abc", head: "def" }, { stateDir });

    expect(result.equal).toBe(false);
    expect(existsSync(join(stateDir, "git-cache"))).toBe(false);
  });

  it("keeps its objects in a bare cache under the state dir", async () => {
    const { h1 } = reviewedHead();
    const h2 = mergeMain();

    await probe(h1, h2);

    expect(existsSync(join(carryCacheDir(stateDir, REPO), "HEAD"))).toBe(true);
    expect(carryCacheDir(stateDir, REPO)).toBe(join(stateDir, "git-cache", "acme", "widgets.git"));
  });

  it("is declared as a durable shepherd step", () => {
    expect(REVIEW_STEPS).toContainEqual({ id: CARRY_STEP, kind: "dispatch" });
  });
});

describe("localMergeTree", { timeout: 30_000 }, () => {
  const mergeTree = (headSha: string, remote = origin): Promise<string> => localMergeTree({ repo: REPO, baseRef: "main", headSha }, { stateDir, remote: () => remote });

  it("answers clean when the head merges onto the base tip with no conflict", async () => {
    const { h1 } = reviewedHead();

    expect(await mergeTree(h1)).toBe("clean");
  });

  it("answers conflict when the head and the base tip edit the same lines", async () => {
    const { h1 } = reviewedHead();
    branchAt("main", "main");
    commit("a.txt", "a-main\n");

    expect(await mergeTree(h1)).toBe("conflict");
  });

  it("answers unread with the failing git command when the fetch fails, and never throws", async () => {
    const { h1 } = reviewedHead();

    expect(await mergeTree(h1, join(root, "missing"))).toBe("unread: git fetch exited 128");
  });

  it("answers unread for a head that is not a sha without touching git", async () => {
    expect(await mergeTree("--upload-pack=x")).toMatch(/^unread: invalid input/);
    expect(existsSync(join(stateDir, "git-cache"))).toBe(false);
  });
});
