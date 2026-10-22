import { successRun, type CheckRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, approveUntilSettled, landScenario, type LandScenario } from "../test-support/land.js";

/** Synthetic ids in the shape of tp#2215: the job's check run stayed in_progress while its workflow run read completed. */
const RUN = 39000000001;
const ORPHAN_JOB = 119000000001;
const RERUN_JOB = 119000000002;
const CI_TIMEOUT_MS = 45 * 60_000;

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const openJob = (id: number, startedAt: string): CheckRun => ({ ...successRun("dag-check", id, startedAt), status: "in_progress", conclusion: null, workflowRunId: RUN, url: `https://example.test/actions/runs/${RUN}/job/${id}` });
const doneJob = (id: number, startedAt: string): CheckRun => ({ ...successRun("dag-check", id, startedAt), workflowRunId: RUN, url: `https://example.test/actions/runs/${RUN}/job/${id}` });

/** validate passes; dag-check is `before` until Shepherd reruns its job, then `after`. Run RUN reads completed until then. */
function scenario(before: CheckRun, after: CheckRun, onRerun: () => void = () => {}): LandScenario {
  const world = landScenario();
  world.fake.runStatuses.set(RUN, "completed");
  world.fake.onGetPr = (pr) => {
    const reran = world.fake.jobReruns.length > 0;
    if (reran) onRerun();
    world.fake.setRuns(pr.headSha, [successRun("validate", 1), reran ? after : before]);
  };
  return world;
}

function start(world: LandScenario): { host: FactoryHost; runId: string } {
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [world.workflow], routes: world.routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, runId: host.runtime.start("land-test") };
}

function stepData(host: FactoryHost, runId: string, stepId: string): { result?: Record<string, unknown> } | undefined {
  return Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === stepId)?.data;
}

describe("ci-wait on a check whose workflow run completed while the check stayed open", () => {
  it("replays tp#2215: reruns the orphaned job once, reads its new job green, and merges well inside the ci-wait bound", async () => {
    const world = scenario(openJob(ORPHAN_JOB, "2026-01-01T00:00:00Z"), doneJob(RERUN_JOB, "2026-01-01T01:00:00Z"));
    const { host, runId } = start(world);

    await approveUntilSettled(host, runId, world.fake);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(world.fake.jobReruns).toEqual([ORPHAN_JOB]);
    expect(stepData(host, runId, "ci-wait:0")?.result).toMatchObject({ verdict: "pending", headSha: H1, orphaned: [{ name: "dag-check", jobId: ORPHAN_JOB, workflowRunId: RUN, status: "in_progress" }] });
    expect(stepData(host, runId, "ci-orphan-rerun:0")?.result).toMatchObject({ headSha: H1, reruns: [{ name: "dag-check", jobId: ORPHAN_JOB, done: true }] });
    expect(stepData(host, runId, "ci-wait:1")?.result).toMatchObject({ verdict: "green", headSha: H1 });
    expect(Number(stepData(host, runId, "ci-wait:0")?.result?.readAt)).toBeLessThan(CI_TIMEOUT_MS);
    expect(world.fake.effects.merge).toBe(1);
  });

  it("fails as a ci-wait timeout, with no second rerun, when the rerun's job is orphaned at the same head too", async () => {
    const world = scenario(openJob(ORPHAN_JOB, "2026-01-01T00:00:00Z"), openJob(RERUN_JOB, "2026-01-01T01:00:00Z"), () => world.fake.runStatuses.set(RUN, "completed"));
    const { host, runId } = start(world);

    const failure = await host.runtime.wait(runId).catch((error: unknown) => error);

    expect(JSON.stringify([String(failure), host.runtime.status(runId)?.error])).toContain(`ci-wait timed out on orphaned checks at ${H1}: dag-check (in_progress)`);
    expect(world.fake.jobReruns).toEqual([ORPHAN_JOB]);
    expect(world.fake.effects.merge).toBe(0);
  });

  it("leaves a job alone while the workflow run that owns it is still running", async () => {
    const world = scenario(openJob(ORPHAN_JOB, "2026-01-01T00:00:00Z"), doneJob(RERUN_JOB, "2026-01-01T01:00:00Z"));
    world.fake.runStatuses.set(RUN, "in_progress");
    const { host, runId } = start(world);

    const failure = await host.runtime.wait(runId).catch((error: unknown) => error);

    expect(JSON.stringify([String(failure), host.runtime.status(runId)?.error])).toContain("ci-wait gave up");
    expect(world.fake.jobReruns).toEqual([]);
    expect(world.fake.calls).toContain("getWorkflowRunStatus");
    expect(world.fake.effects.merge).toBe(0);
  });
});
