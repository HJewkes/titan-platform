import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { GATE_CANCELLED_SIGNAL, type StepResult, type WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ReviewRequest, ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { seatPolicyHead, supersedeMovedGates } from "./head-moved.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Synthetic stand-ins for the three heads of the replayed run: sent back, gated, then moved past the gate. */
const SENT_BACK = fakeSha("replay-sent-back");
const GATED = fakeSha("replay-gated");
const MOVED = fakeSha("replay-moved");
const MOVED_AGAIN = fakeSha("replay-moved-again");

type Services = NonNullable<ReturnType<typeof factoryRoutesFor>["shepherd"]>;

interface Scenario {
  host: FactoryHost;
  fake: FakeGitHub;
  services: Services;
  runId: string;
  reviewed: string[];
  /** Answers the review at the moved head, which waits until the test releases it. */
  answerMoved: (verdict: Verdict) => void;
}

function scriptedPhases(fake: FakeGitHub, reviewed: string[], movedVerdict: Promise<Verdict>): ShepherdPhases {
  const merge = (request: ReviewRequest): Verdict => ({ kind: "MERGE", headSha: request.headSha, evidence: {} });
  return {
    review: async (_ctx, request) => {
      reviewed.push(request.headSha);
      if (request.headSha === SENT_BACK) return { kind: "FIX_FIRST", headSha: SENT_BACK, text: "synthetic finding" };
      return request.headSha === MOVED ? movedVerdict : merge(request);
    },
    wake: async () => (fake.pushHead(1, GATED), { kind: "woken", agent: "impl-a" }),
  };
}

/** One owner-gated shepherd-pr run over `fake`, waiting on its first approve-merge gate. */
async function gatedRun(fake: FakeGitHub, phases: ShepherdPhases, pr: Parameters<FakeGitHub["addPr"]>[0]): Promise<{ host: FactoryHost; services: Services; runId: string }> {
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr(pr);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, services: routes.shepherd!, runId };
}

/** The replayed run: FIX_FIRST at the first head, a fixer's push, MERGE at the second head, and the owner gate there. */
async function gatedAtSecondHead(): Promise<Scenario> {
  const fake = fakeGitHub();
  const reviewed: string[] = [];
  let answerMoved: (verdict: Verdict) => void = () => undefined;
  const movedVerdict = new Promise<Verdict>((resolve) => (answerMoved = resolve));
  const run = await gatedRun(fake, scriptedPhases(fake, reviewed, movedVerdict), { headSha: SENT_BACK });
  return { ...run, fake, reviewed, answerMoved };
}

/** Every review is silent, so the run escalates to the owner after its failed rounds at GATED. */
async function escalatedAtGated(): Promise<{ host: FactoryHost; fake: FakeGitHub; services: Services; runId: string }> {
  const fake = fakeGitHub();
  const phases: ShepherdPhases = { review: async () => ({ kind: "none" }), wake: async () => ({ kind: "unhandled", reason: "test" }) };
  return { ...(await gatedRun(fake, phases, { headSha: GATED })), fake };
}

/** A conflict that survives the fixer's push to GATED asks the owner at GATED. */
async function conflictAtGated(): Promise<{ host: FactoryHost; fake: FakeGitHub; services: Services; runId: string }> {
  const fake = fakeGitHub();
  const phases: ShepherdPhases = { review: async () => ({ kind: "none" }), wake: async () => (fake.pushHead(1, GATED), { kind: "woken", agent: "impl-a" }) };
  return { ...(await gatedRun(fake, phases, { headSha: SENT_BACK, mergeableState: "dirty" })), fake };
}

/** A seat gate at GATED the owner approves just as the PR conflicts; the fixer's push to MOVED still conflicts, so the owner is asked at MOVED. */
async function conflictAfterSeatGate(): Promise<{ host: FactoryHost; fake: FakeGitHub; services: Services; runId: string }> {
  const fake = fakeGitHub();
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => (fake.pushHead(1, MOVED), { kind: "woken", agent: "impl-a" }),
  };
  const run = await gatedRun(fake, phases, { headSha: GATED });
  Object.assign(fake.pr(1), { mergeableState: "dirty" });
  run.host.runtime.signal(run.runId, "approve-merge", { decision: "merge", headSha: GATED }, OWNER);
  await gateOpened(run.host, gateId(run.runId, "approve-merge", 1));
  return { ...run, fake };
}

