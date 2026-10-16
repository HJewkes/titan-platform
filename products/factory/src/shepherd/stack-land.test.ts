import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configuredStackRestack, restackChild, stackChildren, type ChildWake, type RestackInput, type StackLandDeps } from "./stack-land.js";
import type { Git } from "./tree-carry.js";

const REPO = "acme/widgets";
const PARENT = "agent-chat/parent";
const CHILD = "agent-chat/child";
const GRANDCHILD = "agent-chat/grandchild";
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

let root: string;
let origin: string;
let work: string;

const run = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: TEST_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (...args: string[]): string => run(work, args);
const originRef = (ref: string): string => run(origin, ["rev-parse", ref]);

function commitFile(file: string, text: string): string {
  writeFileSync(join(work, file), text);
  git("add", file);
  git("commit", "-q", "-m", `edit ${file}`);
  git("push", "-q", "origin", "HEAD");
  return git("rev-parse", "HEAD");
}

/** Every argument list the module ran, so a test can show none of them forces, rewrites or replays history. */
function recordingGit(seen: string[][], beforePush?: () => void): Git {
  return (gitDir, args) => {
    seen.push([...args]);
    if (args[0] === "push") beforePush?.();
    return new Promise((resolve) => {
      execFile("git", ["--git-dir", gitDir, ...args], { encoding: "utf8", env: TEST_GIT_ENV }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === "number" ? error.code : 128) : 0, stdout, stderr });
      });
    });
  };
}

interface Stack {
  fake: FakeGitHub;
  parentPr: number;
  childPr: number;
  grandchildPr: number;
  parentFinal: string;
  childHead: string;
  grandchildHead: string;
  squash: string;
  wakes: ChildWake[];
  seen: string[][];
  deps: StackLandDeps;
  input: RestackInput;
}

interface StackOptions {
  childBase?: string;
  childBranch?: string;
  parentMerged?: boolean;
  /** Commits a main change touching the child's edited line after the squash. */
  conflictOnMain?: boolean;
  beforePush?: () => void;
}

/** main, P on main, C on P and G on C in a real bare origin; P squash-landed on main as GitHub's squash merge does. */
function buildStack(options: StackOptions = {}): Stack {
  const childBranch = options.childBranch ?? CHILD;
  git("checkout", "-q", "-b", PARENT, "main");
  const parentFinal = commitFile("parent.txt", lines("parent"));
  git("checkout", "-q", "-b", childBranch);
  writeFileSync(join(work, "base.txt"), lines("base").replace("base 0\n", "child edit\n"));
  git("add", "base.txt");
  const childHead = commitFile("child.txt", lines("child"));
  git("checkout", "-q", "-b", GRANDCHILD);
  const grandchildHead = commitFile("grandchild.txt", lines("grandchild"));
  git("checkout", "-q", "main");
  git("merge", "-q", "--squash", PARENT);
  git("commit", "-q", "-m", "squash parent");
  const squash = git("rev-parse", "HEAD");
  git("push", "-q", "origin", "main");
  if (options.conflictOnMain) commitFile("base.txt", lines("base").replace("base 0\n", "main edit\n"));

  const fake = fakeGitHub({ repo: REPO, base: "main" });
  const merged = options.parentMerged ?? true;
  const parentPr = fake.addPr({ headRef: PARENT, headSha: parentFinal, ...(merged && { state: "closed" as const, merged: true, mergeSha: squash }) }).number;
  const childPr = fake.addPr({ headRef: childBranch, headSha: childHead, baseRef: options.childBase ?? PARENT }).number;
  const grandchildPr = fake.addPr({ headRef: GRANDCHILD, headSha: grandchildHead, baseRef: childBranch }).number;
  fake.refs.set(PARENT, parentFinal);
  run(origin, ["update-ref", `refs/pull/${parentPr}/head`, parentFinal]);

  const wakes: ChildWake[] = [];
  const seen: string[][] = [];
  const deps: StackLandDeps = { port: githubPort(fake.wire), wakeChild: async (wake) => (wakes.push(wake), true), held: () => undefined, stateDir: join(root, "state"), remote: () => origin, git: recordingGit(seen, options.beforePush) };
  const input: RestackInput = { repo: REPO, parentPr, parentHeadRef: PARENT, parentFinal, squash, child: { pr: childPr, headRef: childBranch, headSha: childHead } };
  return { fake, parentPr, childPr, grandchildPr, parentFinal, childHead, grandchildHead, squash, wakes, seen, deps, input };
}

const roots: string[] = [];

