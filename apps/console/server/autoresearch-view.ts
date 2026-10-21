import { z } from "zod";

/**
 * The autoresearch run page's read model, as titan-factory's `autoresearch.run` replays it from the run store. The console
 * depends on no factory source, so this pins only the fields the page shows; the reader strips the rest.
 */

const WORKFLOW_STATUSES = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"] as const;
const IDEA_SOURCES = ["planner", "owner", "requeue", "followup"] as const;
const RUNGS = ["none", "L0", "L1", "L2", "L3"] as const;
export const AR_VERDICTS = ["kept", "rejected", "stopped"] as const;

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

const target = z.object({ name: z.string(), pin: z.string(), ratchetRef: z.string(), metric: metricConfig, phases: z.array(z.string()).min(1) });

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
});

/** A step still in flight; its timer runs from `firstStartedAt`, which survives a restart. */
const activeStep = z.object({ stepId: z.string(), firstStartedAt: z.string(), restarts: z.number().int().nonnegative() });

const outcome = z.object({
  verdict: z.enum(AR_VERDICTS),
  reason: z.string(),
  rungReached: z.enum(RUNGS),
  delta: z.number().optional(),
  sigma: z.number().optional(),
  head: z.string().optional(),
  branch: z.string().optional(),
  lesson: z.string().optional(),
});

/** One picked idea's ladder: `outcome` is null while it runs. */
const ladder = z.object({
  idea,
  active: activeStep.nullable(),
  completed: z.array(z.object({ stepId: z.string(), completedAt: z.string() })),
  implementUsd: z.number().nonnegative().nullable(),
  l0: z.object({ ok: z.boolean(), code: z.string().optional() }).nullable(),
  micro: z.object({ predictedDirectionMet: z.boolean() }).nullable(),
  evals: z.array(evalRun),
  outcome: outcome.nullable(),
});

const round = z.object({
  round: z.number().int().positive(),
  queue: z.array(idea),
  rejected: z.array(z.object({ code: z.string() })),
  plannerRetried: z.boolean(),
  analysis: z.array(z.string()),
  selection: z.object({ picks: z.array(z.string()), draws: z.array(z.object({ id: z.string(), draw: z.number() })), plannerTopK: z.array(z.string()) }),
  ladders: z.array(ladder),
  ratchet: z.object({ from: z.string(), to: z.string() }).nullable(),
});

const registries = z.object({
  deadEnds: z.array(z.object({ cell: z.string(), targets: z.array(z.string()), rungFailed: z.string(), deltaOverSigma: z.number().optional(), lesson: z.string().optional() })),
  bugs: z.array(z.object({ symptom: z.string(), fix: z.string(), source: z.enum(["L0", "planner"]) })),
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
  target,
  settings,
  baseline: z.object({ runs: z.array(evalRun), b0: z.number() }),
  best: z.object({ head: z.string(), primary: z.number() }),
  rounds: z.array(round),
  registries,
  cells: z.array(cell),
});

export type ArRunView = z.infer<typeof ArRunViewSchema>;
export type ArLadder = z.infer<typeof ladder>;
