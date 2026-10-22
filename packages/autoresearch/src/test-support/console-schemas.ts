import { z } from "zod";

/**
 * Copies of the console's autoresearch read-model schemas (`ArRunViewSchema` and `ArRunSummarySchema` in the console
 * app), not imports: a package may not import an app. When the console schema changes, change these with it.
 */
const WORKFLOW_STATUSES = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"] as const;
const RUNGS = ["none", "L0", "L1", "L2", "L3"] as const;

const metricConfig = z.object({
  primary: z.string(),
  direction: z.enum(["min", "max"]),
  guards: z.array(z.string()),
  zeroTolerance: z.array(z.string()),
  allGate: z.array(z.string()),
  noOp: z.array(z.string()),
  noise: z.object({ bandSigmas: z.number(), lockAfterPairs: z.number().int(), minPairs: z.number().int(), defaultBandPp: z.number() }),
});

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
  source: z.enum(["planner", "owner", "requeue", "followup"]),
  lineage: z.string(),
  parent: z.string().optional(),
  differsFrom: z.string().optional(),
  expectedEffect: z.object({ metric: z.string(), direction: z.enum(["up", "down"]), microSignal: z.string() }),
  lineageDepth: z.number().int().nonnegative().optional(),
});

const activeStep = z.object({ stepId: z.string(), firstStartedAt: z.string(), restarts: z.number().int().nonnegative() });

const REEVAL_DECISIONS = ["kept", "rejected", "requeued"] as const;

const outcome = z.object({
  verdict: z.enum(["kept", "rejected", "stopped"]),
  reason: z.string(),
  rungReached: z.enum(RUNGS),
  delta: z.number().optional(),
  sigma: z.number().optional(),
  head: z.string().optional(),
  branch: z.string().optional(),
  lesson: z.string().optional(),
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
  lane: z.number().int().positive().optional(),
  fork: z.enum(["exploit", "explore"]).optional(),
  usage: z.object({ implementUsd: z.number().nonnegative(), evalUsd: z.number().nonnegative(), microUsd: z.number().nonnegative() }).optional(),
  reeval: z.object({ vs: z.string(), decision: z.enum(REEVAL_DECISIONS), reason: z.string() }).optional(),
});

const implementer = z.object({
  agent: z.string(),
  sessionId: z.string().optional(),
  resumedFrom: z.string().optional(),
  mode: z.enum(["spawn", "resume"]).optional(),
  account: z.string().optional(),
});

const l0Check = z.object({ name: z.string(), ok: z.boolean(), code: z.string().optional(), ms: z.number().nonnegative().optional() });

const l0 = z.object({ ok: z.boolean(), code: z.string().optional(), checks: z.array(l0Check).optional() });

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

const quotaExemptions = z.object({ bold: z.string().optional(), followup: z.string().optional() });

const move = z.object({ from: z.string(), to: z.string(), kind: z.enum(["ff", "merge", "sync"]), ideaId: z.string().optional() });

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
  ratchet: z.object({ from: z.string(), to: z.string() }).nullable(),
  moves: z.array(move).default([]),
  reevals: z.array(reeval).default([]),
});

const cadenceRound = z.union([z.number().int().positive(), z.literal("end")]);
const snapshotTrigger = z.enum(["phase-end", "kept", "spend"]);
const prNumber = z.number().int().positive();

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
  failed: z.string().optional(),
});

const producedBy = { ideaId: z.string().optional(), round: z.number().int().positive().optional() };

const registries = z.object({
  deadEnds: z.array(
    z.object({ ...producedBy, cell: z.string(), targets: z.array(z.string()), rungFailed: z.string(), deltaOverSigma: z.number().optional(), lesson: z.string().optional() }),
  ),
  bugs: z.array(z.object({ ...producedBy, symptom: z.string(), fix: z.string(), source: z.enum(["L0", "planner"]) })),
});

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
  stopReason: z.string().optional(),
  target,
  settings,
  baseline: z.object({ runs: z.array(evalRun), b0: z.number() }),
  best: z.object({ head: z.string(), primary: z.number() }),
  rounds: z.array(round),
  registries,
  cells: z.array(cell),
  validator: validator.optional(),
  snapshots: z.array(snapshot).default([]),
  snapshotPending: z.object({ trigger: snapshotTrigger }).nullable().default(null),
  syncs: z.array(sync).default([]),
});

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
  openSnapshot: z.object({ k: z.number().int().positive(), pr: prNumber }).nullable().default(null),
});
