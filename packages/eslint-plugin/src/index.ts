import type { ESLint, Linter } from "eslint";
import { maxFunctionLines } from "./max-function-lines.js";
import { maxLineLength } from "./max-line-length.js";
import { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
import { noCommentedCode } from "./no-commented-code.js";
import { noInternalModuleMock } from "./no-internal-module-mock.js";
import { todoNeedsIssue } from "./todo-needs-issue.js";

export { DEFAULT_MAX_LINES, maxFunctionLines } from "./max-function-lines.js";
export { DEFAULT_MAX_LINE_LENGTH, maxLineLength } from "./max-line-length.js";
export { noChainedTypeAssertions } from "./no-chained-type-assertions.js";
export { noCommentedCode } from "./no-commented-code.js";
export { noInternalModuleMock } from "./no-internal-module-mock.js";
export { todoNeedsIssue } from "./todo-needs-issue.js";

const rules = {
  "max-function-lines": maxFunctionLines,
  "max-line-length": maxLineLength,
  "no-chained-type-assertions": noChainedTypeAssertions,
  "no-commented-code": noCommentedCode,
  "no-internal-module-mock": noInternalModuleMock,
  "todo-needs-issue": todoNeedsIssue,
};

const plugin: ESLint.Plugin = {
  meta: { name: "@titan-design/eslint-plugin" },
  rules,
};

// Opt-in rules stay out of recommended so a plugin bump never breaks a consumer that has no baseline for them.
const OPT_IN_RULES = new Set<string>(["max-line-length"]);

export const recommended: Linter.Config = {
  plugins: { titan: plugin },
  rules: Object.fromEntries(
    Object.keys(rules)
      .filter((name) => !OPT_IN_RULES.has(name))
      .map((name) => [`titan/${name}`, "error"]),
  ),
};

export default plugin;
