import { Rule, ESLint, Linter } from 'eslint';

declare const DEFAULT_MAX_LINES = 30;
declare const maxFunctionLines: Rule.RuleModule;

declare const noChainedTypeAssertions: Rule.RuleModule;

declare const noCommentedCode: Rule.RuleModule;

declare const noInternalModuleMock: Rule.RuleModule;

declare const todoNeedsIssue: Rule.RuleModule;

declare const plugin: ESLint.Plugin;
declare const recommended: Linter.Config;

export { DEFAULT_MAX_LINES, plugin as default, maxFunctionLines, noChainedTypeAssertions, noCommentedCode, noInternalModuleMock, recommended, todoNeedsIssue };
