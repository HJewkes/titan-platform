import type { AST, Rule, SourceCode } from "eslint";
import type * as ESTree from "estree";

export const DEFAULT_MAX_LINE_LENGTH = 200;

const LITERAL_TOKEN_TYPES = new Set(["String", "Template", "RegularExpression", "JSXText"]);

type Range = readonly [number, number];

function overlap(a: Range, b: Range): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

function isModuleLink(node: ESTree.Node): boolean {
  if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration") return true;
  return node.type === "ExportNamedDeclaration" && node.source != null;
}

function moduleLinkLines(program: ESTree.Program): Set<number> {
  const lines = new Set<number>();
  for (const node of program.body) {
    if (!isModuleLink(node) || !node.loc) continue;
    for (let line = node.loc.start.line; line <= node.loc.end.line; line++) lines.add(line);
  }
  return lines;
}

// A line counts as code only if a non-comment token touches it, so a long comment or JSDoc line never reports.
// Literals are judged by their share of the line, not their presence: core max-len's ignoreStrings skips any
// line holding a short step id or message, which is where the packed logic hides.
function isCodeDominated(tokens: readonly AST.Token[], lineRange: Range, indent: number): boolean {
  const onLine = tokens.filter((token) => overlap(token.range, lineRange) > 0);
  if (onLine.length === 0) return false;
  const literalChars = onLine
    .filter((token) => LITERAL_TOKEN_TYPES.has(token.type))
    .reduce((sum, token) => sum + overlap(token.range, lineRange), 0);
  const contentChars = lineRange[1] - lineRange[0] - indent;
  return literalChars * 2 < contentChars;
}

function lineRange(sourceCode: SourceCode, line: number): Range {
  const start = sourceCode.getIndexFromLoc({ line, column: 0 });
  return [start, start + (sourceCode.lines[line - 1] ?? "").length];
}

function configuredMax(option: unknown): number {
  if (typeof option !== "object" || option === null || !("max" in option)) return DEFAULT_MAX_LINE_LENGTH;
  return typeof option.max === "number" ? option.max : DEFAULT_MAX_LINE_LENGTH;
}

export const maxLineLength: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Limit code lines to a fixed number of characters, skipping comments, imports and literal-dominated lines" },
    schema: [
      {
        type: "object",
        properties: { max: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooLong:
        "This line is {{length}} characters; the limit is {{max}}. Name an intermediate value with a const, or break the expression across lines. Do not add eslint-disable and do not edit the suppressions file.",
    },
  },
  create(context) {
    const max = configuredMax(context.options[0]);
    const sourceCode = context.sourceCode;
    return {
      Program(program) {
        const skipped = moduleLinkLines(program);
        const tokens = sourceCode.ast.tokens;
        sourceCode.lines.forEach((text, index) => {
          const line = index + 1;
          if (text.length <= max || skipped.has(line)) return;
          const indent = text.length - text.trimStart().length;
          if (!isCodeDominated(tokens, lineRange(sourceCode, line), indent)) return;
          context.report({
            loc: { start: { line, column: max }, end: { line, column: text.length } },
            messageId: "tooLong",
            data: { length: String(text.length), max: String(max) },
          });
        });
      },
    };
  },
};
