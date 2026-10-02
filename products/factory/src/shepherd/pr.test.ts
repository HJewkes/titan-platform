import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerUnavailableError, DispatchError } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import { MergeHeldError, holdingPort } from "./hold.js";
import type { ParkPort } from "./park.js";
import type { ReviewRequest, ShepherdPhases, Verdict, WakeOutcome, WakeRequest } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { VERSION_PACKAGES_BRANCH, type PackageRegistry } from "./release.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef, type ShepherdStore, type ShepherdStoreRef } from "./store.js";
import { OWNER } from "../test-support/resolver.js";

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
function world(phases: ShepherdPhases, validate: (headSha: string) => string = () => "success", fake = fakeGitHub(), park?: ParkPort, registry: PackageRegistry = async () => true, dbPath = ":memory:"): World {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, validate(pr.headSha)), successRun("dag-check", 2)]);
  let clock = 0;
  const ref = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const port = githubPort(fake.wire);
  const mainGreen = { ...port, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 9)]), port.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port: mainGreen, store: ref, now: () => clock, sleep: tick, park, registry });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, ref, store: ref.get() };
}

const DENY_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "never", seat: "frozen-seat" };
const AUTO_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };

/** Start shepherd-pr on PR 1 and register it, as `shepherd.register` will; an undefined `param` starts it with no policy param. */
function shepherdPr1(w: World, registered = OWNER_GATE_POLICY, param: EffectivePolicy | undefined = OWNER_GATE_POLICY): string {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", ...(param && { policy: JSON.stringify(param) }) });
  w.store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: registered });
  return runId;
}

function stepResult(host: FactoryHost, runId: string, stepId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId === stepId)?.data;
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

async function approve(host: FactoryHost, runId: string, headSha: string, iteration = 0): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge", iteration));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha }, OWNER);
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
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
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

  it.each([
    ["FIX_FIRST", { kind: "FIX_FIRST", headSha: H1, text: "missing test" }, "review"],
    ["NO_REPRO", { kind: "NO_REPRO", headSha: H1, result: { class: "vacuous" } }, "fix-proof"],
  ] as const)("asks a human, never the merge decision, when the %s wake is unhandled", async (_kind, verdict, wake) => {
    const { phases, wakes } = fakePhases({ review: () => verdict });
    const w = world(phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "sh-sent-back"));
    w.host.runtime.signal(runId, "sh-sent-back", { decision: "abandon" }, OWNER);
    await w.host.runtime.wait(runId);

    expect(wakes.map((request) => request.kind)).toEqual([wake]);
    expect(stepIds(w.host, runId).filter((id) => id.startsWith("merge"))).toEqual([]);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(w.fake.effects.merge).toBe(0);
  });

  it("lands the head pushed after a human chose to wait on an unhandled FIX_FIRST", async () => {
    const { phases } = fakePhases({ review: (request) => (request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "rename" } : { kind: "none" }) });
    const w = world(phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "sh-sent-back"));
    w.host.runtime.signal(runId, "sh-sent-back", { decision: "await-new-head" }, OWNER);
    w.fake.pushHead(1, H2);
    await approveAndFinish(w.host, runId, H2);

    expect(stepIds(w.host, runId)).not.toContain("merge-policy:0");
    expect(w.fake.effects.merge).toBe(1);
  });

  it("ignores a verdict about another head, so a stale FIX_FIRST neither sends back nor reaches the owner", async () => {
    const { phases, wakes } = fakePhases({ review: () => ({ kind: "FIX_FIRST", headSha: H2, text: "about an older head" }) });
    const w = world(phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(wakes).toEqual([]);
    expect(w.host.gates.get(gateId(runId, "sh-sent-back"))).toBeUndefined();
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).not.toContain("FIX_FIRST");
  });
});

