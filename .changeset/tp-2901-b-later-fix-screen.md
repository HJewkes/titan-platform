---
"@titan-design/evals": patch
---

Add the implement-task later-fix screen (TP-2901 b). `screenLaterFix` runs TP-1144's flake screen with the accepted merge as base and the corrected reference as head, three head runs, in the scratch clone that holds the corrected ref. `laterFixVerdict` attaches a fix only when the screen keeps it and at least one test reproduces, and otherwise returns `needs-new-api`, `passes-on-accepted`, `fails-on-corrected`, `flaky`, `not-collected` or `screen-error:<msg>`. A screen whose planned tests differ from the fix's own is rejected as `plan-mismatch`. `screenCase` gains an optional `onRuns` hook that sees the plan and judged runs behind its verdict.
