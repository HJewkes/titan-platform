import type { ParsedFile } from "@titan-design/code-parser";
import type { Node } from "web-tree-sitter";
import type { GraphMetric } from "../types.js";
import { pythonDeadCode, type DeadCodeCounts } from "./dead-code-python.js";

/**
 * Function-local dead-code metrics (C-65 Phase 1). Pure functions of one file's
 * bytes — the same class as the source metrics in source-metrics.ts — so they
 * ride the content-hash incremental reuse gate. Kept in their own module (not
 * appended to source-metrics.ts) so the already-churn-hot source-metrics.ts is
 * not touched; the reuse machinery folds these names in alongside
 * SOURCE_METRIC_NAMES (see incremental.ts) and index-metrics.ts computes them
 * fresh for (re)parsed files.
 */
export const DEAD_CODE_METRIC_NAMES: ReadonlySet<string> = new Set([
  "unreachable_statements",
  "unused_locals",
  "unused_params",
]);

const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "method_definition",
  "generator_function_declaration",
  "generator_function",
]);

const PARAM_TYPES = new Set(["required_parameter", "optional_parameter"]);

/** Statements that unconditionally end control flow in their block. */
const TERMINALS = new Set([
  "return_statement",
  "throw_statement",
  "break_statement",
  "continue_statement",
]);

/**
 * Per-file dead-code metrics for TypeScript and Python files (Python since
 * TP-318, in dead-code-python.ts). Emitted sparsely — only when a count is > 0 —
 * so a clean file adds no rows (a full index and an incremental re-index
 * therefore produce the identical metric set). Other languages are skipped.
 */
export function computeDeadCodeMetrics(
  files: readonly ParsedFile[],
  fileIdOf: (filePath: string) => string,
): GraphMetric[] {
  const out: GraphMetric[] = [];
  for (const file of files) {
    const counts = deadCodeOf(file);
    if (!counts) continue;
    const id = fileIdOf(file.filePath);
    const { unreachable, locals, params } = counts;
    if (unreachable > 0) {
      out.push({ nodeId: id, name: "unreachable_statements", value: unreachable, unit: "count" });
    }
    if (locals > 0) {
      out.push({ nodeId: id, name: "unused_locals", value: locals, unit: "count" });
    }
    if (params > 0) {
      out.push({ nodeId: id, name: "unused_params", value: params, unit: "count" });
    }
  }
  return out;
}

function deadCodeOf(file: ParsedFile): DeadCodeCounts | null {
  const root = file.tree.rootNode;
  if (file.language === "python") return pythonDeadCode(root);
  if (file.language !== "typescript" && file.language !== "tsx") return null;
  return { unreachable: countUnreachable(root), ...countUnusedBindings(root) };
}

/**
 * Count statements that can never execute: those following an unconditional
 * terminal (`return`/`throw`/`break`/`continue`) inside the SAME
 * `statement_block`. Deliberately shallow — no CFG — so it only claims the
 * decidable case and stays near-zero false-positive:
 * - `switch` bodies are not plain blocks (fallthrough / `case` labels), so their
 *   statements are never in a `statement_block` here and aren't counted.
 * - Anything after a conditional (an `if` with no guaranteed terminal) is not
 *   counted, because the terminal must be a direct child of the block.
 * - A `function_declaration` after a terminal is hoisted (callable before the
 *   terminal), so it is excluded; comments are ignored too.
 */