describe("the route table in a run", () => {
  const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
  const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;
  const merges = (ctx: Parameters<ShepherdPhases["review"]>[0], request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });

  function autoWorld(review: ShepherdPhases["review"], wake: ShepherdPhases["wake"] = async () => UNHANDLED): World {
    const w = world({ review, wake });
    w.fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    w.fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    return w;
  }

  it("updates a PR that went behind during a MERGE review, then merges the updated head with no approve-merge gate", async () => {
    const late: { w?: World } = {};
    const w = autoWorld(async (ctx, request) => {
      if (request.headSha === H1) Object.assign(late.w!.fake.pr(1), { mergeableState: "behind", behind: true });
      return merges(ctx, request);
    });
    late.w = w;
    const greenRuns = w.fake.onGetPr!;
    w.fake.onGetPr = (pr, reads) => (greenRuns(pr, reads), pr.headSha !== H1 && (pr.mergeableState = "clean"));
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.effects).toMatchObject({ updateBranch: 1, merge: 1 });
    expect(w.host.gates.listPending()).toEqual([]);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(stepResult(w.host, runId, "merge-policy:0")).toBeUndefined();
  });

  it("gives a silent reviewer one fresh reviewer at the same head and merges on its MERGE", async () => {
    const asked: ReviewRequest[] = [];
    const w = autoWorld(async (ctx, request) => (asked.push(request), request.fresh ? merges(ctx, request) : { kind: "none", cause: "timeout" }));
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(asked.map((request) => [request.headSha, request.fresh ?? false])).toEqual([
      [H1, false],
      [H1, true],
    ]);
    expect(w.fake.effects.merge).toBe(1);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
  });

  it("opens approve-merge naming the failed rounds after three reviews give no verdict", async () => {
    const asked: ReviewRequest[] = [];
    const w = autoWorld(async (_ctx, request) => (asked.push(request), { kind: "none", cause: "timeout" }));
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await gateOpened(w.host, gateId(runId, "approve-merge"));
    const gate = w.host.gates.get(gateId(runId, "approve-merge"));

    expect(asked).toHaveLength(3);
    expect(gate?.prompt).toContain(`Policy shepherd-route/failed-rounds: 3 review rounds failed at this task: the last at ${H1} ended with no reviewer verdict`);
    expect(w.fake.effects.merge).toBe(0);
  });

  it("counts a FIX_FIRST that yields a new head as progress, so two stuck rounds around it still merge", async () => {
    const late: { w?: World } = {};
    const asked: ReviewRequest[] = [];
    const review: ShepherdPhases["review"] = async (ctx, request) => {
      asked.push(request);
      if (!request.fresh) return { kind: "none", cause: "timeout" };
      return request.headSha === H1 ? { kind: "FIX_FIRST", headSha: H1, text: "missing test" } : merges(ctx, request);
    };
    const w = autoWorld(review, async () => (late.w!.fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }));
    late.w = w;
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(asked.map((request) => [request.headSha, request.fresh ?? false])).toEqual([
      [H1, false],
      [H1, true],
      [H2, false],
      [H2, true],
    ]);
    expect(w.fake.effects.merge).toBe(1);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
  });

  it("opens approve-merge naming the runaway at the sixth FIX_FIRST, each of which yielded a new head", async () => {
    const late: { w?: World } = {};
    const heads: string[] = [];
    const w = autoWorld(
      async (_ctx, request) => (heads.push(request.headSha), { kind: "FIX_FIRST", headSha: request.headSha, text: "again" }),
      async () => (late.w!.fake.pushHead(1, fakeSha(`fix-${heads.length}`)), { kind: "woken", agent: "impl-a" }),
    );
    late.w = w;
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(heads).toHaveLength(6);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`Policy shepherd-route/fix-first-runaway: 6 FIX_FIRST reviews at this task: the last at ${heads[5]}`);
    expect(w.fake.effects.merge).toBe(0);
  });

  it("labels an owner-gate seat's approve-merge as a policy that did not allow the merge", async () => {
    const w = autoWorld(async (ctx, request) => merges(ctx, request));
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("the authority policy did not allow an automated merge: seat none policy owner-gate");
  });

  it("ends the run as merged, with no gate, when the PR is merged elsewhere during the review", async () => {
    const late: { w?: World } = {};
    const w = autoWorld(async (ctx, request) => {
      Object.assign(late.w!.fake.pr(1), { merged: true, state: "closed", mergeSha: fakeSha("elsewhere") });
      return merges(ctx, request);
    });
    late.w = w;
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.host.gates.listPending()).toEqual([]);
    expect(stepResult(w.host, runId, "sh-landed")).toMatchObject({ result: { mergeSha: fakeSha("elsewhere") } });
    expect(w.fake.effects.merge).toBe(0);
  });

  it("starts a new cycle when the head moves during the review, and decides the merge only at the new head", async () => {
    const late: { w?: World } = {};
    const asked: string[] = [];
    const w = autoWorld(async (ctx, request) => {
      asked.push(request.headSha);
      if (request.headSha === H1) late.w!.fake.pushHead(1, H2);
      return merges(ctx, request);
    });
    late.w = w;
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(asked).toEqual([H1, H2]);
    expect(stepResult(w.host, runId, "merge-policy:r1:0")).toMatchObject({ result: { outcome: "allow", headSha: H2 } });
    expect(stepIds(w.host, runId)).not.toContain("merge-policy:0");
    expect(w.fake.effects.merge).toBe(1);
  });

  it("opens approve-merge naming the conflict when a conflict survives one fixer attempt", async () => {
    const fake = fakeGitHub();
    const { phases, wakes } = fakePhases({ wake: () => (fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }) });
    const w = world(phases, undefined, fake);
    w.fake.addPr({ headSha: H1, mergeableState: "dirty" });
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: H2 }, OWNER);
    const done = await w.host.runtime.wait(runId);

    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("Policy shepherd-route/conflict: a merge conflict survived one fixer attempt");
    expect(done.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(0);
  });
});

