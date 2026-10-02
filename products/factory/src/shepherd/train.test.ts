import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { callCommand } from "../test-support/shepherd.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { freezeStoreRef, type FreezeStore } from "./freeze.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";
import { MergeTrain, mergeTrainRef, trainMigration, type MergeTrainRef } from "./train.js";
import type { WatchRow } from "./view.js";

const HEADS = { 1: fakeSha("train-head1"), 2: fakeSha("train-head2") } as const;
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const merges: ShepherdPhases["review"] = (ctx, request) =>
  mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });

interface Repo {
  fake: FakeGitHub;
  /** PR numbers in the order GitHub merged them. */
  merged: number[];
  /** Every merge GitHub refused, by message. */
  refused: string[];
  /** The conclusion of `validate` at a head; undefined leaves the head's checks missing, so CI waits. */
  validate: (headSha: string) => string | undefined;
}

/** Two open PRs on one strict repo; a merge moves the base, so the other open PR falls behind, as on GitHub. */
function twoPrRepo(): Repo {
  const fake = fakeGitHub();
  const repo: Repo = { fake, merged: [], refused: [], validate: () => "success" };
  fake.onGetPr = (pr) => {
    const conclusion = repo.validate(pr.headSha);
    fake.setRuns(pr.headSha, conclusion === undefined ? [] : [successRun("validate", 1, undefined, conclusion), successRun("dag-check", 2)]);
  };
  for (const pr of [1, 2] as const) {
    fake.addPr({ headSha: HEADS[pr], mergeSha: fakeSha(`train-test-merge${pr}`) });
    fake.prFiles.set(pr, [{ path: `src/${pr}.ts`, status: "modified" }]);
  }
  const merge = fake.wire.merge;
  fake.wire.merge = (slug, pr, sha, method) => {
    const result = merge(slug, pr, sha, method);
    if (fake.pr(pr).merged) moveBase(repo, pr);
    return result.catch((error: Error) => (repo.refused.push(error.message), Promise.reject(error)));
  };
  return repo;
}

/** The fake merges before its promise settles, so the base moves in the same tick, as one write on GitHub does. */
function moveBase(repo: Repo, pr: number): void {
  repo.merged.push(pr);
  for (const other of [1, 2]) if (other !== pr && repo.fake.pr(other).state === "open") repo.fake.pr(other).behind = true;
}

function landingPort(repo: Repo): GitHubPort {
  const port = githubPort(repo.fake.wire);
  const mergeShas = () => [1, 2].map((pr) => repo.fake.pr(pr).mergeSha);
  return {
    ...port,
    checkRuns: async (slug, sha) => (mergeShas().includes(sha) && repo.fake.setRuns(sha, [successRun("validate", 9)]), port.checkRuns(slug, sha)),
  };
}

interface World {
  host: FactoryHost;
  routes: FactoryRoutes;
  store: ShepherdStore;
  train: MergeTrainRef;
  freezes: FreezeStore;
}

function world(repo: Repo, review: ShepherdPhases["review"] = merges, dbPath = ":memory:"): World {
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const train = mergeTrainRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port: landingPort(repo), store, train, freeze, now: () => clock, sleep: tick, registry: async () => true });
  const phases: ShepherdPhases = { review, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) };
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, routes, store: store.get(), train, freezes: freeze.get() };
}

function shepherd(w: World, pr: 1 | 2): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), policy: JSON.stringify(AUTO_POLICY) });
  w.store.register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: `impl-${pr}`, policy: AUTO_POLICY });
  return runId;
}

/** Resolves every caller once `count` have called. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return () => (++arrived >= count && open(), opened);
}

/** PR 1's run boards first and finds its branch behind, so it updates while holding the train; its update head's CI waits until `ci` is set. */
function firstUpdates(repo: Repo, w: () => World, runs: { first?: string }, ci: { update?: string }): ShepherdPhases["review"] {
  const greenRuns = repo.fake.onGetPr!;
  repo.fake.onGetPr = (pr, reads) => {
    if (pr.number === 1 && pr.headSha === HEADS[1] && w().train.get().holder(REPO)?.runId === runs.first) pr.behind = true;
    greenRuns(pr, reads);
  };
  repo.validate = (sha) => (sha === HEADS[1] || sha === HEADS[2] ? "success" : ci.update);
  return async (ctx, request: ReviewRequest) => {
    if (request.pr === 2) await vi.waitFor(() => expect(w().train.get().holder(REPO)?.runId).toBe(runs.first), { timeout: 5_000 });
    return merges(ctx, request);
  };
}

