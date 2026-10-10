import type { WorkflowRun } from "@titan-design/workflow";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { TEST_BRIEF } from "../test-support/brief.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep, step } from "../workflows/land.js";
import { MergeResultResult } from "../workflows/land-steps.js";
import { SHEPHERD_WORKFLOW } from "./commands.js";
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere, mergedItself } from "./gone-elsewhere.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

const HEAD = fakeSha("gate-sweep-head");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Records the landing the way a run does after it saw its PR merged elsewhere, then waits on a main gate: the repo is frozen and the gate holds the owner's only release. */
const landedThenWaitingOn = (gate: string): WorkflowDefinition =>
  defineWorkflow({
    name: SHEPHERD_WORKFLOW,
    steps: [
      { id: "sh-landed", kind: "dispatch" },
      { id: gate, kind: "assisted" },
    ],
    run: async (ctx) => {
      await step(ctx, "sh-landed", { repo: REPO, pr: 1 }, z.unknown());
      await ctx.assisted(gate, "main is red after the merge", { brief: TEST_BRIEF });
    },
  });

/** Merges the PR itself, then waits on a post-merge gate, as a red main after its own merge would. */
const mergedItselfThenFrozen = defineWorkflow({
  name: SHEPHERD_WORKFLOW,
  steps: [
    { id: "merge", kind: "dispatch" },
    { id: "sh-landed", kind: "dispatch" },
    { id: "main-frozen", kind: "assisted" },
  ],
  run: async (ctx) => {
    await step(ctx, "merge:0", { repo: REPO, pr: 1, sha: HEAD, method: "squash" }, MergeResultResult);
    await step(ctx, "sh-landed", { repo: REPO, pr: 1 }, z.unknown());
    await ctx.assisted("main-frozen", "the repo is frozen", { brief: TEST_BRIEF });
  },
});

const sentBack = defineWorkflow({
  name: SHEPHERD_WORKFLOW,
  steps: [{ id: "sh-sent-back", kind: "assisted" }],
  run: async (ctx) => void (await ctx.assisted("sh-sent-back", "the review sent it back", { brief: TEST_BRIEF })),
});

async function gatedAt(workflow: WorkflowDefinition, gate: string, options: { held?: boolean; mergeDone?: boolean } = {}) {
  const fake: FakeGitHub = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.addPr({ headSha: HEAD });
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start(SHEPHERD_WORKFLOW, { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  if (options.held) store.get().hold(runId, "demo-hold");
  await gateOpened(host, gateId(runId, gate));
  return { host, fake, runId, services: routes.shepherd! };
}

const settle = (fake: FakeGitHub, outcome: "merged" | "closed"): void =>
  void Object.assign(fake.pr(1), outcome === "merged" ? { merged: true, state: "closed" } : { state: "closed" });

describe("the periodic sweep over runs waiting on a gate", () => {
  it("cancels a held run's approve-merge gate once its PR merged", async () => {
    const { host, fake, runId, services } = await gatedAt(shepherdPrWorkflow({
      wake: async () => ({ kind: "unhandled" as const, reason: "test" }),
      review: async (_ctx: unknown, request: { headSha: string }) => ({ kind: "MERGE" as const, headSha: request.headSha, evidence: {} }),
    }), "approve-merge", { held: true });
    settle(fake, "merged");

    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([{ runId, reason: expect.stringContaining(LANDED_ELSEWHERE) }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("cancelled");
  });

  it.each(["main-frozen", "main-red", "main-red-again"])("keeps a %s gate of a run that recorded the landing of a PR merged elsewhere", async (gate) => {
    const { host, fake, runId, services } = await gatedAt(landedThenWaitingOn(gate), gate);
    settle(fake, "merged");

    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([]);
    expect(host.gates.get(gateId(runId, gate))?.status).toBe("pending");
  });

  it("cancels a sent-back gate once its PR closed", async () => {
    const { host, fake, runId, services } = await gatedAt(sentBack, "sh-sent-back");
    settle(fake, "closed");

    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([{ runId, reason: expect.stringContaining(CLOSED_ELSEWHERE) }]);
  });

  it("keeps a main-frozen gate of a run that merged the PR itself", async () => {
    const { host, fake, runId, services } = await gatedAt(mergedItselfThenFrozen, "main-frozen");
    settle(fake, "merged");

    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([]);
    expect(host.gates.get(gateId(runId, "main-frozen"))?.status).toBe("pending");
  });
});

describe("mergedItself", () => {
  const runWith = (stepResults: object, activeSteps: object = {}) => ({ stepResults, activeSteps }) as Pick<WorkflowRun, "stepResults" | "activeSteps">;
  const result = (data: object) => ({ data: { result: data } });

  it("counts a merge that landed and one in flight", () => {
    expect(mergedItself(runWith({ "merge:0:0": result({ done: true, mergeSha: "abc" }) }))).toBe(true);
    expect(mergedItself(runWith({}, { "merge:0:0": {} }))).toBe(true);
  });

  it("does not count a merge that did not land, a landing recorded without one, or a post-merge step", () => {
    expect(mergedItself(runWith({ "merge:0:0": result({ done: false, skipped: "base-moved", mergeSha: "" }) }))).toBe(false);
    expect(mergedItself(runWith({ "merge:0:0": result({ done: false, skipped: "merged", mergeSha: "" }) }))).toBe(false);
    expect(mergedItself(runWith({ "sh-landed": result({}) }, { "main-frozen": {} }))).toBe(false);
  });
});