describe("the Version Packages PR", () => {
  const RELEASE_FILES = [
    { path: "packages/widget/package.json", status: "modified" },
    { path: "packages/widget/CHANGELOG.md", status: "modified" },
    { path: ".changeset/brave-otters.md", status: "removed" },
  ];

  /** The widget manifest bumped from 1.0.0 at the merge base to 1.1.0 at `head`. */
  function setWidgetManifest(fake: FakeGitHub, head: string): void {
    fake.files.set(`${fakeSha("base")}:packages/widget/package.json`, { content: JSON.stringify({ name: "@demo/widget", version: "1.0.0" }), blobSha: "b0" });
    fake.files.set(`${head}:packages/widget/package.json`, { content: JSON.stringify({ name: "@demo/widget", version: "1.1.0" }), blobSha: "b1" });
  }

  /** The changesets PR as PR 1, registered the way the release sweep registers it. */
  function releaseWorld(registry: PackageRegistry): { w: World; runId: string; reviews: ReviewRequest[] } {
    const { phases, reviews } = fakePhases({});
    const w = world(phases, undefined, undefined, undefined, registry);
    w.fake.addPr({ headSha: H1, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO, mergeSha: fakeSha("test-merge") });
    w.fake.prFiles.set(1, RELEASE_FILES);
    setWidgetManifest(w.fake, H1);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", branch: VERSION_PACKAGES_BRANCH, policy: JSON.stringify(AUTO_POLICY) });
    w.store.register({ repo: REPO, pr: 1, branch: VERSION_PACKAGES_BRANCH, runId, task: "demo/version-packages", implementer: "changesets", policy: AUTO_POLICY });
    return { w, runId, reviews };
  }

  it("lands on green after its release preflight, with no reviewer, no park and no gate", async () => {
    const { w, runId, reviews } = releaseWorld(async () => true);

    await w.host.runtime.wait(runId);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(1);
    expect(reviews).toEqual([]);
    expect(stepIds(w.host, runId)).toContain(`sh-release-preflight:${H1}`);
    expect(stepIds(w.host, runId).filter((id) => id.startsWith("sh-park"))).toEqual([]);
    expect(stepResult(w.host, runId, "merge-policy:0")).toMatchObject({ result: { outcome: "allow", rule: { table: "shepherd-release", rowId: "version-packages" } } });
  });

  it("gates with the package's name when npm has never seen it", async () => {
    const { w, runId } = releaseWorld(async () => false);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(
      "Policy shepherd-release/preflight-blocked: the release cannot land yet: @demo/widget is not on registry.npmjs.org yet",
    );
    expect(w.fake.effects.merge).toBe(0);
    expect(w.store.byRun(runId)?.releaseReady).toBeNull();
  });

  it("defers another PR's merge while the Version Packages PR is ready, then re-reads CI and merges once it lands", async () => {
    const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
    const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;
    const merges: ShepherdPhases["review"] = (ctx, request) =>
      mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] });
    const w = world({ review: merges, wake: async () => UNHANDLED });
    w.fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    w.fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    const release = w.fake.addPr({ headSha: H2, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO });
    w.store.register({ repo: REPO, pr: release.number, branch: VERSION_PACKAGES_BRANCH, runId: "run-release", task: "demo/version-packages", implementer: "changesets", policy: AUTO_POLICY });
    w.store.setReleaseReady("run-release", H2);
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("merge:0"));
    await sleep(100, new AbortController().signal);
    const whileReady = w.fake.effects.merge;
    Object.assign(w.fake.pr(release.number), { state: "closed", merged: true });
    await w.host.runtime.wait(runId);

    expect(whileReady).toBe(0);
    expect(stepResult(w.host, runId, "merge:0")).toMatchObject({ result: { done: false, skipped: "held" } });
    expect(w.fake.effects.merge).toBe(1);
    expect(w.host.runtime.status(runId)?.status).toBe("completed");
  });

  it("never marks a release ready under an owner-gate seat, so another PR's merge is not deferred", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    w.fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    const release = w.fake.addPr({ headSha: H2, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO });
    w.fake.prFiles.set(release.number, RELEASE_FILES);
    setWidgetManifest(w.fake, H2);
    const releaseRun = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: String(release.number), branch: VERSION_PACKAGES_BRANCH, policy: JSON.stringify(OWNER_GATE_POLICY) });
    w.store.register({ repo: REPO, pr: release.number, branch: VERSION_PACKAGES_BRANCH, runId: releaseRun, task: "demo/version-packages", implementer: "changesets", policy: OWNER_GATE_POLICY });

    await gateOpened(w.host, gateId(releaseRun, "approve-merge"));
    const releaseReady = w.store.byRun(releaseRun)?.releaseReady;
    expect(releaseReady).toBeNull();
    const runId = shepherdPr1(w);
    await approveAndFinish(w.host, runId, H1);

    expect(stepResult(w.host, releaseRun, `sh-release-preflight:${H2}`)).toMatchObject({ result: { blockers: [] } });
    expect(stepResult(w.host, runId, "merge:0")).not.toMatchObject({ result: { skipped: "held" } });
    expect(w.fake.effects.merge).toBe(1);
  });
});

