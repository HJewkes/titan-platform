import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { silentLogger } from "@titan-design/daemon";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { startHeadMovedSweep } from "./head-moved-sweep.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

const PARENT = "agent-chat/parent";
const FEATURE_BASE: EffectivePolicy = { ...OWNER_GATE_POLICY, featureBase: true };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const phases: ShepherdPhases = {
  review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: {} }),
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
};

/** A run waiting at approve-merge into a feature base, whose PR GitHub has since retargeted to main. */
async function retargetedRun() {
  const fake = fakeGitHub();
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, baseRef: PARENT });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(FEATURE_BASE) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: FEATURE_BASE });
  await gateOpened(host, gateId(runId, "approve-merge"));
  fake.pr(1).baseRef = "main";
  return { host, services: routes.shepherd!, runId, gate: gateId(runId, "approve-merge") };
}

describe("startHeadMovedSweep", () => {
  it("cancels a retargeted run's approve-merge gate on its first tick", async () => {
    const { host, services, gate } = await retargetedRun();

    await (await startHeadMovedSweep(host, services, {}, silentLogger)).stop();

    expect(host.gates.get(gate)?.status).toBe("cancelled");
  });

  it("keeps the gate of a run under an owner hold across a tick, as the resync does", async () => {
    const { host, services, runId, gate } = await retargetedRun();
    services.store.get().hold(runId, "owner-asked: discuss first");

    await (await startHeadMovedSweep(host, services, {}, silentLogger)).stop();

    expect(host.gates.get(gate)?.status).toBe("pending");
  });
});
