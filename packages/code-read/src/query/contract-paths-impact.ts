import { z } from "zod";
import { BaselineFields, Finding } from "./contract-findings.js";
import { ChurnWindow } from "./contract-hotspots.js";
import { NodeRef, SnapshotRef } from "./schemas.js";

/** Most paths one `paths.impact` call takes. */
export const PATHS_IMPACT_MAX = 500;

/** A file's findings against the baseline, bucketed as `changes.get` buckets them; counts only. */
export const FindingDelta = z.object({
  new: z.number().int(),
  worsened: z.number().int(),
  improved: z.number().int(),
  resolved: z.number().int(),
});

/** An indexed file against the baseline. Every `before` is null when the baseline does not hold the file. */
export const PathDelta = z.object({
  inBaseline: z.boolean(),
  /** A file with no score at the baseline counts as 0, as in `changes.get`; null when the baseline does not hold it. */
  scoreBefore: z.number().nullable(),
  /** Current score minus `scoreBefore`; null when `scoreBefore` is. */
  score: z.number().nullable(),
  complexityBefore: z.number().nullable(),
  /** Current complexity minus `complexityBefore`; null when either is unmeasured. */
  complexity: z.number().nullable(),
  findings: FindingDelta,
});

export const PathHotspot = z.object({
  /** The file grain's score over the window, as `hotspots.list` scores it; 0 when the file has no churn or no complexity. */
  score: z.number(),
  /** The file's position in `hotspots.list` at the same window, 1 the highest; null at a score of 0. */
  rank: z.number().int().nullable(),
});

const IndexedPath = z.object({
  status: z.literal("indexed"),
  /** The path as given. */
  input: z.string(),
  /** Repo-relative, the file's node id. */
  path: z.string(),
  node: NodeRef,
  /** The complexity factor of the hotspot score (max cognitive, else max cyclomatic); null when unmeasured. */
  complexity: z.number().nullable(),
  hotspot: PathHotspot,
  /** Open findings on the file or a symbol in it, worst first. With a baseline each carries a status. */
  findings: z.array(Finding),
  /** Absent without a baseline; null when the baseline is not comparable (another index version). */
  delta: PathDelta.nullable().optional(),
});

/** A repo-relative path the snapshot holds no file for, such as a new, deleted, ignored, or directory path. */
const NotIndexedPath = z.object({ status: z.literal("not-indexed"), input: z.string(), path: z.string() });

/** An absolute path outside `root` (or any absolute path when `root` is not given), or a relative one that climbs out with `..`. */
const OutsideRepoPath = z.object({ status: z.literal("outside-repo"), input: z.string() });

export const PathImpact = z.discriminatedUnion("status", [IndexedPath, NotIndexedPath, OutsideRepoPath]);

export const ImpactRollup = z.object({
  indexed: z.number().int(),
  notIndexed: z.number().int(),
  outsideRepo: z.number().int(),
  /** Sum of the indexed files' hotspot scores. */
  score: z.number(),
  /** Highest complexity over the indexed files; null when none is measured. */
  maxComplexity: z.number().nullable(),
  /** Best (lowest) hotspot rank over the indexed files; null when none ranks. */
  topRank: z.number().int().nullable(),
  openFindings: z.number().int(),
  /** The rows' deltas summed; present and null exactly when every row's `delta` is. */
  delta: z.object({ score: z.number(), findings: FindingDelta }).nullable().optional(),
});

const pathsImpactArgs = z.object({
  snapshot: SnapshotRef.optional(),
  baseline: SnapshotRef.optional(),
  /** Repo-relative paths; a leading `./` is dropped. An absolute path counts only when it lies under `root`. */
  paths: z.array(z.string()).max(PATHS_IMPACT_MAX),
  /** The absolute directory the repo is checked out at, such as a worktree, so absolute paths under it can be read. */
  root: z.string().optional(),
  window: ChurnWindow.default("30d"),
});

const pathsImpactResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  /** One row per distinct path, in the order first given. */
  rows: z.array(PathImpact),
  /** Files with a non-zero hotspot score at the window; the denominator for `hotspot.rank`. */
  ranked: z.number().int(),
  rollup: ImpactRollup,
});

export const PATHS_IMPACT = {
  description:
    "What a set of files weighs in the code graph, such as the files a change touches: per file its complexity, its " +
    "hotspot score and rank as `hotspots.list` ranks them at `window`, and its open findings, plus a rollup. A path the " +
    "snapshot does not hold answers status 'not-indexed', and one outside the repo 'outside-repo'; neither is an error. " +
    "With `baseline`, each indexed row gets a score, complexity, and findings delta; without one, `delta` is absent.",
  args: pathsImpactArgs,
  result: pathsImpactResult,
} as const;

export type PathImpact = z.infer<typeof PathImpact>;
export type PathDelta = z.infer<typeof PathDelta>;
export type PathHotspot = z.infer<typeof PathHotspot>;
export type FindingDelta = z.infer<typeof FindingDelta>;
export type ImpactRollup = z.infer<typeof ImpactRollup>;
