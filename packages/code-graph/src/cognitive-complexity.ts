import type { Node } from "web-tree-sitter";

/**
 * Cognitive complexity per Sonarsource ("Cognitive Complexity: A new way of
 * measuring understandability"). Compared to cyclomatic, this:
 *
 * - Doesn't grow per `case` in a switch — the switch counts once.
 * - Adds a nesting bonus: nested control structures cost more than flat ones.
 * - Treats `else if` chains as one increment each, not as nested ifs.
 *
 * Returns the score for a function body. Caller drives the per-function loop.
 */
export function cognitiveComplexityOf(body: Node, language: string): number {
  const handler = language === "python" ? PY_HANDLER : TS_HANDLER;
  return scoreNode(body, 0, handler);
}

interface LanguageHandler {
  /** Returns the nesting-charged increment (+1 + nesting), or 0 if the node
   *  isn't a complexity contributor. */
  structuralIncrement: (node: Node, nesting: number) => number;
  /** True if this node increases nesting depth for its descendants. */
  isNesting: (node: Node) => boolean;
  /** Flat +1 increments (no nesting bonus): logical operators, `else`, etc. */
  flatIncrement: (node: Node) => number;
}

const TS_STRUCTURAL = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "catch_clause",
  "ternary_expression",
]);

const PY_STRUCTURAL = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
  // elif_clause is intentionally NOT here — it's a flat continuation of an
  // existing if (counted in flatIncrement). Including it would charge both
  // a structural and a flat +1.
]);

const TS_NESTING = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "catch_clause",
  "function_declaration",
  "method_definition",
  "arrow_function",
]);

const PY_NESTING = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "except_clause",
  "function_definition",
  "lambda",
]);

const TS_HANDLER: LanguageHandler = {
  structuralIncrement(node, nesting) {
    return TS_STRUCTURAL.has(node.type) ? 1 + nesting : 0;
  },
  isNesting(node) {
    return TS_NESTING.has(node.type);
  },
  flatIncrement(node) {
    if (node.type === "else_clause") return 1;
    if (
      node.type === "binary_expression" &&
      isLogicalOp(node) &&
      !isInnerOfSameOpChain(node, "binary_expression")
    ) {
      return 1;
    }
    return 0;
  },
};

const PY_HANDLER: LanguageHandler = {
  structuralIncrement(node, nesting) {
    return PY_STRUCTURAL.has(node.type) ? 1 + nesting : 0;
  },
  isNesting(node) {
    return PY_NESTING.has(node.type);
  },
  flatIncrement(node) {
    if (node.type === "elif_clause" || node.type === "else_clause") return 1;
    if (
      node.type === "boolean_operator" &&
      !isInnerOfSameOpChain(node, "boolean_operator")
    ) {
      return 1;
    }
    return 0;
  },
};

function isLogicalOp(node: Node): boolean {
  const op = node.childForFieldName("operator");
  return !!op && (op.text === "&&" || op.text === "||");
}

/**
 * Per Sonarsource: a sequence of like binary logical operators counts once,
 * not per occurrence. `a && b && c` is one chain (+1), not two (+2). Skip
 * the increment when this node's operator matches its parent's operator —
 * the outer node already counted the chain.
 */
function isInnerOfSameOpChain(node: Node, parentType: string): boolean {
  const parent = node.parent;
  if (!parent || parent.type !== parentType) return false;
  const op = node.childForFieldName("operator")?.text;
  const parentOp = parent.childForFieldName("operator")?.text;
  return !!op && op === parentOp;
}

/**
 * A nested if under an else_clause is part of an `else if` chain — the
 * else_clause already counted +1, and treating it as a nested if would
 * double-charge AND inflate the nesting bonus. Skip both.
 */
function isElseIf(node: Node): boolean {
  if (node.type !== "if_statement" && node.type !== "elif_clause") return false;
  const parent = node.parent;
  return !!parent && parent.type === "else_clause";
}

function scoreNode(
  node: Node,
  nesting: number,
  handler: LanguageHandler,
): number {
  const elseIf = isElseIf(node);
  const structural = elseIf ? 0 : handler.structuralIncrement(node, nesting);
  const flat = handler.flatIncrement(node);
  const childNesting =
    !elseIf && handler.isNesting(node) ? nesting + 1 : nesting;

  let score = structural + flat;
  for (const child of node.namedChildren) {
    if (child) score += scoreNode(child, childNesting, handler);
  }
  return score;
}
