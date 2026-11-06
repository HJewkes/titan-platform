import type { WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { GateDecision } from "../gate-policy.js";
import { MergePolicyResult } from "../workflows/land-steps.js";
import { isDeploySkewGate, settleKind } from "./freeze-wait.js";
import { inStepOrder, lastCiHead, payloadOf, stepName } from "./stats.js";

const SETTLE_STEP = "merge-settle";

/** The run's newest recorded merge decision; one that does not parse reads as none. */
function lastDecision(run: WorkflowRun): (GateDecision & { headSha: string }) | undefined {
  const last = inStepOrder(run).filter(({ key }) => stepName(key) === "merge-policy").at(-1);
  const parsed = last && MergePolicyResult.safeParse(payloadOf(last.result));
  return parsed?.success ? parsed.data : undefined;
}

/** Sitting in merge-settle and nothing else, so no write of the run is in flight. */
function onlySettling(run: WorkflowRun): boolean {
  if (run.status !== "running" || run.currentStep === null || !stepIdMatches(SETTLE_STEP, run.currentStep)) return false;
  return Object.keys(run.activeSteps).every((key) => stepIdMatches(SETTLE_STEP, key));
}

/**
 * TP-4778: the gate a run waits on at its head with no bound (freeze-wait.ts `thaw`), read from its recorded decision at the
 * head of its newest CI read. Only a freeze or a deploy ends that wait, so the run is not about to merge.
 */
export function thawWait(run: WorkflowRun): GateDecision | undefined {
  if (!onlySettling(run)) return undefined;
  const decision = lastDecision(run);
  if (decision?.outcome !== "gate" || decision.headSha !== lastCiHead(run)) return undefined;
  return settleKind(decision) === "thaw" ? decision : undefined;
}

/** Waiting at its head for the deploy that would let its attest read go on, so a deploy held for it would never come. */
export function inDeploySkewWait(run: WorkflowRun): boolean {
  const decision = thawWait(run);
  return decision !== undefined && isDeploySkewGate(decision);
}
