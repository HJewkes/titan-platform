import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { readPath } from "../narrow.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { ciWaitHead } from "../workflows/ci-wait-head.js";
import type { ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { supersedeMovedGates } from "./head-moved.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Synthetic heads: the one the owner gate asks about, then the push past it. */
const GATED = fakeSha("stale-head-gated");
const MOVED = fakeSha("stale-head-moved");

/** Auto merge under a visual path with no changed file read: the merge guard asks the owner at every MERGE head. */
const GUARDED: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: false, seat: "none", visualPaths: ["**/*.css"] };

interface Scenario {
  host: FactoryHost;
  fake: FakeGitHub;
  supersede: () => ReturnType<typeof supersedeMovedGates>;
  runId: string;
  reviewed: string[];
}

/** One guard-gated run at GATED whose review at MOVED never answers, so a run that took MOVED sits in review there. */
async function guardGated(): Promise<Scenario> {
  const fake = fakeGitHub();
  const reviewed: string[] = [];
  const phases: ShepherdPhases = {
    review: async (_ctx, request) => (reviewed.push(request.headSha), request.headSha === MOVED ? new Promise<Verdict>(() => undefined) : { kind: "MERGE", headSha: request.headSha, evidence: {} }),
    wake: async () => ({ kind: "unhandled", reason: "test" }),
  };
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const port = githubPort(fake.wire);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: GATED });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(GUARDED) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: GUARDED });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, fake, supersede: () => supersedeMovedGates(host, routes.shepherd!), runId, reviewed };
}

/** The head each recorded ci-wait and land-rules step read, oldest first. */
function landHeads(run: WorkflowRun, prefix: string): string[] {
  const steps = Object.values(run.stepResults).filter((result) => result.stepId.startsWith(prefix));
  return steps.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).map((result) => String(readPath(JSON.parse(result.output ?? "{}"), "result", "headSha")));
}

describe("an owner approve-merge gate superseded by a head push (TP-4767)", () => {
  it("cancels the gate and puts the run in review at the new head, with no CI wait at the old head after the cancel", async () => {
    const { host, fake, supersede, runId, reviewed } = await guardGated();
    const ciWaitsBefore = landHeads(host.runtime.status(runId)!, "ci-wait").length;
    fake.pushHead(1, MOVED);

    const superseded = await supersede();

    expect(superseded.map((gate) => [gate.from, gate.to])).toEqual([[GATED, MOVED]]);
    await vi.waitFor(() => expect(reviewed).toEqual([GATED, MOVED]), { timeout: 20_000 });
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("cancelled");
    expect(landHeads(host.runtime.status(runId)!, "ci-wait").slice(ciWaitsBefore)).toEqual([MOVED]);
    expect(ciWaitHead(host.runtime.status(runId)!.currentStep, REPO, 1)).toBeUndefined();
  }, 45_000);
});
