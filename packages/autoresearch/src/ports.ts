import { z } from "zod";
import { BoundsSchema } from "./bounds.js";
import type { Digest, EvidenceRow } from "./digest.js";
import type { Registries } from "./registry.js";
import { DiffSizeSchema, ImplementerSchema, L0RecordSchema, TargetSchema, type ArMicro, type ArResult, type Idea, type Outcome, type QueueOps } from "./schemas.js";

export const PinnedSchema = z.object({
  pin: z.string(),
  ratchetRef: z.string(),
  ratchetHead: z.string(),
  /** Where baseline evals and ratchet merges run; only `ar-ratchet` moves its head. */
  integrationTree: z.string(),
  target: TargetSchema,
  bounds: BoundsSchema,
  /** The evaluator checkout and the hash of its frozen files, which a real host re-checks around every eval. */
  evaluatorTree: z.string().optional(),
  frozenHash: z.string().optional(),
  targetSha: z.string().optional(),
  boundsSha: z.string().optional(),
});
export type Pinned = z.infer<typeof PinnedSchema>;

export const TreeSchema = z.object({ tree: z.string(), branch: z.string() });
const tokens = z.number().int().nonnegative().optional();
/** One dispatch's spend: agent dollars plus the cache reads and writes that explain them. */
const DispatchUsageSchema = z.object({ usd: z.number().nonnegative(), cacheReadTokens: tokens, cacheWrite5mTokens: tokens, cacheWrite1hTokens: tokens, retries: z.number().int().nonnegative() });
export const ImplementedSchema = ImplementerSchema.extend({
  head: z.string(),
  usd: z.number().nonnegative(),
  lesson: z.string().optional(),
  diff: DiffSizeSchema.optional(),
  usage: DispatchUsageSchema.optional(),
});
/** The planner that answered a round (G2) and what its turn cost (G4); `ops` is checked against the queue schema later. */
export const PlannerSchema = z.object({ agent: z.string(), sessionId: z.string().optional(), mode: z.enum(["spawn", "resume"]).optional(), usage: DispatchUsageSchema.optional() });
export const PlannedSchema = PlannerSchema.partial().extend({ ops: z.unknown() });
export type Planner = z.infer<typeof PlannerSchema>;
/** One row per L0 check, in the order they ran; `diff` is measured and replaces the implementer's own count on the outcome. */
export const StaticCheckSchema = L0RecordSchema.extend({ diff: DiffSizeSchema.optional() });
/** `load5` is absent when the host has no load gate. */
export const LoadWaitSchema = z.object({ waitedMs: z.number().nonnegative(), load5: z.number().nonnegative().optional() });
/** Empty when the host keeps no round archive. */
export const ArchivedSchema = z.object({ path: z.string(), sha256: z.string() }).partial();
export const HeadSchema = z.object({ head: z.string() });
export const ReleasedSchema = z.object({ released: z.string() });

/**
 * Which run's pin an evaluator step runs under. Recorded by the pin step, so a host that restarted after it rebuilds
 * its evaluator from these and refuses when the frozen files no longer hash to `frozenHash`.
 */
export interface RunPin {
  runId: string;
  pin: string;
  frozenHash?: string;
}

export interface RatchetRequest extends RunPin {
  tree: string;
  ratchetRef: string;
  ratchetPrefix: string;
  from: string;
  to: string;
  round: number;
  ideaId: string;
  kind: "ff";
  keepRung: string;
  delta: number;
  sigma: number;
  /** sha256 of each kept run's canonical JSON, so the record names the evidence the move rests on. */
  runDigests: string[];
}

export type Fork = "exploit" | "explore";
export type PlanMode = "spawn" | "resume";

export interface ImplementRequest {
  /** A host names its implementers from the run, not from the tree it was handed. */
  runId: string;
  idea: Idea;
  tree: string;
  base: string;
  brief: string;
  round: number;
  /** The lane slot, 1 to `lanes`. */
  lane: number;
  fork: Fork;
  /** An exploit lane resumes this agent, the last winner's implementer. */
  resumeFrom?: string;
}

export interface MicroRequest extends RunPin {
  idea: Idea;
  tree: string;
  rung: string;
  case: string;
  /** The best's first run's artifact dir, which a replay rung reads as the before side. */
  baselineDir: string;
  microSignal: string;
  microArgs: Record<string, string>;
  key: string;
}

/** The G11 round record: what the round decided and what it read. */
export interface RoundRecord {
  outcomes: Outcome[];
  digest: Digest;
  ops: QueueOps;
  draws: { id: string; draw: number }[];
  registries: Registries;
  evidence: EvidenceRow[];
  /** Absent when the host's planner reports no agent. */
  planner?: Planner;
}

/** Everything the loop touches outside its own run, so tests inject fakes and no test calls a model. */
export interface ArPorts {
  /** Reads `target.json` and `bounds.json` at the pin and points the ratchet ref at the run's starting head. */
  pin(input: { runId: string; pin: string }, signal: AbortSignal): Promise<Pinned>;
  /**
   * The central planner's queue ops for one round, which the workflow checks against the schema and quotas, and the
   * agent that wrote them. Round 1 spawns the planner; later rounds resume it.
   */
  plan(input: { runId: string; round: number; digest: Digest; violations: string[]; mode: PlanMode }, signal: AbortSignal): Promise<z.input<typeof PlannedSchema>>;
  allocTree(input: { runId: string; ideaId: string; base: string; lane: number }, signal: AbortSignal): Promise<z.infer<typeof TreeSchema>>;
  implement(input: ImplementRequest, signal: AbortSignal): Promise<z.input<typeof ImplementedSchema>>;
  /** L0: bounds post-check, unit suite and test proof; never a model call. */
  staticCheck(input: RunPin & { idea: Idea; tree: string; base: string; head: string }, signal: AbortSignal): Promise<z.input<typeof StaticCheckSchema>>;
  micro(input: MicroRequest, signal: AbortSignal): Promise<ArMicro>;
  /** `key` is unique per run, scope and repeat, since a target may use it as a cache directory. */
  evalCase(input: RunPin & { tree: string; case: string; key: string; rung: string }, signal: AbortSignal): Promise<ArResult>;
  ratchet(input: RatchetRequest, signal: AbortSignal): Promise<{ head: string }>;
  /** Parks the tree: checkout removed, branch kept. */
  releaseTree(input: { tree: string }, signal: AbortSignal): Promise<void>;
  /**
   * Waits for machine load to fall before a stage starts; a host with no gate omits it and the step answers at once.
   * `firstStartedAt` is when the step first started, kept across a restart, so a deadline does not reset.
   */
  loadWait?(input: { stage: string; firstStartedAt?: string }, signal: AbortSignal): Promise<z.input<typeof LoadWaitSchema>>;
  /** Writes the round's record and artifacts somewhere durable; a host with no archive omits it. */
  archive?(input: { runId: string; round: number; record: RoundRecord }, signal: AbortSignal): Promise<z.input<typeof ArchivedSchema>>;
  now(): number;
}