function mergePolicyHeads(host: FactoryHost, runId: string): string[] {
  const results = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("merge-policy"));
  return results.map((result) => (JSON.parse(result.output ?? "{}") as { result: { headSha: string } }).result.headSha);
}

describe("a pending approve-merge gate whose pull request head moved", () => {
  it("never asks the merge policy about a head whose review was FIX_FIRST", async () => {
    const { host, runId } = await gatedAtSecondHead();

    expect(mergePolicyHeads(host, runId)).toEqual([GATED]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${GATED}`);
  });

  it("is superseded: the stale gate is cancelled and the run is in review at the new head", async () => {
    const { host, fake, services, runId, reviewed } = await gatedAtSecondHead();
    fake.pushHead(1, MOVED);

    const superseded = await supersedeMovedGates(host, services);

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: GATED, to: MOVED, condition: "head-moved" }]);
    await vi.waitFor(() => expect(reviewed).toEqual([SENT_BACK, GATED, MOVED]));
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("cancelled");
    expect(host.pendingGates().filter((pending) => pending.runId === runId)).toEqual([]);
    expect(host.runtime.status(runId)?.status).toBe("running");
  });

  it("a dry run reports the moved gate and supersedes nothing", async () => {
    const { host, fake, services, runId } = await gatedAtSecondHead();
    fake.pushHead(1, MOVED);

    const superseded = await supersedeMovedGates(host, services, { dryRun: true });

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: GATED, to: MOVED, condition: "head-moved" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
    expect(host.runtime.status(runId)?.status).toBe("paused");
  });

  it("asks the owner again at the new head once its review says MERGE, and merges that head", async () => {
    const { host, fake, services, runId, answerMoved } = await gatedAtSecondHead();
    fake.pushHead(1, MOVED);
    await supersedeMovedGates(host, services);

    answerMoved({ kind: "MERGE", headSha: MOVED, evidence: {} });
    await gateOpened(host, gateId(runId, "approve-merge", 1));
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: MOVED }, OWNER);

    await vi.waitFor(() => expect(fake.pr(1).merged).toBe(true));
    expect(host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(`at head ${MOVED}`);
    expect(mergePolicyHeads(host, runId)).toEqual([GATED, MOVED]);
    expect(fake.pr(1)).toMatchObject({ merged: true, headSha: MOVED });
  });

  it("still fails the run when its approve-merge gate is cancelled for any other reason", async () => {
    const { host, runId } = await gatedAtSecondHead();

    host.gates.cancel(gateId(runId, "approve-merge"), "the owner cancelled it");

    expect(await host.runtime.wait(runId)).toMatchObject({ status: "failed", error: expect.stringContaining("approve-merge was cancelled: the owner cancelled it") });
  });

  it("supersedes a later approve-merge iteration when the head moves again", async () => {
    const { host, fake, services, runId, answerMoved } = await gatedAtSecondHead();
    fake.pushHead(1, MOVED);
    await supersedeMovedGates(host, services);
    answerMoved({ kind: "MERGE", headSha: MOVED, evidence: {} });
    await gateOpened(host, gateId(runId, "approve-merge", 1));
    fake.pushHead(1, MOVED_AGAIN);

    const superseded = await supersedeMovedGates(host, services);

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge", 1), from: MOVED, to: MOVED_AGAIN, condition: "head-moved" }]);
    expect(host.gates.get(gateId(runId, "approve-merge", 1))?.status).toBe("cancelled");
  });

  it("leaves an escalation gate at an old head with the owner when the head moves", async () => {
    const { host, fake, services, runId } = await escalatedAtGated();
    fake.pushHead(1, MOVED);

    const superseded = await supersedeMovedGates(host, services);

    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`shepherd-route/failed-rounds`);
    expect(superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("leaves a conflict gate at an old head with the owner when the head moves", async () => {
    const { host, fake, services, runId } = await conflictAtGated();
    fake.pushHead(1, MOVED);

    const superseded = await supersedeMovedGates(host, services);

    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${GATED}? Policy shepherd-route/conflict`);
    expect(superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("leaves a conflict gate with the owner when the run's last seat-policy decision was about an older head", async () => {
    const { host, fake, services, runId } = await conflictAfterSeatGate();
    fake.pushHead(1, MOVED_AGAIN);

    const superseded = await supersedeMovedGates(host, services);

    expect(host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(`at head ${MOVED}? Policy shepherd-route/conflict`);
    expect(mergePolicyHeads(host, runId)).toEqual([GATED]);
    expect(superseded).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge", 1))?.status).toBe("pending");
  });

  it("leaves a gate alone while the head it asks about is still the pull request's head", async () => {
    const { host, services, runId } = await gatedAtSecondHead();

    expect(await supersedeMovedGates(host, services)).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });

  it("leaves a gate alone when GitHub cannot be read", async () => {
    const { host, fake, services, runId } = await gatedAtSecondHead();
    fake.pushHead(1, MOVED);

    expect(await supersedeMovedGates(host, { ...services, port: { ...services.port, getPr: async () => Promise.reject(new Error("offline")) } })).toEqual([]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("pending");
  });
});

/** FIX_FIRST at SENT_BACK with the wake unhandled, as when the implementer detached; the run waits on the owner's sh-sent-back gate. */
async function sentBackUnwoken(): Promise<{ host: FactoryHost; fake: FakeGitHub; services: Services; runId: string; reviewed: string[] }> {
  const fake = fakeGitHub();
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const reviewed: string[] = [];
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => (reviewed.push(request.headSha), request.headSha === SENT_BACK ? { kind: "FIX_FIRST", headSha: SENT_BACK, text: "synthetic finding" } : { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => ({ kind: "unhandled", reason: "the implementer detached" }),
  };
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: SENT_BACK });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, "sh-sent-back"));
  return { host, fake, services: routes.shepherd!, runId, reviewed };
}

describe("a pending sh-sent-back gate whose pull request head moved", () => {
  it("is superseded, and the run awaits the new head and reviews it with no owner answer", async () => {
    const { host, fake, services, runId, reviewed } = await sentBackUnwoken();
    fake.pushHead(1, MOVED);

    const superseded = await supersedeMovedGates(host, services);

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "sh-sent-back"), from: SENT_BACK, to: MOVED, condition: "head-moved" }]);
    await gateOpened(host, gateId(runId, "approve-merge"));
    expect(reviewed).toEqual([SENT_BACK, MOVED]);
    expect(Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId)).toContain("await-new-head:0");
    expect(host.gates.get(gateId(runId, "sh-sent-back"))?.status).toBe("cancelled");
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${MOVED}`);
  });

  it("stays with the owner while the head it asks about is still the pull request's head", async () => {
    const { host, services, runId } = await sentBackUnwoken();

    expect(await supersedeMovedGates(host, services)).toEqual([]);
    expect(host.gates.get(gateId(runId, "sh-sent-back"))?.status).toBe("pending");
  });

  it("still fails the run when the gate is cancelled for any other reason", async () => {
    const { host, runId } = await sentBackUnwoken();

    host.gates.cancel(gateId(runId, "sh-sent-back"), "the owner cancelled it");

    expect(await host.runtime.wait(runId)).toMatchObject({ status: "failed", error: expect.stringContaining("sh-sent-back was cancelled: the owner cancelled it") });
  });
});

/** Synthetic heads for a red PR whose fixer pushes after the owner's ci-failed gate opened. */
const RED = fakeSha("cc749-red");
const FIXED = fakeSha("cc749-fixed");

/** A host where RED fails `validate` and the ci-red wake is unhandled, as when the implementer detached. */
function redUnwoken(fake: FakeGitHub, dbPath = ":memory:"): { host: FactoryHost; services: Services; reviewed: string[] } {
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1, undefined, open.headSha === RED ? "failure" : "success"), successRun("dag-check", 2)]);
  const reviewed: string[] = [];
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => (reviewed.push(request.headSha), { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => ({ kind: "unhandled", reason: "the implementer detached" }),
  };
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath, workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, services: routes.shepherd!, reviewed };
}

/** A shepherd-pr run on PR 1 at RED, waiting on the owner's ci-failed gate. */
async function ciFailedAtRed(dbPath?: string): Promise<{ host: FactoryHost; fake: FakeGitHub; services: Services; runId: string; reviewed: string[] }> {
  const fake = fakeGitHub();
  const opened = redUnwoken(fake, dbPath);
  fake.addPr({ headSha: RED });
  const runId = opened.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  opened.services.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(opened.host, gateId(runId, "ci-failed"));
  return { ...opened, fake, runId };
}

function ciFailedResults(host: FactoryHost, runId: string): StepResult[] {
  return Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId === "ci-failed");
}

describe("a pending ci-failed gate whose pull request head moved", () => {
  it("is superseded, and the run takes the new head through CI and review with no owner answer", async () => {
    const { host, fake, services, runId, reviewed } = await ciFailedAtRed();
    fake.pushHead(1, FIXED);

    const superseded = await supersedeMovedGates(host, services);

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "ci-failed"), from: RED, to: FIXED, condition: "head-moved" }]);
    await gateOpened(host, gateId(runId, "approve-merge"));
    expect(host.gates.get(gateId(runId, "ci-failed"))?.status).toBe("cancelled");
    expect(host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${FIXED}`);
    expect(reviewed).toEqual([FIXED]);
    expect(Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId)).toContain("await-new-head:0");
  });

  it("stays with the owner while the red head is still the pull request's head", async () => {
    const { host, services, runId } = await ciFailedAtRed();

    expect(await supersedeMovedGates(host, services)).toEqual([]);
    expect(host.gates.get(gateId(runId, "ci-failed"))?.status).toBe("pending");
    expect(host.runtime.status(runId)?.status).toBe("paused");
  });

  it("still fails the run when the gate is cancelled for any other reason", async () => {
    const { host, runId } = await ciFailedAtRed();

    host.gates.cancel(gateId(runId, "ci-failed"), "the owner cancelled it");

    expect(await host.runtime.wait(runId)).toMatchObject({ status: "failed", error: expect.stringContaining("ci-failed was cancelled: the owner cancelled it") });
  });

  it("records the supersede once, and a restarted run replays it without asking about the red head again", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cc749-")), "factory.db");
    const first = await ciFailedAtRed(dbPath);
    first.fake.pushHead(1, FIXED);
    await supersedeMovedGates(first.host, first.services);
    await gateOpened(first.host, gateId(first.runId, "approve-merge"));
    first.host.close();

    const second = redUnwoken(first.fake, dbPath);
    await second.host.resume();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(ciFailedResults(second.host, first.runId)).toEqual([expect.objectContaining({ signal: GATE_CANCELLED_SIGNAL, data: expect.objectContaining({ reason: expect.stringContaining(`moved from head ${RED} to ${FIXED}`) }) })]);
    expect(second.host.gates.get(gateId(first.runId, "ci-failed", 1))).toBeUndefined();
    expect(second.host.gates.get(gateId(first.runId, "approve-merge"))?.status).toBe("pending");
    expect(second.host.runtime.status(first.runId)?.status).toBe("paused");
  });
});

