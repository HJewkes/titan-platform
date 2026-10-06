import { DEFAULT_HEALTH_WEIGHTS, type PenaltyWeight } from "@titan-design/code-graph/analysis";
import { z } from "zod";
import { BaselineFields } from "./contract-findings.js";
import { ChurnWindow } from "./contract-hotspots.js";
import { NodeRef, SnapshotRef } from "./schemas.js";

/** Most rows the reading order or the look-first list returns. */
export const OVERVIEW_ROWS_MAX = 50;

export const AttentionSignalKey = z.enum(["hotspots", "findings", "complexity", "hidden-coupling"]);

/** One named signal of where attention is due, with the points the caller's weights give it. */
export const AttentionSignal = z.object({
  key: AttentionSignalKey,
  label: z.string(),
  penalty: z.number(),
  cap: z.number(),
  /** False when the index does not hold the signal's input yet; its penalty is then 0. */
  measured: z.boolean(),
  detail: z.string(),
});

export const LookFirstReason = z.enum(["over-cutoff", "findings", "churn-complexity"]);

export const LookFirstRow = z.object({
  node: NodeRef,
  score: z.number(),
  churn: z.number(),
  complexity: z.number(),
  recency: z.number(),
  /** Why the row is here; `churn-complexity` only when no other reason applies. */
  reasons: z.array(LookFirstReason),
});

export const ReadingOrderRow = z.object({ node: NodeRef, centrality: z.number() });

const weightShape = (w: PenaltyWeight) => ({ each: z.number().min(0).default(w.each), cap: z.number().min(0).default(w.cap) });
const weight = (w: PenaltyWeight) => z.object(weightShape(w)).prefault({});

const { findings, complexity } = DEFAULT_HEALTH_WEIGHTS;

const signalWeights = z
  .object({
    hotspots: weight(DEFAULT_HEALTH_WEIGHTS.hotspots),
    findings: z
      .object({
        each_new: z.number().min(0).default(findings.eachNew),
        each_carry: z.number().min(0).default(findings.eachCarry),
        cap: z.number().min(0).default(findings.cap),
      })
      .prefault({}),
    complexity: z.object({ ...weightShape(complexity), budget: z.number().min(0).default(complexity.budget) }).prefault({}),
    hidden_coupling: weight(DEFAULT_HEALTH_WEIGHTS.hiddenCoupling),
  })
  .prefault({});

const overviewGetArgs = z.object({
  snapshot: SnapshotRef.optional(),
  baseline: SnapshotRef.optional(),
  window: ChurnWindow.default("30d"),
  /** A file scoring at least this is over the cutoff; the threshold is the caller's policy. */
  cutoff: z.number().min(0).default(3000),
  weights: signalWeights,
  /** Rules left out of the findings signal, such as one already counted as a hotspot over the cutoff. */
  exclude_rules: z.array(z.string()).default([]),
  /** Also return `combined`, 100 minus every signal's penalty. */
  combined: z.boolean().default(false),
  reading_limit: z.number().int().min(0).max(OVERVIEW_ROWS_MAX).default(6),
  look_limit: z.number().int().min(0).max(OVERVIEW_ROWS_MAX).default(8),
});

const FindingCounts = z.object({
  open: z.number().int(),
  /** Status counts against the baseline; present only with one. */
  new: z.number().int().optional(),
  carryover: z.number().int().optional(),
  resolved: z.number().int().optional(),
});

const overviewGetResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  kpis: z.object({
    hotspotsOverCutoff: z.number().int(),
    /** Highest file complexity among files with churn in the window. */
    maxComplexity: z.number(),
    /** Files with a bus factor of 1 in the window. */
    knowledgeSilos: z.number().int(),
    findings: FindingCounts,
  }),
  signals: z.array(AttentionSignal),
  /** Present only when asked for: one number hides which signal moved, so read `signals` first. */
  combined: z.number().optional(),
  readingOrder: z.array(ReadingOrderRow),
  lookFirst: z.array(LookFirstRow),
});

export const OVERVIEW_GET = {
  description:
    "Where to look first in a snapshot: KPIs, named attention signals (hotspots over `cutoff`, findings, complexity over budget, " +
    "hidden coupling) each weighted and capped by the caller's `weights`, a reading order of files by PageRank centrality, and " +
    "the top hotspots with the reasons each is listed. With `baseline`, findings count as new, carried over, or resolved. " +
    "`combined` optionally adds 100 minus the penalties; it is a secondary summary, not a verdict.",
  args: overviewGetArgs,
  result: overviewGetResult,
} as const;

export type AttentionSignal = z.infer<typeof AttentionSignal>;
export type LookFirstRow = z.infer<typeof LookFirstRow>;
export type ReadingOrderRow = z.infer<typeof ReadingOrderRow>;
