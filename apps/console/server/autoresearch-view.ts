import { z } from "zod";

/**
 * The autoresearch run page's read model, as titan-factory's `autoresearch.run` replays it from the run store. The console
 * depends on no factory source, so this pins only the fields the page shows; the reader strips the rest.
 */

const WORKFLOW_STATUSES = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"] as const;
const IDEA_SOURCES = ["planner", "owner", "requeue", "followup"] as const;
const RUNGS = ["none", "L0", "L1", "L2", "L3"] as const;
const AR_VERDICTS = ["kept", "rejected", "stopped"] as const;

/** The labels come from the pinned target, so the page names no metric of its own. */
const metricConfig = z.object({
  primary: z.string(),
  direction: z.enum(["min", "max"]),
  guards: z.array(z.string()),
  zeroTolerance: z.array(z.string()),
  allGate: z.array(z.string()),
  noOp: z.array(z.string()),
  noise: z.object({ bandSigmas: z.number(), lockAfterPairs: z.number().int(), minPairs: z.number().int(), defaultBandPp: z.number() }),
});

/**
 * `repo` (`owner/name`) and `ratchetPrefix` come from the target adapter; ratchet records keep only their shas. Without
 * `repo` the page shows a ratchet move as text, since it cannot name where the commits live.
 */
const target = z.object({
  name: z.string(),
  pin: z.string(),
  ratchetRef: z.string(),
  metric: metricConfig,
  phases: z.array(z.string()).min(1),
  repo: z.string().optional(),
  ratchetPrefix: z.string().optional(),
});

const settings = z.object({ lanes: z.number().int().positive(), rounds: z.number().int().positive(), minPool: z.number().int().nonnegative() });

/** One evaluator run in ar-result/v2's generic maps; `wallS` is absent on v1 runs. */
const evalRun = z.object({
  case: z.string(),
  repeat: z.string(),
  metrics: z.record(z.string(), z.number()),
  gates: z.record(z.string(), z.boolean()),
  violations: z.record(z.string(), z.number()),
  usd: z.number().nonnegative(),
  wallS: z.number().nonnegative().optional(),
});

const idea = z.object({
  id: z.string(),
  round: z.number().int().positive(),
  cell: z.string(),
  class: z.string(),
  direction: z.string(),
  hypothesis: z.string(),
  priority: z.number(),
  bold: z.boolean(),
  source: z.enum(IDEA_SOURCES),
  lineage: z.string(),
  parent: z.string().optional(),
  differsFrom: z.string().optional(),
  expectedEffect: z.object({ metric: z.string(), direction: z.enum(["up", "down"]), microSignal: z.string() }),
  /** C-256 S4c: the parent-chain length over the run's ideas, 0 for a root; absent on a run the read model did not count. */
  lineageDepth: z.number().int().nonnegative().optional(),
});

/** A step still in flight; its timer runs from `firstStartedAt`, which survives a restart. */
const activeStep = z.object({ stepId: z.string(), firstStartedAt: z.string(), restarts: z.number().int().nonnegative() });

const REEVAL_DECISIONS = ["kept", "rejected", "requeued"] as const;

const outcome = z.object({
  verdict: z.enum(AR_VERDICTS),
  reason: z.string(),
  rungReached: z.enum(RUNGS),
  delta: z.number().optional(),
  sigma: z.number().optional(),
  head: z.string().optional(),
  branch: z.string().optional(),
  lesson: z.string().optional(),
  /**
   * Design G7: the noise the idea was judged against. Absent until the engine records it, and then σ reads as unlocked.
   * `locked` is the engine's own call and can go back to false when a re-measured baseline re-opens the estimate.
   * `case`, `head` and `bandWidth` arrive with C-256 S3a; a record from before it has only σ and pairs.
   */
  against: z
    .object({
      sigma: z.number().nonnegative(),
      pairs: z.number().int().nonnegative(),
      locked: z.boolean().optional(),
      case: z.string().optional(),
      head: z.string().optional(),
      bandWidth: z.number().nonnegative().optional(),
    })
    .optional(),
  /** Design G3: the lane slot (1 to `lanes`) the ladder held, and whether it warm-resumed a winner or explored fresh. */
  lane: z.number().int().positive().optional(),
  fork: z.enum(["exploit", "explore"]).optional(),
  /** Design G4: where the idea's dollars went. */
  usage: z.object({ implementUsd: z.number().nonnegative(), evalUsd: z.number().nonnegative(), microUsd: z.number().nonnegative() }).optional(),
  /** C-256 S5a: a later winner's re-evaluation on the head the round's first winner left; its final decision sets the verdict. */
  reeval: z.object({ vs: z.string(), decision: z.enum(REEVAL_DECISIONS), reason: z.string() }).optional(),
});

