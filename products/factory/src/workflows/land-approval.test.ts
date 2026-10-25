import { fakeSha, type FakeGitHub } from "@titan-design/github";
import { GatePayloadInvalid, GateResolverRefused, type GateResolver } from "@titan-design/hitl";
import { partialFake } from "@titan-design/test-kit";
import type { WorkflowContext } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "../definition.js";
import { gateEverything, type GatePolicy, type PolicyRule } from "../gate-policy.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened, landScenario } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { DEVICE_CHECK, LAND_STEPS, SET_ANSWER_ORIGIN, land, type ApprovalAnswer, type ApprovalQuestion, type AskApproval, type LandOutcome } from "./land.js";
import { shepherdLandOptions, type EffectivePolicy } from "../shepherd/policy.js";
import type { Verdict } from "../shepherd/phases.js";
import { approveMergeAsk, approveMergeGate } from "./land-approval.js";

const H2 = fakeSha("head2");
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A land run whose approval is the hook, answering in turn from `answers`; `beforeAnswer` runs as each question arrives. */
function hookedRun(answers: ApprovalAnswer[], beforeAnswer: (question: ApprovalQuestion, fake: FakeGitHub) => void = () => undefined, scenario = landScenario()) {
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
    expect(outcomes.at(-1)).toEqual({ kind: "merged", headSha: H1, mergeSha: fake.pr(1).mergeSha, landed: expect.objectContaining({ baseRef: "main", headSha: H1 }), own: true });
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

/** A non-strict repo whose base keeps moving, so every green head reads behind a base that moved after it went green. */
function movingBaseScenario() {
  const scenario = landScenario();
  scenario.fake.rules.strict = false;
  const keepGreen = scenario.fake.onGetPr!;
  scenario.fake.onGetPr = (pr, reads) => (keepGreen(pr, reads), (pr.behind = true));
  return scenario;
}

describe.each(["merge", "merge-by-set"] as const)("a %s answer at a head whose non-strict base keeps moving", (answer) => {
  it("merges the approved head as it stands, with no update and no second question", async () => {
    const world = hookedRun([answer, "abandon"], undefined, movingBaseScenario());

    await world.host.runtime.wait(world.runId);

    expect(world.asked.map((question) => question.headSha)).toEqual([H1]);
    expect(world.fake.effects).toMatchObject({ updateBranch: 0, merge: 1 });
    expect(world.outcomes.at(-1)).toMatchObject({ kind: "merged", headSha: H1 });
  });
});

describe("approveMergeGate", () => {
  const RULE: PolicyRule = { table: "shepherd-merge-guard", rowId: "visual-path", version: 1 };
  const QUESTION: ApprovalQuestion = { repo: REPO, pr: 1, headSha: H1, round: 0, reason: "a visual path changed", base: "main" };
  const answering = (data: Record<string, unknown>) => partialFake<WorkflowContext>({ assisted: async (stepId) => ({ stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data }) });

  it.each<[string, Record<string, unknown>, ApprovalAnswer]>([
    ["the owner's merge", { decision: "merge", headSha: H1 }, "merge"],
    ["a merge the approved set answered", { decision: "merge", headSha: H1, origin: SET_ANSWER_ORIGIN }, "merge-by-set"],
  ])("reads %s with its source", async (_name, data, expected) => {
    expect(await approveMergeGate(RULE)(answering(data), QUESTION)).toBe(expected);
  });
});

describe("the approve-merge prompt on a ci-policy-weakened gate (TP-2407 c)", () => {
  const RULE: PolicyRule = { table: "shepherd-merge-guard", rowId: "ci-policy-weakened", version: 1 };
  const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: false, seat: "trusted-seat" };
  const CI = ".github/workflows/ci.yml";
  const change = { path: CI, key: "permissions", removed: ["  contents: write"], added: ["  contents: read"], omitted: 0 };
  const evidence = { head: H1, merge: { changedPaths: [CI] }, record: { ciPolicyChanges: [change] }, ciPolicy: { kind: "weakened", keys: ["permissions", "other"] } };
  /** Evidence collected at H1 under a MERGE at any head, so only the accessor's own head check keeps it off another head's gate. */
  const weakenedAt = (headSha: string): Verdict | undefined => ({ kind: "MERGE", headSha, evidence });
  const ask = (headSha: string) => approveMergeAsk(RULE, shepherdLandOptions(() => AUTO, weakenedAt), { repo: REPO, pr: 1, headSha, round: 0, reason: "CI-policy weakened: permissions, other" });

  it("names Class D21, the weakened keys and each before→after line, and sends the owner to the diff for other", () => {
    const { prompt, brief } = ask(H1);

    expect(prompt).toContain("Class D21 (CI policy weakened): permissions, other");
    expect(prompt).toContain(`${CI} (permissions):\n-   contents: write\n+   contents: read`);
    expect(prompt).toContain("No before→after lines read for other; read the diff.");
    expect(prompt).toContain(`https://github.com/${REPO}/pull/1/files`);
    expect(brief.summary).toContain("Class D21 (CI policy weakened): permissions, other");
  });

  it("shows no D21 card on a gate at another head than the evidence was collected at", () => {
    const { prompt, brief } = ask(H2);

    expect(prompt).not.toContain("D21");
    expect(prompt).not.toContain("contents: write");
    expect(brief.summary).not.toContain("D21");
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
    expect(scenario.outcomes.at(-1)).toEqual({ kind: "merged", headSha: H1, mergeSha: scenario.fake.pr(1).mergeSha, landed: expect.objectContaining({ baseRef: "main", headSha: H1 }), own: true });
  });
});

