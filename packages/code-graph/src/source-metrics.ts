import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import { cognitiveComplexityOf } from "./cognitive-complexity.js";
import { computeLcomMetrics } from "./lcom.js";
import { qualify, walkScopes } from "./scope-path.js";
import { SYMBOL_METRIC_NAMES, symbolMetrics, type FunctionStats } from "./symbol-metrics.js";
import type { GraphMetric } from "./types.js";

const TS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "method_definition",
]);

const PY_FUNCTION_TYPES = new Set(["function_definition"]);

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
  "class_count",
  "lcom4_max",
  // Per-symbol complexity, loc and nesting (C-58, C-64, TP-317), keyed
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
  out.push(...symbolMetrics(nodeId, stats, symbolNames));
  out.push(...computeLcomMetrics(file, nodeId));
  return out;
}

function countLoc(content: string): number {
  return content.split("\n").filter((l) => l.trim() !== "").length;
}

function analyzeFunctions(file: ParsedFile): FunctionStats[] {
  const stats: FunctionStats[] = [];
  const fnTypes =
    file.language === "python" ? PY_FUNCTION_TYPES : TS_FUNCTION_TYPES;
  walkScopes(file.tree.rootNode, file.language === "python", (node, scope) => {
    const fn = functionAt(node, fnTypes);
    if (!fn) return;
    stats.push({
      name: fn.name === null ? null : qualify(scope, fn.name),
      cyclomatic: cyclomaticOf(fn.body, file.language),
      cognitive: cognitiveComplexityOf(fn.body, file.language),
      nestingDepth: nestingDepthOf(fn.body, file.language, 0),
      loc: fn.node.endPosition.row - fn.node.startPosition.row + 1,
    });
  });
  return stats;
}

/**
 * A named, standalone function at this node, with its body and declared name —
 * or null. Covers declarations/methods (name on the node) and, crucially,
 * arrow / function-expression bound to a `const`/`let` (`export const foo =
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
  if (
    (node.type === "arrow_function" || node.type === "function_expression") &&
    node.parent?.type === "variable_declarator"
  ) {
    const body = node.childForFieldName("body");
    if (!body) return null;
    return { name: node.parent.childForFieldName("name")?.text ?? null, body, node };
  }
  return null;
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