/**
 * Design gap G2: the agent the implement step ran, and its session once the result records one. Null until the factory
 * records either, so a read model without it still parses. `mode` and `account` arrive with C-256 S3a.
 */
const implementer = z.object({
  agent: z.string(),
  sessionId: z.string().optional(),
  resumedFrom: z.string().optional(),
  mode: z.enum(["spawn", "resume"]).optional(),
  account: z.string().optional(),
});

/** Design G6: one L0 check's row (bounds-post, unit, test-proof); absent on a run recorded before C-256 S3a. */
const l0Check = z.object({ name: z.string(), ok: z.boolean(), code: z.string().optional(), ms: z.number().nonnegative().optional() });

const l0 = z.object({ ok: z.boolean(), code: z.string().optional(), checks: z.array(l0Check).optional() });

/** One picked idea's ladder: `outcome` is null while it runs. */
const ladder = z.object({
  idea,
  implementer: implementer.nullable().default(null),
  active: activeStep.nullable(),
  completed: z.array(z.object({ stepId: z.string(), completedAt: z.string() })),
  implementUsd: z.number().nonnegative().nullable(),
  l0: l0.nullable(),
  micro: z.object({ predictedDirectionMet: z.boolean() }).nullable(),
  evals: z.array(evalRun),
  outcome: outcome.nullable(),
});

const tokens = z.number().int().nonnegative().optional();

/**
 * TP-3954: the planner that answered a round and what its turn cost, from C-256 S3e. Absent on a round recorded before
 * it, and on one whose planner named no agent.
 */
const planner = z.object({
  agent: z.string(),
  sessionId: z.string().optional(),
  mode: z.enum(["spawn", "resume"]).optional(),
  usage: z
    .object({
      usd: z.number().nonnegative(),
      cacheReadTokens: tokens,
      cacheWrite5mTokens: tokens,
      cacheWrite1hTokens: tokens,
      retries: z.number().int().nonnegative(),
    })
    .optional(),
});

/** The planner's `[EXEMPT]` reasons for skipping a quota this round, as its queue ops carry them; absent means none given. */
const quotaExemptions = z.object({ bold: z.string().optional(), followup: z.string().optional() });

/** C-256 S5a: one ratchet move; the first winner fast-forwards, each later kept winner merges, and a snapshot sync moves it too. */
const move = z.object({ from: z.string(), to: z.string(), kind: z.enum(["ff", "merge", "sync"]), ideaId: z.string().optional() });

/**
 * C-256 S5a: a later winner merged onto the new head and measured again. `merge` is null when it conflicted or the host
 * had no integrate port, and then the winner is requeued.
 */
const reeval = z.object({
  ideaId: z.string(),
  from: z.string(),
  vs: z.string(),
  merge: z.string().nullable(),
  conflict: z.array(z.string()).optional(),
  l0: l0.optional(),
  runs: z.array(evalRun),
  delta: z.number().optional(),
  decision: z.enum(REEVAL_DECISIONS),
  reason: z.string(),
});

const round = z.object({
  round: z.number().int().positive(),
  queue: z.array(idea),
  rejected: z.array(z.object({ code: z.string() })),
  plannerRetried: z.boolean(),
  planner: planner.optional(),
  exempt: quotaExemptions.default({}),
  analysis: z.array(z.string()),
  selection: z.object({ picks: z.array(z.string()), draws: z.array(z.object({ id: z.string(), draw: z.number() })), plannerTopK: z.array(z.string()) }),
  ladders: z.array(ladder),
  /** The round's net move; `moves` lists each step of it. */
  ratchet: z.object({ from: z.string(), to: z.string() }).nullable(),
  /** Empty for a round recorded before C-256 S5a. */
  moves: z.array(move).default([]),
  reevals: z.array(reeval).default([]),
});

/** C-256 S5: a snapshot is cut after a numbered round or at the run's `end`. */
const cadenceRound = z.union([z.number().int().positive(), z.literal("end")]);
const snapshotTrigger = z.enum(["phase-end", "kept", "spend"]);
const prNumber = z.number().int().positive();

/** G13a: one snapshot PR the run cut from its ratchet. */
const snapshot = z.object({
  k: z.number().int().positive(),
  tag: z.string(),
  sha: z.string(),
  branch: z.string(),
  pr: prNumber,
  url: z.string().optional(),
  trigger: snapshotTrigger,
  round: cadenceRound,
  logSha: z.string(),
});

/**
 * G13a: the open snapshot PR synced at a round's start. `conflict` or `frozen` say why a sync held for the owner's gate;
 * `runs` is B re-measured after a sync that changed the tree, and belongs to no idea's ladder.
 */
