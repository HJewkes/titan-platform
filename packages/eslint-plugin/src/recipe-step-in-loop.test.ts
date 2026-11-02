import { recipeStepInLoop } from "./recipe-step-in-loop.js";
import { tsRuleTester } from "./test-fixtures.js";

const error = { messageId: "stepInLoop" as const };

tsRuleTester.run("recipe-step-in-loop", recipeStepInLoop, {
  valid: [
    { name: "steps in all([...items.map(…)]) pass", code: "await all(items.map((item) => ctx.dispatch(item)));" },
    { name: "a spread inside all passes", code: "await all([...items.map((item) => step(ctx, item))]);" },
    { name: "a step call outside any loop passes", code: "await ctx.dispatch(item); await step(ctx, item);" },
    { name: "a mapItems callback passes", code: "await mapItems(ctx, items, (item) => ctx.dispatch(item));" },
    { name: "a mapItems callback inside a loop passes", code: "for (const x of xs) { await ctx.mapItems(items, (item) => ctx.seed(item)); }" },
    { name: "a call on another object in a loop passes", code: "for (const x of xs) { client.dispatch(x); }" },
    { name: "a step inside a wrapper function outside any loop passes", code: "await withRetry(() => ctx.dispatch(item)); await (async () => ctx.seed(item))();" },
  ],
  invalid: [
    { name: "a step called in a for loop is an error", code: "for (const item of items) { await ctx.dispatch(item); }", errors: [error] },
    { name: "a step called in a .map callback outside all is an error", code: "const out = items.map((item) => ctx.assisted(item));", errors: [error] },
    { name: "all([...]) called inside a while loop is an error", code: "while (more) { await all([ctx.dispatch(a), ctx.dispatch(b)]); }", errors: [error, error] },
    { name: "all over a map inside a while loop is an error", code: "while (more) { await all(items.map((item) => ctx.seed(item))); }", errors: [error] },
    { name: "step and codeStep wrappers in a forEach", code: "items.forEach((item) => { step(ctx, item); codeStep(ctx, item); });", errors: [error, error] },
    { name: "authorize in a reduce callback", code: "items.reduce((acc, item) => acc + ctx.authorize(item), 0);", errors: [error] },
    { name: "a for loop inside an IIFE inside all is an error", code: "await all([(async () => { for (const i of items) await ctx.dispatch(i); })()]);", errors: [error] },
    { name: "a while loop inside an all(items.map(…)) callback is an error", code: "await all(items.map(async (item) => { while (pending) await ctx.dispatch(item); }));", errors: [error] },
    { name: "a .map nested in a .map under all is an error", code: "await all(xs.map((x) => ys.map((y) => ctx.dispatch(y))));", errors: [error] },
    { name: "a step in a wrapper callback inside a for loop is an error", code: "for (const x of xs) await withRetry(() => ctx.dispatch(x));", errors: [error] },
    { name: "a step in an IIFE inside a for loop is an error", code: "for (const x of xs) await (async () => ctx.dispatch(x))();", errors: [error] },
    { name: "a step in a then callback inside a for loop is an error", code: "for (const x of xs) await p.then(() => ctx.dispatch(x));", errors: [error] },
    { name: "a function declared in a loop body is part of the loop", code: "for (const x of xs) { function later() { return ctx.dispatch(x); } later(); }", errors: [error] },
    { name: "a step in Array.from, find and reduceRight callbacks is an error", code: "Array.from(xs, (x) => ctx.dispatch(x)); xs.find((x) => ctx.seed(x)); xs.reduceRight((a, x) => ctx.authorize(x), 0);", errors: [error, error, error] },
    { name: "all over a map inside an IIFE inside a for loop is an error", code: "for (const y of ys) await (async () => all(xs.map((x) => ctx.dispatch(x))))();", errors: [error] },
  ],
});
