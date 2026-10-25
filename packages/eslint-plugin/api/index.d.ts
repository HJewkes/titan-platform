import { Rule, ESLint, Linter } from 'eslint';

declare const DEFAULT_MAX_LINES = 30;
declare const maxFunctionLines: Rule.RuleModule;

declare const DEFAULT_MAX_LINE_LENGTH = 200;
declare const maxLineLength: Rule.RuleModule;

declare const noChainedTypeAssertions: Rule.RuleModule;

declare const noCommentedCode: Rule.RuleModule;

declare const noInternalModuleMock: Rule.RuleModule;

declare const DEFAULT_MOTION_PATHS: readonly string[];
declare const noWallClockMotion: Rule.RuleModule;

declare const todoNeedsIssue: Rule.RuleModule;

declare const plugin: ESLint.Plugin;
declare const recommended: Linter.Config;

export { DEFAULT_MAX_LINES, DEFAULT_MAX_LINE_LENGTH, DEFAULT_MOTION_PATHS, plugin as default, maxFunctionLines, maxLineLength, noChainedTypeAssertions, noCommentedCode, noInternalModuleMock, noWallClockMotion, recommended, todoNeedsIssue };
