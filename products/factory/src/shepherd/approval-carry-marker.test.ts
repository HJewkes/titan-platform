import { fakeSha } from "@titan-design/github";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PolicyRule } from "../gate-policy.js";
import type { OwnerAtHeadRow } from "../owner-at-head.js";
import { approveMergeAsk } from "../workflows/land-approval.js";
import { followingApprovals } from "./approval-carry.js";
import type { RemergeResult } from "./remerge-carry.js";

/** TP-4141: a D21 fact land marks under another rule keeps an earlier approval from following; all text is synthetic. */
const REPO = "example-org/example-repo";
const APPROVED = fakeSha("marker-approved");
const LATER = fakeSha("marker-later");
const EMPTY: RemergeResult = { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
const AUTHORITY: PolicyRule = { table: "authority", rowId: "MRG-AU", version: 1 };
const VISUAL: PolicyRule = { table: "shepherd-merge-guard", rowId: "visual-path", version: 1 };
const SEAT: PolicyRule = { table: "shepherd-seat", rowId: "none", version: 1 };

/** The prompt land opens at `head` under `rule`, with `held` reported as the head's D21 facts. */
const landPrompt = (head: string, rule: PolicyRule = AUTHORITY, held: readonly OwnerAtHeadRow[] = []): string =>
  approveMergeAsk(rule, { ownerAtHeadAt: () => held }, { repo: REPO, pr: 1, headSha: head, round: 0, reason: "the policy did not allow an automated merge" }).prompt;

const StepInput = z.record(z.string(), z.unknown());

/** A carrying run whose every later head is an empty-remerge merge-up of the approved one, so only the gate decides. */
function rig() {
  const gates: string[] = [];
  const respond = (stepId: string, input: Record<string, unknown>): object => {
    if (stepId.startsWith("sh-carry-scope:")) return { kind: "correctness", baseRef: "main" };
    if (stepId.startsWith("sh-remerge:")) return EMPTY;
    return input;
  };
  async function dispatch<T extends Record<string, unknown>>(stepId: string, _template: string, options: DispatchOptions<T> = {}): Promise<StepResult<T>> {
    const input = StepInput.parse(JSON.parse(Object.values(options.vars ?? {})[0] ?? "{}"));
    return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: options.schema?.parse({ result: respond(stepId, input) }) };
  }
  const owner: WorkflowContext["assisted"] = async (_stepId, prompt) => {
    const head = /at head ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
    gates.push(head);
    return { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: head } } satisfies StepResult;
  };
  const ctx = partialFake<WorkflowContext>({ runId: "run-1", dispatch });
  return { ask: followingApprovals(ctx, owner, { target: { repo: REPO, pr: 1 }, reviewedMerge: () => true }), gates };
}

describe("an owner merge approval meeting a D21 fact marked under another rule", () => {
  it("asks the owner again at a visual-path gate marked ci-policy-weakened, and follows that approval to no later head", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER, VISUAL, ["ci-policy-weakened"]));
    await r.ask("approve-merge:2", landPrompt(fakeSha("marker-last")));

    expect(r.gates).toEqual([APPROVED, LATER, fakeSha("marker-last")]);
  });

  it("asks the owner again at a seat gate marked skill-path", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER, SEAT, ["skill-path"]));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });
});
