import type { Rule } from "eslint";

const TODO_MARKER = /\bTODO\b(.*?)(?=\bTODO\b|\n|$)/g;
const KEY = String.raw`[A-Z][A-Z0-9]*-\d+`;
const ISSUE_NUMBER = String.raw`#\d+`;
const PARENTHESIZED = new RegExp(`^\\((?:${KEY}|${ISSUE_NUMBER})\\)`);
// A bare token must end the sentence: "TODO UTF-8 support" and "TODO ES-2022" are prose, not keys.
const BARE = new RegExp(`^:?\\s+(?:${KEY}|${ISSUE_NUMBER})(?![\\w-])(?=\\s*(?::|[.,;)]|$))`);
// Standards and encodings that look like tracker keys; digits alone cannot tell a year from a task number.
const PROSE_PREFIX = /^:?\s+(?:UTF|ES|ISO|RFC|SHA|MD|TLS|SSL|IPV|ECMA|HTTP)-/;

function namesTask(afterMarker: string): boolean {
  if (PARENTHESIZED.test(afterMarker)) return true;
  const bare = BARE.exec(afterMarker);
  return bare !== null && !PROSE_PREFIX.test(bare[0]);
}

export function needsTaskId(commentText: string): boolean {
  return [...commentText.matchAll(TODO_MARKER)].some((marker) => !namesTask(marker[1] ?? ""));
}

export const todoNeedsIssue: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: { description: "Require every TODO comment to name a tracking task" },
    schema: [],
    messages: {
      missingTaskId:
        "TODO needs a task id, for example `TODO(TP-123): ...`. File the task with `active-work task add`, or delete the comment.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (!needsTaskId(comment.value) || !comment.loc) continue;
          context.report({ loc: comment.loc, messageId: "missingTaskId" });
        }
      },
    };
  },
};
