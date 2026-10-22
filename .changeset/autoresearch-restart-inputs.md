---
"@titan-design/autoresearch": minor
"@titan-design/factory": minor
---

Make autoresearch steps safe across a host restart. The eval, L0, L1 and ratchet steps now name the run and its recorded pin (`RunPin`: `runId`, `pin`, `frozenHash`), and the implement step names `runId`. `ArStepHandler.run` takes the runtime's `StepTiming`, and the load-wait handler passes the step's `firstStartedAt` to `loadWait`. The `plan` port now answers `{ ops, agent?, sessionId?, mode?, usage? }` (`PlannedSchema`), and the round record gains an optional `planner`.

In the factory, the evaluator ports rebuild a run's session from the step's recorded pin after a restart and refuse with `[frozen-drift]` when the frozen files no longer hash to the recorded value. The load gate counts its optional `maxWaitMs` deadline from the step's first start. The planner reports its agent, session and usage. A `[tree-live]` failure is retryable. Implementers are named from the run id rather than the tree name.
