import type { PanelPlan } from "@titan-design/review-panel";
import type { StepRoute } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ReviewBodyPorts } from "./bodies.js";
import { reviewRoutes } from "./definition.js";
import { reviewHead, type ReviewHost } from "./recipe.js";
import { fakeWorld, HEAD, input, merges, MERGE, name, POLICY, TIMING } from "./review-world.test-helpers.js";
import type { StepCall } from "./step-schemas.js";
import { DEFAULT_REVIEW_STEP_IDS } from "./types.js";

const routeOf = (routes: readonly StepRoute[], stepId: string): StepRoute | undefined =>
  routes.find((route) => stepId === route.match || stepId.startsWith(`${route.match}:`));

/** Runs each step through its route, as a durable host stores it, and replays `recorded` in order until a step runs live. */
function fakeHost(ports: ReviewBodyPorts, recorded: readonly (readonly [string, object])[] = []) {
  const routes = reviewRoutes(ports);
  const steps: string[] = [];
  let cursor = 0;
  const call: StepCall = async (stepId, stepInput, schema) => {
    steps.push(stepId);
    const replayed = recorded[cursor];
    if (replayed?.[0] === stepId) return (cursor += 1), schema.parse(replayed[1]);
    cursor = recorded.length;
    const run = { runId: "run-1", workflowName: "review", stepId, iteration: 0, prompt: JSON.stringify(stepInput), signal: new AbortController().signal, attempt: 0, requestKey: stepId };
    const outcome = await routeOf(routes, stepId)?.runner.run(run);
    if (!outcome?.ok) throw new Error(`step ${stepId} failed: ${outcome?.error ?? "no route"}`);
    return z.object({ result: schema }).parse(JSON.parse(outcome.output)).result;
  };
  const host: ReviewHost = { call, historyNext: () => recorded[cursor]?.[0] };
  return { host, steps };
}

const review = (ports: ReviewBodyPorts, recorded?: readonly (readonly [string, object])[]) => {
  const { host, steps } = fakeHost(ports, recorded);
  return reviewHead(host, input, { plan: POLICY, timing: TIMING }).then((outcome) => ({ outcome, steps }));
};

describe("reviewHead", () => {
  it("spends one session per member when correctness and the adversary each say MERGE once (tp#2145)", async () => {
    const { world, ports } = fakeWorld(merges);

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "MERGE", head: HEAD });
    expect(world.spawns).toEqual([name("correctness"), name("adversary")]);
  });

  it("retries a member whose session never started once, under a fresh name", async () => {
    const { world, ports } = fakeWorld(merges, [name("correctness")]);

    const { outcome } = await review(ports);

    expect(outcome.kind).toBe("MERGE");
    expect(world.spawns).toEqual([name("correctness"), name("adversary"), name("correctness", 2)]);
  });

  it("never dispatches a member that said MERGE again while another member times out to the fixer", async () => {
    const { world, ports } = fakeWorld((agent) => (agent.includes("correctness") ? MERGE : undefined));

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "needs-fixer", failure: "timeout", fingerprint: "timeout:adversary" });
    expect(world.spawns).toEqual([name("correctness"), name("adversary"), name("adversary", 2)]);
  });

  it("sends a member that repeats the same refusal after its correction to the fixer, with no fresh member", async () => {
    const { world, ports } = fakeWorld((agent) => (agent.includes("adversary") ? "I read the diff and it looks fine." : MERGE));

    const { outcome } = await review(ports);

    expect(outcome).toMatchObject({ kind: "needs-fixer", failure: "malformed", fingerprint: "parser:no_block" });
    expect([world.spawns, world.resumes, world.fixers.length]).toEqual([[name("correctness"), name("adversary")], [name("adversary")], 1]);
  });

  it("skips preflight on a run recorded before it existed and dispatches the plan its intent recorded", async () => {
    const { world, ports } = fakeWorld(merges);
    const plan: PanelPlan = { class: { class: "standard", touches: [] }, members: [{ shape: "correctness", profile: "reviewer", briefId: "correctness/v1", blocking: true, degraded: false }], spendEstimate: 1, degraded: false };

    const { outcome, steps } = await review(ports, [[`${DEFAULT_REVIEW_STEP_IDS.intent}:${HEAD}`, { plan }]]);

    expect(outcome.kind).toBe("MERGE");
    expect([world.snapshotReads, steps[0]]).toEqual([0, `${DEFAULT_REVIEW_STEP_IDS.intent}:${HEAD}`]);
  });
});