const sync = z.object({
  round: cadenceRound,
  pr: prNumber,
  state: z.enum(["open", "merged", "closed"]),
  merged: z.object({ from: z.string(), to: z.string(), main: z.string() }).optional(),
  conflict: z.array(z.string()).optional(),
  frozen: z.array(z.string()).optional(),
  treeChanged: z.boolean().optional(),
  gate: z.object({ answered: z.boolean(), resolved: z.string().optional() }).optional(),
  runs: z.array(evalRun).optional(),
});

/**
 * TP-3867: each row names the idea and round that produced it from C-256 S3a on. A planner analysis bug never names an
 * idea, and a row recorded before S3a names neither.
 */
const producedBy = { ideaId: z.string().optional(), round: z.number().int().positive().optional() };

const registries = z.object({
  deadEnds: z.array(
    z.object({ ...producedBy, cell: z.string(), targets: z.array(z.string()), rungFailed: z.string(), deltaOverSigma: z.number().optional(), lesson: z.string().optional() }),
  ),
  bugs: z.array(z.object({ ...producedBy, symptom: z.string(), fix: z.string(), source: z.enum(["L0", "planner"]) })),
});

/**
 * Design G17 (§1.7): the held-out validator's looks, aggregate only and report only. Absent until the engine records them.
 * Only the validator panel reads it, so a validator number can never steer what another section shows.
 */
const validator = z.object({
  maxLooks: z.number().int().positive(),
  looks: z.array(
    z.object({
      look: z.number().int().positive(),
      at: z.string(),
      sha: z.string(),
      aggregate: z.object({ metrics: z.record(z.string(), z.number()), gates: z.record(z.string(), z.number()) }),
      provenance: z.string(),
    }),
  ),
});

const cell = z.object({
  cell: z.string(),
  trials: z.number().int().nonnegative(),
  meanAbsDeltaOverSigma: z.number(),
  keepRate: z.number(),
  flag: z.enum(["explore", "demote"]).optional(),
});

export const ArRunViewSchema = z.object({
  runId: z.string(),
  status: z.enum(WORKFLOW_STATUSES),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  error: z.string().nullable(),
  /**
   * C-256 S4c: why the run ended, the engine's `ar-end` code (`rounds-exhausted`, `rounds-without-gain`, `ideas-evaluated`)
   * or a thrown run's error code. Absent while it runs and on a run recorded before S4c.
   */
  stopReason: z.string().optional(),
  target,
  settings,
  baseline: z.object({ runs: z.array(evalRun), b0: z.number() }),
  best: z.object({ head: z.string(), primary: z.number() }),
  rounds: z.array(round),
  registries,
  cells: z.array(cell),
  validator: validator.optional(),
  /** C-256 S5: empty, or null when nothing is pending, on a run recorded before snapshots. */
  snapshots: z.array(snapshot).default([]),
  snapshotPending: z.object({ trigger: snapshotTrigger }).nullable().default(null),
  syncs: z.array(sync).default([]),
});

/** One row of `autoresearch.runs`; `best` is null until the baseline has run, and `round` is 0 until the first round starts. */
export const ArRunSummarySchema = z.object({
  runId: z.string(),
  target: z.string(),
  phase: z.string(),
  round: z.number().int().nonnegative(),
  rounds: z.number().int().positive(),
  status: z.enum(WORKFLOW_STATUSES),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  best: z.object({ head: z.string(), primary: z.number() }).nullable(),
  spend: z.number().nonnegative(),
  /** C-256 S5: the snapshot PR still open for the owner; null when none is, and on a factory from before snapshots. */
  openSnapshot: z.object({ k: z.number().int().positive(), pr: prNumber }).nullable().default(null),
});

/** `autoresearch.diff`: the idea branch against the head it forked from, with the patch capped by the factory. */
export const ArDiffSchema = z.object({
  stat: z.object({ files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative() }),
  patch: z.string(),
  truncated: z.boolean(),
});

export type ArRunView = z.infer<typeof ArRunViewSchema>;
export type ArLadder = z.infer<typeof ladder>;
export type ArImplementer = z.infer<typeof implementer>;
export type ArRound = z.infer<typeof round>;
export type ArPlanner = z.infer<typeof planner>;
export type ArIdea = z.infer<typeof idea>;
export type ArOutcome = z.infer<typeof outcome>;
export type ArAgainst = NonNullable<ArOutcome["against"]>;
export type ArL0Check = z.infer<typeof l0Check>;
export type ArRunSummary = z.infer<typeof ArRunSummarySchema>;
export type ArMove = z.infer<typeof move>;
export type ArReeval = z.infer<typeof reeval>;
export type ArSnapshot = z.infer<typeof snapshot>;
export type ArSync = z.infer<typeof sync>;
export type ArRegistries = z.infer<typeof registries>;
export type ArValidator = z.infer<typeof validator>;
export type ArDiff = z.infer<typeof ArDiffSchema>;
