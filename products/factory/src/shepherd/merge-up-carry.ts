import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import type { Verdict } from "./phases.js";
import type { CarryResult } from "./tree-carry.js";

/** Records that a MERGE moved across a clean merge-up of the base, so the run log names the rule that skipped the review. */
export const MERGE_UP_STEP = "sh-merge-up";
const MERGE_UP_RULE = "clean-merge-up";

const MergeUpRecord = z.looseObject({ fromHead: z.string(), head: z.string(), base: z.string(), rule: z.literal(MERGE_UP_RULE) });

interface ProbedCarry {
  fromHead: string;
  head: string;
  result: CarryResult;
}

/** The reviewed head and every head a merge-up already carried its MERGE to; a chain of merge-ups stays on this line. */
function reviewedLine(reviews: ReadonlyMap<string, Verdict>, fromHead: string): Set<string> {
  const line = new Set([fromHead]);
  for (const [head, verdict] of reviews) if (verdict.kind === "MERGE" && verdict.mergeUpFrom === fromHead) line.add(head);
  return line;
}

/**
 * The head's first parent is on the reviewed line, its second parent is on the base branch, and its tree is the clean
 * merge-tree of the reviewed head and that base commit, so the PR's own diff is the reviewed one. The tree probe has already
 * refused a conflicted merge-tree and a second parent off the base branch; a conflict resolution, an extra commit or a
 * rebase fails one of these.
 */
function isCleanMergeUp(result: CarryResult, fromHead: string, reviews: ReadonlyMap<string, Verdict>): boolean {
  const { equal, base, firstParent, headTree, mergeTree } = result;
  return equal && base !== undefined && firstParent !== undefined && !!headTree && headTree === mergeTree && reviewedLine(reviews, fromHead).has(firstParent);
}

/** A replay whose record took another step here ran before this rule; following the record keeps its history as it was. */
function recordedElsewhere(ctx: WorkflowContext, stepId: string): boolean {
  const next = ctx.historyNext();
  return next !== undefined && next !== stepId;
}

/**
 * The tree-equal rule: equal trees, and the head a clean merge-up of the reviewed line. A probe recorded before the probe read
 * the first parent carries as it did then, so a replay keeps its history.
 */
export function treeCarries(result: CarryResult, fromHead: string, reviews: ReadonlyMap<string, Verdict>): boolean {
  const treeEqual = result.equal && !!result.headTree && result.headTree === result.mergeTree;
  return treeEqual && (result.firstParent === undefined || isCleanMergeUp(result, fromHead, reviews));
}

/** True once the run log records a carry as a clean merge-up; any other carry, or a replay recorded without the step, is false. */
export async function recordMergeUp(ctx: WorkflowContext, carry: ProbedCarry, reviews: ReadonlyMap<string, Verdict>): Promise<boolean> {
  const stepId = `${MERGE_UP_STEP}:${carry.head}`;
  if (!isCleanMergeUp(carry.result, carry.fromHead, reviews) || recordedElsewhere(ctx, stepId)) return false;
  await step(ctx, stepId, { fromHead: carry.fromHead, head: carry.head, base: carry.result.base, rule: MERGE_UP_RULE }, MergeUpRecord);
  return true;
}

export const mergeUpRoute = (now: () => number): StepRoute => codeRoute(MERGE_UP_STEP, now, async (input: object) => input);
