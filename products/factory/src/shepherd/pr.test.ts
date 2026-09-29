import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { MergeHeldError, holdingPort } from "./hold.js";
import type { ReviewRequest, ShepherdPhases, Verdict, WakeOutcome, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef, type ShepherdStore, type ShepherdStoreRef } from "./store.js";

const H2 = fakeSha("head2");
const BRANCH = "feat/demo";
const UNHANDLED: WakeOutcome = { kind: "unhandled", reason: "no agent in this test" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Script {
  review?: (request: ReviewRequest) => Verdict;
  wake?: (request: WakeRequest) => WakeOutcome;
}

/** Phases that record every request and answer from the script; unscripted, review says none and wake is unhandled. */
function fakePhases(script: Script): { phases: ShepherdPhases; wakes: WakeRequest[]; reviews: ReviewRequest[] } {
  const wakes: WakeRequest[] = [];
  const reviews: ReviewRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push(request), script.wake?.(request) ?? UNHANDLED),
    review: async (_ctx, request) => (reviews.push(request), script.review?.(request) ?? { kind: "none" }),
  };
  return { phases, wakes, reviews };
}

interface World {
  host: FactoryHost;
  fake: FakeGitHub;
  ref: ShepherdStoreRef;
  store: ShepherdStore;
}

/** A fake GitHub whose `validate` check follows `validate`, and a host running every factory route over it. */
function world(phases: ShepherdPhases, validate: (headSha: string) => string = () => "success", fake = fakeGitHub()): World {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, validate(pr.headSha)), successRun("dag-check", 2)]);
  let clock = 0;
  const ref = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: tick });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, ref, store: ref.get() };
}

/** Start shepherd-pr on PR 1 and register it, as `shepherd.register` will. */
function shepherdPr1(w: World): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return runId;
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

async function approve(host: FactoryHost, runId: string, headSha: string, iteration = 0): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge", iteration));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha });
}

async function approveAndFinish(host: FactoryHost, runId: string, headSha: string): Promise<void> {
  await approve(host, runId, headSha);
  await host.runtime.wait(runId);
}

/** The agent a wake reaches pushes `headSha` and waits for it, as the real wake phase does. */
function pushes(fake: FakeGitHub, headSha: string): (request: WakeRequest) => WakeOutcome {
  return () => (fake.pushHead(1, headSha), { kind: "woken", agent: "impl-a" });
}

