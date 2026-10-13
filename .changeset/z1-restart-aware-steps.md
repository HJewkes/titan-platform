---
"@titan-design/workflow": minor
---

A step that a restart re-dispatches no longer uses up its retry budget. The active step now records `firstStartedAt`, which is kept across retries and restarts, and `restarts`, the number of times a retry-safe recovery re-dispatched it. The retry gate subtracts restarts from the attempt count before it compares with `maxRetries`. The dispatch input and `RoutedStepInput` carry both fields, so a wait can measure its deadline from the step's first start. A `StepRoute` can now declare a `reconcile` hook, which decides an interrupted step before the route's `onRestart` rule is applied. Rows stored without these fields still load: `firstStartedAt` falls back to `startedAt`, and `restarts` reads as 0.
