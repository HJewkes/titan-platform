import type { WorkflowContext } from "@titan-design/workflow";
import { readdressEscalation, type ReaddressRun } from "./dead-end.js";
import { LeaveLand } from "./leave-land.js";
import { clearSuperseded, supersedingGates, type SupersededRun } from "./stale-gates.js";

type SupersedingRun = SupersededRun & ReaddressRun & { trail: { ownerAsked: Set<string> } };

/**
 * Land's head gates as a shepherd-pr run asks them: a superseded gate clears or carries the run's state and leaves land, an
 * owner answer to approve-merge drops the carried escalation, and a readdressed route gate asks the seat (TP-4759).
 */
export function shepherdSuperseding(run: SupersedingRun): WorkflowContext["assisted"] {
  const supersede = (rereview: string | undefined, gated: string | undefined, stepId: string): LeaveLand => (
    clearSuperseded(run, rereview, gated, stepId), rereview && run.trail.ownerAsked.add(rereview), new LeaveLand()
  );
  return supersedingGates(run.ctx, supersede, () => (run.carried = undefined), (gated, reask) => readdressEscalation(run, gated, reask));
}