/** A fresh origin seeded with one main commit, refusing non-fast-forward pushes, and a working clone of it. */
function freshRepo(): void {
  root = mkdtempSync(join(tmpdir(), "stack-land-"));
  roots.push(root);
  const seed = join(root, "seed");
  origin = join(root, "origin.git");
  work = join(root, "work");
  mkdirSync(seed);
  run(seed, ["init", "-q", "--initial-branch=main"]);
  writeFileSync(join(seed, "base.txt"), lines("base"));
  run(seed, ["add", "base.txt"]);
  run(seed, ["commit", "-q", "-m", "main base"]);
  run(root, ["clone", "-q", "--bare", seed, origin]);
  run(origin, ["config", "receive.denyNonFastForwards", "true"]);
  run(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  run(root, ["clone", "-q", origin, work]);
}

beforeEach(freshRepo);

afterEach(() => roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("restackChild", { timeout: 30_000 }, () => {
  it("retargets a child still on the parent's branch, then fast-forwards it to the merge-onto commit", async () => {
    const s = buildStack();

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "restacked", pr: s.childPr, retargeted: true, parentPr: s.parentPr, squash: s.squash, parentFinal: s.parentFinal, base: s.parentFinal });
    const newHead = result.outcome === "restacked" ? result.newHead : "";
    expect(s.fake.baseChanges).toEqual([{ number: s.childPr, base: "main" }]);
    expect(originRef(`refs/heads/${CHILD}`)).toBe(newHead);
    expect(originRef(`${newHead}^1`)).toBe(s.childHead);
    expect(originRef(`${newHead}^2`)).toBe(originRef("refs/heads/main"));
    expect(result.outcome === "restacked" && result.tree).toBe(originRef(`${newHead}^{tree}`));
    expect(run(origin, ["diff", "--name-only", "refs/heads/main", newHead]).split("\n").sort()).toEqual(["base.txt", "child.txt"]);
    expect(s.wakes).toEqual([]);
  });

  it("pushes but sends no retarget for a child GitHub already moved onto the default branch", async () => {
    const s = buildStack({ childBase: "main" });

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "restacked", retargeted: false });
    expect(s.fake.baseChanges).toEqual([]);
    expect(originRef(`refs/heads/${CHILD}`)).toBe(result.outcome === "restacked" ? result.newHead : "");
  });

  it("leaves a child whose branch moved past the last seen head and wakes its implementer", async () => {
    const s = buildStack();
    git("checkout", "-q", CHILD);
    const moved = commitFile("child.txt", lines("child moved"));

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "head-moved", woken: true });
    expect(originRef(`refs/heads/${CHILD}`)).toBe(moved);
    expect(s.fake.baseChanges).toEqual([]);
    expect(s.wakes).toEqual([{ repo: REPO, pr: s.childPr, headSha: s.childHead, reason: expect.stringMatching(new RegExp(`^parent #${s.parentPr} landed; restack head moved`)) }]);
  });

  it("ends as head-moved when a seat pushes between the restack and its push", async () => {
    let moved = "";
    const s = buildStack({
      beforePush: () => {
        git("checkout", "-q", CHILD);
        moved = commitFile("late.txt", "late\n");
      },
    });

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "head-moved", reason: `parent #${s.parentPr} landed; restack head moved: the fast-forward push was rejected; Shepherd left the base as it was` });
    expect(originRef(`refs/heads/${CHILD}`)).toBe(moved);
    expect(s.fake.pr(s.childPr).baseRef).toBe(PARENT);
    expect(s.fake.baseChanges).toEqual([]);
  });

  it("finds its own pushed commit on a replay, so it neither pushes again nor wakes the implementer", async () => {
    const s = buildStack();
    const first = await restackChild(s.deps, s.input);

    const replay = await restackChild(s.deps, s.input);

    expect(replay).toEqual({ ...first, retargeted: false });
    expect(s.seen.filter((args) => args[0] === "push")).toHaveLength(1);
    expect(s.wakes).toEqual([]);
    expect(s.fake.baseChanges).toEqual([{ number: s.childPr, base: "main" }]);
  });

  it("still retargets on a replay whose first attempt pushed and then stopped before the retarget", async () => {
    const s = buildStack();
    const failing = { ...s.deps, port: { ...s.deps.port, setPrBase: async () => Promise.reject(new Error("network down")) } };
    const first = await restackChild(failing, s.input);

    const replay = await restackChild(s.deps, s.input);

    expect(first).toMatchObject({ outcome: "guard", reason: expect.stringMatching(/^parent #\d+ landed; restack guard: pushed [0-9a-f]{40}, but the retarget to main /) });
    expect(replay).toMatchObject({ outcome: "restacked", retargeted: true });
    expect(s.fake.baseChanges).toEqual([{ number: s.childPr, base: "main" }]);
  });

  it("refuses a child whose head branch GitHub reports differently from the open list", async () => {
    const s = buildStack();
    s.fake.pr(s.childPr).headRef = "agent-chat/renamed";

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "guard", reason: expect.stringContaining("head branch is agent-chat/renamed") });
    expect(s.seen).toEqual([]);
  });

  it("wakes the child's implementer on a conflict with main and pushes nothing", async () => {
    const s = buildStack({ conflictOnMain: true });

    const result = await restackChild(s.deps, s.input);

    expect(result).toEqual({ outcome: "conflict", pr: s.childPr, reason: `parent #${s.parentPr} landed; restack conflict in base.txt; Shepherd pushed nothing`, woken: true });
    expect(originRef(`refs/heads/${CHILD}`)).toBe(s.childHead);
    expect(s.fake.baseChanges).toEqual([]);
    expect(s.seen.some((args) => args[0] === "push")).toBe(false);
  });

  it("never restacks or retargets a child before its parent has merged", async () => {
    const s = buildStack({ parentMerged: false });

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "guard", reason: expect.stringContaining(`parent #${s.parentPr} is not merged`) });
    expect(s.fake.baseChanges).toEqual([]);
    expect(s.fake.effects.merge).toBe(0);
    expect(s.seen).toEqual([]);
    expect(originRef(`refs/heads/${CHILD}`)).toBe(s.childHead);
  });

  for (const [label, reason] of [["the switch is turned off", `stack restack is off for ${REPO}`], ["the repo turns advisory", `${REPO} is advisory`]] as const) {
    it(`pushes, retargets and wakes nothing when ${label} after the child list was read`, async () => {
      const s = buildStack();
      const hold: { reason?: string } = {};
      const deps = { ...s.deps, held: () => hold.reason };
      const [child] = await stackChildren(deps, { repo: REPO, parentPr: s.parentPr, parentHeadRef: PARENT, parentHeadRepo: REPO });
      hold.reason = reason;

      const result = await restackChild(deps, { ...s.input, child: child! });

      expect(result).toEqual({ outcome: "skipped", pr: s.childPr, reason: `parent #${s.parentPr} landed; restack skipped: ${reason}`, woken: false });
      expect(s.seen).toEqual([]);
      expect(s.fake.baseChanges).toEqual([]);
      expect(originRef(`refs/heads/${CHILD}`)).toBe(s.childHead);
      expect(s.wakes).toEqual([]);
    });
  }

  it("skips a child whose head branch is not an agent-chat branch", async () => {
    const s = buildStack({ childBranch: "feature/manual" });

    const result = await restackChild(s.deps, s.input);

    expect(result).toMatchObject({ outcome: "skipped", woken: true });
    expect(s.seen).toEqual([]);
    expect(s.fake.baseChanges).toEqual([]);
  });

  it("fails closed when the origin cannot be read", async () => {
    const s = buildStack();

    const result = await restackChild({ ...s.deps, remote: () => join(root, "missing.git") }, s.input);

    expect(result).toMatchObject({ outcome: "guard", reason: `parent #${s.parentPr} landed; restack guard: git ls-remote exited 128`, woken: true });
    expect(s.fake.baseChanges).toEqual([]);
  });

  it("builds no force, plus refspec, rebase or replay argument on any path", async () => {
    const pushLate = () => {
      git("checkout", "-q", CHILD);
      commitFile("late.txt", "late\n");
    };
    const seen: string[][] = [];
    for (const options of [{}, { conflictOnMain: true }, { beforePush: pushLate }]) {
      freshRepo();
      const s = buildStack(options);
      await restackChild(s.deps, s.input);
      seen.push(...s.seen);
    }

    const forbidden = seen.flat().filter((arg) => /^(-f|--force.*|rebase|replay)$/.test(arg) || arg.startsWith("+") || arg.includes(":+"));
    expect(seen.some((args) => args[0] === "push")).toBe(true);
    expect(forbidden).toEqual([]);
  });
});

