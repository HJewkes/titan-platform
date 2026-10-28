import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step } from "../workflows/land.js";
import type { ShepherdStore } from "./store.js";
import { PlanApprovalSchema, type PlanApproval } from "./plan-approval.js";
import { EffectivePolicySchema, stricterPolicy, type EffectivePolicy } from "./policy.js";

/** A step recorded before approvals existed, or one whose approvals no longer parse, reads as none, so the guard gates. */
const RegistrationPolicyResult = z.looseObject({
  policy: EffectivePolicySchema.nullable(),
  holdReason: z.string().nullish(),
  approved: z.array(PlanApprovalSchema).optional().catch(undefined),
});

interface PolicyRun {
  ctx: WorkflowContext;
  policy: EffectivePolicy;
  policyReads: number;
}

/** What the `sh-policy` step answers: the registration's policy, the reason the run is held for while it is, and the plan approvals the run claimed for its task. */
export function registrationPolicy(store: ShepherdStore, runId: string): { policy: EffectivePolicy | null; holdReason: string | null; approved?: PlanApproval[] } {
  const registration = store.byRun(runId);
  const approved = registration ? store.planApprovals().forRun(runId, registration.task, registration.repo) : [];
  return { policy: registration?.policy ?? null, holdReason: registration?.held ? registration.holdReason : null, ...(approved.length > 0 && { approved }) };
}

/**
 * Read before every merge decision, because the registration may land after the run starts, and an owner's plan approval
 * at any time: each read replaces the approvals the run held, and no registration holds none. Answers the reason the run
 * is held for, if it is.
 */
export async function narrowToRegistration(run: PolicyRun): Promise<string | null | undefined> {
  const { policy, holdReason, approved } = await step(run.ctx, `sh-policy:${run.policyReads++}`, { runId: run.ctx.runId }, RegistrationPolicyResult);
  if (policy) run.policy = { ...stricterPolicy(policy, run.policy), ...(approved && { approved }) };
  else delete run.policy.approved;
  return holdReason;
}
