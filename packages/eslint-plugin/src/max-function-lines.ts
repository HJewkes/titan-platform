import type { Rule } from "eslint";
import type * as ESTree from "estree";

export const DEFAULT_MAX_LINES = 30;

type FunctionNode = (ESTree.FunctionDeclaration | ESTree.FunctionExpression | ESTree.ArrowFunctionExpression) &
  Rule.NodeParentExtension;

function keyName(key: ESTree.Expression | ESTree.PrivateIdentifier): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  if (key.type === "Literal") return String(key.value);
  return undefined;
}

export function functionName(node: FunctionNode): string {
  if (node.type !== "ArrowFunctionExpression" && node.id) return node.id.name;
  const parent = node.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if (parent.type === "MethodDefinition" || parent.type === "Property" || parent.type === "PropertyDefinition") {
    return keyName(parent.key) ?? "anonymous function";
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") return parent.left.name;
  return "anonymous function";
}

// Blank lines are excluded so spacing a function out for readability never pushes it over the limit.
export function countNonBlankLines(lines: readonly string[], start: number, end: number): number {
  let count = 0;
  for (let line = start; line <= end; line++) {
    if (lines[line - 1]?.trim() !== "") count++;
  }
  return count;
}

export const maxFunctionLines: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Limit every function to a fixed number of non-blank lines" },
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooLong:
        "`{{name}}` is {{lines}} lines; the limit is {{max}}. Extract one step into a named function in this file. Do not add eslint-disable and do not edit the suppressions file.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { max?: number };
    const max = options.max ?? DEFAULT_MAX_LINES;
    const lines = context.sourceCode.lines;
    function check(node: FunctionNode): void {
      if (!node.loc) return;
      const count = countNonBlankLines(lines, node.loc.start.line, node.loc.end.line);
      if (count <= max) return;
      context.report({ node, messageId: "tooLong", data: { name: functionName(node), lines: String(count), max: String(max) } });
    }
    return { FunctionDeclaration: check, FunctionExpression: check, ArrowFunctionExpression: check };
  },
};
