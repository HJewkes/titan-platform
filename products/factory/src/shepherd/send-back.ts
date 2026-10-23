import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { LandOutcome } from "../workflows/land.js";
import { withEarlier, type FixFirstTrail } from "./fix-first-trail.js";
import { unhandledSendBack } from "./gate-route.js";
import { sentBackGate, type GateRun } from "./gates.js";
import { LeaveLand } from "./leave-land.js";
import type { Verdict, WakeRequest } from "./phases.js";
import { WorkflowCiReadSchema } from "./workflow-ci-proof.js";

const SENT_BACK_STEP = "sh-sent-back";

/** Where each verdict sends the PR back to. */
const SEND_BACK: Partial<Record<Verdict["kind"], WakeRequest["kind"]>> = { FIX_FIRST: "review", NO_REPRO: "fix-proof" };

/** The run's fixer wake; true means a woken agent already awaited its new head. */
type Woken = (kind: WakeRequest["kind"], payload: unknown) => Promise<boolean>;

/** Never returns: a woken agent starts the next round, and an unhandled wake asks a human. */
export async function sendBack(run: GateRun & FixFirstTrail, headSha: string, verdict: Verdict, woken: Woken): Promise<never> {
  const wake = SEND_BACK[verdict.kind];
  if (!wake) throw new Error(`shepherd-pr: a ${verdict.kind} verdict has no send-back`);
  if (noFixerAnswers(run.ctx, verdict)) throw new LeaveLand(await workflowCiGate(run, headSha));
  if (await woken(wake, wake === "review" ? withEarlier(verdict, run.fixFirstTrail, headSha) : verdict)) throw new LeaveLand();
  throw new LeaveLand(await unhandledSendBack(run, verdict.kind, headSha));
}

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
function workflowCiGate(run: GateRun, headSha: string): Promise<LandOutcome | undefined> {
  const where = `PR #${run.target.pr} in ${run.target.repo} at head ${headSha}`;
  const why = "the PR changes only workflows, whose CI proof needs a required check red at the merge base, so no fixer was woken";
  const prompt = `fix-proof did not reproduce (NO_REPRO) at ${where}: ${why}. Waive the fix-proof, await a new head or abandon?`;
  return sentBackGate(run, headSha, prompt, "a human abandoned the PR after a workflow-only NO_REPRO", prompt, true);
}
