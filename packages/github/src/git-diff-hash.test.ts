import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitIn, seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diffCarry, type DiffPin } from "./diff-hash.js";
import { execGit } from "./exec.js";
import { gitDiffPin, gitMergeUpCheck } from "./git-diff-hash.js";

let root: string;
let clone: string;
let git: (...args: string[]) => string;

/** Twenty numbered lines, with `edits` replacing line n (1-based); a null edit drops the line. */
function numbered(edits: Record<number, string | null> = {}): string {
  const lines = Array.from({ length: 20 }, (_, i) => (i + 1 in edits ? edits[i + 1] : `line ${i + 1}`));
  return lines.filter((line) => line !== null).join("\n") + "\n";
}

function commitOn(branch: string, from: string, files: Record<string, string | Buffer>): string {
  git("checkout", "-q", "-B", branch, from);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(clone, file), content);
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", `${branch} commit`);
  return git("rev-parse", "HEAD");
}

function pushMain(sha: string): void {
  git("push", "-q", "--force", "origin", `${sha}:refs/heads/main`);
}

function mergeInto(branch: string, from: string, other: string): string {
  git("checkout", "-q", "-B", branch, from);
  git("merge", "-q", "--no-ff", "--no-edit", other);
  return git("rev-parse", "HEAD");
}

const pin = (head: string): Promise<DiffPin> => gitDiffPin(execGit, clone, head);
const carry = (reviewed: DiffPin, current: DiffPin) => diffCarry(reviewed, current, gitMergeUpCheck(execGit, clone));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-diff-hash-")));
  clone = path.join(root, "clone");
  seedRepoWithOrigin(clone, path.join(root, "origin.git"), { "a.txt": numbered() });
  git = gitIn(clone);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("gitDiffPin", () => {
  it("takes the merge base from the remote's main, not a stale or shadowing local ref", async () => {
    const seed = git("rev-parse", "HEAD");
    const head = commitOn("topic", seed, { "a.txt": numbered({ 10: "topic" }) });
    const tip = commitOn("main", seed, { "b.txt": "main\n" });
    pushMain(tip);
    git("update-ref", "refs/remotes/origin/main", seed);
    git("branch", "origin/main", seed);

    const result = await pin(head);

    expect(result).toMatchObject({ kind: "exact", main: tip, base: seed });
  });

  it("A17: the hash is equal under a hostile gitconfig", async () => {
    const seed = git("rev-parse", "HEAD");
    const head = commitOn("topic", seed, { "a.txt": numbered({ 3: "", 10: "topic", 17: "  indented" }), "z.txt": "z\n" });
    const hardened = await pin(head);
    stubHostileGitconfig();

    const plain = execFileSync("git", ["-C", clone, "diff", "--no-ext-diff", seed, head], { encoding: "utf8" });
    const underHostile = await pin(head);

    expect(plain).toMatch(/Binary files a\.txt and a\.txt differ/); // the hostile config does change an unhardened diff
    expect(underHostile).toEqual(hardened);
  });

  it("A17: an ambiguous merge base gives a pin that matches nothing, itself included", async () => {
    const seed = git("rev-parse", "HEAD");
    const left = commitOn("left", seed, { "l.txt": "l\n" });
    const right = commitOn("right", seed, { "r.txt": "r\n" });
    pushMain(mergeInto("main", left, right));
    const head = mergeInto("topic", right, left);

    const result = await pin(head);

    expect(result).toMatchObject({ kind: "ambiguous", bases: expect.arrayContaining([left, right]) });
    expect(await carry(result, result)).toMatchObject({ carries: false });
  });
});

