import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { WorkflowNotOwnedError } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { LEAKY_MESSAGE, expectNoLeak } from "../test-support/leak.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { prSnapshot } from "../workflows/pr-snapshot.js";
import { RESYNC_READ_TIMEOUT_MS } from "./bounded.js";
import { CLOSED_ELSEWHERE, LANDED_ELSEWHERE, endRunsGoneElsewhere } from "./gone-elsewhere.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => {
  vi.useRealTimers();
  hosts.splice(0).forEach((host) => host.close());
});

const H1 = fakeSha("gone-head");

/** Two owner-gated PRs, each waiting on approve-merge. */
async function gatedRuns(withSnapshot = false): Promise<{ host: FactoryHost; fake: FakeGitHub; runs: string[]; services: NonNullable<ReturnType<typeof factoryRoutesFor>["shepherd"]> }> {
  const fake = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const store = shepherdStoreRef();
  const port = githubPort(fake.wire);
  const routes = factoryRoutesFor({ port, ...(withSnapshot && { snapshot: prSnapshot(port, { now: () => 0 }) }), store, now: () => 0, sleep: async (_ms, signal) => sleep(1, signal) });
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

  it("reads open PRs from the snapshot with no getPr call, and still reads a merged one from the port", async () => {
    const { host, fake, runs, services } = await gatedRuns(true);
    const before = fake.calls.filter((call) => call === "getPr").length;
    await endRunsGoneElsewhere(host, services);
    await endRunsGoneElsewhere(host, services);
    expect(fake.calls.filter((call) => call === "getPr").length - before).toBe(0);

    Object.assign(fake.pr(1), { merged: true, state: "closed" });
    services.snapshot!.invalidate(REPO);
    const ended = await endRunsGoneElsewhere(host, services);

    expect(ended).toEqual([{ runId: runs[0], reason: `${LANDED_ELSEWHERE}${REPO}#1 was merged outside Shepherd` }]);
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

  it("a run that records its own merge while its PR read is in flight is not cancelled", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    [1, 2].forEach((pr) => Object.assign(fake.pr(pr), { merged: true, state: "closed" }));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const slow = { ...services, port: { ...services.port, getPr: async (repo: string, pr: number) => (await released, services.port.getPr(repo, pr)) } };
    const status = host.runtime.status.bind(host.runtime);
    let mergedMeanwhile = false;
    vi.spyOn(host.runtime, "status").mockImplementation((runId) => {
      const run = status(runId);
      if (!run || !mergedMeanwhile || runId !== runs[0]) return run;
      const landed = { stepId: "merge", iteration: 0, agentId: null, signal: null, completedAt: "2026-01-01T00:00:00.000Z", data: { result: { done: true } } };
      return { ...run, stepResults: { ...run.stepResults, merge: landed } };
    });

    const sweeping = endRunsGoneElsewhere(host, slow);
    mergedMeanwhile = true;
    release();
    const ended = await sweeping;

    expect(ended.map((run) => run.runId)).toEqual([runs[1]]);
    expect(host.runtime.status(runs[0]!)?.status).toBe("paused");
  });

  it("an unreadable PR still leaves its run held while the other runs end", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    Object.assign(fake.pr(2), { merged: true, state: "closed" });
    const failing = { ...services, port: { ...services.port, getPr: async (repo: string, pr: number) => (pr === 1 ? Promise.reject(Object.assign(new Error("boom"), { status: 500 })) : services.port.getPr(repo, pr)) } };
    const unreadable: string[] = [];

    const ended = await endRunsGoneElsewhere(host, failing, { onUnreadable: (runId) => unreadable.push(runId) });

    expect(unreadable).toEqual([runs[0]]);
    expect(ended.map((run) => run.runId)).toEqual([runs[1]]);
    expect(host.runtime.status(runs[0]!)?.status).toBe("paused");
  });

  it("a PR read that never answers calls onUnreadable with the timeout and the other runs still end", async () => {
    const { host, fake, runs, services } = await gatedRuns();
    [1, 2].forEach((pr) => Object.assign(fake.pr(pr), { merged: true, state: "closed" }));
    const hanging = { ...services, port: { ...services.port, getPr: (repo: string, pr: number) => (pr === 1 ? new Promise<never>(() => undefined) : services.port.getPr(repo, pr)) } };
    const unreadable: [string, string][] = [];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;

    const sweeping = endRunsGoneElsewhere(host, hanging, { onUnreadable: (runId, cause) => unreadable.push([runId, cause]) }).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(RESYNC_READ_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect((await sweeping).map((run) => run.runId)).toEqual([runs[1]]);
    expect(unreadable).toEqual([[runs[0], expect.stringMatching(/timed out/)]]);
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
