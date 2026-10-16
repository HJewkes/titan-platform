import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restackOnto } from "./stack-restack.js";
import type { Git } from "./tree-carry.js";

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
  s.git("push", "-q", "origin", "main", `:refs/heads/${branch}`);
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

// TP-2528 slice b: the merge-onto restack. After a parent squash-lands, the child takes a
// merge commit whose tree is `merge-tree --merge-base=<fork point> child main`, pushed as a
// plain fast-forward. These cases are slice a's, run at depths 2 to 4.

const testGit: Git = (gitDir, args) =>
  new Promise((resolve) => {
    execFile("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", env: TEST_GIT_ENV }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 128) : 0, stdout, stderr });
    });
  });

const workGitDir = (): string => join(root, "work", ".git");

function restackScratch(): Scratch {
  const s = scratch();
  execFileSync("git", ["--git-dir", join(root, "origin.git"), "config", "receive.denyNonFastForwards", "true"], { env: TEST_GIT_ENV });
  return s;
}

type Read = (file: string) => string;
const appendLine = (read: Read, file: string, level: number): string => `${read(file)}level ${level} line\n`;
const editBaseLine = (read: Read, level: number): string => read("base.txt").replace(`base ${level * 3}\n`, `base ${level * 3} level ${level}\n`);

function overBoth(level: number, read: Read): Record<string, string> {
  if (level === 0) return { "p.txt": lines("parent") };
  if (level === 1) return { "c.txt": lines("child"), "base.txt": editBaseLine(read, level) };
  return { "p.txt": appendLine(read, "p.txt", level), "c.txt": appendLine(read, "c.txt", level) };
}

const STACK_CASES: { name: string; edit: (level: number, read: Read) => Record<string, string> }[] = [
  { name: "each level adds its own file", edit: (level) => ({ [`l${level}.txt`]: lines(`level ${level}`) }) },
  { name: "each child edits a file its parent created", edit: (level, read) => ({ "p.txt": level === 0 ? lines("parent") : appendLine(read, "p.txt", level) }) },
  { name: "each level edits a file that existed before the stack", edit: (level, read) => ({ "base.txt": editBaseLine(read, level) }) },
  { name: "a grandchild edits files from both its ancestors", edit: overBoth },
];

const LEVELS = ["p", "c", "g", "h"];

function buildStack(s: Scratch, edit: (level: number, read: Read) => Record<string, string>, depth: number): string[] {
  const names = LEVELS.slice(0, depth);
  names.forEach((name, level) => {
    branchFrom(s, names[level - 1] ?? "main", name);
    const files = Object.entries(edit(level, s.read));
    for (const [file, text] of files) writeFileSync(join(root, "work", file), text);
    s.git("add", ...files.map(([file]) => file));
    s.git("commit", "-q", "-m", `${name} edits its files`);
  });
  s.git("push", "-q", "origin", ...names);
  return names;
}

/** The tree `rebase --onto main <upstream>` gives the child, built on a detached HEAD that is never pushed. */
function rebaseOntoTree(s: Scratch, upstream: string, childHead: string): string {
  s.git("rebase", "-q", "--onto", "main", upstream, childHead);
  const tree = s.git("rev-parse", "HEAD^{tree}");
  s.git("checkout", "-q", "main");
  return tree;
}

/** Each origin branch's head, by branch name. */
const originHeads = (s: Scratch): Map<string, string> =>
  new Map(s.git("ls-remote", "--heads", "origin").split("\n").map((line) => { const [sha = "", ref = ""] = line.split("\t"); return [ref.replace("refs/heads/", ""), sha]; }));

/** Squash-lands `parent`, restacks `child` onto main, pushes it plainly and checks every level property. */
async function landAndRestack(s: Scratch, parent: string, child: string, next: string | undefined): Promise<void> {
  const [parentFinal = "", childHead = ""] = s.git("rev-parse", parent, child).split("\n");
  const ownDelta = s.git("diff", parent, child);
  const nextView = next === undefined ? "" : s.git("diff", `${child}...${next}`);
  const nextHead = next === undefined ? undefined : originHeads(s).get(next);
  squashLand(s, parent);
  const main = s.git("rev-parse", "main");

  const result = await restackOnto(testGit, workGitDir(), { childHead, parentFinal, squash: main, main });

  if (result.kind !== "restacked") throw new Error(`restack of ${child} was ${JSON.stringify(result)}`);
  s.git("push", "-q", "origin", `${result.commit}:refs/heads/${child}`);
  s.git("branch", "-q", "-f", child, result.commit);
  const heads = originHeads(s);
  expect(heads.get(child)).toBe(result.commit);
  expect(s.git("rev-parse", `${result.commit}^1`, `${result.commit}^2`)).toBe(`${childHead}\n${main}`);
  expect(s.git("diff", "main", result.commit)).toBe(ownDelta);
  expect(result.tree).toBe(rebaseOntoTree(s, result.base, childHead));
  if (next === undefined) return;
  expect(s.git("diff", `${child}...${next}`)).toBe(nextView);
  expect(heads.get(next)).toBe(nextHead);
}