/** A land run at the approve-merge gate with no hook; `sendBack` is what the flag step would read, absent as before it existed. */
async function gatedRun(sendBack?: boolean) {
  const scenario = landScenario();
  const outcomes: LandOutcome[] = [];
  const sendBackOffered = sendBack === undefined ? undefined : async () => sendBack;
  const workflow = defineWorkflow({ name: "land-gated", steps: LAND_STEPS, run: async (ctx) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: gateEverything, sendBackOffered })) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes: scenario.routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("land-gated");
  const gate = gateId(runId, "approve-merge");
  await gateOpened(host, gate);
  return { host, fake: scenario.fake, outcomes, runId, gate };
}

const offered = (host: FactoryHost, gate: string): unknown => host.gates.get(gate)?.questions?.[0]?.options.map((option) => option.id);
const COORDINATOR: GateResolver = { class: "coordinator", id: "coord-a", channel: "test" };

describe("approve-merge send-back", () => {
  it("stops sent-back with the owner's note and never merges the head", async () => {
    const { host, fake, outcomes, runId, gate } = await gatedRun(true);

    host.gates.resolve(gate, { decision: "send-back", headSha: H1, note: "rename the flag" }, OWNER);
    await host.runtime.wait(runId);

    expect(offered(host, gate)).toEqual(["merge", "abandon", "send-back"]);
    expect(fake.effects.merge).toBe(0);
    expect(outcomes.at(-1)).toEqual({ kind: "stopped", reason: "sent-back", headSha: H1, detail: "rename the flag" });
  });

  it.each([
    ["the flag reads false", false],
    ["no flag is wired", undefined],
  ])("offers no send-back and the store refuses one when %s", async (_case, sendBack) => {
    const { host, gate } = await gatedRun(sendBack);

    const sent = () => host.gates.resolve(gate, { decision: "send-back", headSha: H1, note: "rename the flag" }, OWNER);

    expect(offered(host, gate)).toEqual(["merge", "abandon"]);
    expect(sent).toThrow(GatePayloadInvalid);
    expect(host.gates.get(gate)?.status).toBe("pending");
  });

  it("refuses a send-back that carries no note at the store, so the gate stays pending", async () => {
    const { host, gate } = await gatedRun(true);

    expect(() => host.gates.resolve(gate, { decision: "send-back", headSha: H1 }, OWNER)).toThrow(GatePayloadInvalid);
    expect(() => host.gates.resolve(gate, { decision: "send-back", headSha: H2, note: "rename" }, OWNER)).toThrow(GatePayloadInvalid);
    expect(host.gates.get(gate)?.status).toBe("pending");
  });

  it("never lets a coordinator send back, whatever the note", async () => {
    const { host, gate } = await gatedRun(true);

    expect(() => host.gates.resolve(gate, { decision: "send-back", headSha: H1, note: "rename the flag" }, COORDINATOR)).toThrow(GateResolverRefused);
    expect(host.gates.get(gate)?.status).toBe("pending");
  });
});

describe("the rule land stamps on approve-merge", () => {
  /** Opens land's own approve-merge gate under a policy that gates on `rule`, and returns the rule the store kept. */
  async function storedRule(rule: PolicyRule) {
    const policy: GatePolicy = { decide: () => ({ outcome: "gate", rule, reason: "synthetic reason" }) };
    const scenario = landScenario({ policy });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [scenario.workflow], routes: scenario.routes, gatePollMs: 5 });
    hosts.push(host);
    const gate = gateId(host.runtime.start("land-test"), "approve-merge");
    await gateOpened(host, gate);
    return host.gates.get(gate)?.rule;
  }

  it("is the table.json row for an authority gate, and none for release or factory-local gates or an authority row that does not gate", async () => {
    const rule = (table: string, rowId: string): PolicyRule => ({ table, rowId, version: 1 });

    const mrgAu = await storedRule(rule("authority", "MRG-AU"));
    const unstamped = [rule("shepherd-release", "owner-gate"), rule("shepherd-merge-guard", "no-facts"), rule("shepherd-route", "failed-rounds"), rule("factory-default", "gate-all"), rule("shepherd-seat", "owner-gate"), rule("authority", "none")];

    expect(mrgAu).toEqual({ table: "F5", version: "1.0.0", ruleId: "MRG-AU", resolvers: ["owner-terminal", "owner-remote"], delegates: ["coordinator"] });
    for (const policyRule of unstamped) expect(await storedRule(policyRule), `${policyRule.table}/${policyRule.rowId}`).toBeUndefined();
  });
});
