import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { mergeableState, type MergeableState, type RunState } from "./route-table.js";

export const OBSERVE_STEP = "sh-observe";
export const OBSERVE_STEPS: readonly StepDeclaration[] = [{ id: OBSERVE_STEP, kind: "dispatch" }];

/** The PR as GitHub reports it once a review ends: the route table's run state and mergeable state, and the head now. */
export interface ObservedPr {
  runState: RunState;
  mergeableState: MergeableState;
  headSha: string;
  mergeSha: string | null;
}

interface PrTarget {
  repo: RepoSlug;
  pr: number;
}

const ObservedResult = z.looseObject({ state: z.string(), merged: z.boolean(), draft: z.boolean(), headSha: z.string(), mergeableState: z.string(), mergeSha: z.string().nullable() });

/** Recorded as a step, so a replay routes on what the first run saw. */
export async function observePr(ctx: WorkflowContext, target: PrTarget, reviewedHead: string): Promise<ObservedPr> {
  const pr = await step(ctx, `${OBSERVE_STEP}:${reviewedHead}`, target, ObservedResult);
  const runState: RunState = pr.merged ? "merged-elsewhere" : pr.state === "closed" ? "closed-elsewhere" : "open";
  return { runState, mergeableState: mergeableState(pr.mergeableState, pr.draft), headSha: pr.headSha, mergeSha: pr.mergeSha };
}

export function observeRoute(port: GitHubPort, now: () => number): StepRoute {
  return codeRoute(OBSERVE_STEP, now, async (input: PrTarget) => {
    const { state, merged, draft, headSha, mergeableState, mergeSha } = await port.getPr(input.repo, input.pr);
    return { state, merged, draft, headSha, mergeableState, mergeSha };
  });
}
