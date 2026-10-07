import { ruleTester } from "./test-fixtures.js";
import { todoNeedsIssue } from "./todo-needs-issue.js";

const message =
  "TODO needs a task id, for example `TODO(TP-123): ...`. File the task with `active-work task add`, or delete the comment.";

ruleTester.run("todo-needs-issue", todoNeedsIssue, {
  valid: [
    { name: "a TODO with a task id in parentheses", code: "// TODO(TP-123): drop the shim" },
    { name: "a TODO with an issue number in parentheses", code: "// TODO(#123): drop the shim" },
    { name: "a TODO with a colon and a bare key", code: "// TODO: KEY-123" },
    { name: "a TODO with a colon, a bare key and a following colon", code: "// TODO: KEY-123: drop the shim" },
    { name: "a TODO with a bare issue number", code: "// TODO #123" },
    { name: "a JSDoc TODO with a task id", code: "/**\n * TODO(TP-9): document this\n */" },
    { name: "a task number that looks like a year is still a key", code: "// TODO: TP-2024" },
    { name: "a task number of 1900 is still a key", code: "// TODO: TP-1900" },
    { name: "FIXME is not checked", code: "// FIXME: later" },
    { name: "a block comment TODO with a task id", code: "/* TODO(ABC-7): batch these */" },
    { name: "a comment without TODO", code: "// todo lists are out of scope here" },
    { name: "TODO inside a string is not a comment", code: 'const label = "TODO";' },
  ],
  invalid: [
    { name: "a key-shaped standard name is prose", code: "// TODO UTF-8 support", errors: [{ message }] },
    { name: "a standard name with a year is prose", code: "// TODO ES-2022", errors: [{ message }] },
    { name: "a key only inside a URL does not count", code: "// TODO: https://example.com/browse/TP-123", errors: [{ message }] },
    { name: "a key later in the sentence does not count", code: "// TODO: see TP-123", errors: [{ message }] },
    { name: "a JSDoc TODO without a task id", code: "/**\n * TODO: document this\n */", errors: [{ message }] },
    { name: "a second TODO without a key is reported", code: "// TODO(TP-1): one, TODO two", errors: [{ message }] },
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