/** Starts both runs and returns once run 1 holds the train on its update head, whose CI waits, and run 2 waits at its merge. */
async function firstHoldsSecondWaits(repo: Repo, ci: { update?: string }): Promise<{ w: World; first: string; second: string }> {
  const runs: { first?: string } = {};
  const late: { w?: World } = {};
  const w = (late.w = world(repo, firstUpdates(repo, () => late.w!, runs, ci)));
  runs.first = shepherd(w, 1);
  const second = shepherd(w, 2);
  await vi.waitFor(() => expect(repo.fake.effects.updateBranch).toBe(1), { timeout: 5_000 });
  await vi.waitFor(() => expect(w.host.runtime.status(second)?.currentStep).toMatch(/^merge:/), { timeout: 5_000 });
  return { w, first: runs.first, second };
}

async function statusRow(w: World, pr: number): Promise<WatchRow | undefined> {
  const envelope = await callCommand<WatchRow[]>(w.host, w.routes, "shepherd.status", { repo: REPO });
  return envelope.ok ? envelope.data.find((row) => row.pr === pr) : undefined;
}

describe("the merge train", () => {
  it("lands two PRs approved at once one after the other, with no merge GitHub refuses", async () => {
    const repo = twoPrRepo();
    const both = barrier(2);
    const w = world(repo, async (ctx, request) => (request.headSha === HEADS[request.pr as 1 | 2] && (await both()), merges(ctx, request)));
    const runs = [shepherd(w, 1), shepherd(w, 2)];

    await Promise.all(runs.map((runId) => w.host.runtime.wait(runId)));

    expect(runs.map((runId) => w.host.runtime.status(runId)?.status)).toEqual(["completed", "completed"]);
    expect([...repo.merged].sort()).toEqual([1, 2]);
    expect(repo.refused).toEqual([]);
    expect(repo.fake.effects.updateBranch).toBe(1);
    expect(w.train.get().holder(REPO)).toBeUndefined();
  });

  it("moves on to the next run when the holder's CI fails after its update-branch", async () => {
    const repo = twoPrRepo();
    const runs: { first?: string } = {};
    const ci: { update?: string } = {};
    const late: { w?: World } = {};
    const w = (late.w = world(repo, firstUpdates(repo, () => late.w!, runs, ci)));
    runs.first = shepherd(w, 1);
    const second = shepherd(w, 2);

    await vi.waitFor(() => expect(w.host.runtime.status(second)?.currentStep).toMatch(/^merge:/), { timeout: 5_000 });
    await vi.waitFor(() => expect(repo.fake.effects.updateBranch).toBe(1), { timeout: 5_000 });
    const waiting = await statusRow(w, 2);
    ci.update = "failure";
    await w.host.runtime.wait(second);

    expect(waiting?.nextAction).toBe(`waiting for the merge train behind run ${runs.first} (#1)`);
    expect(w.host.runtime.status(second)?.status).toBe("completed");
    expect(repo.merged).toEqual([2]);
    await gateOpened(w.host, gateId(runs.first, "ci-failed"));
    expect(w.train.get().holder(REPO)).toBeUndefined();
  });

  it("gives the train to the next run when the holder's run is cancelled while it holds it", async () => {
    const repo = twoPrRepo();
    const runs: { first?: string } = {};
    const late: { w?: World } = {};
    const w = (late.w = world(repo, firstUpdates(repo, () => late.w!, runs, {})));
    runs.first = shepherd(w, 1);
    const second = shepherd(w, 2);

    await vi.waitFor(() => expect(repo.fake.effects.updateBranch).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(w.host.runtime.status(second)?.currentStep).toMatch(/^merge:/), { timeout: 5_000 });
    w.host.runtime.cancel(runs.first, "abandoned in this test");
    await w.host.runtime.wait(second);

    expect(w.host.runtime.status(second)?.status).toBe("completed");
    expect(repo.merged).toEqual([2]);
    expect(w.train.get().holder(REPO)).toBeUndefined();
  });
});