function countUnreachable(root: Node): number {
  let count = 0;
  const visit = (node: Node): void => {
    if (node.type === "statement_block") count += unreachableInBlock(node);
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return count;
}

function unreachableInBlock(block: Node): number {
  let seenTerminal = false;
  let count = 0;
  for (const child of block.namedChildren) {
    if (!child) continue;
    if (
      seenTerminal &&
      child.type !== "comment" &&
      child.type !== "function_declaration"
    ) {
      count++;
    }
    if (TERMINALS.has(child.type)) seenTerminal = true;
  }
  return count;
}

/**
 * Count unused *local variables* and *parameters* across every function in the
 * file, function-locally and conservatively (bias to NOT flag — false positives
 * are worse than misses for a health signal). Each function is analysed
 * independently; a binding is "unused" when its name is never referenced within
 * the function's subtree (nested closures included).
 *
 * Only PLAIN-identifier bindings are considered — destructuring/rest/pattern
 * params and locals are treated as always-used and never flagged (their
 * omit-some-keys usage is usually deliberate, and reasoning about them soundly
 * needs a scope tree). Further cuts: `_`-prefixed names (intentional-ignore) are
 * skipped; a name declared more than once anywhere in the function (shadowing) is
 * skipped rather than risk a wrong count; and an unused parameter is only counted
 * when every parameter after it is also unused (TS6133's rule — you can't drop a
 * middle parameter, only a trailing run).
 */
function countUnusedBindings(root: Node): { locals: number; params: number } {
  let locals = 0;
  let params = 0;
  const visit = (node: Node): void => {
    if (FUNCTION_TYPES.has(node.type)) {
      const r = analyzeFunction(node);
      locals += r.locals;
      params += r.params;
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return { locals, params };
}

function analyzeFunction(fn: Node): { locals: number; params: number } {
  // All plain-id binding declarations in the subtree (own + nested): their nodes
  // are excluded from reference counts, and a name seen twice marks a shadow.
  const declIds = new Set<number>();
  const nameCount = new Map<string, number>();
  collectBindingDecls(fn, declIds, nameCount);

  const refs = new Map<string, number>();
  countReferences(fn, declIds, refs);

  const isUnused = (name: string): boolean =>
    !name.startsWith("_") &&
    (nameCount.get(name) ?? 0) <= 1 &&
    (refs.get(name) ?? 0) === 0;

  // Params: only the trailing run of unused params counts (TS6133 middle-param rule).
  const paramNames = ownParamNames(fn);
  let params = 0;
  for (let i = paramNames.length - 1; i >= 0; i--) {
    const name = paramNames[i] ?? null;
    if (name !== null && isUnused(name)) params++;
    else break;
  }

  let locals = 0;
  for (const name of ownLocalNames(fn)) {
    if (isUnused(name)) locals++;
  }
  return { locals, params };
}

/**
 * Ordered parameter names of a function's `formal_parameters`. A non-plain
 * parameter (destructuring/rest) yields `null` — a position we never flag and
 * which stops the trailing-unused run (you can't drop params after it).
 * Bare single-identifier arrow params (`x => …`, no parens) are not analysed.
 */
function ownParamNames(fn: Node): (string | null)[] {
  const params = fn.childForFieldName("parameters");
  if (!params) return [];
  const out: (string | null)[] = [];
  for (const p of params.namedChildren) {
    if (!p || !PARAM_TYPES.has(p.type)) continue;
    const first = p.namedChild(0);
    out.push(first?.type === "identifier" ? first.text : null);
  }
  return out;
}

/**
 * Names of plain-identifier locals declared in the function's OWN scope — walking
 * the body but not descending into nested functions (those bindings belong to the
 * nested function). Destructuring declarators are skipped.
 */
function ownLocalNames(fn: Node): string[] {
  const body = fn.childForFieldName("body");
  if (!body) return [];
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (FUNCTION_TYPES.has(node.type)) return;
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") out.push(name.text);
    }
    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(body);
  return out;
}

/** Record every plain-id binding declaration node (param/local, own + nested). */
function collectBindingDecls(
  fn: Node,
  ids: Set<number>,
  nameCount: Map<string, number>,
): void {
  const mark = (n: Node | null): void => {
    if (n?.type !== "identifier") return;
    ids.add(n.id);
    nameCount.set(n.text, (nameCount.get(n.text) ?? 0) + 1);
  };
  const walk = (node: Node): void => {
    if (PARAM_TYPES.has(node.type)) mark(node.namedChild(0));
    else if (node.type === "variable_declarator") mark(node.childForFieldName("name"));
    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(fn);
}

/** Count value references (identifier / object-shorthand) by name, minus declarations. */
function countReferences(
  fn: Node,
  declIds: ReadonlySet<number>,
  out: Map<string, number>,
): void {
  const walk = (node: Node): void => {
    if (
      (node.type === "identifier" ||
        node.type === "shorthand_property_identifier") &&
      !declIds.has(node.id)
    ) {
      out.set(node.text, (out.get(node.text) ?? 0) + 1);
    }
    for (const child of node.namedChildren) {
      if (child) walk(child);
    }
  };
  walk(fn);
}
