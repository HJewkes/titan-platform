import type { Node } from "web-tree-sitter";
import { commentLineStats, type CommentLineStats } from "./analysis/comment-lines.js";
import { countNarratingComments } from "./analysis/narrating-comments.js";
import { isPassThrough } from "./analysis/pass-through.js";
import { symbolId } from "./extractors/ids.js";
import type { GraphMetric } from "./types.js";

/** Comment and shape counts of one function (TP-322); `passThrough` is 1 or 0. */
export interface FunctionShapeStats extends CommentLineStats {
  narratingComments: number;
  passThrough: number;
}

export interface FunctionStats extends FunctionShapeStats {
  /** Scope-qualified declared name (`Job.run`), or null for an anonymous function (e.g. `export default () => {}`). */
  name: string | null;
  cyclomatic: number;
  cognitive: number;
  nestingDepth: number;
  /** Lines spanned by the whole function node, signature included. */
  loc: number;
}

type NumericStat = "cyclomatic" | "cognitive" | "nestingDepth" | "loc" | keyof FunctionShapeStats;

/** Per-symbol metric name and the unit and function stat it reports. */
const SYMBOL_METRICS: readonly { name: string; stat: NumericStat; unit: string }[] = [
  { name: "symbol_cognitive", stat: "cognitive", unit: "count" },
  { name: "symbol_cyclomatic", stat: "cyclomatic", unit: "count" },
  { name: "symbol_loc", stat: "loc", unit: "lines" },
  { name: "symbol_max_nesting", stat: "nestingDepth", unit: "count" },
  { name: "symbol_comment_lines", stat: "commentLines", unit: "lines" },
  { name: "symbol_docstring_lines", stat: "docstringLines", unit: "lines" },
  { name: "symbol_body_lines", stat: "bodyLines", unit: "lines" },
  { name: "symbol_comment_ratio", stat: "commentRatio", unit: "ratio" },
  { name: "symbol_narrating_comments", stat: "narratingComments", unit: "count" },
  { name: "symbol_pass_through", stat: "passThrough", unit: "count" },
];

export const SYMBOL_METRIC_NAMES: readonly string[] = SYMBOL_METRICS.map((m) => m.name);

/**
 * Per-symbol metrics (C-58, C-64, TP-317): for each named function whose qualified
 * name has a `symbol` node on this file, emit every SYMBOL_METRICS entry on that
 * node (`<fileId>#<qualifiedName>`). Model B (C-64) gives non-exported helpers a
 * node too, so internal functions get their own values here, not just exports. A
 * qualified name shared by several functions (a getter/setter pair) takes the max
 * of each stat independently; a declared name with no function (a bare class) emits nothing.
 */
export function symbolMetrics(
  fileId: string,
  stats: readonly FunctionStats[],
  symbolNames: ReadonlySet<string>,
): GraphMetric[] {
  if (symbolNames.size === 0) return [];
  const byName = new Map<string, Record<NumericStat, number>>();
  for (const s of stats) {
    if (!s.name || !symbolNames.has(s.name)) continue;
    const prev = byName.get(s.name);
    if (!prev) {
      byName.set(s.name, { ...s });
      continue;
    }
    for (const { stat } of SYMBOL_METRICS) prev[stat] = Math.max(prev[stat], s[stat]);
  }
  const out: GraphMetric[] = [];
  for (const [name, values] of byName) {
    const nodeId = symbolId(fileId, name);
    for (const m of SYMBOL_METRICS) {
      out.push({ nodeId, name: m.name, value: values[m.stat], unit: m.unit });
    }
  }
  return out;
}

/** `fn` is the function node, `body` its body, `lines` the file's content split on newlines. */
export function functionShapeStats(fn: Node, body: Node, lines: readonly string[]): FunctionShapeStats {
  return {
    ...commentLineStats(fn, body, lines),
    narratingComments: countNarratingComments(fn, body),
    passThrough: isPassThrough(fn, body) ? 1 : 0,
  };
}
