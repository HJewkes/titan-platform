import { Rule, ESLint, Linter } from 'eslint';

declare const DEFAULT_MAX_LINES = 30;
declare const maxFunctionLines: Rule.RuleModule;

declare const DEFAULT_MAX_LINE_LENGTH = 200;
declare const maxLineLength: Rule.RuleModule;

declare const noChainedTypeAssertions: Rule.RuleModule;

declare const noCommentedCode: Rule.RuleModule;

declare const noInternalModuleMock: Rule.RuleModule;

declare const noTestClockBudget: Rule.RuleModule;

declare const DEFAULT_MOTION_PATHS: readonly string[];
declare const noWallClockMotion: Rule.RuleModule;

/**
 * Flags a step op (`ctx.dispatch`, `ctx.seed`, `ctx.assisted`, `ctx.authorize`, or `step(ctx, …)` and `codeStep(ctx, …)`) called in a loop.
 * Residual: a helper that holds the step op and is called in a loop is not seen, because the rule reads one function at a time.
 * The runtime orphan trap (TP-3108 S5) covers that case.
 */
declare const recipeStepInLoop: Rule.RuleModule;

declare const todoNeedsIssue: Rule.RuleModule;

declare const plugin: ESLint.Plugin;
declare const recommended: Linter.Config;

export { DEFAULT_MAX_LINES, DEFAULT_MAX_LINE_LENGTH, DEFAULT_MOTION_PATHS, plugin as default, maxFunctionLines, maxLineLength, noChainedTypeAssertions, noCommentedCode, noInternalModuleMock, noTestClockBudget, noWallClockMotion, recipeStepInLoop, recommended, todoNeedsIssue };
