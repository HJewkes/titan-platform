import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMergeUpChain } from "./merge-up-approval.js";
import { readMergeUpChain, type MergeUpChain } from "./merge-up-chain.js";

const REPO = "acme/widgets";

let root: string;
let origin: string;
let stateDir: string;

const git = (...args: string[]): string => gitIn(origin)(...args);

function commitOn(branch: string, file: string, text: string): string {
  git("checkout", "-q", branch);
  writeFileSync(join(origin, file), text);
  git("add", file);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

/** Moves main on by one unrelated commit, then merges main into the PR branch: one clean merge-up. */
function mergeUp(n: number): string {
  commitOn("main", `main-${n}.txt`, `m${n}\n`);
  git("checkout", "-q", "feature");
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return git("rev-parse", "HEAD");
}

/** main with one commit, and the owner's approved head on `feature`, which main has not seen. */
function approvedHead(): string {
  const shas = withHistory(origin, [
    { files: { "a.txt": "a0\n" }, message: "seed" },
    { branch: "feature", from: ":1", files: { "a.txt": "a1\n" }, message: "pr change" },
  ]);
  return shas[1]!;
}

const read = (fromHead: string, head: string, remote = origin): Promise<MergeUpChain> => readMergeUpChain({ repo: REPO, baseRef: "main", fromHead, head }, { stateDir, remote: () => remote });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "merge-up-chain-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readMergeUpChain", { timeout: 60_000 }, () => {
  it("accepts one clean merge-up of main since the approved head", async () => {
    const approved = approvedHead();
    const head = mergeUp(1);

    const chain = await read(approved, head);

    expect(chain).toMatchObject({ ok: true, commits: [{ sha: head, firstParent: approved, secondParent: git("rev-parse", "main"), secondParentOnBase: true }] });
    expect(chain.ok && isMergeUpChain(chain.commits, approved, head)).toBe(true);
  });

  it("accepts four clean merge-ups in a row, oldest first", async () => {
    const approved = approvedHead();
    const heads = [mergeUp(1), mergeUp(2), mergeUp(3), mergeUp(4)];

    const chain = await read(approved, heads[3]!);

    expect(chain.ok && chain.commits.map((commit) => commit.sha)).toEqual(heads);
    expect(chain.ok && isMergeUpChain(chain.commits, approved, heads[3]!)).toBe(true);
  });

  it("refuses a plain commit on the PR branch after the merge-ups", async () => {
    const approved = approvedHead();
    mergeUp(1);
    const head = commitOn("feature", "a.txt", "a2\n");

    expect(await read(approved, head)).toEqual({ ok: false, reason: `${head} has 1 parent(s), not the two of a merge-up` });
  });

  it("refuses a merge that carries a change of its own beyond what main brought", async () => {
    const approved = approvedHead();
    commitOn("main", "main-1.txt", "m1\n");
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-commit", "main");
    writeFileSync(join(origin, "a.txt"), "smuggled\n");
    git("add", "a.txt");
    git("commit", "-q", "--no-edit");
    const head = git("rev-parse", "HEAD");

    expect(await read(approved, head)).toEqual({ ok: false, reason: `${head} changes more than the merge of ${git("rev-parse", "main")} brought` });
  });

  it("refuses a merge whose second parent is not on main", async () => {
    const approved = approvedHead();
    const side = withHistory(origin, [{ branch: "side", from: "main", files: { "side.txt": "s\n" }, message: "side" }])[0]!;
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-ff", "--no-edit", "side");
    const head = git("rev-parse", "HEAD");

    expect(await read(approved, head)).toEqual({ ok: false, reason: `${head} merges ${side}, which is not on main` });
  });

  it("refuses when the approved head is not on the PR's line", async () => {
    const approved = approvedHead();
    const head = commitOn("main", "main-1.txt", "m1\n");

    expect(await read(approved, head)).toEqual({ ok: false, reason: `${approved} is not an ancestor of ${head}` });
  });

  it("refuses an unmoved head", async () => {
    const approved = approvedHead();

    expect(await read(approved, approved)).toEqual({ ok: false, reason: "the head has not moved since the approved head" });
  });

  it("refuses on a git error, here a fetch from a remote that does not exist", async () => {
    const approved = approvedHead();
    const head = mergeUp(1);

    expect(await read(approved, head, join(root, "missing"))).toEqual({ ok: false, reason: "git fetch exited 128" });
  });
});