describe("sh-park", () => {
  /** Phases and a park port that log one shared order of events, so a test can see park land before review. */
  function parkWorld(park: (name: string) => string[]): { w: World; events: string[] } {
    const events: string[] = [];
    const phases: ShepherdPhases = {
      wake: async () => UNHANDLED,
      review: async (_ctx, request) => (events.push(`review ${request.headSha}`), { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    };
    const w = world(phases, undefined, undefined, (name) => (events.push(`park ${name}`), { lines: park(name) }));
    w.fake.addPr({ headSha: H1 });
    return { w, events };
  }

  it("parks the registered implementer once CI is green, before the review of that head", async () => {
    const { w, events } = parkWorld((name) => [`Parked ${name}.`]);
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H1);

    expect(events).toEqual(["park impl-a", `review ${H1}`]);
    expect(stepIds(w.host, runId).indexOf("ci-wait:0")).toBeLessThan(stepIds(w.host, runId).indexOf(`sh-park:${H1}`));
    expect(stepResult(w.host, runId, `sh-park:${H1}`)).toMatchObject({ result: { kind: "parked", agent: "impl-a", lines: ["Parked impl-a."] } });
  });

  it("logs a broker refusal of park in the step output and still takes the run to its merge", async () => {
    const { w, events } = parkWorld(() => {
      throw new DispatchError("agent-chat refused agent park: Not parked: impl-a is live");
    });
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H1);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(1);
    expect(events).toEqual(["park impl-a", `review ${H1}`]);
    expect(stepResult(w.host, runId, `sh-park:${H1}`)).toMatchObject({
      result: { kind: "not-parked", agent: "impl-a", reason: "agent-chat refused agent park: Not parked: impl-a is live", brokerDown: false },
    });
  });

  it("logs a broker that is down as not parked and still takes the run to its merge", async () => {
    const { w } = parkWorld(() => {
      throw new BrokerUnavailableError("agent-chat agent park: could not reach or start the agent-chat broker");
    });
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H1);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(1);
    expect(stepResult(w.host, runId, `sh-park:${H1}`)).toMatchObject({ result: { kind: "not-parked", brokerDown: true } });
  });
});

