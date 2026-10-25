import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost, type FactoryRoutes } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { callCommand } from "../test-support/shepherd.js";
import { factoryRoutesFor } from "../workflows.js";
import { CI_WAIT_ATTEMPTS, sleep } from "../workflows/land.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import type { PrTimeline, TimelineEntry } from "./view.js";

const MIN = 60_000;
const TIMEOUT_MS = 45 * MIN;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Checks are green from the start, but mergeable_state reads unknown until `settlesAtMs`, as it did through the 10-24 queue backlog. */
function world(settlesAtMs: number) {
  const fake = fakeGitHub();
  const clock = { now: 0 };
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    pr.mergeableState = clock.now >= settlesAtMs ? "clean" : "unknown";
  };
  fake.addPr({ headSha: H1 });
  const store = shepherdStoreRef();
  const routes: FactoryRoutes = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock.now,
    sleep: async (ms, signal) => ((clock.now += ms), sleep(1, signal)),
    registry: async () => "trusted" as const,
  });
  const reviewed: string[] = [];
  const phases: ShepherdPhases = {
    wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
    review: async (_ctx, request: ReviewRequest) => (reviewed.push(request.headSha), { kind: "none" }),
  };
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  const timeouts = async (): Promise<TimelineEntry[]> => {
    const timeline = await callCommand<PrTimeline>(host, routes, "shepherd.timeline", { repo: REPO, pr: 1 });
    if (!timeline.ok) throw new Error(timeline.error);
    return timeline.data.entries.filter((entry) => entry.kind === "event" && entry.event === "ci-timeout");
  };
  return { host, runId, clock, reviewed, timeouts };
}

describe("a Shepherd run whose ci-wait times out while GitHub has not settled the PR", () => {
  it("waits again and reaches review once the PR settles, with no re-register, and the timeline shows the re-wait", async () => {
    const w = world(50 * MIN);

    await vi.waitFor(() => expect(w.reviewed[0]).toBe(H1));

    expect(w.host.runtime.status(w.runId)?.status).not.toBe("failed");
    expect(w.clock.now).toBeGreaterThan(TIMEOUT_MS);
    expect(await w.timeouts()).toEqual([
      { kind: "event", event: "ci-timeout", reason: `attempt 1 of ${CI_WAIT_ATTEMPTS}, waiting again: ci-wait:0 timed out after ${TIMEOUT_MS} ms, waiting on mergeable_state unknown`, actor: "shepherd", at: expect.any(String), headSha: H1 },
    ]);
  });

  it("fails naming the attempt count, never reaching review, once every attempt times out", async () => {
    const w = world(Number.POSITIVE_INFINITY);

    const run = await w.host.runtime.wait(w.runId);

    expect(run.status).toBe("failed");
    expect(run.error).toBe(`[ci-timeout] ci-wait timed out after ${TIMEOUT_MS} ms on each of ${CI_WAIT_ATTEMPTS} attempts: waiting on mergeable_state unknown`);
    expect(w.reviewed).toEqual([]);
    expect((await w.timeouts()).map((entry) => entry.kind === "event" && entry.reason?.split(":")[0])).toEqual([
      `attempt 1 of ${CI_WAIT_ATTEMPTS}, waiting again`,
      `attempt 2 of ${CI_WAIT_ATTEMPTS}, waiting again`,
      `attempt 3 of ${CI_WAIT_ATTEMPTS}, attempts spent, the run fails`,
    ]);
  });
});
