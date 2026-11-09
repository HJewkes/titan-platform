import type { Node } from "web-tree-sitter";

/**
 * The tree-sitter node types and walkers behind cyclomatic complexity and nesting depth, kept in
 * one place so code-graph's source metrics and style-analyzer's complexity extractor count alike.
 */

/** TypeScript statements that open a nesting level. */
export const TS_NESTING_TYPES: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
]);

/** Python statements that open a nesting level. */
export const PY_NESTING_TYPES: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
]);

/** TypeScript nodes that each add one decision path. */
export const TS_BRANCH_TYPES: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

/** Python nodes that each add one decision path. */
export const PY_BRANCH_TYPES: ReadonlySet<string> = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
]);

export interface NestingOptions {
  /** Keep an `else if` chain at its `if`'s depth, as ESLint max-depth and Sonar do. */
  readonly flattenElseIf?: boolean;
}

function isPython(language: string): boolean {
  return language === "python";
}

/** True for a short-circuit `&&` or `||` binary expression, each of which adds a decision path. */
function isShortCircuitOperator(node: Node): boolean {
  if (node.type !== "binary_expression") return false;
  const op = node.childForFieldName("operator")?.text;
  return op === "&&" || op === "||";
}

function branchIncrement(node: Node, language: string): number {
  const branchTypes = isPython(language) ? PY_BRANCH_TYPES : TS_BRANCH_TYPES;
  let increment = branchTypes.has(node.type) ? 1 : 0;
  if (isShortCircuitOperator(node)) increment++;
  if (isPython(language) && node.type === "boolean_operator") increment++;
  return increment;
}

/** McCabe cyclomatic complexity of `body`: one plus every branch node and boolean operator under it. */
export function cyclomaticOf(body: Node, language: string): number {
  let complexity = 1;
  const visit = (node: Node): void => {
    complexity += branchIncrement(node, language);
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
  return complexity;
}

function isElseIf(parent: Node, child: Node): boolean {
  return parent.type === "else_clause" && child.type === "if_statement";
}

/** Deepest nesting level under `node`, starting from `depth`. */
export function nestingDepthOf(
  node: Node,
  language: string,
  depth = 0,
  options: NestingOptions = {},
): number {
  const nestingTypes = isPython(language) ? PY_NESTING_TYPES : TS_NESTING_TYPES;
  let maxDepth = depth;
  for (const child of node.namedChildren) {
    const opens = nestingTypes.has(child.type) && !(options.flattenElseIf === true && isElseIf(node, child));
    const childMax = nestingDepthOf(child, language, opens ? depth + 1 : depth, options);
    if (childMax > maxDepth) maxDepth = childMax;
  }
  return maxDepth;
}
