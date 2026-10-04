import type { Rule } from "eslint";

const TODO = /\bTODO\b/;
// A tracker key such as TP-123, or a GitHub issue number such as #123; a bare "#" is not a reference.
const TASK_REFERENCE = /\b[A-Z][A-Z0-9]*-\d+\b|#\d+\b/;

export function needsTaskId(commentText: string): boolean {
  return TODO.test(commentText) && !TASK_REFERENCE.test(commentText);
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
