import type { Node } from "web-tree-sitter";
import { commentLineStats, type CommentLineStats } from "./analysis/comment-lines.js";
import { countNarratingComments } from "./analysis/narrating-comments.js";
import { isPassThrough } from "./analysis/pass-through.js";
import type { PropStats } from "./analysis/prop-metrics.js";
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
  /** Deepest chain of rendered JSX elements in the body; 0 when it renders none. */
  jsxDepth: number;
  /** The cognitive score's share charged inside JSX expressions, and the rest (C-97 S2). */
  markupCognitive: number;
  logicCognitive: number;
  /** Lines spanned by the whole function node, signature included. */
  loc: number;
  /** Own-declared prop counts of a component (C-97 S3); null when it is no component or its props type is not in this file. */
  props: PropStats | null;
}

type NumericStat =
  | "cyclomatic"
  | "cognitive"
  | "nestingDepth"
  | "jsxDepth"
  | "markupCognitive"
  | "logicCognitive"
  | "loc"
  | keyof FunctionShapeStats;

/**
 * Per-symbol metric name, the unit and function stat it reports, whether a zero is
 * left unwritten, and whether it is written only for a function that renders JSX.
 */
const SYMBOL_METRICS: readonly {
  name: string;
  stat: NumericStat;
  unit: string;
  omitZero?: boolean;
  jsxOnly?: boolean;
}[] = [
  { name: "symbol_cognitive", stat: "cognitive", unit: "count" },
  { name: "symbol_cyclomatic", stat: "cyclomatic", unit: "count" },
  { name: "symbol_loc", stat: "loc", unit: "lines" },
  { name: "symbol_max_nesting", stat: "nestingDepth", unit: "count" },
  { name: "symbol_jsx_depth", stat: "jsxDepth", unit: "count", omitZero: true },
  { name: "symbol_markup_cognitive", stat: "markupCognitive", unit: "count", jsxOnly: true },
  { name: "symbol_logic_cognitive", stat: "logicCognitive", unit: "count", jsxOnly: true },
  { name: "symbol_comment_lines", stat: "commentLines", unit: "lines" },
  { name: "symbol_docstring_lines", stat: "docstringLines", unit: "lines" },
  { name: "symbol_body_lines", stat: "bodyLines", unit: "lines" },
  { name: "symbol_comment_ratio", stat: "commentRatio", unit: "ratio" },
  { name: "symbol_narrating_comments", stat: "narratingComments", unit: "count" },
  { name: "symbol_pass_through", stat: "passThrough", unit: "count" },
];

/** Component prop metrics; all three are absent where `props` is null. */
const PROP_METRICS: readonly { name: string; stat: keyof PropStats }[] = [
  { name: "symbol_prop_count", stat: "propCount" },
  { name: "symbol_bool_prop_count", stat: "boolPropCount" },
  { name: "symbol_unread_props", stat: "unreadProps" },
];

export const SYMBOL_METRIC_NAMES: readonly string[] = [...SYMBOL_METRICS, ...PROP_METRICS].map((m) => m.name);

type SymbolValues = Record<NumericStat, number> & { props: PropStats | null };

/**
 * Per-symbol metrics (C-58, C-64, TP-317): for each named function whose qualified
 * name has a `symbol` node on this file, emit every SYMBOL_METRICS entry on that
 * node (`<fileId>#<qualifiedName>`), skipping an `omitZero` entry whose value is 0 and a
 * `jsxOnly` entry where the symbol renders no JSX, plus PROP_METRICS where `props` resolved. Model B (C-64) gives non-exported helpers a
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
  const out: GraphMetric[] = [];
  for (const [name, values] of mergeByName(stats, symbolNames)) {
    const nodeId = symbolId(fileId, name);
    for (const m of SYMBOL_METRICS) {
      if (m.omitZero && values[m.stat] === 0) continue;
      if (m.jsxOnly && values.jsxDepth === 0) continue;
      out.push({ nodeId, name: m.name, value: values[m.stat], unit: m.unit });
    }
    const props = values.props;
    if (props) out.push(...PROP_METRICS.map((m) => ({ nodeId, name: m.name, value: props[m.stat], unit: "count" })));
  }
  return out;
}

function mergeByName(stats: readonly FunctionStats[], symbolNames: ReadonlySet<string>): Map<string, SymbolValues> {
  const byName = new Map<string, SymbolValues>();
  for (const s of stats) {
    if (!s.name || !symbolNames.has(s.name)) continue;
    const prev = byName.get(s.name);
    if (!prev) {
      byName.set(s.name, { ...s });
      continue;
    }
    for (const { stat } of SYMBOL_METRICS) prev[stat] = Math.max(prev[stat], s[stat]);
    prev.props = maxProps(prev.props, s.props);
  }
  return byName;
}

function maxProps(a: PropStats | null, b: PropStats | null): PropStats | null {
  if (!a || !b) return a ?? b;
  return {
    propCount: Math.max(a.propCount, b.propCount),
    boolPropCount: Math.max(a.boolPropCount, b.boolPropCount),
    unreadProps: Math.max(a.unreadProps, b.unreadProps),
  };
}

/** `fn` is the function node, `body` its body, `lines` the file's content split on newlines. */
export function functionShapeStats(fn: Node, body: Node, lines: readonly string[]): FunctionShapeStats {
  return {
    ...commentLineStats(fn, body, lines),
    narratingComments: countNarratingComments(fn, body),
    passThrough: isPassThrough(fn, body) ? 1 : 0,
  };
}
