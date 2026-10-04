import { ruleTester } from "./test-fixtures.js";
import { todoNeedsIssue } from "./todo-needs-issue.js";

const message =
  "TODO needs a task id, for example `TODO(TP-123): ...`. File the task with `active-work task add`, or delete the comment.";

ruleTester.run("todo-needs-issue", todoNeedsIssue, {
  valid: [
    { name: "a TODO with a task id in parentheses", code: "// TODO(TP-123): drop the shim" },
    { name: "a TODO pointing at an issue number", code: "// TODO: see #42" },
    { name: "a block comment TODO with a task id", code: "/* TODO(ABC-7): batch these */" },
    { name: "a comment without TODO", code: "// todo lists are out of scope here" },
    { name: "TODO inside a string is not a comment", code: 'const label = "TODO";' },
  ],
  invalid: [
    { name: "a bare TODO", code: "// TODO: drop the shim", errors: [{ message }] },
    { name: "a TODO with a hash and no number", code: "// TODO: see #", errors: [{ message }] },
    { name: "a TODO with an empty parenthesis", code: "// TODO(): later", errors: [{ message }] },
    { name: "a lowercase key is not a task id", code: "// TODO(tp-123): later", errors: [{ message }] },
    {
      name: "each offending comment is reported",
      code: "// TODO: one\nconst a = 1;\n/* TODO two */",
      errors: [{ message, line: 1 }, { message, line: 3 }],
    },
  ],
});
