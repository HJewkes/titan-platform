import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { supersedeRebasedGates } from "./base-moved.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { SUPERSEDED } from "./stale-gates.js";
import { shepherdStoreRef, type ShepherdStoreRef } from "./store.js";

const PARENT = "agent-chat/parent";
const FEATURE_BASE: EffectivePolicy = { ...OWNER_GATE_POLICY, featureBase: true };

type Services = NonNullable<ReturnType<typeof factoryRoutesFor>["shepherd"]>;

interface Gated {
  host: FactoryHost;
  fake: FakeGitHub;
  services: Services;
  store: ShepherdStoreRef;
  runId: string;
}

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const phases: ShepherdPhases = {
  review: async (_ctx, request) => ({ kind: "MERGE", headSha: request.headSha, evidence: {} }),
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
};

/** An owner-gated shepherd-pr run on a PR into `base`, waiting at its first approve-merge gate. */
async function gatedInto(base: string, policy: EffectivePolicy = FEATURE_BASE): Promise<Gated> {
  const fake = fakeGitHub();
  fake.onGetPr = (open) => fake.setRuns(open.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, baseRef: base });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(policy) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, fake, services: routes.shepherd!, store, runId };
}

/** The seat behind the run lost its feature-base grant after the gate opened, as for a gate opened before land checked the base first. */
function dropFeatureBase({ store, runId }: Gated): void {
  store.get().update(runId, { task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
}

const gateStatus = ({ host, runId }: Gated) => host.gates.get(gateId(runId, "approve-merge"))?.status;

describe("supersedeRebasedGates", () => {
  it("a gate opened into the parent branch is cancelled once GitHub retargets the PR to main", async () => {
    const w = await gatedInto(PARENT);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.prompt).toContain(`into ${PARENT}?`);
    w.fake.pr(1).baseRef = "main";

    const superseded = await supersedeRebasedGates(w.host, w.services);

    expect(superseded).toEqual([{ runId: w.runId, gateId: gateId(w.runId, "approve-merge"), from: PARENT, to: "main", condition: "base-changed" }]);
    expect(gateStatus(w)).toBe("cancelled");
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.reason).toBe(`${SUPERSEDED}the pull request's base moved from ${PARENT} to main`);
  });

  it("a pending gate into a non-default base with no feature-base grant is cancelled even though the base did not move", async () => {
    const w = await gatedInto(PARENT);
    dropFeatureBase(w);

    const superseded = await supersedeRebasedGates(w.host, w.services);

    expect(superseded).toEqual([{ runId: w.runId, gateId: gateId(w.runId, "approve-merge"), from: PARENT, to: PARENT, condition: "base-changed" }]);
    expect(w.host.gates.get(gateId(w.runId, "approve-merge"))?.reason).toBe(`${SUPERSEDED}the base ${PARENT} is not the default branch main`);
  });

  it("a gate into a feature base on a run whose policy grants featureBase stays", async () => {
    const w = await gatedInto(PARENT);

    expect(await supersedeRebasedGates(w.host, w.services)).toEqual([]);
    expect(gateStatus(w)).toBe("pending");
  });

  it("a gate into main on a PR still on main stays", async () => {
    const w = await gatedInto("main", OWNER_GATE_POLICY);

    expect(await supersedeRebasedGates(w.host, w.services)).toEqual([]);
    expect(gateStatus(w)).toBe("pending");
  });

  it("dryRun reports and cancels nothing", async () => {
    const w = await gatedInto(PARENT);
    w.fake.pr(1).baseRef = "main";

    const superseded = await supersedeRebasedGates(w.host, w.services, { dryRun: true });

    expect(superseded.map((gate) => gate.gateId)).toEqual([gateId(w.runId, "approve-merge")]);
    expect(gateStatus(w)).toBe("pending");
  });

  it("an unreadable PR leaves the gate", async () => {
    const w = await gatedInto(PARENT);
    dropFeatureBase(w);
    const port = { ...w.services.port, getPr: async () => Promise.reject(new Error("synthetic read failure")) };

    expect(await supersedeRebasedGates(w.host, { ...w.services, port })).toEqual([]);
    expect(gateStatus(w)).toBe("pending");
  });

  it("an unreadable default branch leaves the gate", async () => {
    const w = await gatedInto(PARENT);
    dropFeatureBase(w);
    const port = { ...w.services.port, defaultBranch: async () => Promise.reject(new Error("synthetic read failure")) };

    expect(await supersedeRebasedGates(w.host, { ...w.services, port })).toEqual([]);
    expect(gateStatus(w)).toBe("pending");
  });

  it("a superseded gate's run re-enters land and waits at base-wait with no new gate", async () => {
    const w = await gatedInto(PARENT);
    dropFeatureBase(w);

    await supersedeRebasedGates(w.host, w.services);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.currentStep).toMatch(/^base-wait/), { timeout: 10_000, interval: 5 });
    expect(w.host.pendingGates().filter((pending) => pending.runId === w.runId)).toEqual([]);
    expect(w.fake.effects.merge).toBe(0);
  });
});
