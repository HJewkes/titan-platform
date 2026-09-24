import type { NodeKind } from "../types.js";
import type { MetricDescriptor } from "./types.js";

const FILE: readonly NodeKind[] = ["file"];
const SYMBOL: readonly NodeKind[] = ["symbol"];
const STRUCTURAL: readonly NodeKind[] = ["file", "module", "external"];

/** Degree metrics from `metrics.ts`, recomputed over the whole assembled graph on every index. */
const DEGREE: readonly MetricDescriptor[] = [
  {
    name: "fan_in", unit: "count", appliesTo: STRUCTURAL, rollup: "none", direction: "neutral",
    absent: "zero", source: "degree",
    description: "Import and re-export edges into the node. Summing over a group would count its internal edges.",
  },
  {
    name: "fan_out", unit: "count", appliesTo: STRUCTURAL, rollup: "none", direction: "higher-worse",
    absent: "zero", source: "degree",
    description: "Import and re-export edges out of the node. Summing over a group would count its internal edges.",
  },
  {
    name: "instability", unit: "ratio", appliesTo: STRUCTURAL, rollup: "none", direction: "neutral",
    absent: "exclude", source: "degree",
    description: "fan_out / (fan_in + fan_out); written only when the node has an import edge.",
  },
  {
    name: "utilization", unit: "count", appliesTo: [...STRUCTURAL, "symbol"], rollup: "none", direction: "neutral",
    absent: "zero", source: "degree",
    description: "Inbound edges weighted by reference count over the barrel-resolved graph: how heavily a node is used.",
  },
];

/** Pure functions of one file's bytes (`source-metrics.ts`, `lcom.ts`), carried forward under reuse. */
const SOURCE: readonly MetricDescriptor[] = [
  {
    name: "loc", unit: "lines", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "source-metrics", description: "Non-blank lines in the file.",
  },
  {
    name: "function_count", unit: "count", appliesTo: FILE, rollup: "sum", direction: "neutral",
    absent: "zero", source: "source-metrics", description: "Functions, methods, and arrow functions declared in the file.",
  },
  {
    name: "cyclomatic_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics", description: "Highest cyclomatic complexity of any function in the file.",
  },
  {
    name: "cyclomatic_sum", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "source-metrics", description: "Cyclomatic complexity summed over the file's functions.",
  },
  {
    name: "cognitive_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics", description: "Highest cognitive complexity of any function in the file.",
  },
  {
    name: "cognitive_sum", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "source-metrics", description: "Cognitive complexity summed over the file's functions.",
  },
  {
    name: "max_nesting_depth", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics", description: "Deepest block nesting inside any function in the file.",
  },
  {
    name: "symbol_cognitive", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Cognitive complexity of the function a symbol names; the max when several functions share the name.",
  },
  {
    name: "symbol_cyclomatic", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Cyclomatic complexity of the function a symbol names; the max when several functions share the name.",
  },
  {
    name: "symbol_loc", unit: "lines", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Lines spanned by the function a symbol names, signature included; the max when several share the name.",
  },
  {
    name: "symbol_max_nesting", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Deepest block nesting inside the function a symbol names; the max when several share the name.",
  },
  {
    name: "symbol_comment_lines", unit: "lines", appliesTo: SYMBOL, rollup: "max", direction: "neutral",
    absent: "exclude", source: "source-metrics",
    description: "Rows holding a comment inside the function a symbol names, the docstring excluded; the max when several share the name.",
  },
  {
    name: "symbol_docstring_lines", unit: "lines", appliesTo: SYMBOL, rollup: "max", direction: "neutral",
    absent: "exclude", source: "source-metrics",
    description: "Rows of the function's docstring: the Python docstring, or the JSDoc block attached to a TypeScript declaration.",
  },
  {
    name: "symbol_body_lines", unit: "lines", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Non-blank rows of the function's body that hold code, comments and the docstring excluded.",
  },
  {
    name: "symbol_comment_ratio", unit: "ratio", appliesTo: SYMBOL, rollup: "max", direction: "neutral",
    absent: "exclude", source: "source-metrics",
    description: "symbol_comment_lines / max(symbol_body_lines, 1). High values suggest narration; zero is not a defect.",
  },
  {
    name: "symbol_narrating_comments", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Comments in the body whose words overlap the next statement's identifiers by 2 tokens or half the comment. A candidate signal.",
  },
  {
    name: "symbol_pass_through", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "1 when the function's body is one call forwarding every parameter, in order, as a bare argument; else 0.",
  },
  {
    name: "except_count", unit: "count", appliesTo: FILE, rollup: "sum", direction: "neutral",
    absent: "zero", source: "exception-handling", description: "Python except clauses and TypeScript catch clauses in the file.",
  },
  {
    name: "except_density", unit: "per100loc", appliesTo: FILE, rollup: "none", direction: "higher-worse",
    absent: "zero", source: "exception-handling", description: "except_count per 100 non-blank lines. Recompute from the sums for a group.",
  },
  {
    name: "swallowed_except", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "exception-handling",
    description: "Handlers whose body is empty, pass, ..., continue, a bare or empty return, or a single logging call. Exempts Python's `except ImportError`/`ModuleNotFoundError` (alone or paired), the standard optional-dependency idiom.",
  },
  {
    name: "class_count", unit: "count", appliesTo: FILE, rollup: "sum", direction: "neutral",
    absent: "zero", source: "lcom", description: "Classes declared in the file; written only when there is one.",
  },
  {
    name: "lcom4_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "lcom", description: "Highest LCOM4 of any class in the file; above 1 means the class could split.",
  },
];

