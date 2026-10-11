import { fakeSha, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { gateEverything } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, landScenario } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { DEVICE_CHECK, LAND_STEPS, land, type ApprovalAnswer, type ApprovalQuestion, type AskApproval, type LandOutcome } from "./land.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A land run whose approval is the hook, answering in turn from `answers`; `beforeAnswer` runs as each question arrives. */
function hookedRun(answers: ApprovalAnswer[], beforeAnswer: (question: ApprovalQuestion, fake: FakeGitHub) => void = () => undefined) {
  const scenario = landScenario();
  const asked: ApprovalQuestion[] = [];
  const askApproval: AskApproval = async (_ctx, question) => (asked.push(question), beforeAnswer(question, scenario.fake), answers[asked.length - 1]!);
  const outcomes: LandOutcome[] = [];
  const workflow = defineWorkflow({ name: "land-hooked", steps: LAND_STEPS, run: async (ctx) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: gateEverything, askApproval })) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake: scenario.fake, asked, outcomes, runId: host.runtime.start("land-hooked") };
}

describe("land with an askApproval hook", () => {
  it("merges the head the hook approved without opening approve-merge", async () => {
    const { host, fake, asked, outcomes, runId } = hookedRun(["merge"]);

    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(asked).toEqual([{ repo: REPO, pr: 1, headSha: H1, round: 0, reason: expect.any(String), base: "main" }]);
    expect(host.gates.get(gateId(runId, "approve-merge"))).toBeUndefined();
    expect(fake.effects.merge).toBe(1);
    expect(outcomes.at(-1)).toEqual({ kind: "merged", headSha: H1, mergeSha: fake.pr(1).mergeSha });
  });

  it("reports a failed answer as a red head with one device check that CI cannot rerun", async () => {
    const { host, fake, outcomes, runId } = hookedRun([{ failed: "screen stays dark" }]);

    await host.runtime.wait(runId);

    expect(fake.effects.merge).toBe(0);
    expect(outcomes.at(-1)).toEqual({
      kind: "ci-failed",
      headSha: H1,
      failing: [{ name: DEVICE_CHECK, conclusion: "screen stays dark", url: "https://github.com/octo/demo/pull/1", workflowRunId: null }],
    });
  });

  it("stops abandoned without merging when the hook abandons", async () => {
    const { host, fake, outcomes, runId } = hookedRun(["abandon"]);

    await host.runtime.wait(runId);

    expect(fake.effects.merge).toBe(0);
    expect(outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "abandoned", headSha: H1 });
  });

  it("never merges a head pushed while the hook was answering for the old one", async () => {
    const world = hookedRun(["merge", "abandon"], (question, fake) => question.headSha === H1 && fake.pushHead(1, H2));

    await world.host.runtime.wait(world.runId);

    expect(world.asked.map((question) => question.headSha)).toEqual([H1, H2]);
    expect(world.fake.effects.merge).toBe(0);
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "stopped", reason: "abandoned", headSha: H2 });
  });
});

describe("land without an askApproval hook", () => {
  it("still opens approve-merge at the head and merges once the owner approves", async () => {
    const scenario = landScenario();
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("land-test");
    await gateOpened(host, gateId(runId, "approve-merge"));

    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    const run = await host.runtime.wait(runId);

    expect(run.status).toBe("completed");
    expect(scenario.fake.effects.merge).toBe(1);
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: H1, mergeSha: scenario.fake.pr(1).mergeSha });
  });
});
