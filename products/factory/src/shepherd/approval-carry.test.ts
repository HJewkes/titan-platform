import { fakeSha } from "@titan-design/github";
import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { followingApprovals } from "./approval-carry.js";
import type { RemergeResult } from "./remerge-carry.js";

const REPO = "acme/widgets";
const TARGET = { repo: REPO, pr: 1 };
const APPROVED = fakeSha("approved");
const MERGED_UP = fakeSha("merged-up");
const LATER = fakeSha("later");
const EMPTY: RemergeResult = { carries: true, rule: "remerge-empty", headTree: "t", remergeTree: "t", paths: [], generatedPaths: [] };
const RESOLVED: RemergeResult = { carries: false, paths: ["src/a.ts"], generatedPaths: [], reason: "the merge changed 1 path(s) outside the declared generated files" };

const landPrompt = (head: string, table = "authority", row = "MRG-AU"): string =>
  `Merge PR #1 in ${REPO} at head ${head}? CI is green. Policy ${table}/${row}: the authority policy did not allow an automated merge`;

interface Rig {
  ask: WorkflowContext["assisted"];
  /** Heads the owner was asked about. */
  gates: string[];
  steps: { stepId: string; input: Record<string, unknown> }[];
}

interface RigOptions {
  kind?: string;
  remerge?: RemergeResult;
  /** Heads whose review is a MERGE; every head by default. */
  reviewed?: (head: string) => boolean;
  /** The owner's answer at each gate; merge at the asked head by default. */
  answer?: (head: string) => Record<string, unknown>;
}

function rig({ kind = "correctness", remerge = EMPTY, reviewed = () => true, answer = (head) => ({ decision: "merge", headSha: head }) }: RigOptions = {}): Rig {
  const gates: string[] = [];
  const steps: Rig["steps"] = [];
  const respond = (stepId: string, input: Record<string, unknown>): object => {
    if (stepId.startsWith("sh-carry-scope:")) return { kind, baseRef: "main" };
    if (stepId.startsWith("sh-remerge:")) return remerge;
    return input;
  };
  const dispatch = async (stepId: string, _template: string, options: { vars: Record<string, string> }) => {
    const input = JSON.parse(Object.values(options.vars)[0]!) as Record<string, unknown>;
    steps.push({ stepId, input });
    return { data: { result: respond(stepId, input) } };
  };
  const ctx = { runId: "run-1", dispatch } as unknown as WorkflowContext;
  const owner: WorkflowContext["assisted"] = async (_stepId, prompt) => {
    const head = /at head ([0-9a-f]{40})/.exec(prompt)?.[1] ?? "";
    gates.push(head);
    return { stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: answer(head) } satisfies StepResult;
  };
  return { ask: followingApprovals(ctx, owner, { target: TARGET, reviewedMerge: reviewed }), gates, steps };
}

describe("an approve-merge answer following the head", () => {
  it("answers the gate at the approved head plus an empty-remerge merge of the base without asking the owner", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    const answer = await r.ask("approve-merge:1", landPrompt(MERGED_UP, "shepherd-merge-guard", "merge-state-unsettled"));

    expect(answer.data).toEqual({ decision: "merge", headSha: MERGED_UP });
    expect(r.gates).toEqual([APPROVED]);
    expect(r.steps.find((step) => step.stepId === `sh-remerge:${MERGED_UP}`)!.input).toMatchObject({ fromHead: APPROVED, head: MERGED_UP, baseRef: "main" });
    expect(r.steps.find((step) => step.stepId === `sh-approval-carry:${MERGED_UP}`)!.input).toEqual({ decision: "merge", headSha: MERGED_UP, fromHead: APPROVED, rule: "remerge-empty" });
  });

  it("asks the owner again when the later gate names another base, and follows on the same one", async () => {
    const r = rig();
    const into = (head: string, base: string) => landPrompt(head).replace("? CI is green", ` into ${base}? CI is green`);

    await r.ask("approve-merge", into(APPROVED, "feat/x"));
    await r.ask("approve-merge:1", into(MERGED_UP, "main"));
    await r.ask("approve-merge:2", into(LATER, "main"));

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
    expect(r.steps.find((step) => step.stepId === `sh-remerge:${LATER}`)!.input).toMatchObject({ fromHead: MERGED_UP });
  });

  it("follows a review round's ship pick, which resolves the same gate with a merge at its head", async () => {
    const r = rig({ remerge: { ...EMPTY, rule: "remerge-generated-only", paths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] } });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));

    expect(r.gates).toEqual([APPROVED]);
  });

  it("asks the owner again when the merge-up resolved a conflict in a reviewed file", async () => {
    const r = rig({ remerge: RESOLVED });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
    expect(r.steps.some((step) => step.stepId.startsWith("sh-approval-carry"))).toBe(false);
  });

  it("follows a chain of merge-ups, each from the head the last answer covered", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));
    await r.ask("approve-merge:2", landPrompt(LATER));

    expect(r.gates).toEqual([APPROVED]);
    expect(r.steps.find((step) => step.stepId === `sh-remerge:${LATER}`)!.input).toMatchObject({ fromHead: MERGED_UP });
  });

  it("never follows for a security run and never probes it", async () => {
    const r = rig({ kind: "security" });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
    expect(r.steps.some((step) => step.stepId.startsWith("sh-remerge"))).toBe(false);
  });

  it("asks again at a head whose review is not a standing MERGE", async () => {
    const r = rig({ reviewed: (head) => head !== MERGED_UP });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
    expect(r.steps).toEqual([]);
  });

  it("follows nothing after the owner abandoned", async () => {
    const r = rig({ answer: (head) => ({ decision: "abandon", headSha: head }) });

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
  });

  it("never follows into or out of an escalation, which decides the run, not a head", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED, "shepherd-route", "failed-rounds"));
    await r.ask("approve-merge:1", landPrompt(MERGED_UP));
    await r.ask("approve-merge:2", landPrompt(LATER, "shepherd-route", "no-progress"));

    expect(r.gates).toEqual([APPROVED, MERGED_UP, LATER]);
  });

  it("passes any other gate straight through", async () => {
    const r = rig();

    await r.ask("approve-merge", landPrompt(APPROVED));
    await r.ask("sh-sent-back", `Send back at head ${MERGED_UP}?`);

    expect(r.gates).toEqual([APPROVED, MERGED_UP]);
    expect(r.steps).toEqual([]);
  });
});
