import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { portReads, type PrReads } from "../workflows/pr-snapshot.js";
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

const ObservedResult = z.looseObject({ state: z.string(), merged: z.boolean(), draft: z.boolean(), headSha: z.string(), mergeableState: z.string(), mergeSha: z.string().nullable(), behind: z.boolean().optional() });

/** Recorded as a step, so a replay routes on what the first run saw. */
export async function observePr(ctx: WorkflowContext, target: PrTarget, reviewedHead: string): Promise<ObservedPr> {
  const pr = await step(ctx, `${OBSERVE_STEP}:${reviewedHead}`, target, ObservedResult);
  const runState: RunState = pr.merged ? "merged-elsewhere" : pr.state === "closed" ? "closed-elsewhere" : "open";
  return { runState, mergeableState: settledState(pr), headSha: pr.headSha, mergeSha: pr.mergeSha };
}

/** GitHub has not settled `mergeable_state`, but the compare already says behind: that is behind, not a head to read again. */
function settledState(pr: z.infer<typeof ObservedResult>): MergeableState {
  const state = mergeableState(pr.mergeableState, pr.draft);
  return state === "unknown" && pr.behind === true ? "behind" : state;
}

/** `reads` is the repo's snapshot when one is wired: routing on a read up to one tick old only delays a write, which re-reads its PR. */
export function observeRoute(port: GitHubPort, now: () => number, reads: PrReads = portReads(port)): StepRoute {
  return codeRoute(OBSERVE_STEP, now, async (input: PrTarget) => {
    const { state, merged, draft, headSha, mergeableState, mergeSha, behind } = await reads.getPr(input.repo, input.pr);
    return { state, merged, draft, headSha, mergeableState, mergeSha, behind };
  });
}