describe("merge-onto restack of a stack landed level by level", { timeout: 30_000 }, () => {
  for (const stackCase of STACK_CASES) {
    for (const depth of [2, 3, 4]) {
      it(`restacks cleanly at depth ${depth} when ${stackCase.name}`, async () => {
        const s = restackScratch();
        const names = buildStack(s, stackCase.edit, depth);
        const stackTree = s.git("rev-parse", `${names[depth - 1]}^{tree}`);

        for (let level = 1; level < depth; level += 1) await landAndRestack(s, names[level - 1] ?? "", names[level] ?? "", names[level + 1]);
        squashLand(s, names[depth - 1] ?? "");

        expect(s.git("rev-parse", "main^{tree}")).toBe(stackTree);
      });
    }
  }

  it("restacks the add/add case that a merge-tree without the explicit merge base conflicts on", async () => {
    const s = restackScratch();
    buildStack(s, STACK_CASES[1]?.edit ?? overBoth, 2);
    const parentFinal = s.git("rev-parse", "p");
    const childHead = s.git("rev-parse", "c");
    squashLand(s, "p");
    const main = s.git("rev-parse", "main");

    const result = await restackOnto(testGit, workGitDir(), { childHead, parentFinal, squash: main, main });

    expect(s.gitResult("merge-tree", "--write-tree", childHead, main).ok).toBe(false);
    expect(result).toMatchObject({ kind: "restacked", base: parentFinal });
  });

  it("merges from the fork point after a cascade, not from the parent's first head", async () => {
    const s = restackScratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    branchFrom(s, "p", "c");
    s.commitFile("c.txt", lines("child"), "C adds c.txt");
    s.git("checkout", "-q", "p");
    s.commitFile("p.txt", lines("parent").replace("parent 3\n", "parent 3 fix\n"), "P fix round");
    const parentFinal = s.git("rev-parse", "p");
    s.git("checkout", "-q", "c");
    s.git("merge", "-q", "--no-edit", "p");
    s.commitFile("p.txt", lines("parent").replace("parent 3\n", "parent 3 fix child\n"), "C edits the fixed line");
    const childHead = s.git("rev-parse", "c");
    const ownDelta = s.git("diff", "p", "c");
    squashLand(s, "p");
    const main = s.git("rev-parse", "main");

    const result = await restackOnto(testGit, workGitDir(), { childHead, parentFinal, squash: main, main });

    expect(result).toMatchObject({ kind: "restacked", base: parentFinal });
    if (result.kind === "restacked") expect(s.git("diff", "main", result.commit)).toBe(ownDelta);
  });

  it("reports a conflict when the child edits lines the parent's unsynced last fix round also edited", async () => {
    const s = restackScratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    branchFrom(s, "p", "c");
    s.commitFile("p.txt", lines("parent").replace("parent 3\n", "parent 3 child\n"), "C edits line 3");
    const childHead = s.git("rev-parse", "c");
    s.git("checkout", "-q", "p");
    s.commitFile("p.txt", lines("parent").replace("parent 3\n", "parent 3 fix\n"), "P fix round edits line 3");
    const parentFinal = s.git("rev-parse", "p");
    squashLand(s, "p");
    const main = s.git("rev-parse", "main");

    const result = await restackOnto(testGit, workGitDir(), { childHead, parentFinal, squash: main, main });

    expect(result).toEqual({ kind: "conflict", base: s.git("merge-base", childHead, parentFinal), files: ["p.txt"] });
  });

  it("refuses with a guard when the squash tree is not the parent's final tree or the squash is not on main", async () => {
    const s = restackScratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");
    const firstHead = s.git("rev-parse", "p");
    s.commitFile("p.txt", lines("parent") + "fix\n", "P fix round");
    const preStack = s.git("rev-parse", "main");
    branchFrom(s, "p", "c");
    s.commitFile("c.txt", lines("child"), "C adds c.txt");
    const childHead = s.git("rev-parse", "c");
    const parentFinal = s.git("rev-parse", "p");
    squashLand(s, "p");
    const main = s.git("rev-parse", "main");

    const staleParent = await restackOnto(testGit, workGitDir(), { childHead, parentFinal: firstHead, squash: main, main });
    const offMain = await restackOnto(testGit, workGitDir(), { childHead, parentFinal, squash: main, main: preStack });

    expect(staleParent).toMatchObject({ kind: "guard", reason: expect.stringContaining("differs from parent final") });
    expect(offMain).toMatchObject({ kind: "guard", reason: expect.stringContaining("is not on main") });
  });

  it("moves no ref and never builds a rebase, replay, push, force or + refspec argument", async () => {
    const s = restackScratch();
    buildStack(s, overBoth, 2);
    const parentFinal = s.git("rev-parse", "p");
    const childHead = s.git("rev-parse", "c");
    squashLand(s, "p");
    const main = s.git("rev-parse", "main");
    const refsBefore = s.git("for-each-ref");
    const calls: (readonly string[])[] = [];
    const recording: Git = (gitDir, args) => {
      calls.push(args);
      return testGit(gitDir, args);
    };

    const result = await restackOnto(recording, workGitDir(), { childHead, parentFinal, squash: main, main, parentPr: 7 });

    expect(result.kind).toBe("restacked");
    expect(s.git("for-each-ref")).toBe(refsBefore);
    expect(calls.flat().filter((arg) => /^(rebase|replay|push|update-ref|branch|-f|--force.*|\+.*)$/.test(arg))).toEqual([]);
    if (result.kind === "restacked") expect(s.git("log", "-1", "--format=%s", result.commit)).toBe(`Restack onto main after #7 (merge-base ${parentFinal})`);
  });

  it("is checked against an origin that refuses a forced non-fast-forward", () => {
    const s = restackScratch();
    branchFrom(s, "main", "p");
    s.commitFile("p.txt", lines("parent"), "P adds p.txt");

    s.git("reset", "-q", "--hard", "main");

    expect(s.gitResult("push", "-q", "--force", "origin", "p").ok).toBe(false);
  });
});
