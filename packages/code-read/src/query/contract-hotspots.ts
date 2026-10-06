import { z } from "zod";
import { BaselineFields } from "./contract-findings.js";
import { NodeRef, SnapshotRef } from "./schemas.js";

/** Most rows one `hotspots.list` page returns; a table pages with `offset`. */
export const HOTSPOTS_PAGE_MAX = 500;

/** A window as metric descriptors name it: "30d", or "lifetime" for all of git history. code-graph stores 30d, 90d, and 180d by default. */
export const ChurnWindow = z.string().regex(/^(?:[1-9]\d*d|lifetime)$/);

export const HotspotMark = z.enum(["new", "worsened"]);

export const Hotspot = z.object({
  node: NodeRef,
  /** Commits touching the file in the window; a symbol reads its declaring file's churn. */
  churn: z.number(),
  /** File: max cognitive complexity over its functions (cyclomatic when cognitive is absent). Symbol: its own, else its file's. */
  complexity: z.number(),
  /** The age discount applied to the score, 1 for none; the symbol grain applies none. */
  recency: z.number(),
  /** File: round(churn × complexity × recency). Symbol: utilization × complexity × churn (blast radius). */
  score: z.number(),
  /** Symbol grain only. */
  utilization: z.number().optional(),
  /** Present only with a baseline; null when the node was no hotspot there. */
  baselineScore: z.number().nullable().optional(),
  /** Present only with a baseline, and only for a row that is new or scores higher than at the baseline. */
  mark: HotspotMark.optional(),
});

const hotspotsListArgs = z.object({
  snapshot: SnapshotRef.optional(),
  baseline: SnapshotRef.optional(),
  grain: z.enum(["file", "symbol"]).default("file"),
  window: ChurnWindow.default("30d"),
  /** Keep rows scoring at least this; the threshold is the caller's policy. */
  cutoff: z.number().min(0).optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(0).max(HOTSPOTS_PAGE_MAX).default(20),
});

const hotspotsListResult = z.object({
  snapshotId: z.number().int(),
  ...BaselineFields,
  rows: z.array(Hotspot),
  /** Rows at or above the cutoff, before `offset` and `limit`. */
  total: z.number().int(),
});

export const HOTSPOTS_LIST = {
  description:
    "Files or symbols ranked by hotspot score, highest first, offset-paginated. File grain scores churn × complexity × " +
    "recency over the churn `window`; symbol grain scores blast radius, utilization × complexity × file churn. " +
    "Generated files and their symbols are left out. `cutoff` keeps rows scoring at least that. With `baseline`, each row gets its " +
    "baseline score and is marked new or worsened.",
  args: hotspotsListArgs,
  result: hotspotsListResult,
} as const;

export type Hotspot = z.infer<typeof Hotspot>;
export type HotspotMark = z.infer<typeof HotspotMark>;
