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
    { name: "a plain function declared in a loop is not a loop", code: "for (const x of xs) { function later() { return ctx.dispatch(x); } }" },
  ],
  invalid: [
    { name: "a step called in a for loop is an error", code: "for (const item of items) { await ctx.dispatch(item); }", errors: [error] },
    { name: "a step called in a .map callback outside all is an error", code: "const out = items.map((item) => ctx.assisted(item));", errors: [error] },
    { name: "all([...]) called inside a while loop is an error", code: "while (more) { await all([ctx.dispatch(a), ctx.dispatch(b)]); }", errors: [error, error] },
    { name: "all over a map inside a while loop is an error", code: "while (more) { await all(items.map((item) => ctx.seed(item))); }", errors: [error] },
    { name: "step and codeStep wrappers in a forEach", code: "items.forEach((item) => { step(ctx, item); codeStep(ctx, item); });", errors: [error, error] },
    { name: "authorize in a reduce callback", code: "items.reduce((acc, item) => acc + ctx.authorize(item), 0);", errors: [error] },
  ],
});
