import { z } from "zod";

/** The parent run's stages in order; `--from` names one of them. */
export const STAGES = ["gather", "audition", "script", "rewrite", "eval", "resolve", "tts", "render", "qa", "sheets", "export"] as const;
export type StageName = (typeof STAGES)[number];

/** Stages that run today's template commands through the host's bridge file until their TypeScript ports land. */
export const BRIDGE_STAGES = ["render", "qa", "sheets"] as const;
export type BridgeStage = (typeof BRIDGE_STAGES)[number];
export const isBridgeStage = (stage: StageName): stage is BridgeStage => (BRIDGE_STAGES as readonly string[]).includes(stage);

/** Every stage but `export` runs as its own `explainer.<stage>` child workflow behind the stage cache; export only links files. */
export const CACHED_STAGES = ["gather", "audition", "script", "rewrite", "eval", "resolve", "tts", "render", "qa", "sheets"] as const;
export type CachedStage = (typeof CACHED_STAGES)[number];
export const isCachedStage = (stage: StageName): stage is CachedStage => (CACHED_STAGES as readonly string[]).includes(stage);

/** The artifacts a run starts from, before any stage. */
export const RUN_INPUTS = ["spine", "facts"] as const;

/**
 * Stages a run takes only when it starts at them: a run from `script` has no gather or audition, so a base run without
 * one still serves `--from` a later stage.
 */
export const OPTIONAL_STAGES: readonly StageName[] = ["gather", "audition"];

/** Model spend of one stage, folded over its calls; tokens a runner left out count as zero here and nowhere else. */
export const StageUsageSchema = z.object({
  usd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  /** Prompt-cache writes; absent where the runner reported none, as in every record made before they were kept. */
  cacheWriteTokens: z.number().optional(),
  calls: z.number(),
  costUnknown: z.literal(true).optional(),
});
export type StageUsage = z.infer<typeof StageUsageSchema>;

export const NO_USAGE: StageUsage = { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };

/** A check's verdict. `gate: true` means a failed check failed its stage; any other check is reported only. */
export const CheckSchema = z.object({ name: z.string(), pass: z.boolean(), gate: z.boolean().optional(), detail: z.string().optional() });
export type Check = z.infer<typeof CheckSchema>;

/**
 * What a stage's code step stores. Timing and usage live here, not on the workflow's step result, so the report
 * can read wall time and code-step spend before the workflow package records them itself.
 */
export const StageRecordSchema = z.object({
  stage: z.enum(STAGES),
  bridged: z.boolean(),
  /** The run whose outputs this stage reused instead of running; it then cost nothing here. */
  reusedFrom: z.string().optional(),
  /** The stage key, and the child run that made (or, on a hit, first made) the outputs. */
  key: z.string().optional(),
  childRunId: z.string().optional(),
  /** The outputs came from the stage cache: the child run with this key had already finished. */
  cached: z.boolean().optional(),
  startedAt: z.string(),
  endedAt: z.string(),
  wallMs: z.number(),
  usage: StageUsageSchema,
  retries: z.number(),
  outputs: z.record(z.string(), z.string()),
  checks: z.array(CheckSchema),
  notes: z.array(z.string()),
});
export type StageRecord = z.infer<typeof StageRecordSchema>;

/** What a stage body returns; the stage route adds the timing and the stage name. */
export interface StageOutcome {
  outputs: Record<string, string>;
  usage?: StageUsage;
  retries?: number;
  checks?: Check[];
  notes?: string[];
}

/** Where the run stopped at its spend cap, so `resume` knows the stage to start from. */
export const StopSchema = z.object({ stage: z.enum(STAGES), spentUsd: z.number(), capUsd: z.number() });
export type Stop = z.infer<typeof StopSchema>;

export const addUsage = (a: StageUsage, b: StageUsage): StageUsage => ({
  usd: a.usd + b.usd,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  ...(a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) } : {}),
  calls: a.calls + b.calls,
  ...(a.costUnknown || b.costUnknown ? { costUnknown: true as const } : {}),
});
