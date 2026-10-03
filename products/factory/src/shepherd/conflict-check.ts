import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { codeRoute, step } from "../workflows/land.js";
import type { ShepherdDeps } from "./phases.js";
import { gateHead } from "./stale-gates.js";

export const CONFLICT_CHECK_STEP = "sh-conflict-check";
export const CONFLICT_CHECK_STEPS: readonly StepDeclaration[] = [{ id: CONFLICT_CHECK_STEP, kind: "dispatch" }];

/** How long a check waits for GitHub to settle mergeability before it reads the state as no conflict. */
export const CONFLICT_SETTLE_MS = 2 * 60_000;

export interface ConflictCheckInput {
  repo: RepoSlug;
  pr: number;
  headSha: string;
}

const ConflictCheckResult = z.looseObject({ headSha: z.string(), mergeableState: z.string() });

/** True when GitHub reports the PR, still at `headSha`, conflicting with its base as the base stands now. */
export async function conflictsAt(ctx: WorkflowContext, stepId: string, input: ConflictCheckInput): Promise<boolean> {
  const read = await step(ctx, stepId, input, ConflictCheckResult);
  return read.headSha === input.headSha && read.mergeableState === "dirty";
}

/** GitHub recomputes mergeability lazily once the base moves, so the read waits out `unknown` for a bounded time. */
async function readMergeable(port: GitHubPort, input: ConflictCheckInput, timing: DeadlineTiming & { pollMs: number }, signal: AbortSignal): Promise<object> {
  const clock = deadline(timing);
  for (;;) {
    const pr = await port.getPr(input.repo, input.pr);
    if (pr.mergeableState !== "unknown" || clock.expired()) return { headSha: pr.headSha, mergeableState: pr.mergeableState };
    await clock.sleep(timing.pollMs, signal);
  }
}

export function conflictCheckRoute(deps: ShepherdDeps, settleMs = CONFLICT_SETTLE_MS): StepRoute {
  const timing = { now: deps.now, sleep: deps.sleep, pollMs: Math.min(deps.pollMs ?? 5_000, 5_000), timeoutMs: settleMs };
  return codeRoute(CONFLICT_CHECK_STEP, deps.now, (input: ConflictCheckInput, signal) => readMergeable(deps.port, input, timing, signal));
}

/** Checks the head an approve-merge gate names before the gate opens and again once it resolves to merge; a conflict throws `leave`. */
export function conflictCheckedGates(assisted: WorkflowContext["assisted"], conflicts: (headSha: string) => Promise<boolean>, leave: (headSha: string) => Error): WorkflowContext["assisted"] {
  return async (stepId, prompt, options) => {
    const headSha = stepIdMatches("approve-merge", stepId) ? gateHead(prompt) : undefined;
    if (!headSha) return assisted(stepId, prompt, options);
    if (await conflicts(headSha)) throw leave(headSha);
    const answer = await assisted(stepId, prompt, options);
    if (answer.data?.decision === "merge" && (await conflicts(headSha))) throw leave(headSha);
    return answer;
  };
}
