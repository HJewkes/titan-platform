import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import { EXCEPTION_METRIC_NAMES, exceptionMetrics } from "./analysis/exception-handling.js";
import { jsxDepthOf } from "./analysis/jsx-metrics.js";
import { cognitiveSplitOf } from "./cognitive-complexity.js";
import { computeLcomMetrics } from "./lcom.js";
import { PY_FUNCTION_TYPES, TS_BOUND_FUNCTION_TYPES, TS_FUNCTION_DECL_TYPES } from "./node-kinds.js";
import { qualify, walkScopes } from "./scope-path.js";
import { functionShapeStats, SYMBOL_METRIC_NAMES, symbolMetrics, type FunctionStats } from "./symbol-metrics.js";
import type { GraphMetric } from "./types.js";

const TS_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
]);

const PY_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
]);

const TS_BRANCH_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const PY_BRANCH_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
]);

/**
 * Names of every metric `computeSourceMetrics` can emit. These are pure
 * functions of a file's content, so the incremental indexer can carry them
 * forward unchanged for a byte-identical file instead of re-parsing it. If a
 * new source metric is added above, add its name here — the incremental
 * round-trip test will fail loudly if this set drifts out of sync.
 */
export const SOURCE_METRIC_NAMES: ReadonlySet<string> = new Set([
  "loc",
  "function_count",
  "cyclomatic_max",
  "cyclomatic_sum",
  "cognitive_max",
  "cognitive_sum",
  "max_nesting_depth",
  "jsx_depth_max",
  "logic_cognitive_max",
  "class_count",
  "lcom4_max",
  ...EXCEPTION_METRIC_NAMES,
  // Per-symbol complexity, size, comments and shape (C-58, C-64, TP-317, TP-322), keyed
  // to `symbol` node ids. Source-local like the file-level metrics above, so an
  // unchanged file carries them forward — but their nodeId is `<fileId>#<name>`,
  // so the reuse basis buckets them under the symbol's parent file (incremental.ts).
  ...SYMBOL_METRIC_NAMES,
]);

const EMPTY_NAMES: ReadonlySet<string> = new Set();

/**
 * Per-file source metrics. `symbolNamesByFile` maps a file id to the names of
 * the `symbol` nodes it declares; when supplied, per-function complexity is
 * emitted on those symbol nodes (C-58; all declared functions since C-64). It
 * defaults to empty, so existing callers/tests that don't thread the symbol
 * layer keep emitting only file-level metrics.
 */
export function computeSourceMetrics(
  files: readonly ParsedFile[],
  fileIdOf: (filePath: string) => string,
  symbolNamesByFile: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): GraphMetric[] {
  const out: GraphMetric[] = [];
  for (const file of files) {
    const id = fileIdOf(file.filePath);
    out.push(...metricsForFile(id, file, symbolNamesByFile.get(id) ?? EMPTY_NAMES));
  }
  return out;
}

function metricsForFile(
  nodeId: string,
  file: ParsedFile,
  symbolNames: ReadonlySet<string>,
): GraphMetric[] {
  const out: GraphMetric[] = [];
  const loc = countLoc(file.content);
  out.push({ nodeId, name: "loc", value: loc, unit: "lines" });

  const stats = analyzeFunctions(file);
  out.push({
    nodeId,
    name: "function_count",
    value: stats.length,
    unit: "count",
  });

  if (stats.length > 0) {
    out.push({
      nodeId,
      name: "cyclomatic_max",
      value: Math.max(...stats.map((s) => s.cyclomatic)),
      unit: "count",
    });
    out.push({
      nodeId,
      name: "cyclomatic_sum",
      value: stats.reduce((acc, s) => acc + s.cyclomatic, 0),
      unit: "count",
    });
    out.push({
      nodeId,
      name: "cognitive_max",
      value: Math.max(...stats.map((s) => s.cognitive)),
      unit: "count",
    });
    out.push({
      nodeId,
      name: "cognitive_sum",
      value: stats.reduce((acc, s) => acc + s.cognitive, 0),
      unit: "count",
    });
    out.push({
      nodeId,
      name: "max_nesting_depth",
      value: Math.max(...stats.map((s) => s.nestingDepth)),
      unit: "count",
    });
  }
  const jsxDepthMax = Math.max(jsxDepthIn(file, file.tree.rootNode), ...stats.map((s) => s.jsxDepth));
  if (jsxDepthMax > 0) out.push({ nodeId, name: "jsx_depth_max", value: jsxDepthMax, unit: "count" });
  out.push(...logicCognitiveMax(nodeId, stats));
  out.push(...symbolMetrics(nodeId, stats, symbolNames));
  out.push(...computeLcomMetrics(file, nodeId));
  out.push(...exceptionMetrics(nodeId, file.tree.rootNode, loc));
  return out;
}

