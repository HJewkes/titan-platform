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
    absent: "exclude", source: "source-metrics", description: "Highest cyclomatic complexity of any function in the file; points attention at branchy code.",
  },
  {
    name: "cyclomatic_sum", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "source-metrics", description: "Cyclomatic complexity summed over the file's functions; points attention at branchy code.",
  },
  {
    name: "cognitive_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics", description: "Highest cognitive complexity of any function in the file, an estimate of comprehension friction.",
  },
  {
    name: "cognitive_sum", unit: "count", appliesTo: FILE, rollup: "sum", direction: "higher-worse",
    absent: "zero", source: "source-metrics", description: "Cognitive complexity summed over the file's functions, an estimate of comprehension friction.",
  },
  {
    name: "max_nesting_depth", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics", description: "Deepest block nesting inside any function in the file.",
  },
  {
    name: "jsx_depth_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Deepest JSX element tree in the file: the max of symbol_jsx_depth over its functions and module-scope JSX. Written only when > 0.",
  },
  {
    name: "logic_cognitive_max", unit: "count", appliesTo: FILE, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Highest symbol_logic_cognitive over the file's JSX-rendering functions. Written only when one of them renders JSX.",
  },
  {
    name: "symbol_cognitive", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Cognitive complexity (comprehension friction) of the function a symbol names; the max when several functions share the name.",
  },
  {
    name: "symbol_cyclomatic", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Cyclomatic complexity (an attention pointer) of the function a symbol names; the max when several functions share the name.",
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
    name: "symbol_jsx_depth", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Most JSX elements on one ancestor chain in the function, fragments not counted. Walks into {…} and inline callbacks, stops at a nested named function; attribute JSX sits one below its owner. Written only when > 0.",
  },
  {
    name: "symbol_markup_cognitive", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Share of symbol_cognitive, nesting bonus included, charged inside JSX {…} expressions: conditional rendering and callbacks inline in JSX. Hook callbacks such as useMemo or useEffect stay logic, a deliberate departure from excluding every nested callback. Written only when symbol_jsx_depth > 0.",
  },
  {
    name: "symbol_logic_cognitive", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "symbol_cognitive minus symbol_markup_cognitive: the component's own logic, hook callbacks included. Written only when symbol_jsx_depth > 0.",
  },
  {
    name: "symbol_prop_count", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Own-declared props of a component (a PascalCase function with symbol_jsx_depth > 0): members of its first parameter's type, resolved within the file through extends and & clauses; types the file does not declare (HTMLAttributes<…>) add none. Absent when the props type is imported.",
  },
  {
    name: "symbol_bool_prop_count", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Own-declared component props typed boolean, or a union of true/false/boolean with undefined. Absent where symbol_prop_count is.",
  },
  {
    name: "symbol_unread_props", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "source-metrics",
    description: "Own-declared component props never read in the body: a destructured binding with no references, or a name no props.<name> access reads. 0 when a ...rest element or the whole props object forwards them. Absent where symbol_prop_count is.",
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
    name: "symbol_caller_count", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "neutral",
    absent: "exclude", source: "call-graph",
    description: "Distinct symbols, or files at module level, with a resolved call to this function, method or class. Unresolved calls are not counted.",
  },
  {
    name: "symbol_single_caller_helper", unit: "count", appliesTo: SYMBOL, rollup: "sum", direction: "higher-worse",
    absent: "exclude", source: "call-graph",
    description: "1 when a non-exported symbol has exactly one resolved caller and that caller is a symbol; else 0.",
  },
  {
    name: "symbol_constant_params", unit: "count", appliesTo: SYMBOL, rollup: "max", direction: "higher-worse",
    absent: "exclude", source: "call-graph",
    description: "Parameters that every one of at least 2 resolved call sites passes the same literal, or never passes. Rest and keyword-splat parameters are ignored.",
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
    description: "min(1, file age / window) for a file that churned in the {w} window; 1 for lifetime. Discounts the hotspot score, churn × complexity after Adam Tornhill and CodeScene.",
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

const kindFlag = (name: string, description: string, absent: "zero" | "exclude" = "exclude"): MetricDescriptor => ({
  name, unit: "count", appliesTo: SYMBOL, rollup: "sum", direction: "neutral", absent, source: "test-kinds", description,
});

const testCount = (name: string, direction: "lower-worse" | "higher-worse" | "neutral", description: string): MetricDescriptor => ({
  name, unit: "count", appliesTo: SYMBOL, rollup: "none", direction, absent: "zero", source: "test-kinds",
  description: `${description} Counts test functions reaching the symbol through calls edges (a click CliRunner's invoke(cmd, ...) counts as a call to cmd, the group alone for a group); written only where a test reaches it.`,
});

/**
 * Python code kinds and test kinds (`test-kinds.ts`, TP-2170). Facts only: which kinds need which tests is a
 * consumer's policy. Each `symbol_kind_*` is 0 or 1 on a function outside a test file, and each `test_kind_*`
 * 0 or 1 on a pytest test function.
 */
const TEST_KINDS: readonly MetricDescriptor[] = [
  kindFlag("symbol_kind_parser", "1 when the function's own name (a method's too) says parse, decode, deserialize, tokenize, lex or loads, or it calls json, yaml, toml, csv, ast.literal_eval or struct.unpack decoding."),
  kindFlag("symbol_kind_io", "1 when the function itself calls open; a method only paths and files have (read_text, write_text, mkdir, unlink, open and the like) on any receiver; a method str or other types share (replace, rename, glob, read) on a proven Path (a Path(...) call, a name bound to one, or a Path-annotated parameter); os (path arithmetic aside), subprocess, socket, shutil, requests, httpx or urllib.request."),
  kindFlag("symbol_output_signal", "1 when the function itself prints, writes sys.stdout, echoes through click or typer, builds an argparse parser, carries a click, typer, Flask or FastAPI command or route decorator, or is called in its file's __main__ guard."),
  kindFlag("symbol_state_writes", "1 when the function declares global or nonlocal, or assigns into or mutates (append, update and the like) state it does not own: a module-level name it does not rebind, self, cls or a parameter."),
  {
    name: "symbol_unlisted_calls", unit: "count", appliesTo: SYMBOL, rollup: "sum", direction: "neutral",
    absent: "exclude", source: "test-kinds",
    description: "Calls in the function the purity allow-list does not cover: pure builtins, math, re, json.dumps and the like, methods only str has on any receiver, and methods str, list or dict share with stateful types (replace, copy, join, keys, get) or mutators only on a local proven to hold such a value (every binding of it a plain assignment from a literal, a value-typed builtin such as str or sorted, or another value). A function handed to map, filter, functools.reduce or a key= argument counts as a call to it. symbol_kind_pure needs a resolved calls edge for every one.",
  },
  kindFlag("symbol_kind_output_boundary", "1 when symbol_output_signal is, or a pyproject console script or a module-level call in a __main__.py starts the function."),
  kindFlag("symbol_kind_pure", "1 when the function is no parser, and neither it nor any function it reaches through calls edges does I/O, writes state it does not own, is an output boundary, or makes a call that is neither on the allow-list nor resolved to a source function. An unresolved call means not pure."),
  kindFlag("test_kind_snapshot", "1 when the test takes a syrupy or pytest-regressions fixture, calls approvaltests verify, or compares with == against snapshot, or compares one file read with another (a golden file). A file read compared with a literal or a variable is exact output."),
  kindFlag("test_kind_exact_output", "1 when the test asserts == on a value (not a length, shape, exit status, snapshot or round trip), or calls a unittest assertEqual family method."),
  kindFlag("test_kind_loose_output", "1 when the test's output assertions are all loose (in, startswith, a length or shape, a comparison or truthiness) and none is exact, snapshot or round trip."),
  kindFlag("test_kind_error_path", "1 when the test uses pytest.raises or assertRaises, or asserts a non-zero exit_code, returncode or .code attribute, or an HTTP error status_code."),
  kindFlag("test_kind_property", "1 when the test is decorated with hypothesis @given."),
  kindFlag("test_kind_roundtrip", "1 when the test asserts f(g(x)) == x."),
  testCount("symbol_tests_snapshot", "lower-worse", "Snapshot, approval or golden-file tests (test_kind_snapshot) reaching the symbol."),
  testCount("symbol_tests_exact_output", "lower-worse", "Exact-output tests (test_kind_exact_output) reaching the symbol."),
  testCount("symbol_tests_loose_output_only", "higher-worse", "Tests whose output assertions are all loose (test_kind_loose_output) reaching the symbol."),
  testCount("symbol_tests_error_path", "lower-worse", "Error-path tests (test_kind_error_path) reaching the symbol."),
  testCount("symbol_tests_property", "neutral", "Property tests (test_kind_property) reaching the symbol."),
  testCount("symbol_tests_roundtrip", "lower-worse", "Round-trip tests (test_kind_roundtrip) reaching the symbol."),
];

/** Every metric name code-graph writes, with windowed names as `{w}` templates. */
export const METRIC_CATALOGUE: readonly MetricDescriptor[] = [
  ...DEGREE, ...SOURCE, ...SMELLS, ...HISTORY, ...TESTS, ...TEST_KINDS,
];