describe("stackChildren", () => {
  it("lists only the parent's direct children, so a grandchild is untouched until its own parent lands", async () => {
    const s = buildStack();

    const children = await stackChildren(s.deps, { repo: REPO, parentPr: s.parentPr, parentHeadRef: PARENT, parentHeadRepo: REPO });
    await restackChild(s.deps, s.input);

    expect(children).toEqual([{ pr: s.childPr, headRef: CHILD, headSha: s.childHead }]);
    expect(originRef(`refs/heads/${GRANDCHILD}`)).toBe(s.grandchildHead);
    expect(s.fake.pr(s.grandchildPr).baseRef).toBe(CHILD);
    expect(s.fake.baseChanges.map((change) => change.number)).not.toContain(s.grandchildPr);
  });

  it("stacks nothing on a parent whose head is on a fork or is the default branch", async () => {
    const s = buildStack();

    expect(await stackChildren(s.deps, { repo: REPO, parentPr: s.parentPr, parentHeadRef: PARENT, parentHeadRepo: "someone/fork" })).toEqual([]);
    expect(await stackChildren(s.deps, { repo: REPO, parentPr: s.parentPr, parentHeadRef: "main", parentHeadRepo: REPO })).toEqual([]);
  });
});

describe("configuredStackRestack", () => {
  it("is on only for a repo whose config says stackRestack: true, matching the key in any case", () => {
    const on = configuredStackRestack(() => ({ "Acme/Widgets": { stackRestack: true }, "acme/other": { stackRestack: false }, "acme/plain": {} }));

    expect([on("acme/widgets"), on("acme/other"), on("acme/plain"), on("acme/absent")]).toEqual([true, false, false, false]);
  });

  it("is off when there is no config file or the read throws", () => {
    expect(configuredStackRestack(() => undefined)(REPO)).toBe(false);
    expect(configuredStackRestack(() => { throw new Error("invalid config"); })(REPO)).toBe(false);
  });
});
