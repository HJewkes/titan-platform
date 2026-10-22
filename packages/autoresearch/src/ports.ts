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
/** One row per L0 check, in the order they ran; `diff` is measured and replaces the implementer's own count on the outcome. */
export const StaticCheckSchema = L0RecordSchema.extend({ diff: DiffSizeSchema.optional() });
/** `load5` is absent when the host has no load gate. */
export const LoadWaitSchema = z.object({ waitedMs: z.number().nonnegative(), load5: z.number().nonnegative().optional() });
/** Empty when the host keeps no round archive. */
export const ArchivedSchema = z.object({ path: z.string(), sha256: z.string() }).partial();
export const HeadSchema = z.object({ head: z.string() });
export const ReleasedSchema = z.object({ released: z.string() });

export interface RatchetRequest {
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
  pin: string;
}

export type Fork = "exploit" | "explore";
export type PlanMode = "spawn" | "resume";

export interface ImplementRequest {
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

export interface MicroRequest {
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
}

/** Everything the loop touches outside its own run, so tests inject fakes and no test calls a model. */
export interface ArPorts {
  /** Reads `target.json` and `bounds.json` at the pin and points the ratchet ref at the run's starting head. */
  pin(input: { runId: string; pin: string }, signal: AbortSignal): Promise<Pinned>;
  /** The central planner's queue ops for one round; the workflow checks them against the schema and quotas. */
  /** Round 1 spawns the planner (`mode: "spawn"`); later rounds resume it. */
  plan(input: { runId: string; round: number; digest: Digest; violations: string[]; mode: PlanMode }, signal: AbortSignal): Promise<unknown>;
  allocTree(input: { runId: string; ideaId: string; base: string; lane: number }, signal: AbortSignal): Promise<z.infer<typeof TreeSchema>>;
  implement(input: ImplementRequest, signal: AbortSignal): Promise<z.input<typeof ImplementedSchema>>;
  /** L0: bounds post-check, unit suite and test proof; never a model call. */
  staticCheck(input: { idea: Idea; tree: string; base: string; head: string }, signal: AbortSignal): Promise<z.input<typeof StaticCheckSchema>>;
  micro(input: MicroRequest, signal: AbortSignal): Promise<ArMicro>;
  /** `key` is unique per run, scope and repeat, since a target may use it as a cache directory. */
  evalCase(input: { tree: string; case: string; key: string; rung: string }, signal: AbortSignal): Promise<ArResult>;
  ratchet(input: RatchetRequest, signal: AbortSignal): Promise<{ head: string }>;
  /** Parks the tree: checkout removed, branch kept. */
  releaseTree(input: { tree: string }, signal: AbortSignal): Promise<void>;
  /** Waits for machine load to fall before a stage starts; a host with no gate omits it and the step answers at once. */
  loadWait?(input: { stage: string }, signal: AbortSignal): Promise<z.input<typeof LoadWaitSchema>>;
  /** Writes the round's record and artifacts somewhere durable; a host with no archive omits it. */
  archive?(input: { runId: string; round: number; record: RoundRecord }, signal: AbortSignal): Promise<z.input<typeof ArchivedSchema>>;
  now(): number;
}
