---
"@titan-design/eslint-plugin": minor
---

Add the opt-in `recipe-step-in-loop` rule, which reports a step op (`ctx.dispatch`, `ctx.seed`, `ctx.assisted`, `ctx.authorize`, `step(ctx, …)`, `codeStep(ctx, …)`) called in a loop outside an `all(...)` fan-out.
