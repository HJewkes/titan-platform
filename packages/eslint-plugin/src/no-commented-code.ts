import type { Rule } from "eslint";
import type { Comment } from "estree";

type ParserLike = {
  parse?: (text: string, options: object) => unknown;
  parseForESLint?: (text: string, options: object) => { ast: unknown };
};
type Expression = { type: string; callee?: Expression; arguments?: Expression[]; value?: unknown };
type Statement = {
  type: string;
  expression?: Expression;
  body?: Statement;
  label?: unknown;
  argument?: unknown;
};
type Body = Statement[];

const DIRECTIVE =
  /^\s*(?:eslint-(?:disable|enable)|@ts-|istanbul ignore|c8 ignore|v8 ignore|prettier-ignore|\/\s*<reference)/;
// A lone expression reads as prose (`read-only`, `100 - 75`, `a, b`) unless it has a code signal.
const CODE_EXPRESSIONS = new Set([
  "AssignmentExpression",
  "AwaitExpression",
  "CallExpression",
  "ChainExpression",
  "NewExpression",
  "UpdateExpression",
]);

function isDirective(comment: Comment): boolean {
  return comment.type === ("Shebang" as string) || DIRECTIVE.test(comment.value);
}

// `sudo(8)` cites a manual page; it is a call only to the parser.
function isManPageReference({ type, callee, arguments: args = [] }: Expression): boolean {
  const numeric = args.length === 1 && typeof args[0]?.value === "number";
  return type === "CallExpression" && callee?.type === "Identifier" && numeric;
}

function isCodeExpression(expression: Expression | undefined): boolean {
  return expression !== undefined && CODE_EXPRESSIONS.has(expression.type) && !isManPageReference(expression);
}

// `continue`, `break`, `return` and `debugger` alone are notes in an empty block, not code; espree and
// typescript-estree disagree on whether `continue` parses outside a loop, so both must land on prose.
function isBareKeyword({ type, label, argument }: Statement): boolean {
  if (type === "DebuggerStatement") return true;
  if (type === "ContinueStatement" || type === "BreakStatement") return !label;
  return type === "ReturnStatement" && !argument;
}

// Every statement needs a positive signal: a body, a declaration, an argument, a code expression or a `;`.
function isCodeStatement(statement: Statement, endsWithSemicolon: boolean): boolean {
  if (statement.type === "LabeledStatement" && statement.body) return isCodeStatement(statement.body, endsWithSemicolon);
  if (statement.type === "EmptyStatement") return false;
  if (statement.type === "ExpressionStatement") return endsWithSemicolon || isCodeExpression(statement.expression);
  return endsWithSemicolon || !isBareKeyword(statement);
}

function parseBody(parser: ParserLike, text: string, options: object): Body | null {
  try {
    const result = parser.parseForESLint ? parser.parseForESLint(text, options).ast : parser.parse?.(text, options);
    return (result as { body?: Body } | undefined)?.body ?? null;
  } catch {
    return null;
  }
}

type Wrapped = { body?: { body?: Wrapped[] } };

// The wrapper is a function around a loop, so `return`, `await`, `continue` and `break` all parse.
function unwrap(body: Body): Body {
  const loop = (body[0] as Wrapped | undefined)?.body?.body?.[0];
  return (loop?.body?.body ?? []) as unknown as Body;
}

// Module first so `import` parses; the wrapper lets statements that need a function or loop parse.
function parsesAsStatements(parser: ParserLike, text: string, options: object): boolean {
  const attempts = [text, `async function* wrapper() {\nwhile (true) {\n${text}\n}\n}`];
  return attempts.some((source) => {
    const body = parseBody(parser, source, options);
    if (!body) return false;
    const statements = source === text ? body : unwrap(body);
    return statements.some((statement) => isCodeStatement(statement, /;\s*$/.test(text)));
  });
}

// Block comments often prefix each line with `*`; strip it so the text is what the author wrote.
function textOf(comment: Comment): string {
  if (comment.type !== "Block") return comment.value;
  return comment.value.replace(/^[ \t]*\*[ \t]?/gm, "");
}

// Only whole-line `//` comments on consecutive lines form one statement; a trailing comment stands alone.
function groupLineComments(comments: Comment[], isAlone: (comment: Comment) => boolean): Comment[][] {
  const groups: Comment[][] = [];
  for (const comment of comments) {
    const last = groups.at(-1);
    const previous = last?.at(-1);
    const adjacent = previous?.loc && comment.loc && previous.loc.end.line + 1 === comment.loc.start.line;
    const joins = adjacent && [previous, comment].every((c) => c?.type === "Line" && c && isAlone(c));
    if (last && joins) last.push(comment);
    else groups.push([comment]);
  }
  return groups;
}

export const noCommentedCode: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Disallow comments that contain code" },
    schema: [],
    messages: {
      commentedCode: "This comment is code. Delete it; git history keeps it. If it explains why, rewrite it as a sentence.",
    },
  },
  create(context) {
    const { languageOptions } = context;
    const parser = (languageOptions.parser ?? {}) as ParserLike;
    const options = { ecmaVersion: languageOptions.ecmaVersion ?? "latest", sourceType: "module", range: true, loc: true, tokens: true, comment: true };
    const isCode = (comments: Comment[]) =>
      parsesAsStatements(parser, comments.map(textOf).join("\n"), options);

    const isAlone = (comment: Comment) => {
      const line = context.sourceCode.lines[(comment.loc?.start.line ?? 1) - 1] ?? "";
      return line.slice(0, comment.loc?.start.column).trim() === "";
    };

    function codeComments(group: Comment[]): Comment[][] {
      if (isCode(group)) return [group];
      if (group.length === 1) return [];
      return group.filter((comment) => isCode([comment])).map((comment) => [comment]);
    }

    return {
      Program() {
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => !isDirective(comment) && !(comment.type === "Block" && comment.value.startsWith("*")));
        for (const group of groupLineComments(comments, isAlone).flatMap(codeComments)) {
          const start = group[0]?.loc?.start;
          const end = group.at(-1)?.loc?.end;
          if (start && end) context.report({ loc: { start, end }, messageId: "commentedCode" });
        }
      },
    };
  },
};