describe("the effective merge policy", () => {
  it.each([
    ["an absent run param", undefined],
    ["an owner-gate run param", OWNER_GATE_POLICY],
  ])("keeps a registration's deny with %s", async (_case, param) => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w, DENY_POLICY, param);

    await w.host.runtime.wait(runId);

    expect(stepResult(w.host, runId, "merge-policy:0")).toMatchObject({ result: { outcome: "deny", rule: { rowId: "frozen-seat" } } });
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(w.fake.effects.merge).toBe(0);
  });

  it("keeps a run param's deny when the registration would gate", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(w, OWNER_GATE_POLICY, DENY_POLICY);

    await w.host.runtime.wait(runId);

    expect(stepResult(w.host, runId, "merge-policy:0")).toMatchObject({ result: { outcome: "deny" } });
    expect(w.fake.effects.merge).toBe(0);
  });

  it("under auto, merges on MRG-AU-RV with no hitl gate and stores the evidence record in merge-policy", async () => {
    const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
    const locator = { sourceId: "transcript-1" } as unknown as SourceTextLocator;
    const phases: ShepherdPhases = {
      wake: async () => UNHANDLED,
      review: async (ctx, request) =>
        mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
    };
    const w = world(phases);
    w.fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
    w.fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
    const runId = shepherdPr1(w, AUTO_POLICY, AUTO_POLICY);

    await w.host.runtime.wait(runId);

    expect(w.fake.effects.merge).toBe(1);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(stepResult(w.host, runId, "merge-policy:0")).toMatchObject({
      result: { outcome: "allow", headSha: H1, rule: { table: "authority", rowId: "MRG-AU-RV" } },
      allowEvidence: { runId, head: H1, reviewer, testMergeSha: fakeSha("test-merge"), decision: { outcome: "allow" } },
    });
    expect(w.fake.comments.get(1)).toHaveLength(1);
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

  it("refuses every merge through factoryRoutesFor when the store is unbound, rather than guessing no PR is held", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1 });
    const merge = factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef() }).find((route) => route.match === "merge")!;
    const input = { prompt: JSON.stringify({ repo: REPO, pr: 1, sha: H1, method: "squash" }), signal: new AbortController().signal, attempt: 1, requestKey: "k", stepId: "merge:0" };

    const outcome = await merge.runner.run(input as never);

    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/not bound/) });
    expect(fake.effects.merge).toBe(0);
  });

  it("holds a land-pr merge of a PR whose branch registration is held before the PR was recorded", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1, headRef: BRANCH });
    w.store.register({ repo: REPO, branch: BRANCH, runId: "run-branch", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    w.store.hold("run-branch", "owner wants a look");
    const runId = w.host.runtime.start("land-pr", { repo: REPO, pr: "1" });

    await approve(w.host, runId, H1);
    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.currentStep).toBe("merge:0"));
    await sleep(100, new AbortController().signal);
    const whileHeld = { merges: w.fake.effects.merge, status: w.host.runtime.status(runId)?.status };
    w.store.release("run-branch");
    await w.host.runtime.wait(runId);

    expect(whileHeld).toEqual({ merges: 0, status: "running" });
    expect(w.fake.effects.merge).toBe(1);
  });

  it("lets a land-pr run on an unregistered PR merge through the same routes", async () => {
    const w = world(fakePhases({}).phases);
    w.fake.addPr({ headSha: H1 });
    const runId = w.host.runtime.start("land-pr", { repo: REPO, pr: "1" });

    await approveAndFinish(w.host, runId, H1);

    expect(w.fake.effects.merge).toBe(1);
  });
});

