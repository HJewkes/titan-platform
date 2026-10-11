import type { StepResult, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { step } from "../workflows/land.js";
import { APPROVAL_CARRY_STEP, carryingBase, type CarryTarget } from "./carry-merge.js";
import { fixCarryStep } from "./fix-carry.js";
import { remergeStep } from "./remerge-carry.js";

/** Land's own merge question; a conflict, release or other gate that shares the step id asks something else. */
const LAND_GATE = /^Merge PR #\d+ in \S+ at head ([0-9a-f]{40})(?: into (\S+))?\? CI is green\. Policy ([\w-]+)\//;
/** An escalation (failed rounds, a runaway fixer) is a decision about the run, so it never follows a head. */
const ESCALATION_TABLE = "shepherd-route";

const MergeAnswer = z.looseObject({ decision: z.literal("merge"), headSha: z.string() });

interface ApprovalCarry {
  target: CarryTarget;
  /** True when the run's verdict at this head is a MERGE; an approval follows only a head whose review stands too. */
  reviewedMerge: (headSha: string) => boolean;
}

export function landGateHead(stepId: string, prompt: string): string | undefined {
  const match = LAND_GATE.exec(prompt);
  return stepIdMatches("approve-merge", stepId) && match && match[3] !== ESCALATION_TABLE ? match[1] : undefined;
}

/** The base a land gate names; a gate from before the base was named reads as none. */
const landGateBase = (prompt: string): string | undefined => LAND_GATE.exec(prompt)?.[2];

interface Followed {
  rule: string;
  /** The tree or diff facts the carry rests on, recorded with the answer. */
  proof: Record<string, unknown>;
}

/** The merge-up probe first; a head it refuses may still be the approved head merged with the base plus a small fix. */
async function followProof(ctx: WorkflowContext, target: CarryTarget, baseRef: string, fromHead: string, head: string): Promise<Followed | undefined> {
  const remerge = await remergeStep(ctx, { repo: target.repo, baseRef, fromHead, head });
  if (remerge.carries && remerge.rule) return { rule: remerge.rule, proof: { headTree: remerge.headTree, mergeTree: remerge.remergeTree, paths: remerge.paths } };
  const fix = await fixCarryStep(ctx, { repo: target.repo, baseRef, fromHead, head });
  if (!fix.carries || !fix.rule) return undefined;
  return { rule: fix.rule, proof: { base: fix.base, headTree: fix.headTree, mergeTree: fix.mergeTree, changedLines: fix.changedLines, paths: fix.paths } };
}

/** The recorded answer, shaped as the gate's own: land reads only `data`, which names the head the follow was checked at. */
async function followedAnswer(ctx: WorkflowContext, target: CarryTarget, fromHead: string, head: string): Promise<StepResult | undefined> {
  const baseRef = await carryingBase(ctx, target, `approve:${head}`);
  if (baseRef === undefined) return undefined;
  const carried = await followProof(ctx, target, baseRef, fromHead, head);
  if (!carried) return undefined;
  const stepId = `${APPROVAL_CARRY_STEP}:${head}`;
  const followed = await step(ctx, stepId, { decision: "merge", headSha: head, fromHead, ...carried }, MergeAnswer);
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: followed.decision, headSha: followed.headSha } };
}

/**
 * Wraps `assisted` so a merge answer at land's gate, the owner's or a review round's ship pick, follows to a later gate at a
 * head that is the approved head plus one merge of the base whose remerge-diff is empty or touches only declared generated
 * files, or the approved head merged with the base plus a small fix (see `SMALL_FIX_LIMITS`). Any other head, a kind that does not carry, an escalation, a gate on another base or a head without a standing
 * MERGE asks again.
 */
export function followingApprovals(ctx: WorkflowContext, assisted: WorkflowContext["assisted"], carry: ApprovalCarry): WorkflowContext["assisted"] {
  let approved: { head: string; base: string | undefined } | undefined;
  return async (stepId, prompt, options) => {
    const asked = landGateHead(stepId, prompt);
    if (asked === undefined) return assisted(stepId, prompt, options);
    const base = landGateBase(prompt);
    const from = approved && approved.head !== asked && approved.base === base && carry.reviewedMerge(asked) ? approved.head : undefined;
    const followed = from === undefined ? undefined : await followedAnswer(ctx, carry.target, from, asked);
    const answer = followed ?? (await assisted(stepId, prompt, options));
    if (MergeAnswer.safeParse(answer.data).data?.headSha === asked) approved = { head: asked, base };
    return answer;
  };
}
