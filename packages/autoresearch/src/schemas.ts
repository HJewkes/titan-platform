import { createHash } from "node:crypto";
import { canonicalArgs } from "@titan-design/rpc-client";
import { z } from "zod";

const IdeaSourceSchema = z.enum(["planner", "owner", "requeue", "followup"]);

/** What the planner proposes; the workflow derives `id`, `lineage` and `cell` from it. */
export const ProposalSchema = z.object({
  hypothesis: z.string(),
  mechanism: z.string(),
  class: z.string(),
  direction: z.string(),
  targets: z.array(z.string()),
  params: z.record(z.string(), z.number()).optional(),
  expectedEffect: z.object({ metric: z.string(), direction: z.enum(["up", "down"]), microSignal: z.string() }),
  /** Extra micro-rung template arguments, such as the `cluster` an L1-cluster rung replays. */
  microArgs: z.record(z.string(), z.string()).default({}),
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

/** One evaluator run, as the target's frozen scorer prints it. Every name is the target's own vocabulary. */
export const ArResultSchema = z.object({
  schema: z.literal("ar-result/v2"),
  case: z.string(),
  repeat: z.string(),
  metrics: z.record(z.string(), z.number()),
  gates: z.record(z.string(), z.boolean()).default({}),
  violations: z.record(z.string(), z.number().int().nonnegative()).default({}),
  usd: z.number().nonnegative(),
  wall_s: z.number().nonnegative(),
  rung: z.string().optional(),
  evaluator_pin: z.string().optional(),
  /** Where the run left its artifacts; a replay micro rung reads the best's as its baseline. */
  artifact_dir: z.string().optional(),
});
export type ArResult = z.infer<typeof ArResultSchema>;

export const ArMicroSchema = z.object({
  schema: z.literal("ar-micro/v1"),
  rung: z.string(),
  predicted_direction_met: z.boolean(),
  usd: z.number().nonnegative(),
  /** The count the rung judged, and its value per name on the best and on the idea. */
  signal: z.string().optional(),
  base: z.record(z.string(), z.number()).optional(),
  idea: z.record(z.string(), z.number()).optional(),
});
export type ArMicro = z.infer<typeof ArMicroSchema>;

const count = z.number().int().nonnegative();
/** `files` and `lines` count the whole diff; the `src` and `test` splits are measured by L0, never self-reported. */
export const DiffSizeSchema = z.object({ files: count, lines: count, srcFiles: count.optional(), srcLines: count.optional(), testLines: count.optional() });
export type DiffSize = z.infer<typeof DiffSizeSchema>;

const nonnegative = z.number().nonnegative();

/** The noise an idea was judged against, fixed at round start; `locked` is the engine's own call, not a pair count. */
export const AgainstSchema = z.object({ case: z.string(), head: z.string(), bandWidth: nonnegative, sigma: nonnegative, pairs: count, locked: z.boolean() });

/** The agent that wrote the idea; `account` names whose spend it was. */
export const ImplementerSchema = z.object({
  agent: z.string(),
  sessionId: z.string().optional(),
  resumedFrom: z.string().optional(),
  mode: z.enum(["spawn", "resume"]),
  account: z.string().optional(),
});

const CheckRowSchema = z.object({ name: z.string(), ok: z.boolean(), code: z.string().optional(), ms: nonnegative.optional() });
export const L0RecordSchema = z.object({ ok: z.boolean(), code: z.string().optional(), checks: z.array(CheckRowSchema).default([]) });

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
  /** Recorded, never capped: the ledger and the planner digest read it. */
  diff: DiffSizeSchema.optional(),
  lesson: z.string().optional(),
  against: AgainstSchema.optional(),
  implementer: ImplementerSchema.optional(),
  /** The lane slot, 1 to `lanes`, the ladder held while it ran. */
  lane: z.number().int().positive().optional(),
  fork: z.enum(["exploit", "explore"]).optional(),
  l0: L0RecordSchema.optional(),
  micro: ArMicroSchema.optional(),
  usage: z.object({ implementUsd: nonnegative, evalUsd: nonnegative, microUsd: nonnegative }).optional(),
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
  /** The band, in primary-metric units, until σ is trusted. */
  defaultBand: z.number().nonnegative().default(1.5),
});

