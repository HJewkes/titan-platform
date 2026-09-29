# @titan-design/workflow

## 0.5.0

### Minor Changes

- c6bb111: Key every memoized call by step id and call index, and record the method that wrote it. `seed` now counts toward the shared per-step counter, so `seed("x")` followed by `assisted("x")` opens a gate instead of returning the seed's result, and a second `seed("x")` runs as a new call. A replay that reaches a recorded call through a different method fails with the new `WorkflowNonDeterminismError`. `StepResult` gains an optional `operation` field. Runs stored by 0.4 and earlier keep their old keys and resume unchanged.
- 3085355: Add `routedRunner(routes)`: one runner that sends each dispatch step to the runner its route names, with a per-route restart rule. `repeat` redispatches a step interrupted by a crash; `park` leaves the run `recovery_required`. `assertRoutes(workflowName, stepIds)` fails registration on an unrouted step id, and two routes with the same match fail at construction.
- 8e2d31f: `WorkflowRuntime.signal(runId, stepId, payload, resolvedBy)` forwards an optional `GateResolver` to the gate store, which records it on the gate. A store that refuses the resolver throws `GateResolverRefused` from `signal`, and the run stays paused with its gate pending. Add `gateResolverMigration(n)` from `@titan-design/hitl/sqlite` to your migration list, then pass a resolver to every `signal`: after that migration, a signal with no resolver is refused by the database.
- d7f09e5: Add typed dispatch output: `ctx.dispatch(stepId, template, { schema })` forwards the zod schema to the runner as `StepRunInput.outputSchema`, parses the output as JSON, and returns it as `StepResult.data` typed as the schema's output. An invalid payload throws the non-retryable `StepOutputInvalidError` after one runner call. Undeclared top-level `titan.trace.*` keys are carried into `data`, which is bounded by the new `maxStepDataBytes` runtime option (default 64 KiB). Replay re-derives `data` from the recorded output and fails a drifted run with `WorkflowSchemaDriftError`.

### Patch Changes

- d0ce38a: session-read's `SessionUsageAccumulator` and workflow's durable-harness usage now select measurements with agent-protocol's `foldUsage` and no longer carry their own copies of the fold. Results are unchanged (TP-423).
- f160116: Count every attempt's cost in `StepResult.usage`. A step that fails and then succeeds on retry now reports the failed attempts' cost too, and the active step persists that cost as the new optional `ActiveStep.priorUsage` field so a resumed run counts each attempt once. `durableHarnessRunner` now reports `usage` on success from the harness's measurements, and a legacy `attach` recovery keeps the usage its runner reported.
- 46dfd6c: `agentRunner` forwards a step's `schema` to the agent as its output schema, ahead of `defaults.outputSchema`, and a `schema_invalid` agent failure now ends as a non-retryable `StepOutputInvalidError` through `agentRunner`, `idempotentRunner` and `routedRunner`.
- Updated dependencies [b8a5614]
- Updated dependencies [629cdd9]
- Updated dependencies [d0ce38a]
  - @titan-design/agent-protocol@0.3.0
  - @titan-design/hitl@0.3.0
  - @titan-design/agent@0.4.3

## 0.4.3

### Patch Changes

- 18527b6: agent-protocol: add the `ended` terminal outcome, the `observe_launched` transition and the exported `TERMINAL_EXECUTION_PHASES` tuple (TP-192 S1). workflow maps an `ended` settlement to a non-retryable failed step. agent-lifecycle derives its recoverable-phase filter from `TERMINAL_EXECUTION_PHASES`, so `ended` rows are never listed as recoverable.
  - @titan-design/agent@0.4.2

## 0.4.2

### Patch Changes

- bb543d3: `mapItems` keeps launching after a retryable item failure, stops on a non-retryable one or once failures exceed `maxFailures` (default 3), and counts failed-call cost in `spentUsd`. `StepFailedError` now carries `retryable` and `usage`, and `agentRunner` reports usage on failed runs (TP-372).
- Updated dependencies [bb543d3]
  - @titan-design/agent@0.4.1

## 0.4.1

### Patch Changes

- Updated dependencies [984e067]
  - @titan-design/agent@0.4.0

## 0.4.0

### Minor Changes

- c821985: Add `mapItems`, a fan-out with concurrency and budget caps that resumes by item key, and `idempotentRunner`, which redispatches interrupted repeat-safe steps after a restart. Step results carry `usage`. `agentRunner` reports cost and tokens, and stores `outputSchema` output as JSON instead of `[object Object]`.

### Patch Changes

- Updated dependencies [09690de]
  - @titan-design/agent@0.3.0

## 0.3.0

### Minor Changes

- c798f28: Report every signal an output carries and key repeated human gates by iteration.

  - `parseSignals` and `createSignalSetParser` return every signal, highest precedence first. `parseSignal` returns the head of that list. `high_risk` now leads the default order, so a risk score of 4 or more beats a PASS verdict.
  - The default patterns match `**NEEDS REVISION**`, `verdict: **NEEDS WORK**` and `**NEEDS WORK**` again.
  - Empty or whitespace-only output parses as `EMPTY_OUTPUT_SIGNAL` (`"empty_output"`) instead of `null`, so a silent reviewer escalates rather than passing.
  - `parseSignal` therefore returns a different value for two kinds of input it already accepted: an output carrying several signals now returns the highest-precedence one rather than the first pattern in the old key order, and empty output returns `"empty_output"` where it returned `null`. Check any code that routes on `StepResult.signal`.
  - `unfilledVariables(template, vars)` lists the placeholders a template needs that `vars` does not supply.
  - `assisted()` called again under the same `stepId` opens a new gate (`<runId>/<stepId>:n`, result key `stepId:n`) instead of returning the first answer. The first call keeps its existing key and gate id, and `runtime.signal` resolves whichever call is waiting. Stored runs keep their key shape. One upgrade case is handled rather than left to orphan a gate: a run paused by an earlier release inside `assisted(x)` after a `dispatch(x)` under the same step id waits on `<runId>/x`, and `assisted` adopts that gate when it is still pending and the bare key holds no result.

### Patch Changes

- Updated dependencies [825b8b2]
  - @titan-design/store-sqlite@0.3.1
  - @titan-design/hitl@0.2.1

## 0.2.1

### Patch Changes

- Updated dependencies [e204012]
- Updated dependencies [cf764b6]
  - @titan-design/store-sqlite@0.3.0
  - @titan-design/hitl@0.2.0

## 0.2.0

### Minor Changes

- 25391fa: Add durable execution transitions and a transactional, lease-fenced execution ledger. Persist workflow dispatch identities and acknowledgments before waiting, and retain uncertain executions for explicit recovery rather than silently redispatching after restart.

### Patch Changes

- Updated dependencies [11b94a2]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/agent@0.2.0
  - @titan-design/store-sqlite@0.2.1
  - @titan-design/hitl@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [8153dd8]
  - @titan-design/store-sqlite@0.2.0
  - @titan-design/hitl@0.1.1

## 0.1.0

### Minor Changes

- 403326f: Port brain's durable workflow runtime: memoized `dispatch` / `seed` / `assisted` steps over a
  SQLite run table, replay-on-restart via `hydrate`, human gates through `@titan-design/hitl`,
  an `agentRunner` over `@titan-design/agent`, signal parsing, and typed lifecycle events.
