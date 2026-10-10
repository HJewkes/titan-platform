import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { gateEverything, type GatePolicy } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { LAND_STEPS, land, landRoutes, type LandOptions, type LandOutcome } from "./land.js";

const REPO = "o/r";
const H2 = fakeSha("head2");
const allowMerges: GatePolicy = { decide: () => ({ outcome: "allow", rule: { table: "test-table", rowId: "MRG-TEST", version: 1 }, reason: "allowed" }) };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

type Body = (ctx: WorkflowContext, fake: FakeGitHub, outcomes: LandOutcome[]) => Promise<void>;

interface BaseWorld {
  host: FactoryHost;
  fake: FakeGitHub;
  outcomes: LandOutcome[];
  /** The PR's base at each merge the fake took. */
  mergedInto: string[];
}

/** One PR on `base` whose checks pass on every head but `red`; every wait yields a tick, so a test can act mid-wait. */
function baseWorld(base: string, body: Body, red?: string): BaseWorld {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, baseRef: base });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, pr.headSha === red ? "failure" : "success"), successRun("dag-check", 2)]);
  const mergedInto: string[] = [];
  const merge = fake.wire.merge;
  fake.wire.merge = async (...args) => (mergedInto.push(fake.pr(1).baseRef), merge(...args));
  const routes = landRoutes({ port: githubPort(fake.wire), now: () => 0, pollMs: 1, sleep: () => new Promise((resolve) => setTimeout(resolve, 1)) });
  const outcomes: LandOutcome[] = [];
  const workflow = defineWorkflow({ name: "land-base", steps: LAND_STEPS, run: (ctx) => body(ctx, fake, outcomes) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, outcomes, mergedInto };
}

function landOnce(options: LandOptions): Body {
  return async (ctx, _fake, outcomes) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, options));
}

function stepIds(host: FactoryHost, runId: string): string[] {
  return Object.values(host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
}

function stepResult(host: FactoryHost, runId: string, stepId: string): unknown {
  const found = Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId === stepId);
  return (found?.data as { result?: unknown } | undefined)?.result;
}

async function waitingAt(host: FactoryHost, runId: string, stepId: string): Promise<void> {
  await vi.waitFor(() => expect(host.runtime.status(runId)?.currentStep).toBe(stepId), { timeout: 4_000, interval: 5 });
}

describe("land on a base that is not the default branch", () => {
  it("waits with the approved head on a feature base, then asks again on main once the PR is retargeted, and merges into main", async () => {
    const world = baseWorld("feat/x", landOnce({ policy: gateEverything }));
    const runId = world.host.runtime.start("land-base");
    await gateOpened(world.host, gateId(runId, "approve-merge"));
    world.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await waitingAt(world.host, runId, "base-wait:0");
    const waitingStatus = world.host.runtime.status(runId)!.status;
    world.fake.pr(1).baseRef = "main";
    await gateOpened(world.host, gateId(runId, "approve-merge", 1));
    const mergesBeforeReask = world.fake.effects.merge;
    world.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await world.host.runtime.wait(runId);

    expect(waitingStatus).toBe("running");
    expect(stepResult(world.host, runId, "base-check:0")).toMatchObject({ base: "feat/x", defaultBranch: "main", allowed: false, reason: expect.stringContaining("the base is feat/x") });
    expect(world.host.gates.get(gateId(runId, "approve-merge"))?.prompt).toContain(`at head ${H1} into feat/x?`);
    expect(world.host.gates.get(gateId(runId, "approve-merge", 1))?.prompt).toContain(`at head ${H1} into main?`);
    expect(mergesBeforeReask).toBe(0);
    expect(run.status).toBe("completed");
    expect(world.mergedInto).toEqual(["main"]);
    expect(world.outcomes).toEqual([{ kind: "merged", headSha: H1, mergeSha: world.fake.pr(1).mergeSha }]);
    expect(stepResult(world.host, runId, "land-rules:1")).toMatchObject({ base: "main" });
  });

  it("merges into the feature base when the run's policy allows one, with no wait", async () => {
    const world = baseWorld("feat/x", landOnce({ policy: allowMerges, featureBase: () => true }));

    const run = await world.host.runtime.wait(world.host.runtime.start("land-base"));

    expect(run.status).toBe("completed");
    expect(world.mergedInto).toEqual(["feat/x"]);
    expect(stepIds(world.host, run.id).filter((id) => id.startsWith("base-wait"))).toEqual([]);
  });

  it("re-reads the base each round, so a PR retargeted to a feature base between rounds waits instead of merging", async () => {
    const world = baseWorld(
      "main",
      async (ctx, fake, outcomes) => {
        outcomes.push(await land(ctx, { repo: REPO, pr: 1, round: 0 }, { policy: allowMerges }));
        Object.assign(fake.pr(1), { headSha: H2, baseRef: "feat/x" });
        outcomes.push(await land(ctx, { repo: REPO, pr: 1, round: 1 }, { policy: allowMerges }));
      },
      H1,
    );
    const runId = world.host.runtime.start("land-base");

    await waitingAt(world.host, runId, "base-wait:r1:0");
    const mergesWhileWaiting = world.fake.effects.merge;
    world.fake.pr(1).baseRef = "main";
    const run = await world.host.runtime.wait(runId);

    expect(stepResult(world.host, runId, "land-rules")).toMatchObject({ base: "main" });
    expect(stepResult(world.host, runId, "land-rules:r1")).toMatchObject({ base: "feat/x" });
    expect(mergesWhileWaiting).toBe(0);
    expect(run.status).toBe("completed");
    expect(world.outcomes.map((outcome) => outcome.kind)).toEqual(["ci-failed", "merged"]);
    expect(world.mergedInto).toEqual(["main"]);
  });

  it("skips a merge whose base was retargeted after the base check, and waits on the new base", async () => {
    const world = baseWorld("main", landOnce({ policy: allowMerges }));
    const defaultBranch = world.fake.wire.getDefaultBranch;
    world.fake.wire.getDefaultBranch = async (repo) => {
      const answer = await defaultBranch(repo);
      world.fake.pr(1).baseRef = "feat/x";
      return answer;
    };
    const runId = world.host.runtime.start("land-base");

    await waitingAt(world.host, runId, "base-wait:0");
    world.fake.wire.getDefaultBranch = defaultBranch;
    world.fake.pr(1).baseRef = "main";
    const run = await world.host.runtime.wait(runId);

    expect(stepResult(world.host, runId, "merge:0")).toMatchObject({ done: false, skipped: "base-changed" });
    expect(run.status).toBe("completed");
    expect(world.mergedInto).toEqual(["main"]);
  });
});
