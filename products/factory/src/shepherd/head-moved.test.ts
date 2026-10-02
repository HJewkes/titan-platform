import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ReviewRequest, ShepherdPhases, Verdict } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { supersedeMovedGates } from "./head-moved.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Synthetic stand-ins for the three heads of the replayed run: sent back, gated, then moved past the gate. */
const SENT_BACK = fakeSha("replay-sent-back");
const GATED = fakeSha("replay-gated");
const MOVED = fakeSha("replay-moved");

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

/** The replayed run: FIX_FIRST at the first head, a fixer's push, MERGE at the second head, and the owner gate there. */
async function gatedAtSecondHead(): Promise<Scenario> {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const reviewed: string[] = [];
  let answerMoved: (verdict: Verdict) => void = () => undefined;
  const movedVerdict = new Promise<Verdict>((resolve) => (answerMoved = resolve));
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(scriptedPhases(fake, reviewed, movedVerdict))], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: SENT_BACK });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, fake, services: routes.shepherd!, runId, reviewed, answerMoved };
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

    expect(superseded).toEqual([{ runId, gateId: gateId(runId, "approve-merge"), from: GATED, to: MOVED }]);
    await vi.waitFor(() => expect(reviewed).toEqual([SENT_BACK, GATED, MOVED]));
    expect(host.gates.get(gateId(runId, "approve-merge"))?.status).toBe("cancelled");
    expect(host.pendingGates().filter((pending) => pending.runId === runId)).toEqual([]);
    expect(host.runtime.status(runId)?.status).toBe("running");
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
