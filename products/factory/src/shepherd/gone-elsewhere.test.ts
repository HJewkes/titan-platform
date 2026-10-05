import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { WorkflowNotOwnedError } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere } from "./gone-elsewhere.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const H1 = fakeSha("gone-head");

/** Two owner-gated PRs, each waiting on approve-merge. */
async function gatedRuns(): Promise<{ host: FactoryHost; fake: FakeGitHub; runs: string[]; services: NonNullable<ReturnType<typeof factoryRoutesFor>["shepherd"]> }> {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
  const phases = { wake: async () => ({ kind: "unhandled" as const, reason: "test" }), review: async (_ctx: unknown, request: { headSha: string }) => ({ kind: "MERGE" as const, headSha: request.headSha, evidence: {} }) };
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runs = [1, 2].map((pr) => {
    fake.addPr({ headSha: H1 });
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(pr), policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr, runId, task: `demo/${pr}`, implementer: "impl-a", policy: OWNER_GATE_POLICY });
    return runId;
  });
  for (const runId of runs) await gateOpened(host, gateId(runId, "approve-merge"));
  return { host, fake, runs, services: routes.shepherd! };
}

describe("endRunsGoneElsewhere", () => {
  it("ends a gated run whose PR was merged elsewhere and cancels its gate, and leaves an open PR's run waiting", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    Object.assign(fake.pr(1), { merged: true, state: "closed" });

    const ended = await endRunsGoneElsewhere(host, services);
    await host.runtime.wait(runs[0]!);

    expect(ended).toEqual([{ runId: runs[0], reason: `${LANDED_ELSEWHERE}${REPO}#1 was merged outside Shepherd` }]);
    expect(host.runtime.status(runs[0]!)?.status).toBe("cancelled");
    expect(host.gates.get(gateId(runs[0]!, "approve-merge"))?.status).toBe("cancelled");
    expect(host.runtime.status(runs[1]!)?.status).toBe("paused");
    expect(host.gates.get(gateId(runs[1]!, "approve-merge"))?.status).toBe("pending");
  });

  it("ends a gated run whose PR was closed without a merge", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    fake.pr(2).state = "closed";

    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([{ runId: runs[1], reason: `${CLOSED_ELSEWHERE}${REPO}#2 was closed outside Shepherd` }]);
  });

  it("leaves every run waiting when GitHub cannot be read", async () => {
    const { host, runs, services } = await gatedRuns();
    const unreadable = { ...services, port: { ...services.port, getPr: async () => Promise.reject(new Error("rate limited")) } };

    const ended = await endRunsGoneElsewhere(host, unreadable);

    expect(ended).toEqual([]);
    expect(runs.map((runId) => host.runtime.status(runId)?.status)).toEqual(["paused", "paused"]);
  });

  it("ends a run whose PR answers 404 and reports a 5xx as unreadable with its status, never its text", async () => {
    const { host, runs, services } = await gatedRuns();
    const failing = (error: Error) => ({ ...services, port: { ...services.port, getPr: async (_repo: string, pr: number) => (pr === 1 ? Promise.reject(error) : services.port.getPr(REPO, pr)) } });
    const unreadable: [string, string][] = [];

    const kept = await endRunsGoneElsewhere(host, failing(Object.assign(new Error(LEAKY_MESSAGE), { status: 502 })), { onUnreadable: (runId, cause) => unreadable.push([runId, cause]) });
    expect(kept).toEqual([]);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]![0]).toBe(runs[0]);
    expect(unreadable[0]![1]).toBe("HTTP 502");
    expectNoLeak(unreadable);

    const ended = await endRunsGoneElsewhere(host, failing(Object.assign(new Error("Not Found"), { status: 404 })));
    expect(ended).toHaveLength(1);
    expect(ended[0]!.runId).toBe(runs[0]);
    expect(ended[0]!.reason).toContain("404");
  });

  it("reports a held run when the runtime refuses the cancel because another runtime leases it", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    Object.assign(fake.pr(1), { merged: true, state: "closed" });
    vi.spyOn(host.runtime, "cancel").mockImplementation((runId) => {
      throw new WorkflowNotOwnedError(runId);
    });
    const held: string[] = [];
    const failed: string[] = [];

    const ended = await endRunsGoneElsewhere(host, services, { onHeld: (runId) => held.push(runId), onCancelFailed: (runId) => failed.push(runId) });

    expect(ended).toEqual([]);
    expect(held).toEqual([runs[0]]);
    expect(failed).toEqual([]);
  });

  it("reports a cancel that fails for any other reason with its error class, never its text, and never as held", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    Object.assign(fake.pr(1), { merged: true, state: "closed" });
    vi.spyOn(host.runtime, "cancel").mockImplementation(() => {
      throw new Error(LEAKY_MESSAGE);
    });
    const held: string[] = [];
    const failed: [string, string][] = [];

    const ended = await endRunsGoneElsewhere(host, services, { onHeld: (runId) => held.push(runId), onCancelFailed: (runId, cause) => failed.push([runId, cause]) });

    expect(ended).toEqual([]);
    expect(held).toEqual([]);
    expect(failed).toHaveLength(1);
    expect(failed[0]![0]).toBe(runs[0]);
    expect(failed[0]![1]).toBe("Error");
    expectNoLeak(failed);
    expect(host.runtime.status(runs[0]!)?.status).toBe("paused");
  });

  it("throws a non-lease cancel failure when no caller asked to hear of it", async () => {
    const { host, fake, services } = await gatedRuns();
    Object.assign(fake.pr(1), { merged: true, state: "closed" });
    vi.spyOn(host.runtime, "cancel").mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(endRunsGoneElsewhere(host, services)).rejects.toThrow("database unavailable");
  });
});
