import type { ParsedFile } from "@titan-design/code-parser";
import { computeSourceMetrics } from "./source-metrics.js";
import { computeDeadCodeMetrics } from "./analysis/dead-code.js";
import { computeGrowthRiskMetrics } from "./analysis/growth-risk.js";
import { qualifiedByName } from "./symbol-aliases.js";
import type { GraphMetric } from "./types.js";

/**
 * Everything the metrics and alias passes need from one file's syntax tree,
 * computed while that tree is alive so the tree can be deleted right after
 * (TP-747: web-tree-sitter WASM memory never shrinks, so peak memory is set by
 * how many trees are alive at once).
 */
export interface FileDigest {
  fileId: string;
  /** File-level metrics on `fileId` plus symbol-level metrics for every name in `symbolNames`. */
  sourceMetrics: GraphMetric[];
  deadCodeMetrics: GraphMetric[];
  growthRiskMetrics: GraphMetric[];
  /** Bare declared name to the qualified names that share it, for requalify aliases. */
  qualifiedByName: Map<string, Set<string>>;
}

/**
 * Digest one parsed file. `symbolNames` are the names of the symbol nodes this
 * file's own extraction produced; metric assembly later drops symbol metrics
 * whose node did not survive into the final node map.
 */
export function digestParsedFile(file: ParsedFile, fileId: string, symbolNames: ReadonlySet<string>): FileDigest {
  const idOf = () => fileId;
  return {
    fileId,
    sourceMetrics: computeSourceMetrics([file], idOf, new Map([[fileId, symbolNames]])),
    deadCodeMetrics: computeDeadCodeMetrics([file], idOf),
    growthRiskMetrics: computeGrowthRiskMetrics([file], idOf),
    qualifiedByName: qualifiedByName(file),
  };
}
