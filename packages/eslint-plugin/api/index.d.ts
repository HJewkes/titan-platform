import { Rule, ESLint, Linter } from 'eslint';

/**
 * A titan rule names the review-finding class keys it catches, so a review step can skip a class a rule
 * already covers. The keys come from the fixed vocabulary in the repo's checks registry (TP-6483).
 */
type TitanRule = Rule.RuleModule & {
    meta: {
        docs: {
            description: string;
            classes: readonly string[];
        };
    };
};

declare const DEFAULT_MAX_LINES = 30;
declare const maxFunctionLines: TitanRule;

declare const DEFAULT_MAX_LINE_LENGTH = 200;
declare const maxLineLength: TitanRule;

declare const noChainedTypeAssertions: TitanRule;

declare const noCommentedCode: TitanRule;

declare const noInternalModuleMock: TitanRule;

declare const noTestClockBudget: TitanRule;

declare const DEFAULT_MOTION_PATHS: readonly string[];
declare const noWallClockMotion: TitanRule;

/**
 * Flags a step op (`ctx.dispatch`, `ctx.seed`, `ctx.assisted`, `ctx.authorize`, or `step(ctx, …)` and `codeStep(ctx, …)`) called in a loop.
 * Residual: a helper declared outside the loop that holds the step op and is called in it is not seen, because the rule reads one function at a time.
 * The runtime orphan trap (TP-3108 S5) covers that case.
 */
declare const recipeStepInLoop: TitanRule;

declare const todoNeedsIssue: TitanRule;

declare const plugin: ESLint.Plugin;
declare const recommended: Linter.Config;

export { DEFAULT_MAX_LINES, DEFAULT_MAX_LINE_LENGTH, DEFAULT_MOTION_PATHS, plugin as default, maxFunctionLines, maxLineLength, noChainedTypeAssertions, noCommentedCode, noInternalModuleMock, noTestClockBudget, noWallClockMotion, recipeStepInLoop, recommended, todoNeedsIssue };
