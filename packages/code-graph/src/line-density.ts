import type { Node } from "web-tree-sitter";
import type { GraphMetric } from "./types.js";

/**
 * Line-density metrics (TP-2474 k): how much each line carries. Agents under a line
 * cap pack conditions onto fewer, longer lines, which keeps SLOC low while the code
 * gets no simpler. Pure functions of one file's bytes, written on every file, zeros
 * included, so percentiles over a snapshot see the clean files too.
 */
export const LINE_DENSITY_METRIC_NAMES: readonly string[] = [
  "long_line_share_160",
  "chars_per_sloc",
  "bool_ops_per_line",
];

const LONG_LINE_CHARS = 160;
const SHORT_CIRCUIT_OPERATORS = new Set(["&&", "||", "??"]);
const CONDITIONAL_TYPES = new Set(["ternary_expression", "conditional_expression", "boolean_operator"]);

/** `content` gives the line widths; `root` gives the operators, so text inside strings and comments never counts. */
export function lineDensityMetrics(nodeId: string, content: string, root: Node): GraphMetric[] {
  const lines = content.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.trim() !== "");
  const sloc = lines.length;
  const perLine = (n: number): number => (sloc === 0 ? 0 : n / sloc);
  const longLines = lines.filter((l) => l.length > LONG_LINE_CHARS).length;
  const chars = lines.reduce((acc, l) => acc + l.trim().length, 0);
  return [
    { nodeId, name: "long_line_share_160", value: perLine(longLines), unit: "ratio" },
    { nodeId, name: "chars_per_sloc", value: perLine(chars), unit: "ratio" },
    { nodeId, name: "bool_ops_per_line", value: perLine(booleanOperatorCount(root)), unit: "ratio" },
  ];
}

/** TS `&&`, `||`, `??` and `?:`; Python `and`, `or` and `x if c else y`. */
function booleanOperatorCount(root: Node): number {
  let count = 0;
  const visit = (node: Node): void => {
    if (CONDITIONAL_TYPES.has(node.type) || isShortCircuit(node)) count++;
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return count;
}

function isShortCircuit(node: Node): boolean {
  if (node.type !== "binary_expression") return false;
  const op = node.childForFieldName("operator");
  return op !== null && SHORT_CIRCUIT_OPERATORS.has(op.text);
}
