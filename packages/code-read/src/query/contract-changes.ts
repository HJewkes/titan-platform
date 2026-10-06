import { z } from "zod";
import { Finding } from "./contract-findings.js";
import { ChurnWindow } from "./contract-hotspots.js";
import { NodeRef, SnapshotRef } from "./schemas.js";

/** Most rows each list of a `changes.get` result returns; `counts` always holds the full sizes. */
export const CHANGES_ROWS_MAX = 500;

/** A file present at both snapshots whose hotspot score moved; a file with no score counts as 0. */
export const ScoreChange = z.object({
  node: NodeRef,
  before: z.number(),
  after: z.number(),
  delta: z.number(),
});

export const NewFile = z.object({ node: NodeRef, score: z.number() });

/** A finding open at both snapshots whose measured value moved; `delta` is current value minus baseline value. */
export const FindingChange = z.object({ finding: Finding, before: z.number(), delta: z.number() });

/** A file whose hotspot score rose since the baseline and that carries an open finding now. */
export const Regression = ScoreChange.extend({ findings: z.array(z.string()) });

export const CoChangePair = z.object({ a: NodeRef, b: NodeRef, count: z.number().int() });

const changesGetArgs = z.object({
  snapshot: SnapshotRef.optional(),
  baseline: SnapshotRef,
  window: ChurnWindow.default("30d"),
  /** A file scoring at least this is over the cutoff; the threshold is the caller's policy. */
  cutoff: z.number().min(0).default(3000),
  limit: z.number().int().min(0).max(CHANGES_ROWS_MAX).default(20),
});

const changesGetResult = z.object({
  snapshotId: z.number().int(),
  baselineSnapshotId: z.number().int(),
  /** False across index versions; every list is then empty, because the two indexes measure differently. */
  comparable: z.boolean(),
  files: z.object({
    /** Below the cutoff at the baseline, at or above it now; highest delta first. */
    crossedCutoff: z.array(ScoreChange),
    /** Files the baseline does not hold; highest score first. */
    added: z.array(NewFile),
  }),
  findings: z.object({
    new: z.array(Finding),
    worsened: z.array(FindingChange),
    improved: z.array(FindingChange),
    resolved: z.array(Finding),
  }),
  coupling: z.object({
    /** False until co-change pairs are stored in the index; `added` is then empty. */
    measured: z.boolean(),
    added: z.array(CoChangePair),
  }),
  regressions: z.array(Regression),
  counts: z.object({
    crossedCutoff: z.number().int(),
    newFiles: z.number().int(),
    newFindings: z.number().int(),
    worsened: z.number().int(),
    improved: z.number().int(),
    resolved: z.number().int(),
    newCoupling: z.number().int(),
    regressions: z.number().int(),
  }),
});

export const CHANGES_GET = {
  description:
    "What changed between a `baseline` snapshot and this one: files that crossed the hotspot `cutoff`, files the baseline " +
    "does not hold, findings new, worsened, improved, or resolved, new co-change coupling (unmeasured until pairs are " +
    "stored), and regressions: files whose hotspot score rose and that carry an open finding. Each list holds at most " +
    "`limit` rows; `counts` holds the full sizes. Across index versions `comparable` is false and every list is empty.",
  args: changesGetArgs,
  result: changesGetResult,
} as const;

export type ScoreChange = z.infer<typeof ScoreChange>;
export type NewFile = z.infer<typeof NewFile>;
export type FindingChange = z.infer<typeof FindingChange>;
export type Regression = z.infer<typeof Regression>;
export type CoChangePair = z.infer<typeof CoChangePair>;
