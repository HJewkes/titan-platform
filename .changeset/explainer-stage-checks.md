---
"@titan-design/explainer": minor
"@titan-design/evals": patch
---

Each `explainer.<stage>` child run ends with a `checks:<stage>` step that runs the stage's deterministic checks; every verdict carries `gate`, a failed gate fails the stage, and reported checks only show in the run report's new Checks table. `bridge.json` `check` commands take `gate` (default `true`). `explainer stage --json` prints the record, verdicts included, even when a gate failed. Adds the `explainer-video` and per-stage ev units with frozen, sha-only cases.
