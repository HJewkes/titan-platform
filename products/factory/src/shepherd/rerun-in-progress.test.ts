import { fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type GitHubWire } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";
import { awaitFixerHead } from "./wake.js";

const H2 = fakeSha("head2");
/** tp#1188 c94ab3dc: attempt 1 of this run failed hub-compose at 04:18:37 while validate ran on until 04:25:01. */
const RUN = 38203111277;
const VALIDATE_TAIL_MS = 6.5 * 60_000;
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const hubCompose = (id: number, conclusion: string): CheckRun => ({ ...successRun("hub-compose", id, undefined, conclusion), workflowRunId: RUN, url: `https://example.test/actions/runs/${RUN}/job/${id}` });

interface Replay {
  /** How long run 38203111277 stays in progress after Shepherd first asks; Infinity never finishes. */
  runningMs: number;
  /** When set, another actor's rerun replaces the failed job this long after Shepherd first asks. */
  otherRerunAfterMs?: number;
  rerunQueueMs?: number;
}

/** hub-compose fails at H1 in a run still in progress; attempt 2 (ours or another actor's) passes, as it did at 04:26. */
function scenario(replay: Replay) {
  const fake = fakeGitHub();
  fake.rules = { contexts: ["hub-compose", "dag-check"], strict: true };
  let clock = 0;
  let firstAsked: number | undefined;
  const since = () => clock - (firstAsked ?? clock);
  const reran = () => fake.effects.rerunFailedJobs >= 1 || (replay.otherRerunAfterMs !== undefined && firstAsked !== undefined && since() >= replay.otherRerunAfterMs);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [pr.headSha === H1 && !reran() ? hubCompose(114660617197, "failure") : hubCompose(114660999999, "success"), successRun("dag-check", 2)]);
  const wire: GitHubWire = {
    ...fake.wire,
    getWorkflowRunStatus: async (repo, runId) => {
      if (runId !== RUN || fake.effects.rerunFailedJobs > 0) return fake.wire.getWorkflowRunStatus(repo, runId);
      firstAsked ??= clock;
      return since() < replay.runningMs ? "in_progress" : "completed";
    },
  };
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = {
    wake: async (ctx, request) => (wakes.push(request), fake.pushHead(1, H2), awaitFixerHead(ctx, request, { agent: "impl-a" })),
    review: async () => ({ kind: "none" }),
  };
  const store = shepherdStoreRef();
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const port = githubPort(wire);
  const mainGreen = { ...port, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("hub-compose", 9), successRun("dag-check", 10)]), port.checkRuns(repo, sha)) };
  const routes = factoryRoutesFor({ port: mainGreen, store, now: () => clock, sleep: tick, rerunQueueMs: replay.rerunQueueMs });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1 });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  return { fake, host, runId, wakes };
}

function result(host: FactoryHost, runId: string, stepId: string): unknown {
  return Object.values(host.runtime.status(runId)!.stepResults).find((step) => step.stepId === stepId)?.data;
}

async function approveAt(host: FactoryHost, runId: string, headSha: string): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha }, OWNER);
  await host.runtime.wait(runId);
}

describe("a ci-red head whose failed job's Actions run is still in progress", () => {
  it("replays tp#1188 c94ab3dc: reruns the failed job once the run finishes, reads green at the same head, and wakes no fixer", async () => {
    const { fake, host, runId, wakes } = scenario({ runningMs: VALIDATE_TAIL_MS });

    await approveAt(host, runId, H1);

    expect(result(host, runId, "rerun:0")).toMatchObject({ result: { reruns: [{ runId: RUN, done: true }], settled: true } });
    expect(result(host, runId, "ci-wait:r1:0")).toMatchObject({ result: { headSha: H1, verdict: "green" } });
    expect(wakes).toEqual([]);
    expect(fake.effects.rerunFailedJobs).toBe(1);
    expect(fake.effects.merge).toBe(1);
  });

  it("settles on another actor's rerun of the running run without a second rerun", async () => {
    const { fake, host, runId, wakes } = scenario({ runningMs: Infinity, otherRerunAfterMs: 2 * 60_000 });

    await approveAt(host, runId, H1);

    expect(result(host, runId, "rerun:0")).toMatchObject({ result: { settled: true } });
    expect(wakes).toEqual([]);
    expect(fake.effects.rerunFailedJobs).toBe(0);
  });

  it("ends the step unsettled when the run outlasts the queue bound, so the round reads red and wakes the fixer", async () => {
    const { fake, host, runId, wakes } = scenario({ runningMs: Infinity, rerunQueueMs: 60_000 });

    await approveAt(host, runId, H2);

    expect(result(host, runId, "rerun:0")).toMatchObject({ result: { reruns: [{ runId: RUN, done: false, skipped: "in-progress" }], settled: false } });
    expect(result(host, runId, "ci-wait:r1:0")).toMatchObject({ result: { headSha: H1, verdict: "red" } });
    expect(wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(fake.effects.rerunFailedJobs).toBe(0);
  });
});
