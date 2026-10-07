import type { Rule } from "eslint";
import type { Comment } from "estree";

type ParserLike = {
  parse?: (text: string, options: object) => unknown;
  parseForESLint?: (text: string, options: object) => { ast: unknown };
};
type Statement = { type: string; expression?: { type: string }; body?: Statement };
type Body = Statement[];

const DIRECTIVE =
  /^\s*(?:eslint-(?:disable|enable)|@ts-|istanbul ignore|c8 ignore|v8 ignore|prettier-ignore|\/\s*<reference)/;
// An identifier or literal on its own is a word or a quoted phrase; it reads as prose.
const PROSE_EXPRESSIONS = new Set(["Identifier", "Literal"]);

function isDirective(comment: Comment): boolean {
  return comment.type === ("Shebang" as string) || DIRECTIVE.test(comment.value);
}

function isProseStatement(statement: Statement): boolean {
  if (statement.type === "LabeledStatement" && statement.body) return isProseStatement(statement.body);
  if (statement.type === "EmptyStatement") return true;
  return statement.type === "ExpressionStatement" && PROSE_EXPRESSIONS.has(statement.expression?.type ?? "");
}

function parseBody(parser: ParserLike, text: string, options: object): Body | null {
  try {
    const result = parser.parseForESLint ? parser.parseForESLint(text, options).ast : parser.parse?.(text, options);
    return (result as { body?: Body } | undefined)?.body ?? null;
  } catch {
    return null;
  }
}

// Module first so `import` parses; the function wrapper lets `return` and `await` parse.
function parsesAsStatements(parser: ParserLike, text: string, options: object): boolean {
  const attempts = [text, `async function* wrapper() {\n${text}\n}`];
  return attempts.some((source) => {
    const body = parseBody(parser, source, options);
    if (!body) return false;
    const statements = source === text ? body : ((body[0] as { body?: { body?: Body } } | undefined)?.body?.body ?? []);
    return statements.length > 0 && !statements.every(isProseStatement);
  });
}

function groupLineComments(comments: Comment[]): Comment[][] {
  const groups: Comment[][] = [];
  for (const comment of comments) {
    const last = groups.at(-1);
    const previous = last?.at(-1);
    const adjacent = previous?.loc && comment.loc && previous.loc.end.line + 1 === comment.loc.start.line;
    if (last && adjacent && previous?.type === "Line") last.push(comment);
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
      parsesAsStatements(parser, comments.map((comment) => comment.value).join("\n"), options);

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
        for (const group of groupLineComments(comments).flatMap(codeComments)) {
          const start = group[0]?.loc?.start;
          const end = group.at(-1)?.loc?.end;
          if (start && end) context.report({ loc: { start, end }, messageId: "commentedCode" });
        }
      },
    };
  },
};
