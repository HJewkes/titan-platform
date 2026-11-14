import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { GitResult, GitCachePorts } from "./carry-cache-ports.js";
import { CLOSURE_LOCK_PATH, ClosureRegenFailure, type ClosureRegen } from "./lock-regen.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "repo-seat" };
const TIP = fakeSha("main-tip");
const TEXT_TREE = fakeSha("text-merge-tree");
const REGEN_TREE = fakeSha("regenerated-tree");
const UNRESOLVED = fakeSha("unresolved-merge");
const MERGED = fakeSha("regenerated-merge");
const FIXER_HEAD = fakeSha("fixer-head");
const OTHER = "products/factory/src/shepherd/example.ts";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const ok = (stdout = ""): GitResult => ({ code: 0, stdout, stderr: "" });

/** A bare cache whose text merge of the head onto main conflicts in `conflicted`; a push moves the fake PR's head. */
function fakeCache(fake: FakeGitHub, conflicted: readonly string[], regenChanged: readonly string[]) {
  let remoteHead = H1;
  const pushes: string[] = [];
  const git = async (_dir: string, args: readonly string[]): Promise<GitResult> => {
    const [command] = args;
    if (command === "-c") return { code: 1, stdout: [TEXT_TREE, ...conflicted].join("\n"), stderr: "" };
    if (command === "rev-parse") return ok(TIP);
    if (command === "diff-tree") return ok(regenChanged.join("\n"));
    if (command === "commit-tree") return ok(args[1] === TEXT_TREE ? UNRESOLVED : MERGED);
    if (command === "ls-remote") return ok(`${remoteHead}\trefs/heads/topic-1`);
    if (command === "push") {
      pushes.push(args.at(-1) ?? "");
      remoteHead = MERGED;
      fake.pushHead(1, MERGED);
      fake.pr(1).mergeableState = "clean";
    }
    return ok();
  };
  const ports: GitCachePorts = { git, fs: { exists: () => true, mkdirp: () => undefined }, stateDir: () => "/state" };
  return { ports, pushes };
}

/** A dirty PR that changed the lock; a fixer wake pushes a clean head, so either path ends at a mergeable head. */
function lockConflictWorld(conflicted: readonly string[], regen: ClosureRegen, changed = CLOSURE_LOCK_PATH, regenChanged = [CLOSURE_LOCK_PATH], headRef = "topic-1") {
  const fake = fakeGitHub({ baseSha: TIP });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: H1, headRepo: REPO, headRef, mergeableState: "dirty" });
  fake.prFiles.set(1, [{ path: changed, status: "modified" }]);
  const cache = fakeCache(fake, conflicted, regenChanged);
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => {
      wakes.push(request);
      fake.pushHead(1, FIXER_HEAD);
      fake.pr(1).mergeableState = "clean";
      return { kind: "woken", agent: "fixer" };
    },
    review: async () => ({ kind: "none", cause: "no-verdict" }),
  };
  const store = shepherdStoreRef();
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, gitCache: cache.ports, closureRegen: regen, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), park: async () => ({ lines: [] }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return { fake, host, runId, wakes, pushes: cache.pushes };
}

type World = ReturnType<typeof lockConflictWorld>;

const regenOutputs = (world: World): unknown[] =>
  Object.entries(world.host.runtime.status(world.runId)!.stepResults).filter(([id]) => id.startsWith("sh-lock-regen")).map(([, result]) => (result.data as { result?: unknown } | undefined)?.result);

const atGate = (world: World): string | null | undefined => world.host.runtime.status(world.runId)?.currentStep;

describe("Shepherd regenerates closure.lock.json when it is the only conflict (TP-5732)", () => {
  it("merges main, regenerates the lock on the merged tree and pushes, with no fixer wake", async () => {
    const regen = vi.fn<ClosureRegen>(async () => REGEN_TREE);

    const world = lockConflictWorld([CLOSURE_LOCK_PATH], regen);

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));
    expect(world.wakes).toEqual([]);
    expect(regen).toHaveBeenCalledWith({ gitDir: "/state/git-cache/octo/demo.git", commit: UNRESOLVED }, expect.any(AbortSignal));
    expect(world.pushes).toEqual([`${MERGED}:refs/heads/topic-1`]);
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "pushed", conflicted: [CLOSURE_LOCK_PATH], tip: TIP, newHead: MERGED })]);
  });

  it("wakes the fixer when another file conflicts beside the lock, and pushes nothing", async () => {
    const regen = vi.fn<ClosureRegen>(async () => REGEN_TREE);

    const world = lockConflictWorld([CLOSURE_LOCK_PATH, OTHER], regen);

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));
    expect(world.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(regen).not.toHaveBeenCalled();
    expect(world.pushes).toEqual([]);
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "declined", conflicted: [CLOSURE_LOCK_PATH, OTHER] })]);
  });

  it("wakes the fixer when the regeneration fails, and pushes nothing", async () => {
    const regen = vi.fn<ClosureRegen>(async () => Promise.reject(new ClosureRegenFailure("build exited 1")));

    const world = lockConflictWorld([CLOSURE_LOCK_PATH], regen);

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));
    expect(world.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(world.pushes).toEqual([]);
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "declined", reason: "closure regen: build exited 1", conflicted: [CLOSURE_LOCK_PATH] })]);
  });

  it("wakes the fixer when the regenerated tree changes a file beside the lock, and pushes nothing", async () => {
    const regen = vi.fn<ClosureRegen>(async () => REGEN_TREE);

    const world = lockConflictWorld([CLOSURE_LOCK_PATH], regen, CLOSURE_LOCK_PATH, [CLOSURE_LOCK_PATH, OTHER]);

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));
    expect(world.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(world.pushes).toEqual([]);
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "declined", reason: "the regenerated tree changes more than closure.lock.json" })]);
  });

  it("never pushes to the default branch when it is the PR's head branch", async () => {
    const regen = vi.fn<ClosureRegen>(async () => REGEN_TREE);

    const world = lockConflictWorld([CLOSURE_LOCK_PATH], regen, CLOSURE_LOCK_PATH, [CLOSURE_LOCK_PATH], "main");

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));
    expect(regen).not.toHaveBeenCalled();
    expect(world.pushes).toEqual([]);
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "declined", reason: "the head branch is the default branch" })]);
  });

  it("leaves a PR that never changed the lock to the fixer without reading the git cache", async () => {
    const regen = vi.fn<ClosureRegen>(async () => REGEN_TREE);

    const world = lockConflictWorld([CLOSURE_LOCK_PATH], regen, OTHER);

    await vi.waitFor(() => expect(atGate(world)).toMatch(/^approve-merge/));

    expect(world.wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(regen).not.toHaveBeenCalled();
    expect(regenOutputs(world)).toEqual([expect.objectContaining({ outcome: "declined", reason: "the pull request does not change closure.lock.json" })]);
  });
});
