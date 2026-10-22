import { z } from "zod";
import { BoundsSchema } from "./bounds.js";
import type { Digest } from "./digest.js";
import { DiffSizeSchema, TargetSchema, type ArMicro, type ArResult, type Idea } from "./schemas.js";

export const PinnedSchema = z.object({
  pin: z.string(),
  ratchetRef: z.string(),
  ratchetHead: z.string(),
  /** Where baseline evals and ratchet merges run; only `ar-ratchet` moves its head. */
  integrationTree: z.string(),
  target: TargetSchema,
  bounds: BoundsSchema,
});
export type Pinned = z.infer<typeof PinnedSchema>;

export const TreeSchema = z.object({ tree: z.string(), branch: z.string() });
export const ImplementedSchema = z.object({ head: z.string(), usd: z.number().nonnegative(), lesson: z.string().optional(), diff: DiffSizeSchema.optional() });
export const StaticCheckSchema = z.object({ ok: z.boolean(), code: z.string().optional() });
export const HeadSchema = z.object({ head: z.string() });
export const ReleasedSchema = z.object({ released: z.string() });

export interface RatchetRequest {
  tree: string;
  ratchetRef: string;
  ratchetPrefix: string;
  from: string;
  to: string;
}

/** Everything the loop touches outside its own run, so tests inject fakes and no test calls a model. */
export interface ArPorts {
  /** Reads `target.json` and `bounds.json` at the pin and points the ratchet ref at the run's starting head. */
  pin(input: { runId: string; pin: string }, signal: AbortSignal): Promise<Pinned>;
  /** The central planner's queue ops for one round; the workflow checks them against the schema and quotas. */
  plan(input: { runId: string; round: number; digest: Digest; violations: string[] }, signal: AbortSignal): Promise<unknown>;
  allocTree(input: { runId: string; ideaId: string; base: string }, signal: AbortSignal): Promise<z.infer<typeof TreeSchema>>;
  implement(input: { idea: Idea; tree: string; base: string; brief: string }, signal: AbortSignal): Promise<z.infer<typeof ImplementedSchema>>;
  /** L0: bounds post-check, unit suite and test proof; never a model call. */
  staticCheck(input: { idea: Idea; tree: string; base: string; head: string }, signal: AbortSignal): Promise<z.infer<typeof StaticCheckSchema>>;
  micro(input: { idea: Idea; tree: string; rung: string }, signal: AbortSignal): Promise<ArMicro>;
  evalCase(input: { tree: string; case: string; key: string }, signal: AbortSignal): Promise<ArResult>;
  ratchet(input: RatchetRequest, signal: AbortSignal): Promise<{ head: string }>;
  /** Parks the tree: checkout removed, branch kept. */
  releaseTree(input: { tree: string }, signal: AbortSignal): Promise<void>;
  now(): number;
}
