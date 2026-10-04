import type { ESLint } from "eslint";
import { maxFunctionLines } from "./max-function-lines.js";
import { todoNeedsIssue } from "./todo-needs-issue.js";

export { DEFAULT_MAX_LINES, maxFunctionLines } from "./max-function-lines.js";
export { todoNeedsIssue } from "./todo-needs-issue.js";

const plugin: ESLint.Plugin = {
  meta: { name: "@titan-design/eslint-plugin" },
  rules: {
    "max-function-lines": maxFunctionLines,
    "todo-needs-issue": todoNeedsIssue,
  },
};

export default plugin;