describe("shepherd-pr", () => {
  it("waits in sh-await-pr until the registered branch has a PR, then lands that PR", async () => {
    const w = world(fakePhases({}).phases);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, branch: BRANCH });
    w.store.register({ repo: REPO, branch: BRANCH, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });

    await vi.waitFor(() => expect(w.fake.calls.filter((call) => call === "listPrs").length).toBeGreaterThanOrEqual(3));
    const beforePr = { steps: stepIds(w.host, runId), reads: w.fake.calls.filter((call) => call === "getPr").length };
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    await approveAndFinish(w.host, runId, H1);

    expect(beforePr).toEqual({ steps: [], reads: 0 });
    expect(w.store.byRun(runId)?.pr).toBe(1);
    expect(w.fake.effects.merge).toBe(1);
  });

  it("makes no merge call while a PR held after approval stays held, then merges on release", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.store.hold(runId, "owner wants a look");
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("merge:0"));
    await sleep(100, new AbortController().signal);
    const whileHeld = { merges: w.fake.effects.merge, status: w.host.runtime.status(runId)?.status };
    w.store.release(runId);
    await w.host.runtime.wait(runId);

    expect(whileHeld).toEqual({ merges: 0, status: "running" });
    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(1);
  });

  it("wakes the implementer with a review wake on FIX_FIRST, before any merge decision on that head", async () => {
    const fake = fakeGitHub();
    const { phases, wakes } = fakePhases({
      review: (request) => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "missing test" } : { kind: "none" }),
      wake: pushes(fake, H2),
    });
    const w = world(phases, undefined, fake);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H2);

    expect(wakes).toEqual([{ kind: "review", repo: REPO, pr: 1, round: 0, headSha: H1, payload: { kind: "FIX_FIRST", headSha: H1, text: "missing test" } }]);
    expect(stepIds(w.host, runId)).not.toContain("merge-policy:0");
    expect(w.fake.effects.merge).toBe(1);
  });

  it("opens the ci-failed gate when the ci-red wake is unhandled", async () => {
    const { phases, wakes } = fakePhases({});
    const w = world(phases, () => "failure");
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "ci-failed"));

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(w.host.runtime.status(runId)?.status).toBe("paused");
  });

  it("lands the next round straight after a woken ci-red wake, with no ci-failed gate and no await-new-head", async () => {
    const fake = fakeGitHub();
    const { phases, wakes } = fakePhases({ wake: pushes(fake, H2) });
    const w = world(phases, (sha) => (sha === H1 ? "failure" : "success"), fake);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H2);
    const steps = stepIds(w.host, runId);

    expect(wakes.map((wake) => wake.kind)).toEqual(["ci-red"]);
    expect(steps).toContain("land-rules:r1");
    expect(steps.filter((id) => id.startsWith("await-new-head") || id.startsWith("ci-failed") || id.startsWith("rerun"))).toEqual([]);
    expect(w.fake.effects.merge).toBe(1);
  });

  it("sends a dirty PR to a conflict wake, and lands the head the woken agent pushed", async () => {
    const fake = fakeGitHub();
    const resolve = (): WakeOutcome => ((fake.pr(1).mergeableState = "clean"), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" });
    const { phases, wakes } = fakePhases({ wake: resolve });
    const w = world(phases, undefined, fake);
    w.fake.addPr({ headSha: H1, mergeableState: "dirty" });
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H2);

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(w.fake.effects.merge).toBe(1);
  });

  it("reviews every green head, each before the merge decision on it", async () => {
    const fake = fakeGitHub();
    const decidedAtReview: string[][] = [];
    const late: { host?: FactoryHost; runId?: string } = {};
    const { phases, reviews } = fakePhases({
      review: (request) => {
        decidedAtReview.push(stepIds(late.host!, late.runId!).filter((id) => id.startsWith("merge-policy")));
        return request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "rename" } : { kind: "MERGE", headSha: H2, evidence: {} };
      },
      wake: pushes(fake, H2),
    });
    const w = world(phases, undefined, fake);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);
    Object.assign(late, { host: w.host, runId });

    await approveAndFinish(w.host, runId, H2);

    expect(reviews.map((review) => [review.headSha, review.round])).toEqual([
      [H1, 0],
      [H2, 1],
    ]);
    expect(decidedAtReview).toEqual([[], []]);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("review at this head: MERGE");
  });

  it.each([
    ["merged by shepherd-pr", false],
    ["merged by someone else", true],
  ])("records one sh-landed with the merge sha when the PR is %s", async (_case, mergedElsewhere) => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1, ...(mergedElsewhere ? { merged: true, state: "closed", mergeSha: fakeSha("elsewhere") } : {}) });
    const runId = shepherdPr1(w);

    if (!mergedElsewhere) await approve(w.host, runId, H1);
    await w.host.runtime.wait(runId);
    const landed = Object.values(w.host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === "sh-landed");

    expect(landed).toHaveLength(1);
    expect(landed[0]!.data).toMatchObject({ result: { pr: 1, mergeSha: mergedElsewhere ? fakeSha("elsewhere") : expect.any(String) } });
  });

  it("sends NO_REPRO to a fix-proof wake, never to a review wake or a merge", async () => {
    const { phases, wakes } = fakePhases({ review: () => ({ kind: "NO_REPRO", headSha: H1, result: { class: "vacuous" } }) });
    const w = world(phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(wakes.map((wake) => wake.kind)).toEqual(["fix-proof"]);
    expect(w.fake.effects.merge).toBe(0);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("review at this head: NO_REPRO");
  });
});

describe("the merge hold", () => {
  it("refuses a held PR at the port and passes an unregistered PR straight through", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    w.fake.addPr({ headSha: H2 });
    w.store.register({ repo: REPO, pr: 1, runId: "run-held", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    w.store.hold("run-held", "frozen");
    const port = holdingPort(githubPort(w.fake.wire), () => w.store);

    await expect(port.merge(REPO, 1, H1, "squash")).rejects.toThrow(MergeHeldError);
    await expect(port.merge(REPO, 2, H2, "squash")).resolves.toMatchObject({ done: true });
    expect(w.fake.effects.merge).toBe(1);
  });

  it("refuses every merge when the store is unbound, rather than guessing no PR is held", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1 });
    const port = holdingPort(githubPort(fake.wire), () => shepherdStoreRef().get());

    await expect(port.merge(REPO, 1, H1, "squash")).rejects.toThrow(/not bound/);
    expect(fake.effects.merge).toBe(0);
  });

  it("lets a land-pr run on an unregistered PR merge through the same routes", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    const runId = w.host.runtime.start("land-pr", { repo: REPO, pr: "1" });

    await approveAndFinish(w.host, runId, H1);

    expect(w.fake.effects.merge).toBe(1);
  });
});
