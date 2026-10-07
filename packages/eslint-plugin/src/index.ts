import type { ESLint, Linter } from "eslint";
import { maxFunctionLines } from "./max-function-lines.js";
import { noCommentedCode } from "./no-commented-code.js";
import { todoNeedsIssue } from "./todo-needs-issue.js";

export { DEFAULT_MAX_LINES, maxFunctionLines } from "./max-function-lines.js";
export { noCommentedCode } from "./no-commented-code.js";
export { todoNeedsIssue } from "./todo-needs-issue.js";

const rules = {
  "max-function-lines": maxFunctionLines,
  "no-commented-code": noCommentedCode,
  "todo-needs-issue": todoNeedsIssue,
};

const plugin: ESLint.Plugin = {
  meta: { name: "@titan-design/eslint-plugin" },
  rules,
};

export const recommended: Linter.Config = {
  plugins: { titan: plugin },
  rules: Object.fromEntries(Object.keys(rules).map((name) => [`titan/${name}`, "error"])),
};

export default plugin;
