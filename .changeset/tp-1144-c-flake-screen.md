---
"@titan-design/evals": patch
---

TP-1144c: add the implement-task flake screen. `screenCase` builds and tests one accepted merge in a scratch clone under `<out>/.scratch`, base once and head three times, and `screenVerdict` keeps it or names why it drops: `no-hidden-tests`, `screen-error:<msg>`, `flaky`, `fails-on-accepted`, `vacuous` or `not-collected`.
