import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { step } from "../workflows/land.js";
import { EffectivePolicySchema, stricterPolicy, type EffectivePolicy } from "./policy.js";

const RegistrationPolicyResult = z.looseObject({ policy: EffectivePolicySchema.nullable(), holdReason: z.string().nullish() });

interface PolicyRun {
  ctx: WorkflowContext;
  policy: EffectivePolicy;
  policyReads: number;
}

/** Read before every merge decision, because the registration may land after the run starts. Answers the reason the run is held for, if it is. */
export async function narrowToRegistration(run: PolicyRun): Promise<string | null | undefined> {
  const { policy, holdReason } = await step(run.ctx, `sh-policy:${run.policyReads++}`, { runId: run.ctx.runId }, RegistrationPolicyResult);
  if (policy) run.policy = stricterPolicy(policy, run.policy);
  return holdReason;
}
