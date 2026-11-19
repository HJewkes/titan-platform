import { BY_REC_MODES, BY_REC_POLICY_SCHEMA, byRecPolicySchema, type ByRecPolicy } from "@titan-design/owner-queue";
import { z } from "zod";

/**
 * `shepherd.autoByRec` (TP-6772): the approve-merge by-rec sweep. Absent means `shadow` at 24 h, so the sweep only logs
 * until the owner sets `live`; `off` stops it at the next tick. A leaf, so config imports no gate code.
 */
export const AutoByRecConfigSchema = z.strictObject({
  mode: z.enum(BY_REC_MODES).optional(),
  afterHours: z.number().int().min(1).max(720).optional(),
});

export type AutoByRecConfig = z.infer<typeof AutoByRecConfigSchema>;

/** The shared policy the config stands for; Shepherd's config adds no exclusions, so the floor in code is the only list. */
export function byRecPolicyOf(config: AutoByRecConfig | undefined): ByRecPolicy {
  return byRecPolicySchema.parse({ schema: BY_REC_POLICY_SCHEMA, ...config });
}