describe("Q13's two exclusions", () => {
  const ADDED = { 10: "line 10\ntopic" };

  /** A topic line added after line 10, reviewed while main is the seed; then main changes line 8, inside its context. */
  async function reviewedThenMainMoves(): Promise<{ reviewed: string; tip: string; reviewedPin: DiffPin }> {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "a.txt": numbered(ADDED) });
    const reviewedPin = await pin(reviewed);
    const tip = commitOn("main", seed, { "a.txt": numbered({ 8: "main" }) });
    pushMain(tip);
    return { reviewed, tip, reviewedPin };
  }

  it("exclusion 1: a rebase with an identical verbatim diff carries on the full hash", async () => {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "a.txt": numbered(ADDED) });
    const reviewedPin = await pin(reviewed);
    pushMain(commitOn("main", seed, { "b.txt": "main\n" }));
    const rebased = commitOn("rebased", "main", { "a.txt": numbered(ADDED) });

    expect(await carry(reviewedPin, await pin(rebased))).toEqual({ carries: true, by: "equal-full" });
  });

  it("exclusion 2: a conflict-free merge of main that changes only context carries as a merge-up", async () => {
    const { reviewed, tip, reviewedPin } = await reviewedThenMainMoves();
    const merged = mergeInto("topic", reviewed, tip);

    const current = await pin(merged);

    expect(current).toMatchObject({ kind: "exact" });
    expect(current.kind === "exact" && reviewedPin.kind === "exact" && current.full !== reviewedPin.full).toBe(true);
    expect(await carry(reviewedPin, current)).toEqual({ carries: true, by: "merge-up", mainParent: tip });
  });

  it("A17: a rebase over changed context does not carry", async () => {
    const { tip, reviewedPin } = await reviewedThenMainMoves();
    const rebased = commitOn("rebased", tip, { "a.txt": numbered({ 8: "main", ...ADDED }) });

    expect(await carry(reviewedPin, await pin(rebased))).toMatchObject({ carries: false, reason: expect.stringMatching(/not a two-parent merge/) });
  });

  it("A17: a moved added line does not carry", async () => {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "a.txt": numbered(ADDED) });
    const moved = commitOn("topic", reviewed, { "a.txt": numbered({ 14: "line 14\ntopic" }) });

    expect(await carry(await pin(reviewed), await pin(moved))).toMatchObject({ carries: false, reason: expect.stringMatching(/not a two-parent merge/) });
  });

  it("A17: a moved added line does not carry inside a merge of main either", async () => {
    const { reviewed, tip, reviewedPin } = await reviewedThenMainMoves();
    git("checkout", "-q", "-B", "topic", reviewed);
    git("merge", "-q", "--no-ff", "--no-commit", tip);
    fs.writeFileSync(path.join(clone, "a.txt"), numbered({ 8: "main", 14: "line 14\ntopic" }));
    git("commit", "-q", "-a", "--no-edit");
    const moved = git("rev-parse", "HEAD");

    expect(await carry(reviewedPin, await pin(moved))).toMatchObject({ carries: false, reason: expect.stringMatching(/is not a clean merge/) });
  });

  it("A17: a whitespace-only change does not carry", async () => {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "a.txt": numbered({ 10: "topic" }) });
    const respaced = commitOn("topic", reviewed, { "a.txt": numbered({ 10: "topic " }) });

    expect(await carry(await pin(reviewed), await pin(respaced))).toMatchObject({ carries: false, reason: expect.stringMatching(/changes the reviewed lines/) });
  });

  it("A17: a mode-only change does not carry", async () => {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "run.sh": "echo hi\n" });
    git("update-index", "--chmod=+x", "run.sh");
    git("commit", "-q", "-m", "chmod");
    const chmodded = git("rev-parse", "HEAD");

    expect(await carry(await pin(reviewed), await pin(chmodded))).toMatchObject({ carries: false, reason: expect.stringMatching(/changes the reviewed lines/) });
  });

  it("A17: a binary change does not carry", async () => {
    const seed = git("rev-parse", "HEAD");
    const reviewed = commitOn("topic", seed, { "blob.bin": Buffer.from([0, 1, 2, 3, 0, 255]) });
    const changed = commitOn("topic", reviewed, { "blob.bin": Buffer.from([0, 1, 2, 4, 0, 255]) });

    expect(await carry(await pin(reviewed), await pin(changed))).toMatchObject({ carries: false, reason: expect.stringMatching(/changes the reviewed lines/) });
  });

  it("A17: a moved hunk with identical context keeps its hash (Q13's named residual, accepted with no task)", async () => {
    const block = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\n";
    const seed = commitOn("main", git("rev-parse", "HEAD"), { "r.txt": `${block}one\ntwo\nthree\nfour\nfive\nsix\nseven\n${block}` });
    pushMain(seed);
    const atFirst = commitOn("first", seed, { "r.txt": `${block.replace("gamma\n", "gamma\nadded\n")}one\ntwo\nthree\nfour\nfive\nsix\nseven\n${block}` });
    const atSecond = commitOn("second", seed, { "r.txt": `${block}one\ntwo\nthree\nfour\nfive\nsix\nseven\n${block.replace("gamma\n", "gamma\nadded\n")}` });

    const [first, second] = [await pin(atFirst), await pin(atSecond)];

    expect(first.kind === "exact" && second.kind === "exact" && first.full === second.full).toBe(true);
  });
});

/**
 * A global gitconfig and a `GIT_CONFIG_COUNT` injection, each with an attributes file that turns text into binary,
 * which no diff flag undoes: only the hardened environment keeps them out.
 */
function stubHostileGitconfig(): void {
  const write = (name: string, text: string) => {
    fs.writeFileSync(path.join(root, name), text);
    return path.join(root, name);
  };
  const globalAttributes = write("global.attributes", "a.txt -diff\n");
  vi.stubEnv("GIT_CONFIG_GLOBAL", write("hostile.gitconfig", `${HOSTILE_GITCONFIG}[core]\n\tattributesFile = ${globalAttributes}\n`));
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.attributesFile");
  vi.stubEnv("GIT_CONFIG_VALUE_0", write("injected.attributes", "*.txt -diff\n"));
}

// Each key would change a plain `git diff`; the hardened environment and the §2.3 flags must leave the pin as it was.
const HOSTILE_GITCONFIG = `[diff]
\tnoprefix = true
\tmnemonicPrefix = true
\talgorithm = patience
\trenames = copies
\tcontext = 10
\tinterHunkContext = 10
\tindentHeuristic = false
\trelative = true
\tsuppressBlankEmpty = true
\texternal = false
[core]
\tquotePath = false
[color]
\tui = always
`;
