---
"@titan-design/factory": patch
---

Adds F11's comparator in `event-log/agreement.ts`: `kindCensus` (clock 1, polling: every declared kind has a backstop row) and `agreement` (clock 2, webhook: matched, webhook-only, backstop-only, pending and divergent-key rows from the window's rows and the reconciler's duplicate lines). Both are pure, and only `event-log/` and tests may import them (I7). The A17 harness feed now carries PR, review, push and ruleset facts as well as CI, and the harness's own A17 cases check that a scenario covering every reconciler kind yields the same occurrence keys in both modes, less the declared transients, and that a re-observed occurrence is never a second row.
