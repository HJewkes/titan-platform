import { createHash } from "node:crypto";
import { canonicalArgs } from "@titan-design/rpc-client";
import { z } from "zod";

const IdeaSourceSchema = z.enum(["planner", "owner", "requeue", "followup"]);

/** What the planner proposes; the workflow derives `id`, `lineage` and `cell` from it. */
const ProposalSchema = z.object({
  hypothesis: z.string(),
  mechanism: z.string(),
  class: z.string(),
  direction: z.string(),
  targets: z.array(z.string()),
  params: z.record(z.string(), z.number()).optional(),
  expectedEffect: z.object({ metric: z.string(), direction: z.enum(["up", "down"]), microSignal: z.string() }),
  testPlan: z.string(),
  bold: z.boolean(),
  differsFrom: z.string().optional(),
  priority: z.number().default(0),
  source: IdeaSourceSchema.default("planner"),
  parent: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export const IdeaSchema = ProposalSchema.extend({
  id: z.string(),
  lineage: z.string(),
  cell: z.string(),
  round: z.number().int(),
});
export type Idea = z.infer<typeof IdeaSchema>;

export const QueueOpsSchema = z.object({
  add: z.array(ProposalSchema).default([]),
  drop: z.array(z.object({ id: z.string(), reason: z.string().optional() })).default([]),
  reprioritize: z.array(z.object({ id: z.string(), priority: z.number() })).default([]),
  analysis: z.array(z.string()).default([]),
  exempt: z.object({ bold: z.string().optional(), followup: z.string().optional() }).default({}),
});
export type QueueOps = z.infer<typeof QueueOpsSchema>;

/** One evaluator run, as the frozen `score.py` (or the S1 fixture's `fake_eval.sh`) prints it. */
export const ArResultSchema = z.object({
  schema: z.literal("ar-result/v1"),
  seed: z.string(),
  repeat: z.string(),
  all_gate: z.boolean(),
  hidden_regressions: z.number().int().nonnegative(),
  cc_total_delta_pct: z.number(),
  single_caller_delta: z.number(),
  accepted_tasks: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
});
export type ArResult = z.infer<typeof ArResultSchema>;

export const ArMicroSchema = z.object({
  schema: z.literal("ar-micro/v1"),
  rung: z.string(),
  predicted_direction_met: z.boolean(),
  usd: z.number().nonnegative(),
});
export type ArMicro = z.infer<typeof ArMicroSchema>;

/** How one idea's ladder ended; every stop is recorded, never thrown, so siblings keep running. */
export const OutcomeSchema = z.object({
  ideaId: z.string(),
  lineage: z.string(),
  cell: z.string(),
  verdict: z.enum(["kept", "rejected", "stopped"]),
  reason: z.string(),
  rungReached: z.enum(["none", "L0", "L1", "L2", "L3"]),
  head: z.string().optional(),
  branch: z.string().optional(),
  delta: z.number().optional(),
  sigma: z.number().optional(),
  runs: z.array(ArResultSchema).default([]),
  lesson: z.string().optional(),
});
export type Outcome = z.infer<typeof OutcomeSchema>;

export function ideaId(proposal: Pick<Proposal, "class" | "targets" | "params" | "mechanism">): string {
  const mechanismNorm = proposal.mechanism.trim().toLowerCase().replace(/\s+/g, " ");
  const key = canonicalArgs({ class: proposal.class, targets: [...proposal.targets].sort(), params: proposal.params ?? {}, mechanismNorm });
  return `i-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

const NoiseSettingsSchema = z.object({
  bandSigmas: z.number().positive().default(2),
  lockAfterPairs: z.number().int().positive().default(5),
  minPairs: z.number().int().positive().default(3),
  defaultBandPp: z.number().nonnegative().default(1.5),
});

const PhaseSchema = z.object({
  id: z.string(),
  train: z.array(z.string()).min(1),
  baselineRuns: z.number().int().min(2).multipleOf(2).default(6),
  stop: z.object({ ideasEvaluated: z.number().int().positive(), roundsWithoutGain: z.number().int().positive() }),
});

/** The S1 subset of `ar-target/v1` (plan 2.1): what the recipe reads; the rung commands belong to the ports. */
export const TargetSchema = z.object({
  schema: z.literal("ar-target/v1"),
  ratchetPrefix: z.string(),
  metric: z.object({
    direction: z.enum(["min", "max"]),
    guards: z.object({ single_caller_delta: z.number() }),
    noise: NoiseSettingsSchema,
  }),
  /** L1 rung name per change class: replay or one cluster. */
  microRung: z.record(z.string(), z.string()),
  phases: z.array(PhaseSchema).min(1),
});
export type Target = z.infer<typeof TargetSchema>;
