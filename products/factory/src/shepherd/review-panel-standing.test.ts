import { fakeSha } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { panelReview } from "./review-panel-step.js";
import type { ProofStanding } from "./take-verdict.js";

/** Synthetic head of a PR whose unanimous panel says MERGE. */
const HEAD = fakeSha("review-panel-standing-head");
const REVIEWER = { agentId: "agent-rv-octo-demo-1", sessionId: "session-rv-octo-demo-1" };
const LOCATOR = { source: { conversation: { nativeId: REVIEWER.sessionId } } };
const MERGE = { kind: "verdict", verdict: "MERGE", head: HEAD, locator: LOCATOR, reviewer: REVIEWER };
const PANEL_MERGE = { outcome: "MERGE", head: HEAD, findings: [], dissent: [], degraded: [], satisfiesG10: false };
const AUTO = JSON.stringify({ merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" });
const TARGET = { repo: "octo/demo", pr: 1, head: HEAD };
const PLAN = { class: { class: "standard" as const, touches: [] }, members: [{ shape: "correctness" as const, profile: "reviewer", briefId: "correctness", blocking: true, degraded: false }], spendEstimate: 0, degraded: false };
const INTENT = { kind: "intent" as const, panel: "on" as const, plan: PLAN, panelReviewers: {} };
const AWAITING = { ...TARGET, reviewerAgentId: REVIEWER.agentId, reviewerSessionId: REVIEWER.sessionId, dispatchedAt: 0 };

/** A context answering each step by its id prefix and logging its input; it stops at the evidence step. */
function scripted(): { ctx: WorkflowContext; inputs: Map<string, unknown> } {
  const inputs = new Map<string, unknown>();
  const unused = (): never => {
    throw new Error("not used here");
  };
  const answers: Record<string, unknown> = {
    "sh-await-verdict": MERGE,
    "sh-review-panel": PANEL_MERGE,
    "sh-publish-review": { headSha: HEAD, conclusion: "success", published: false, reason: "no App" },
  };
  const ctx: WorkflowContext = {
    runId: "run-1",
    workflowName: "shepherd-pr",
    signal: new AbortController().signal,
    param: (name) => (name === "policy" ? AUTO : undefined),
    iteration: () => 0,
    historyNext: () => undefined,
    resumedGate: () => undefined,
    recoveredInFlight: () => [],
    capability: () => { throw new Error("no capabilities in this fake"); },
    expireGates: () => [],
    dispatch: async (stepId, _template, options) => {
      inputs.set(stepId, JSON.parse(Object.values(options?.vars ?? {})[0] ?? "null"));
      const prefix = stepId.slice(0, stepId.indexOf(":"));
      if (!(prefix in answers)) throw new Error(`stop at ${stepId}`);
      return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "2026-10-14T00:00:00.000Z", data: options?.schema?.parse({ result: answers[prefix] }) };
    },
    seed: unused,
    assisted: unused,
    authorize: unused,
  };
  return { ctx, inputs };
}

/** Drives the panel to its evidence step and returns the input that step was given. */
async function evidenceInput(standing: ProofStanding): Promise<unknown> {
  const { ctx, inputs } = scripted();
  const base = { ...TARGET, runId: "run-1" };

  await expect(panelReview(ctx, INTENT, base, AWAITING, REVIEWER, "acct-1", standing)).rejects.toThrow(`stop at sh-merge-evidence:${HEAD}`);

  return inputs.get(`sh-merge-evidence:${HEAD}`);
}

describe("the proof standing of a unanimous panel MERGE", () => {
  it("records an unverified standing on the MERGE's evidence", async () => {
    const input = await evidenceInput({ unverified: "error", reason: "the fix-proof check could not be read" });

    expect(input).toMatchObject({ proofUnverified: "error (the fix-proof check could not be read)" });
  });

  it("records nothing for an empty standing", async () => {
    const input = await evidenceInput({});

    expect(input).not.toHaveProperty("proofUnverified");
  });
});
