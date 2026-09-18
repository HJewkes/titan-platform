import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import type { GraphMetric } from "../types.js";

/**
 * Growth-risk / scaling-smell metrics (C-66 Phase 2). Cheap, function-local
 * *heuristics* — NOT Big-O or a proven complexity class (real asymptotic
 * inference is undecidable; see the roadmap's hard NO). Pure functions of one
 * file's bytes, so they ride the content-hash incremental reuse gate, folded
 * into the carry-forward set in incremental.ts alongside the source/dead-code
 * metric names. Emitted sparsely (only when a smell is present).
 */
export const GROWTH_RISK_METRIC_NAMES: ReadonlySet<string> = new Set([
  "loop_depth",
  "recursive_functions",
  "search_in_loop",
]);

const TS_LOOP_TYPES = new Set([
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
]);

const PY_LOOP_TYPES = new Set(["for_statement", "while_statement"]);

const NAMED_FN_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "function_definition",
]);

/**
 * Array/collection methods that scan linearly — inside a loop they turn an O(n)
 * pass into an O(n·m) one (a scaling smell). `.includes`/`.indexOf` on a `Set`
 * or `Map` are O(1), so this is a heuristic, not a bound.
 */
const SEARCH_METHODS = new Set([
  "includes",
  "indexOf",
  "lastIndexOf",
  "find",
  "findIndex",
  "some",
  "every",
  "filter",
]);

/**
 * Per-file growth-risk metrics for TS/Python files, all SMELLS not bounds:
 * - `loop_depth` — max *lexical* loop nesting (triple-nested → 3), emitted at
 *   depth ≥ 2 (depth-2 loops over two *different* collections are actually linear).
 * - `recursive_functions` — named functions that call themselves directly.
 * - `search_in_loop` — linear-scan method calls (`.includes`/`.find`/…) inside a
 *   loop (an O(n) scan per iteration; `.includes` on a `Set` is O(1)).
 * All emitted sparsely (only when present). Non-TS/Python files are skipped.
 */
export function computeGrowthRiskMetrics(
  files: readonly ParsedFile[],
  fileIdOf: (filePath: string) => string,
): GraphMetric[] {
  const out: GraphMetric[] = [];
  for (const file of files) {
    const loopTypes = file.language === "python" ? PY_LOOP_TYPES : TS_LOOP_TYPES;
    const root = file.tree.rootNode;
    const id = fileIdOf(file.filePath);
    const depth = maxLoopDepth(root, loopTypes, 0);
    if (depth >= 2) {
      out.push({ nodeId: id, name: "loop_depth", value: depth, unit: "count" });
    }
    const recursion = countDirectRecursion(root);
    if (recursion > 0) {
      out.push({ nodeId: id, name: "recursive_functions", value: recursion, unit: "count" });
    }
    const searches = countSearchInLoop(root, loopTypes, false);
    if (searches > 0) {
      out.push({ nodeId: id, name: "search_in_loop", value: searches, unit: "count" });
    }
  }
  return out;
}

/**
 * Count named functions that call themselves directly by name — a recursion flag
 * (unbounded recursion is a scaling risk). Function-local and conservative: only
 * a plain `name(...)` call inside the same function counts; method self-calls
 * via `this.m()` and mutual recursion (which would need a call graph — a roadmap
 * hard NO) are out of scope. A name shadowed by a nested same-named function is
 * not distinguished (rare).
 */
function countDirectRecursion(root: Node): number {
  let count = 0;
  const visit = (node: Node): void => {
    if (NAMED_FN_TYPES.has(node.type)) {
      const name = node.childForFieldName("name")?.text;
      const body = node.childForFieldName("body");
      if (name && body && callsName(body, name)) count++;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return count;
}

/** Whether `node`'s subtree contains a direct call `name(...)`. */
function callsName(node: Node, name: string): boolean {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "identifier" && fn.text === name) return true;
  }
  for (const child of node.namedChildren) {
    if (child && callsName(child, name)) return true;
  }
  return false;
}

/**
 * Count linear-scan method calls (`.includes`/`.find`/…) that occur inside a
 * loop — an O(n) search per iteration, a quadratic-shaped smell. `inLoop`
 * tracks whether the current node is lexically inside a loop body.
 */
function countSearchInLoop(
  node: Node,
  loopTypes: ReadonlySet<string>,
  inLoop: boolean,
): number {
  let count = 0;
  if (inLoop && node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    const prop = fn?.type === "member_expression" ? fn.childForFieldName("property") : null;
    if (prop && SEARCH_METHODS.has(prop.text)) count++;
  }
  const childInLoop = inLoop || loopTypes.has(node.type);
  for (const child of node.namedChildren) {
    if (child) count += countSearchInLoop(child, loopTypes, childInLoop);
  }
  return count;
}

/** Deepest lexical nesting of loop constructs under `node`. */
function maxLoopDepth(
  node: Node,
  loopTypes: ReadonlySet<string>,
  depth: number,
): number {
  let max = depth;
  for (const child of node.namedChildren) {
    if (!child) continue;
    const next = loopTypes.has(child.type) ? depth + 1 : depth;
    const childMax = maxLoopDepth(child, loopTypes, next);
    if (childMax > max) max = childMax;
  }
  return max;
}
