import type { CiPolicy } from "@titan-design/session-read";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { Verdict } from "../shepherd/phases.js";
import { ownerAtHeadAt, skillPathsAt } from "../shepherd/policy.js";
import { approveMergeGate } from "../workflows/land-approval.js";
import { ownerEvidence, type ReadVerdictText } from "./owner-evidence.js";

/** TP-4404: land opens each gate here from the evidence it was given, with its own fact functions; every value is synthetic. */
const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const RV = { agentId: "agent-rv", sessionId: "session-rv" };
const LOCATOR = { source: { sourceId: "synthetic:session" }, evidence: { line: { byteOffset: 0 } } };
const SOURCE = "src/synthetic.ts";
const SKILL = ".claude/skills/synthetic-skill/SKILL.md";
const CI_WEAKENED = "shepherd-merge-guard/ci-policy-weakened";
const BEFORE_OPEN = "2020-01-01T00:00:00.000Z";
const AFTER_OPEN = "2999-01-01T00:00:00.000Z";

const weakened = (...keys: string[]) => ({ kind: "weakened", keys }) as CiPolicy;
const verdictText = (...lines: string[]) => [...lines.slice(0, -1), "", "Verdict: MERGE", `PR: ${REPO}#1`, `Head: ${H}`, lines.at(-1)!].join("\n");

/** An evidence step's output at H, whole as the step writes it. */
function evidence(ciPolicy?: CiPolicy, changedPaths: string[] = [SOURCE]) {
  const merge = { head: H, resolver: RV, dispatchedReviewer: RV, verdict: { value: "MERGE", head: H }, requiredContexts: [], allowedApps: [], checkRuns: [], mergeTreeClean: true, repoFrozen: false, changedPaths, seatGrants: [] };
  const record = { runId: "run-1", repo: REPO, pr: 1, head: H, baseRef: "main", testMergeSha: null, checkRuns: [], verdictLocator: LOCATOR, reviewer: RV, decision: { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "ci-policy-weakened", version: 1 }, reason: "synthetic" } };
  return { head: H, merge, record, ...(ciPolicy && { ciPolicy }) };
}

const liveGate = defineWorkflow({
  name: "live-merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const rule = ctx.param("rule")!;
    const verdictFor = (head: string): Verdict => ({ kind: "MERGE", headSha: head, evidence: JSON.parse(ctx.param("evidence")!) });
    const facts = { reviewedMerge: () => true, skillPathsAt: (head: string) => skillPathsAt(head, verdictFor), ownerAtHeadAt: (head: string) => ownerAtHeadAt(head, verdictFor) };
    const question = { repo: REPO, pr: 1, headSha: H, round: 0, reason: "synthetic reason", base: "main" };
    await approveMergeGate({ table: rule.slice(0, rule.indexOf("/")), rowId: rule.slice(rule.indexOf("/") + 1), version: 1 }, facts)(ctx, question);
  },
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const evidenceStep = (completedAt: string, result: object, iteration: number): StepResult => ({ stepId: `sh-merge-evidence:${H}`, iteration, agentId: null, signal: null, completedAt, data: { result } });

/** Opens the gate on `opened`, then lays `steps` over its run as the evidence steps Shepherd recorded. */
async function gateOn(opened: object, steps: StepResult[], rule = CI_WEAKENED) {
  const stored = openFactoryHost({ dbPath: ":memory:", workflows: [liveGate], routes: [], gatePollMs: 5 });
  hosts.push(stored);
  const withSteps = (run: WorkflowRun | undefined) => run && { ...run, stepResults: { ...run.stepResults, ...Object.fromEntries(steps.map((step) => [`${step.stepId}:${step.iteration}`, step])) } };
  const host: FactoryHost = { ...stored, runs: Object.assign(Object.create(stored.runs), { get: (id: string) => withSteps(stored.runs.get(id)) }) };
  const runId = stored.runtime.start("live-merge-gate", { rule, evidence: JSON.stringify(opened) });
  const gateId = `${runId}/approve-merge`;
  await vi.waitFor(() => expect(stored.gates.get(gateId)?.status).toBe("pending"));
  return { host, gate: stored.gates.get(gateId)! };
}

const reads =
  (text: string): ReadVerdictText =>
  async () =>
    text;

describe("the owner-at-head evidence card", () => {
  it("heads a decorated weakened line before a canonical unchanged one with the stored reading, listing both lines", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const text = verdictText("**CI policy:** weakened secrets", "CI-policy: unchanged");

    const card = await ownerEvidence(gate, { host, readText: reads(text) });

    expect(card).toMatchObject({ status: "ready", head: H, facts: ["ci-policy-weakened"] });
    expect(card.status === "ready" && card.sections).toEqual([
      {
        fact: "ci-policy-weakened",
        ciPolicy: weakened("secrets"),
        verdictText: text,
        labelledLines: [
          { raw: "**CI policy:** weakened secrets", reading: weakened("secrets") },
          { raw: "CI-policy: unchanged", reading: { kind: "unchanged" } },
        ],
      },
    ]);
  });

  it("reads missing when the verdict text no longer reads as the stored CI-policy reading", async () => {
    const stored = evidence(weakened("permissions"));
    const { host, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("does not read as the evidence's CI-policy reading") });
  });

  it("reads missing when the gate's marker names a fact the evidence does not hold, an unknown one included", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const marked = { ...gate, prompt: gate.prompt.replace("their own head: ci-policy-weakened.", "their own head: ci-policy-weakened, bogus.") };

    const card = await ownerEvidence(marked, { host, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", facts: ["ci-policy-weakened", "bogus"] });
  });

  it("shows the evidence the gate opened on, not a re-read that completed after it", async () => {
    const opened = evidence(weakened("secrets"));
    const reread = evidence(weakened("permissions"));
    const { host, gate } = await gateOn(opened, [evidenceStep(BEFORE_OPEN, opened, 0), evidenceStep(AFTER_OPEN, reread, 1)]);

    const card = await ownerEvidence(gate, { host, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card.status === "ready" && card.sections.map((section) => section.ciPolicy)).toEqual([weakened("secrets")]);
  });

  it("reads missing, with the terminal command, for a gate whose facts need file sections", async () => {
    const stored = evidence(undefined, [SKILL]);
    const { host, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "authority/MRG-AU");

    const card = await ownerEvidence(gate, { host, readText: reads(verdictText("CI-policy: unchanged")) });

    expect(card).toMatchObject({ status: "missing", facts: ["skill-path"], reason: expect.stringContaining("file sections"), command: expect.stringContaining(`"headSha":"${H}"`) });
  });

  it("reads missing when no evidence step completed before the gate opened", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, gate } = await gateOn(stored, [evidenceStep(AFTER_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("no well-formed merge evidence") });
  });
});