/** Max logic cognitive over the file's JSX-rendering functions; nothing when none renders JSX. */
function logicCognitiveMax(nodeId: string, stats: readonly FunctionStats[]): GraphMetric[] {
  const rendering = stats.filter((s) => s.jsxDepth > 0);
  if (rendering.length === 0) return [];
  const value = Math.max(...rendering.map((s) => s.logicCognitive));
  return [{ nodeId, name: "logic_cognitive_max", value, unit: "count" }];
}

function countLoc(content: string): number {
  return content.split("\n").filter((l) => l.trim() !== "").length;
}

function analyzeFunctions(file: ParsedFile): FunctionStats[] {
  const stats: FunctionStats[] = [];
  const fnTypes =
    file.language === "python" ? PY_FUNCTION_TYPES : TS_FUNCTION_DECL_TYPES;
  const lines = file.content.split("\n");
  walkScopes(file.tree.rootNode, file.language === "python", (node, scope) => {
    const fn = functionAt(node, fnTypes);
    if (!fn) return;
    const cognitive = cognitiveSplitOf(fn.body, file.language);
    stats.push({
      name: fn.name === null ? null : qualify(scope, fn.name),
      cyclomatic: cyclomaticOf(fn.body, file.language),
      cognitive: cognitive.total,
      markupCognitive: cognitive.markup,
      logicCognitive: cognitive.total - cognitive.markup,
      nestingDepth: nestingDepthOf(fn.body, file.language, 0),
      jsxDepth: jsxDepthIn(file, fn.body),
      loc: fn.node.endPosition.row - fn.node.startPosition.row + 1,
      ...functionShapeStats(fn.node, fn.body, lines),
    });
  });
  return stats;
}

/**
 * A named, standalone function at this node, with its body and declared name —
 * or null. Covers declarations/methods (name on the node) and, crucially,
 * arrow, function or generator expression bound to a `const`/`let` (`export const foo =
 * () => {}`), where the name lives on the enclosing variable_declarator. Those
 * bindings were previously invisible to the analyzer (C-58) — a real complexity
 * under-count in an arrow-heavy codebase. Anonymous inline callbacks (parent is
 * a call, not a declarator) are intentionally excluded: their control flow
 * already rolls into the enclosing function's cognitive score.
 */
function functionAt(
  node: Node,
  fnTypes: ReadonlySet<string>,
): { name: string | null; body: Node; node: Node } | null {
  if (fnTypes.has(node.type)) {
    const body = node.childForFieldName("body");
    return body ? { name: node.childForFieldName("name")?.text ?? null, body, node } : null;
  }
  if (TS_BOUND_FUNCTION_TYPES.has(node.type) && node.parent?.type === "variable_declarator") {
    const body = node.childForFieldName("body");
    if (!body) return null;
    return { name: node.parent.childForFieldName("name")?.text ?? null, body, node };
  }
  return null;
}

/** JSX depth under `root`, stopping at each nested function `analyzeFunctions` scores on its own. Python has no JSX. */
function jsxDepthIn(file: ParsedFile, root: Node): number {
  if (file.language === "python") return 0;
  return jsxDepthOf(root, (node) => functionAt(node, TS_FUNCTION_DECL_TYPES) !== null);
}

function nestingDepthOf(node: Node, language: string, depth: number): number {
  const nestingTypes =
    language === "python" ? PY_NESTING_TYPES : TS_NESTING_TYPES;
  let maxDepth = depth;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const next = nestingTypes.has(child.type) ? depth + 1 : depth;
    const childMax = nestingDepthOf(child, language, next);
    if (childMax > maxDepth) maxDepth = childMax;
  }
  return maxDepth;
}

function cyclomaticOf(body: Node, language: string): number {
  const branchTypes =
    language === "python" ? PY_BRANCH_TYPES : TS_BRANCH_TYPES;
  let complexity = 1;
  const visit = (node: Node): void => {
    if (branchTypes.has(node.type)) complexity++;
    if (node.type === "binary_expression") {
      const op = node.childForFieldName("operator");
      if (op && (op.text === "&&" || op.text === "||")) complexity++;
    }
    if (language === "python" && node.type === "boolean_operator") {
      complexity++;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(body);
  return complexity;
}
