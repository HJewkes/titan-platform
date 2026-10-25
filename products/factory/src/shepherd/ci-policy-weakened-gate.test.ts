import { fakeSha } from "@titan-design/github";
import type { DispatchOptions, StepResult, WorkflowContext } from "@titan-design/workflow";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PolicyRule } from "../gate-policy.js";
import { approveMergeAsk } from "../workflows/land-approval.js";
import { followingApprovals } from "./approval-carry.js";
import type { RemergeResult } from "./remerge-carry.js";

const REPO = "acme/widgets";
const APPROVED = fakeSha("approved");
const LATER = fakeSha("later");
const EMPTY: RemergeResult = { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
const D21: PolicyRule = { table: "shepherd-merge-guard", rowId: "ci-policy-weakened", version: 1 };
const AUTHORITY: PolicyRule = { table: "authority", rowId: "MRG-AU", version: 1 };

const landPrompt = (head: string, rule: PolicyRule = AUTHORITY): string =>
  `Merge PR #1 in ${REPO} at head ${head}? CI is green. Policy ${rule.table}/${rule.rowId}: the policy did not allow an automated merge`;

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

describe("an owner merge approval meeting a CI-policy-weakened gate", () => {
  it("asks the owner again at a ci-policy-weakened gate, even when the head is an empty-remerge merge-up", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(LATER, D21));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("does not follow an approval given at a ci-policy-weakened gate to a later head's gate", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED, D21));
    await r.ask("approve-merge:1", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED, LATER]);
  });

  it("still follows an authority approval to an empty-remerge head without asking", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    const answer = await r.ask("approve-merge:1", landPrompt(LATER));

    expect(answer.data).toEqual({ decision: "merge", headSha: LATER });
    expect(r.gates).toEqual([APPROVED]);
  });
});

describe("the approve-merge brief at a CI-policy-weakened gate", () => {
  const ask = (rule: PolicyRule) => approveMergeAsk(rule, { reviewedMerge: () => true }, { repo: REPO, pr: 1, headSha: LATER, round: 0, reason: "CI-policy weakened: permissions" });
  const recommended = (rule: PolicyRule) => ask(rule).brief.questions![0]!.options.filter((option) => option.recommended).map((option) => option.id);

  it("recommends nothing on a reviewer's MERGE and sends the owner to the card and the diff", () => {
    const { brief } = ask(D21);

    expect(recommended(D21)).toEqual([]);
    expect(brief.summary).toMatch(/The reviewer judged CI policy weakened; read the card and the diff; no recommendation\.$/);
    expect(brief.summary).not.toMatch(/recommend merge/);
  });

  it("still recommends merge on a reviewer's MERGE at an authority gate", () => {
    expect(recommended(AUTHORITY)).toEqual(["merge"]);
    expect(ask(AUTHORITY).brief.summary).toMatch(/recommend merge\.$/);
  });
});
