import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// TP-2528 slice a: proves that a stack of PRs (P <- C <- G) squash-merged one
// level at a time takes a clean merge-up of main at each level, and that each
// child's diff against main is exactly its own delta. Real git, local bare origin.

const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const lines = (tag: string, count = 12): string => Array.from({ length: count }, (_, i) => `${tag} ${i}`).join("\n") + "\n";

interface Scratch {
  git(...args: string[]): string;
  gitResult(...args: string[]): { ok: boolean; out: string };
  commitFile(file: string, text: string, message: string): void;
  read(file: string): string;
}

let root: string;

function scratch(): Scratch {
  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  const work = join(root, "work");
  const run = (cwd: string, args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: TEST_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Seeded and cloned rather than pushed to an empty bare repo: the push hook refuses an
  // origin with no default branch, and a clone of a populated origin has origin/HEAD.
  mkdirSync(seed);
  run(seed, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(seed, "base.txt"), lines("base"));
  run(seed, ["add", "base.txt"]);
  run(seed, ["commit", "-q", "-m", "main base"]);
  run(root, ["clone", "-q", "--bare", seed, bare]);
  run(root, ["clone", "-q", bare, work]);
  return {
    git: (...args) => run(work, args),
    gitResult: (...args) => {
      try {
        return { ok: true, out: run(work, args) };
      } catch (error) {
        const output = error instanceof Error && "stdout" in error ? `${String(error.stdout)}${String("stderr" in error ? error.stderr : "")}` : String(error);
        return { ok: false, out: output };
      }
    },
    commitFile(file, text, message) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      writeFileSync(join(work, file), text);
      run(work, ["add", file]);
      run(work, ["commit", "-q", "-m", message]);
      run(work, ["push", "-q", "origin", "HEAD"]);
    },
    read: (file) => readFileSync(join(work, file), "utf8"),
  };
}

/** Squash-merges `branch` into main and deletes it, as GitHub's squash merge does. */
function squashLand(s: Scratch, branch: string): void {
  s.git("checkout", "-q", "main");
  s.git("merge", "--squash", branch);
  s.git("commit", "-q", "-m", `squash ${branch}`);
  s.git("push", "-q", "origin", "main");
  s.git("push", "-q", "origin", "--delete", branch);
  s.git("branch", "-q", "-D", branch);
}

/** Files changed on `branch` relative to main, with status, as name-status lines. */
const deltaAgainstMain = (s: Scratch, branch: string): string[] => s.git("diff", "--name-status", "main", branch).split("\n").filter(Boolean).sort();

function branchFrom(s: Scratch, base: string, name: string): void {
  s.git("checkout", "-q", "-b", name, base);
}

/** Merge main into a child; throws with the conflict output when not clean. */
function mergeUp(s: Scratch, child: string): void {
  s.git("checkout", "-q", child);
  const result = s.gitResult("merge", "--no-edit", "main");
  if (!result.ok) {
    const conflicted = s.gitResult("diff", "--name-only", "--diff-filter=U").out;
    throw new Error(`merge-up of main into ${child} is NOT clean; conflicts: ${conflicted}\n${result.out}`);
  }
  s.git("push", "-q", "origin", child);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "stack-squash-proof-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a 3-deep stack squash-merged in order", () => {
  it("takes a clean merge-up at each level when each child edits only its own files", () => {
    const s = scratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    branchFrom(s, "p", "c");
    s.commitFile("c.txt", lines("child"), "C adds c.txt");
    branchFrom(s, "c", "g");
    s.commitFile("g.txt", lines("grand"), "G adds g.txt");

    squashLand(s, "p");
    mergeUp(s, "c");
    expect(deltaAgainstMain(s, "c")).toEqual(["A\tc.txt"]);
    expect(s.read("p.txt")).toBe(lines("parent"));
    expect(s.read("c.txt")).toBe(lines("child"));

    squashLand(s, "c");
    mergeUp(s, "g");
    expect(deltaAgainstMain(s, "g")).toEqual(["A\tg.txt"]);
    expect(s.read("c.txt")).toBe(lines("child"));
    expect(s.read("g.txt")).toBe(lines("grand"));

    squashLand(s, "g");
    expect(s.git("ls-tree", "--name-only", "main").split("\n")).toEqual(["base.txt", "c.txt", "g.txt", "p.txt"]);
  });

  // Finding: a plain merge-up of main is NOT clean here. P's squash adds p.txt on main
  // while C (which carries P's commits) also adds it with different content, so git sees
  // add/add against the pre-stack base. Shepherd must use `rebase --onto main <old parent
  // head>` for a child that touches a file its parent created.
  it("conflicts on a plain merge-up when a child edits a file its parent created", () => {
    const s = scratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    branchFrom(s, "p", "c");
    s.commitFile("p.txt", lines("parent") + "child line\n", "C edits p.txt");

    squashLand(s, "p");

    expect(() => mergeUp(s, "c")).toThrow(/CONFLICT \(add\/add\)/);
  });

  it("rebase --onto main from the old parent head keeps each child's delta when a child edits a parent-created file", () => {
    const s = scratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    const parentHead = s.git("rev-parse", "p");
    branchFrom(s, "p", "c");
    s.commitFile("p.txt", lines("parent") + "child line\n", "C edits p.txt");
    const childHead = s.git("rev-parse", "c");
    branchFrom(s, "c", "g");
    s.commitFile("p.txt", lines("parent") + "child line\ngrand line\n", "G edits p.txt");

    squashLand(s, "p");
    s.git("rebase", "--onto", "main", parentHead, "c");
    s.git("push", "-q", "--force", "origin", "c");
    expect(deltaAgainstMain(s, "c")).toEqual(["M\tp.txt"]);
    expect(s.git("diff", "main", "c")).toContain("+child line");

    squashLand(s, "c");
    s.git("rebase", "--onto", "main", childHead, "g");
    expect(deltaAgainstMain(s, "g")).toEqual(["M\tp.txt"]);
    expect(s.read("p.txt")).toBe(lines("parent") + "child line\ngrand line\n");
    expect(s.git("diff", "main", "g")).toContain("+grand line");
  });

  it("takes a clean merge-up when a child edits a file that existed on main before the stack", () => {
    const s = scratch();
    branchFrom(s, "main", "p");
    s.commitFile("base.txt", lines("base").replace("base 1\n", "base 1 parent\n"), "P edits base.txt");
    branchFrom(s, "p", "c");
    s.commitFile("base.txt", lines("base").replace("base 1\n", "base 1 parent\n").replace("base 9\n", "base 9 child\n"), "C edits base.txt");

    squashLand(s, "p");
    mergeUp(s, "c");
    const diff = s.git("diff", "main", "c");
    expect(diff).toContain("+base 9 child");
    expect(diff).not.toContain("base 1 parent");
  });
});