describe("an update-branch the base cannot merge into", () => {
  const behindPr = (fake: FakeGitHub): void => {
    fake.updateBranchConflict = true;
    fake.addPr({ headSha: H1, mergeableState: "behind", behind: true });
  };

  it("wakes the fixer with the conflict instead of failing the run", async () => {
    const fake = fakeGitHub();
    const resolve = (): WakeOutcome => ((fake.updateBranchConflict = false), (fake.pr(1).behind = false), (fake.pr(1).mergeableState = "clean"), fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" });
    const { phases, wakes } = fakePhases({ wake: resolve });
    const w = world(phases, undefined, fake);
    behindPr(fake);
    const runId = shepherdPr1(w);

    await approveAndFinish(w.host, runId, H2);

    expect(w.host.runtime.status(runId)?.status).toBe("completed");
    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["conflict", H1]]);
    expect(w.fake.effects.merge).toBe(1);
  });

  it("opens approve-merge naming the conflict when it survives one fixer wake", async () => {
    const fake = fakeGitHub();
    const { phases, wakes } = fakePhases({ wake: () => (fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }) });
    const w = world(phases, undefined, fake);
    behindPr(fake);
    const runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: H2 }, OWNER);
    const done = await w.host.runtime.wait(runId);

    expect(wakes.map((wake) => wake.kind)).toEqual(["conflict"]);
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain("a merge conflict survived one fixer attempt");
    expect(done.status).toBe("completed");
    expect(w.fake.effects.merge).toBe(0);
  });
});

describe("a new cycle at a new head", () => {
  it("expires pending approve-merge and sh-sent-back gates for an older head and keeps one at the current head", async () => {
    const stale = fakeSha("old-head");
    const fake = fakeGitHub();
    const w = world(fakePhases({}).phases, undefined, fake);
    fake.addPr({ headSha: H1 });
    const seedGates = fake.onGetPr!;
    let runId = "";
    fake.onGetPr = (pr, reads) => {
      seedGates(pr, reads);
      if (reads !== 1) return;
      w.host.gates.create({ id: `${runId}/approve-merge:7`, prompt: `Merge PR #1 in ${REPO} at head ${stale}?` });
      w.host.gates.create({ id: `${runId}/sh-sent-back`, prompt: `The review of PR #1 in ${REPO} at head ${stale} said FIX_FIRST` });
      w.host.gates.create({ id: `${runId}/sh-sent-back:3`, prompt: `The review of PR #1 in ${REPO} at head ${H1} said FIX_FIRST` });
    };
    runId = shepherdPr1(w);

    await gateOpened(w.host, gateId(runId, "approve-merge"));

    expect(w.host.gates.get(`${runId}/approve-merge:7`)?.status).toBe("cancelled");
    expect(w.host.gates.get(`${runId}/sh-sent-back`)?.status).toBe("cancelled");
    expect(w.host.gates.get(`${runId}/sh-sent-back:3`)?.status).toBe("pending");
    expect(w.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

describe("a restarted run", () => {
  it("keeps the approve-merge gate it waits on at the newest head", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tp742-")), "factory.db");
    const fake = fakeGitHub();
    const red = (sha: string): string => (sha === H1 ? "failure" : "success");
    const first = world(fakePhases({ wake: pushes(fake, H2) }).phases, red, fake, undefined, undefined, dbPath);
    fake.addPr({ headSha: H1 });
    const runId = shepherdPr1(first);
    await gateOpened(first.host, gateId(runId, "approve-merge"));
    first.host.close();

    const second = world(fakePhases({ wake: pushes(fake, H2) }).phases, red, fake, undefined, undefined, dbPath);
    await second.host.resume();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(second.host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(second.host.runtime.status(runId)?.status).toBe("paused");
  });
});