const PhaseSchema = z.object({
  id: z.string(),
  train: z.array(z.string()).min(1),
  baselineRuns: z.number().int().min(2).multipleOf(2).default(6),
  stop: z.object({ ideasEvaluated: z.number().int().positive(), roundsWithoutGain: z.number().int().positive() }),
});

const GuardSchema = z.object({ slack: z.number().nonnegative(), direction: z.enum(["min", "max"]) });

/** The keep rule as data: which metric is judged, which may not get worse, and which counts must stay zero. */
export const MetricSpecSchema = z.object({
  primary: z.object({ name: z.string(), direction: z.enum(["min", "max"]) }),
  /** How far a metric's median may get worse than the best's; a bare number is the slack of a `min` metric. */
  guards: z.record(z.string(), z.union([z.number().nonnegative(), GuardSchema])).default({}),
  /** Violation names of which a single one in any run rejects. */
  zeroTolerance: z.array(z.string()).default([]),
  /** When set, a run passes only with every gate true, and an idea may not pass less often than the best. */
  allGate: z.boolean().default(false),
  /** The metric whose 0 marks a run that changed nothing. */
  noOp: z.string().optional(),
  noise: NoiseSettingsSchema,
});
export type MetricSpec = z.infer<typeof MetricSpecSchema>;

/** One rung's argv template; `renderCommand` fills its `{name}` tokens. */
const RungSchema = z.object({ cmd: z.array(z.string()).min(1), maxUsd: nonnegative.optional(), timeoutMin: z.number().positive().optional() });

/** The subset of `ar-target/v1` the recipe and the ports read. */
export const TargetSchema = z.object({
  schema: z.literal("ar-target/v1"),
  repo: z.string().optional(),
  ratchetPrefix: z.string(),
  metric: MetricSpecSchema,
  /** L1 rung name per change class; a class with none goes from L0 straight to L2. */
  microRung: z.record(z.string(), z.string()).default({}),
  /** Globs no idea may touch and no class may allow: the evaluator and everything it reads. */
  frozen: z.array(z.string()).default([]),
  /** Case alias to the case set it belongs to, the `{caseSet}` argument. */
  caseSets: z.record(z.string(), z.string()).default({}),
  /** The `{runnerRoot}` argument, relative to the evaluator checkout. */
  runnerRoot: z.string().default("."),
  unitTests: z.array(z.string()).default([]),
  testProof: z.array(z.string()).default([]),
  rungs: z.record(z.string(), RungSchema).default({}),
  phases: z.array(PhaseSchema).min(1),
  /** Milestone looks at held-out cases, which the host supplies and the target never names; `maxLooks` caps them per run. */
  validator: z
    .object({ runs: z.number().int().min(1).default(1), maxLooks: z.number().int().min(1).default(2) })
    .default({ runs: 1, maxLooks: 2 }),
});
export type Target = z.infer<typeof TargetSchema>;

/** Fills each `{name}` token of an argv template; a token with no value throws, so a rung never runs with a literal brace. */
export function renderCommand(cmd: readonly string[], vars: Readonly<Record<string, string>>): string[] {
  return cmd.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (vars[name] === undefined) throw new Error(`[template] {${name}}`);
      return vars[name];
    }),
  );
}

/** The micro rung's `<count>:<up|down>` argument: a planner signal that already names its direction is kept as it is. */
export function microSignalArg(idea: Pick<Proposal, "expectedEffect">): string {
  const { microSignal, direction } = idea.expectedEffect;
  return microSignal.includes(":") ? microSignal : `${microSignal}:${direction}`;
}

/** A result schema that also requires every metric the keep rule reads, the gates of an allGate target and each zero-tolerance violation count, so a run missing one fails its eval step. */
export function resultSchemaFor(metric: MetricSpec): z.ZodType<ArResult> {
  const required = [metric.primary.name, ...Object.keys(metric.guards), ...(metric.noOp ? [metric.noOp] : [])];
  return ArResultSchema.superRefine((result, issues) => {
    for (const name of required.filter((key) => result.metrics[key] === undefined)) issues.addIssue({ code: "custom", path: ["metrics", name], message: `missing metric ${name}` });
    const unreported = metric.zeroTolerance.filter((key) => result.violations[key] === undefined);
    for (const name of unreported) issues.addIssue({ code: "custom", path: ["violations", name], message: `missing violation count ${name}` });
    if (metric.allGate && Object.keys(result.gates).length === 0) issues.addIssue({ code: "custom", path: ["gates"], message: "allGate target needs gates" });
  });
}
