import { z } from "zod";
import { BoundsSchema } from "./bounds.js";
import type { Digest, EvidenceRow } from "./digest.js";
import type { Registries } from "./registry.js";
import { AgainstSchema, ArResultSchema, DiffSizeSchema, ImplementerSchema, L0RecordSchema, ProposalSchema, ReevalVerdictSchema, TargetSchema, type ArMicro, type ArResult, type Idea, type Outcome, type QueueOps } from "./schemas.js";

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

/** `ff` moves onto the round's first winner, `merge` onto a later winner merged on top of it, `sync` onto main merged in. */
export const RatchetKindSchema = z.enum(["ff", "merge", "sync"]);

export interface RatchetRequest extends RunPin {
  tree: string;
  ratchetRef: string;
  ratchetPrefix: string;
  from: string;
  to: string;
  round: number;
  /** Absent only for a `sync`, which moves onto main rather than an idea. */
  ideaId?: string;
  kind: z.infer<typeof RatchetKindSchema>;
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

/** Merges a later winner onto the round's new head in the integration tree; never pushes. */
export interface IntegrateRequest {
  runId: string;
  tree: string;
  base: string;
  head: string;
  message: string;
  /** The step's first start, which the merge commit is dated with, so a restart rebuilds the same sha. */
  at?: string;
}

/** `skipped` is the answer of a host with no integrate port: the winner is requeued, never kept on its solo run. */
export const IntegrateResultSchema = z.union([z.object({ merged: z.string() }), z.object({ conflict: z.array(z.string()) }), z.object({ skipped: z.literal("no-integrate") })]);
export type IntegrateResult = z.infer<typeof IntegrateResultSchema>;

/** One later winner's re-evaluation on top of the round's new head `vs`; `from` is the head its solo ladder ran against. */
export const ReevalSchema = z.object({
  ideaId: z.string(),
  from: z.string(),
  vs: z.string(),
  merge: z.string().nullable(),
  conflict: z.array(z.string()).optional(),
  l0: L0RecordSchema.optional(),
  runs: z.array(ArResultSchema),
  delta: z.number().optional(),
  decision: ReevalVerdictSchema.shape.decision,
  reason: z.string(),
});
export type Reeval = z.infer<typeof ReevalSchema>;

export const RatchetMoveSchema = z.object({ from: z.string(), to: z.string(), kind: RatchetKindSchema, ideaId: z.string().optional() });

/** G7 and G16: what a round decided, recorded after its ratchet so a reader never re-derives it. */
export const RoundSummarySchema = z.object({
  round: z.number().int().positive(),
  best: z.object({ head: z.string(), primary: z.number() }),
  against: AgainstSchema,
  keptIds: z.array(z.string()),
  /** Winners requeued for a later round: a merge conflict, or no integrate port. */
  superseded: z.array(z.string()),
  /** The net move, from the first move's `from` to the last move's `to`. */
  ratchet: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** The first planner answer's misses; empty when it met every quota. */
  quotaViolations: z.array(z.string()),
  plannerRetried: z.boolean(),
  /** Absent on rounds recorded before concurrent winners, which read as empty. */
  moves: z.array(RatchetMoveSchema).default([]),
  reevals: z.array(ReevalSchema).default([]),
});
export type RoundSummary = z.infer<typeof RoundSummarySchema>;

export const StopReasonSchema = z.enum(["ideas-evaluated", "rounds-without-gain", "rounds-exhausted"]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const CadenceTriggerSchema = z.enum(["phase-end", "kept", "spend"]);
export type CadenceTrigger = z.infer<typeof CadenceTriggerSchema>;
/** A cut or a sync after the last round is round `end`. */
export const CadenceRoundSchema = z.union([z.number().int().positive(), z.literal("end")]);
export type CadenceRound = z.infer<typeof CadenceRoundSchema>;

const usd = z.number().nonnegative();
/** What a snapshot PR's body is rendered from: aggregates only, so no case name or per-case number reaches the PR. */
export const SnapshotLogSchema = z.object({
  phase: z.string(),
  trigger: CadenceTriggerSchema,
  round: CadenceRoundSchema,
  /** The ratchet head the previous cut tagged, or the run's starting head. */
  from: z.string(),
  to: z.string(),
  kept: z.array(z.object({ ideaId: z.string(), delta: z.number().optional(), sigma: z.number().optional() })),
  /** No cap is enforced: a round may overshoot the cadence's spend, and this shows by how much. */
  spentSince: z.object({ agentUsd: usd, modelUsd: usd }),
});
export type SnapshotLog = z.infer<typeof SnapshotLogSchema>;

/** Cuts snapshot `k` at a ratchet sha: tag, PR branch with one log commit, the PR, and its Shepherd registration. */
export interface SnapshotRequest extends RunPin {
  k: number;
  trigger: CadenceTrigger;
  round: CadenceRound;
  sha: string;
  ratchetRef: string;
  ratchetPrefix: string;
  log: SnapshotLog;
  /** The step's first start, which the log commit is dated with, so a restart rebuilds the same sha. */
  at?: string;
}

export const SnapshotCutSchema = z.object({
  k: z.number().int().positive(),
  tag: z.string(),
  sha: z.string(),
  branch: z.string(),
  pr: z.number().int().positive(),
  url: z.string().optional(),
  shepherdRunId: z.string().optional(),
  logSha: z.string(),
});
/** `failed` is the recorded answer of a port that threw, so a replay reads the same failure instead of cutting again. */
export const SnapshotResultSchema = z.union([SnapshotCutSchema, z.object({ failed: z.string() })]);

/** Reads the open snapshot PR and, once it merged, merges main into the ratchet; `resolved` is an owner's merge to move onto instead. */
export interface SyncRequest extends RunPin {
  round: CadenceRound;
  pr: number;
  branch: string;
  /** The ratchet head the run holds as B. */
  head: string;
  ratchetRef: string;
  ratchetPrefix: string;
  tree: string;
  resolved?: string;
  /** With `resolved`: the frozen paths the held gate showed the owner, the only ones the resolved merge may change. */
  allowedFrozen?: string[];
  at?: string;
}

/**
 * `treeChanged` compares the tree outside the snapshot log dir, since the log commit alone would always change it.
 * `conflict` and `frozen` leave the ratchet where it was.
 */
export const SyncResultSchema = z.object({
  state: z.enum(["open", "merged", "closed"]),
  merged: z.object({ from: z.string(), to: z.string(), main: z.string() }).optional(),
  conflict: z.array(z.string()).optional(),
  frozen: z.array(z.string()).optional(),
  treeChanged: z.boolean().optional(),
});
export type SyncResult = z.infer<typeof SyncResultSchema>;

export const InboxSchema = z.object({ ideas: z.array(ProposalSchema), cursor: z.number().int().nonnegative() });

const nonnegative = z.number().nonnegative();
const tokenCount = z.number().int().nonnegative();
/** G17: one phase's row in the host's registry. Cases appear only as the target's own train aliases. */
export const RegistryRowSchema = z.object({
  phase: z.string(),
  pin: z.string(),
  targetSha: z.string().optional(),
  boundsSha: z.string().optional(),
  trainCases: z.array(z.string()),
  ideasByRung: z.record(z.string(), tokenCount),
  sigma: nonnegative,
  pairs: tokenCount,
  locked: z.boolean(),
  spend: z.object({ agentUsd: nonnegative, modelUsd: nonnegative, cacheReadTokens: tokenCount, cacheWriteTokens: tokenCount }),
  archives: z.array(z.string()),
  stopReason: StopReasonSchema,
  provenance: z.string(),
});
export type RegistryRow = z.infer<typeof RegistryRowSchema>;
export const RegisteredSchema = z.object({ path: z.string().optional() });

/** A validator look returns aggregates only; strict, so a per-case key fails the step instead of reaching a reader. */
export const LookAggregateSchema = z.strictObject({
  look: z.number().int().positive(),
  at: z.string(),
  sha: z.string(),
  aggregate: z.strictObject({ metrics: z.record(z.string(), z.number()), gates: z.record(z.string(), z.number()) }),
  provenance: z.string(),
  usd: nonnegative,
});
export type LookAggregate = z.infer<typeof LookAggregateSchema>;

export interface LookRequest {
  /** The run being looked at, not the look's own run. */
  runId: string;
  pin: string;
  frozenHash?: string;
  look: number;
  head: string;
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
  /**
   * Merges a later winner onto the round's new head in the integration tree, or names the conflicting files after
   * aborting; it never pushes. A host without it has every later winner requeued.
   */
  integrate?(input: IntegrateRequest, signal: AbortSignal): Promise<IntegrateResult>;
  /** Cuts a snapshot PR; every sub-write is idempotent. A host with none never cuts, and its run sets no `snapshot` settings. */
  snapshot?(input: SnapshotRequest, signal: AbortSignal): Promise<z.input<typeof SnapshotCutSchema>>;
  /** Reads the open snapshot PR and syncs main back into the ratchet; never rebases or force-pushes. */
  sync?(input: SyncRequest, signal: AbortSignal): Promise<z.input<typeof SyncResultSchema>>;
  /** Parks the tree: checkout removed, branch kept. */
  releaseTree(input: { tree: string }, signal: AbortSignal): Promise<void>;
  /**
   * Waits for machine load to fall before a stage starts; a host with no gate omits it and the step answers at once.
   * `firstStartedAt` is when the step first started, kept across a restart, so a deadline does not reset.
   */
  loadWait?(input: { stage: string; firstStartedAt?: string }, signal: AbortSignal): Promise<z.input<typeof LoadWaitSchema>>;
  /** Writes the round's record and artifacts somewhere durable; a host with no archive omits it. */
  archive?(input: { runId: string; round: number; record: RoundRecord }, signal: AbortSignal): Promise<z.input<typeof ArchivedSchema>>;
  /** Owner proposals written since `after`, and the cursor past them; a host with no inbox omits it. */
  ownerIdeas?(input: { runId: string; round: number; after: number }, signal: AbortSignal): Promise<z.input<typeof InboxSchema>>;
  /** One milestone look at the head on held-out cases, aggregated; the search never reads it. */
  validate?(input: LookRequest, signal: AbortSignal): Promise<LookAggregate>;
  /** Appends the phase's row to the host's registry; a host with none omits it. */
  registry?(input: { runId: string; row: RegistryRow }, signal: AbortSignal): Promise<z.input<typeof RegisteredSchema>>;
  now(): number;
}