describe("seatPolicyHead", () => {
  const PROMPT = `Merge PR #1 in ${REPO} at head ${GATED}? CI is green. Policy shepherd-seat/trusted-seat: gated`;

  function decision(stepId: string, result: object, completedAt: string): StepResult {
    return { stepId, iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt, output: JSON.stringify({ result }) };
  }

  function runWith(...results: StepResult[]): WorkflowRun {
    return { stepResults: Object.fromEntries(results.map((result) => [`${result.stepId}:0`, result])) } as unknown as WorkflowRun;
  }

  const seatGate = { outcome: "gate", headSha: GATED, rule: { table: "shepherd-seat" } };

  it("names the head of a gate the seat policy opened at that head", () => {
    expect(seatPolicyHead(runWith(decision("merge-policy:r1:0", seatGate, "2026-10-02T00:00:00Z")), PROMPT)).toBe(GATED);
  });

  it("is undefined when the seat policy allowed that head rather than gating it", () => {
    expect(seatPolicyHead(runWith(decision("merge-policy:r1:0", { ...seatGate, outcome: "allow" }, "2026-10-02T00:00:00Z")), PROMPT)).toBeUndefined();
  });

  it("reads the last decision by round and index, not by completion time", () => {
    const later = decision("merge-policy:r2:0", { ...seatGate, rule: { table: "shepherd-route" } }, "2026-10-01T00:00:00Z");
    const earlier = decision("merge-policy:r1:3", seatGate, "2026-10-03T00:00:00Z");

    expect(seatPolicyHead(runWith(earlier, later), PROMPT)).toBeUndefined();
  });

  it("is undefined when the last decision's output does not parse", () => {
    const broken = { ...decision("merge-policy:r1:0", seatGate, "2026-10-02T00:00:00Z"), output: "{not json" };

    expect(seatPolicyHead(runWith(broken), PROMPT)).toBeUndefined();
  });
});