describe("a holder whose own merge must wait", () => {
  it("gives the train up while its PR is held, and merges second once released", async () => {
    const repo = twoPrRepo();
    const ci: { update?: string } = {};
    const { w, first, second } = await firstHoldsSecondWaits(repo, ci);

    w.store.hold(first, "owner hold in this test");
    await w.host.runtime.wait(second);
    const firstWhileHeld = w.host.runtime.status(first)?.status;
    const mergedWhileHeld = [...repo.merged];
    ci.update = "success";
    w.store.release(first);
    await w.host.runtime.wait(first);

    expect(firstWhileHeld).toBe("running");
    expect(mergedWhileHeld).toEqual([2]);
    expect([first, second].map((runId) => w.host.runtime.status(runId)?.status)).toEqual(["completed", "completed"]);
    expect(repo.merged).toEqual([2, 1]);
    expect(repo.refused).toEqual([]);
    expect(w.train.get().holder(REPO)).toBeUndefined();
  });

  it("gives the train to the fix task's PR when the repo freezes under the holder", async () => {
    const repo = twoPrRepo();
    const { w, first, second } = await firstHoldsSecondWaits(repo, {});

    const { episode } = w.freezes.freeze(REPO, fakeSha("train-red-main"));
    w.freezes.setFixTask(REPO, episode, "demo/2");
    w.freezes.setFixer(REPO, episode, "impl-2");
    await w.host.runtime.wait(second);

    expect(w.host.runtime.status(second)?.status).toBe("completed");
    expect(w.host.runtime.status(first)?.status).toBe("running");
    expect(repo.merged).toEqual([2]);
    expect(repo.refused).toEqual([]);
  });
});

describe("a restart mid-train", () => {
  it("keeps the holder it reads back from the store, which merges before the run waiting behind it", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp686-")), "factory.db");
    const repo = twoPrRepo();
    const runs: { first?: string } = {};
    const ci: { update?: string } = {};
    const late: { w?: World } = {};
    const first = (late.w = world(repo, firstUpdates(repo, () => late.w!, runs, ci), dbPath));
    runs.first = shepherd(first, 1);
    const second = shepherd(first, 2);
    await vi.waitFor(() => expect(repo.fake.effects.updateBranch).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(first.host.runtime.status(second)?.currentStep).toMatch(/^merge:/), { timeout: 5_000 });
    first.host.close();

    const restarted = (late.w = world(repo, merges, dbPath));
    const holderOnResume = restarted.train.get().holder(REPO)?.runId;
    ci.update = "success";
    await restarted.host.adopt();
    await Promise.all([runs.first, second].map((runId) => restarted.host.runtime.wait(runId)));

    expect(holderOnResume).toBe(runs.first);
    expect(repo.merged).toEqual([1, 2]);
    expect(repo.refused).toEqual([]);
    expect(restarted.train.get().holder(REPO)).toBeUndefined();
  });
});

describe("MergeTrain.take", () => {
  function openTrain(): MergeTrain {
    const db = openDatabase(":memory:");
    runMigrations(db, [trainMigration(1)]);
    return new MergeTrain(db);
  }

  it("refuses a take from a holder that is no longer the holder, and keeps the real one", () => {
    const train = openTrain();
    train.take(REPO, "run-a", 1, null);
    train.take(REPO, "run-b", 2, "run-a");

    expect(train.take(REPO, "run-c", 3, "run-a")).toBe(false);
    expect(train.holder(REPO)).toMatchObject({ runId: "run-b", pr: 2 });
  });

  it("refuses a take from nobody while a run holds the train", () => {
    const train = openTrain();
    train.take(REPO, "run-a", 1, null);

    expect(train.take(REPO, "run-b", 2, null)).toBe(false);
    expect(train.holder(REPO)?.runId).toBe("run-a");
  });
});