/** Sparse per-file smells: a row only when the count clears the writer's floor. */
const SMELLS: readonly MetricDescriptor[] = [
  {
    name: "unreachable_statements", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "dead-code", description: "Statements after an unconditional return, throw, break, or continue. TypeScript only.",
  },
  {
    name: "unused_locals", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "dead-code", description: "Local bindings never read. TypeScript only.",
  },
  {
    name: "unused_params", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "dead-code", description: "Trailing parameters never read. TypeScript only.",
  },
  {
    name: "loop_depth", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "zero", source: "growth-risk", description: "Deepest lexical loop nesting; written at 2 or more.",
  },
  {
    name: "recursive_functions", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "growth-risk", description: "Functions that call themselves by name. TypeScript only.",
  },
  {
    name: "search_in_loop", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "growth-risk", description: "Linear searches such as .includes or .find inside a loop. TypeScript only.",
  },
];

/** Git-history metrics from `history-metrics.ts`; `{w}` is a window such as `30d` or `lifetime`. */
const HISTORY: readonly MetricDescriptor[] = [
  {
    name: "churn_{w}", unit: "lines", appliesTo: FILE, rollup: "sum", direction: "neutral",
    absent: "zero", source: "history", windowed: true, description: "Lines added plus deleted in the {w} window.",
  },
  {
    name: "churn_{w}_commits", unit: "count", appliesTo: FILE, rollup: "none", direction: "neutral",
    absent: "zero", source: "history", windowed: true,
    description: "Commits touching the file in the {w} window. A group's distinct commits are not the sum.",
  },
  {
    name: "churn_{w}_authors", unit: "count", appliesTo: FILE, rollup: "none", direction: "neutral",
    absent: "zero", source: "history", windowed: true,
    description: "Distinct authors of the file's commits in the {w} window. Not additive.",
  },
  {
    name: "recency_{w}", unit: "ratio", appliesTo: FILE, rollup: "none", direction: "neutral",
    absent: "exclude", source: "history", windowed: true,
    description: "min(1, file age / window) for a file that churned in the {w} window; 1 for lifetime. A hotspot discount.",
  },
  {
    name: "file_age_days", unit: "days", appliesTo: FILE, rollup: "max", direction: "neutral",
    absent: "exclude", source: "history", description: "Days since the file first appeared in git history.",
  },
  {
    name: "bus_factor_{w}", unit: "count", appliesTo: FILE, rollup: "none", direction: "lower-worse",
    absent: "exclude", source: "history", windowed: true,
    description: "Fewest authors covering half the file's churn in the {w} window.",
  },
  {
    name: "top_author_share_{w}", unit: "ratio", appliesTo: FILE, rollup: "none", direction: "higher-worse",
    absent: "exclude", source: "history", windowed: true,
    description: "Share of the file's churn in the {w} window written by its top author.",
  },
];

/** Test linking (`test-linker.ts`) and the Istanbul overlay (`coverage.ts`), keyed on source nodes. */
const TESTS: readonly MetricDescriptor[] = [
  {
    name: "linked_test_count", unit: "count", appliesTo: FILE, rollup: "none", direction: "lower-worse",
    absent: "zero", source: "test-linker",
    description: "Test files linked to this source. One test can link to several sources, so it does not sum.",
  },
  {
    name: "test_bus_factor_{w}", unit: "count", appliesTo: FILE, rollup: "none", direction: "lower-worse",
    absent: "exclude", source: "test-linker", windowed: true,
    description: "Bus factor of the churn on this source's linked tests in the {w} window.",
  },
  {
    name: "test_top_author_share_{w}", unit: "ratio", appliesTo: FILE, rollup: "none", direction: "higher-worse",
    absent: "exclude", source: "test-linker", windowed: true,
    description: "Top author's share of the churn on this source's linked tests in the {w} window.",
  },
  {
    name: "coverage_pct", unit: "percent", appliesTo: ["file", "symbol"], rollup: "none", direction: "lower-worse",
    absent: "exclude", source: "coverage",
    description: "Functions covered over functions total, from an ingested Istanbul report. Never written by the indexer.",
  },
];

/** Every metric name code-graph writes, with windowed names as `{w}` templates. */
export const METRIC_CATALOGUE: readonly MetricDescriptor[] = [...DEGREE, ...SOURCE, ...SMELLS, ...HISTORY, ...TESTS];
