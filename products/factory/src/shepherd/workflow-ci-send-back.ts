import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { LandOutcome } from "../workflows/land.js";
import { sentBackGate, type GateRun } from "./gates.js";
import type { Verdict } from "./phases.js";
import { WorkflowCiReadSchema } from "./workflow-ci-proof.js";

const SENT_BACK_STEP = "sh-sent-back";

/** A record that went on from this NO_REPRO to any step but the gate woke a fixer, as before TP-4109, and replays that way. */
function recordedWake(ctx: WorkflowContext): boolean {
  const next = ctx.historyNext();
  return next !== undefined && !stepIdMatches(SENT_BACK_STEP, next);
}

/**
 * A workflow-only head's CI proof needs a required check red at the merge base, which no push to the PR can make, so a fixer
 * woken for it has nothing to push and the round ends at the owner's gate all the same (TP-4109, tp#2325).
 */
export function noFixerAnswers(ctx: WorkflowContext, verdict: Verdict): boolean {
  if (verdict.kind !== "NO_REPRO") return false;
  const read = WorkflowCiReadSchema.safeParse(verdict.result);
  return read.success && !read.data.proved && !recordedWake(ctx);
}

/** The owner's waivable send-back for that NO_REPRO, asked at once; undefined lands the next round. */
export function workflowCiGate(run: GateRun, headSha: string): Promise<LandOutcome | undefined> {
  const where = `PR #${run.target.pr} in ${run.target.repo} at head ${headSha}`;
  const why = "the PR changes only workflows, whose CI proof needs a required check red at the merge base, so no fixer was woken";
  const prompt = `fix-proof did not reproduce (NO_REPRO) at ${where}: ${why}. Waive the fix-proof, await a new head or abandon?`;
  return sentBackGate(run, headSha, prompt, "a human abandoned the PR after a workflow-only NO_REPRO", prompt, true);
}
