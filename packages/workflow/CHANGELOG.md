# @titan-design/workflow

## 0.14.0

### Minor Changes

- 2256a3b: Meter agent-chat workflow steps from their transcripts and retire an agent mid-step when its slice's budget runs out. `StepUsage` gains `peakContextTokens`, and a code step can throw `CodeStepFailure` to keep what it spent.
- 869014a: `StepUsage` gains optional `cacheReadTokens`, `cacheWrite5mTokens`, `cacheWrite1hTokens` and `model`. `agentRunner` fills them from the run's usage, and `addUsage` and `usageFromMeasurements` carry them. Absent stays absent.
- 4a2495f: Capability context: `WorkflowRuntimeOptions.capabilities` and `ctx.capability(name)` give step bodies an opaque handle whose declared secrets are refused (`CapabilityLeakError`) or redacted before they reach step output, the trace, the store or a prompt variable. The factory's guarded context forwards `capability`.
- 0229ba6: Add `codeStep`, `codeRoute` and `codeRecordRoute`: the code-step pair a host dispatches JSON input through and records one `{ result }` record from, with an `envelope` hook for the stored record and an `errorText` hook for thrown messages.
- ee64f09: Add `WorkflowRunStore.listByWorkflow` and `WorkflowRuntime.listByWorkflow`, which load one workflow's runs of the asked statuses with a `WHERE workflow_name = ?` read instead of every run. New tables get a `(workflow_name, status)` index, and `workflowNameIndexMigration` adds it to an existing table.
- 2165cec: Keep per-step telemetry. A completed dispatch's `StepResult` now records `startedAt`, `firstStartedAt` and `restarts`, and a seed's records `startedAt`; `projectRunTrace` places each attempt at its recorded start. Every `WorkflowEvent` carries `at` from the runtime clock. A `codeRecordRoute` body may return `usage` beside `result`; the route reports it as the step's usage, so `mapItems` sums and budgets it like a dispatch's. All fields are optional, so stored runs and events from earlier releases read as before; no migration is needed.

### Patch Changes

- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 50fd2a5: A replayed authorize step now reads its recorded outcome through a schema instead of a cast, so a malformed record throws a validation error rather than being trusted. Typed-lint cleanup elsewhere in the package changes no behavior.
- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [9411e94]
- Updated dependencies [91e3e3d]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [211db45]
- Updated dependencies [b3f677b]
- Updated dependencies [84d962e]
- Updated dependencies [6c2df6a]
- Updated dependencies [c58d555]
- Updated dependencies [c026f23]
- Updated dependencies [5edd38d]
- Updated dependencies [9b42150]
- Updated dependencies [c1f9297]
- Updated dependencies [646f4d7]
- Updated dependencies [5e34e3d]
- Updated dependencies [869014a]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [1b0c46a]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
  - @titan-design/agent@0.7.0
  - @titan-design/authority@0.6.0
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/hitl@0.10.0
  - @titan-design/store-sqlite@0.5.0
  - @titan-design/rpc-protocol@0.4.0

## 0.13.1

### Patch Changes

- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/agent-protocol@0.9.0
  - @titan-design/agent@0.6.1

## 0.13.0

### Minor Changes

- e22d2fd: Count runs per status without loading them (TP-2419). `WorkflowRunStore.countByStatus` reads the status index alone. Serve's `/health` counts through it instead of parsing every run's step results on each probe, which held the event loop for most of a second per request.
- cbc3107: Stop parsing every registered run on serve's hot paths (TP-2420). `WorkflowRunStore.statuses` reads each run's status without its step results, and `WorkflowRunStore.page` reads runs an id-ordered page at a time, optionally only those finished since a cutoff; the factory host exposes the store as `runs`. Shepherd's watch rows load only the runs a read wants: `list` by state, `status` by repo and PR, `waiting` the unfinished and gated runs, and the seat digest only finished runs their seat has not heard of. Pending gates are read once per call instead of once per registration. Those reads and the reverts sweep, which now pages the revert window's completed runs, yield the event loop every 10 ms.
- c0bdde5: `register` takes `abandonsOrphan`: when a workflow returns, a recovered step its replay never reached is dropped with a new `step_abandoned` event if the predicate allows it, instead of parking the run as `recovery_required`. Without the predicate such a run still parks, now with the evidence `replay never reached recovered step <id>` (TP-2560 a).
- c4fc339: Add the `strictReplay` register option (TP-2574 a): a replay that makes a live call while results its prior drive recorded remain unread parks as `recovery_required` before any side effect, with `replay diverged` evidence naming the call and the next unread record.
- ef109f3: `GateAuthorize` takes an optional third argument `{ admittedBy }` ("owner-class", "allowance", "evidence" or "delegate") so an authorizer can tell how the store admitted a resolver; it still only narrows, and a two-argument authorize is unchanged. `openGate` accepts a `rule`, and `ctx.assisted` takes `rule?: GateRule` and stores it on the gate it opens (TP-3289).
- dbc8a21: `projectRunTrace` now emits gate and artifact records (TP-391 b): human gates read from the hitl gate store for `assisted` steps, owner-gated `authorize` steps and a paused run's pending gate (prompt and payload as digests only, `decidedBy` as `human:owner` or `agent:<id>`), plus the policy gates and artifacts a step carries under `StepResult.data["titan.trace.gates"]` and `["titan.trace.artifacts"]`, parsed strictly. A malformed entry throws naming the step. Export `TRACE_ARTIFACTS_KEY` beside `TRACE_GATES_KEY`.
- 45d312c: Add `projectRunTrace(run, { gates, executions?, digest })`, a pure projection of a stored run into strict `titan.trace/v1` run and attempt records: one attempt per ledger attempt, retries included, each with its own usage (TP-391 a). A dispatch's `StepResult.attempt` now records the attempt that succeeded.
- 31a7c73: `runtime.cancel(runId, reason, { abandon: true })` finishes a run no runtime drives as cancelled without replaying it to settle its in-flight steps.
- 2892aad: A step that a restart re-dispatches no longer uses up its retry budget. The active step now records `firstStartedAt`, which is kept across retries and restarts, and `restarts`, the number of times a retry-safe recovery re-dispatched it. The retry gate subtracts restarts from the attempt count before it compares with `maxRetries`. The dispatch input and `RoutedStepInput` carry both fields, so a wait can measure its deadline from the step's first start. A `StepRoute` can now declare a `reconcile` hook, which decides an interrupted step before the route's `onRestart` rule is applied. Rows stored without these fields still load: `firstStartedAt` falls back to `startedAt`, and `restarts` reads as 0.
- d79f48e: Add `WorkflowRuntime.quiesce()` and `quiesced()` for a planned handoff. Quiesce releases every live run's lease, then stops admission: `hydrate()` claims nothing, `start()` persists the new run unclaimed for the successor runtime to adopt, and `cancel()` marks the run `cancelling` and releases it instead of finishing it.

### Patch Changes

- 8a027ad: `hydrate` no longer re-claims a run this runtime parked as `recovery_required` because its workflow returned with a step unfinished; it stays held until the row changes or a new runtime starts (TP-2438).
- a2e2a70: Document trace projection (TP-391 c): the README gains a "Trace projection" section covering `projectRunTrace`'s inputs, record kinds and order, the `titan.trace.gates` and `titan.trace.artifacts` data keys, and what is digested. A new test pins that a projection after rebuilding the runtime and SQLite stores from the same database is JSON-byte-identical, and that `workflowStepRequestKey` output matches `ATTEMPT_ID_PATTERN`.
- fa23feb: TP-3340: Shepherd opens no visual accept offer at a step the old host left in flight, so a flag turned on between hosts cannot end an adopted run short of that step. The workflow context gains `recoveredInFlight()`.
- Updated dependencies [108b7f4]
- Updated dependencies [9f24b7f]
- Updated dependencies [a79cffd]
- Updated dependencies [dfffc6c]
- Updated dependencies [d754d5b]
- Updated dependencies [abadd64]
- Updated dependencies [d79a135]
- Updated dependencies [1b2c974]
- Updated dependencies [ef109f3]
  - @titan-design/agent@0.6.0
  - @titan-design/agent-protocol@0.8.0
  - @titan-design/authority@0.5.0
  - @titan-design/hitl@0.9.0

## 0.12.2

### Patch Changes

- Updated dependencies [c54c098]
  - @titan-design/agent@0.5.0

## 0.12.1

### Patch Changes

- 3977860: `durableHarnessRunner` reports the usage on a failed durable terminal, so `StepFailedError.usage` and the `mapItems` budget count what a failed durable step spent.

## 0.12.0

### Minor Changes

- 790401a: Mark usage with an unpriced measurement as `costUnknown` instead of counting it as $0. `mapItems` with `budgetUsd` stops launching on such usage with `stoppedBy: "cost_unknown"`.

### Patch Changes

- Updated dependencies [ea3d34c]
  - @titan-design/agent-protocol@0.7.0
  - @titan-design/agent@0.4.7

## 0.11.0

### Minor Changes

- dda3272: Pin a definition version on each run: `register(name, fn, { version })` stores the version on the run row, and `hydrate` parks a run pinned to a different version as `recovery_required` with evidence naming both versions instead of replaying the new definition over its memos. Existing tables add the column with the new `workflowDefinitionVersionMigration`; a pinned run in a table without it throws `WorkflowStoreSchemaOutdated`.

## 0.10.1

### Patch Changes

- bd74657: Gate sweeps skip a gate another host settled between listing and cancelling instead of throwing partway through.

## 0.10.0

### Minor Changes

- ff6424a: A Shepherd run replayed after a serve restart now follows the route its record took after each review, so a route table changed by a redeploy no longer sends it back to review or publish at a head it already left. Resync answers an active reviewer-starting step whose head the PR has moved past, and supersedes nothing when the PR cannot be read (TP-1831). The workflow context gains `historyNext()`, and the runtime gains `completeStep()` for a run no runtime holds.
- 7f4e467: Add `runtime.annotate(runId, stepId, data)` and `WorkflowRunStore.annotate(id, key, result)`: record a step result on a run that already finished, once, without a fence. Unfinished runs and existing keys are refused with false.
- 34066da: Add `WorkflowContext.resumedGate()`: the step a resumed run was paused on and has not reached again, so a workflow that changed since the record can tell a still-pending gate from live code.

### Patch Changes

- 534cec8: Give each run-state rule one definition inside the package: parking a run for recovery, the active-status list, gate ownership, the step outcome mapping, and `messageOf`. No behavior change.
- Updated dependencies [7345a13]
- Updated dependencies [f4b073d]
- Updated dependencies [d020cf9]
- Updated dependencies [2ff0840]
- Updated dependencies [69db518]
- Updated dependencies [c517313]
- Updated dependencies [69db518]
- Updated dependencies [cff7a11]
- Updated dependencies [bc96ab3]
- Updated dependencies [1f7de27]
- Updated dependencies [dcde08d]
- Updated dependencies [20778a2]
- Updated dependencies [ff6ff86]
  - @titan-design/agent-protocol@0.6.0
  - @titan-design/agent@0.4.6
  - @titan-design/authority@0.4.0
  - @titan-design/hitl@0.8.0
  - @titan-design/store-sqlite@0.4.0

## 0.9.1

### Patch Changes

- Updated dependencies [f2e4abf]
  - @titan-design/hitl@0.7.0

## 0.9.0

### Minor Changes

- 27702c6: `assisted` and `authorize` take an optional `brief` (hitl `GateBrief`: `summary`, `evidenceRef`, `questions?`) and store it on the gate they open, so a store with `requireBrief` accepts it. The `gate_opened` event gains an optional `summary`.

### Patch Changes

- 85870d9: `WorkflowRuntime.hydrate` takes an optional `exclude` set of run ids to leave unclaimed. Factory serve uses it so a held Shepherd run whose PR read fails is no longer adopted and driven: it waits for the next tick, when a successful read ends it or adopts it.
- 0f55e8b: Surface the errors Shepherd swallowed. `WorkflowRuntime.cancel` now throws a typed `WorkflowNotOwnedError` (same message) when it cannot claim the run. The gone-elsewhere sweep treats only that error as a lease held elsewhere; any other cancel failure goes to the new `onCancelFailed` callback, which serve logs, resync reports as `cancelErrors` and keeps held, and the pre-adoption recheck keeps unadopted. A `findPr` rejection in the Version Packages sweep is now a `{ repo, error }` note. A reviewer that never starts after failed roster reads names the last roster error in its reason. A thrown review-ruleset read or registration read still gates the merge, and the gate reason now names it (`unreadFacts` on the evidence).
- Updated dependencies [ea96b66]
- Updated dependencies [f886302]
- Updated dependencies [411b4f0]
- Updated dependencies [7fb6a9b]
  - @titan-design/store-sqlite@0.3.3
  - @titan-design/agent-protocol@0.5.0
  - @titan-design/hitl@0.6.0
  - @titan-design/agent@0.4.5

## 0.8.1

### Patch Changes

- 26a39c5: Emit the documented `step_failed` event before every `StepFailedError` a run context throws: retries exhausted, non-retryable failures, invalid output, and authority deny or refuse. A failing `mapItems` item now emits it too.
- Updated dependencies [32adb30]
- Updated dependencies [775af4a]
- Updated dependencies [117c3ae]
- Updated dependencies [3a4d4ed]
  - @titan-design/authority@0.3.0
  - @titan-design/hitl@0.5.0
  - @titan-design/store-sqlite@0.3.2

## 0.8.0

### Minor Changes

- 9b219eb: `AssistedOptions.recordCancel`: a gate cancelled while the step waits on it becomes the step's recorded answer, with signal `GATE_CANCELLED_SIGNAL` (`gate-cancelled`) and data `{ reason }`, instead of throwing `GateCancelled`. The next call to the same step opens a fresh gate, and a replay reads the same cancel. Without the option a cancelled gate still fails the run, and cancelling the run still ends it.
- 9d36afb: `WorkflowRuntime.start` takes an optional `onStart(runId)` hook that runs inside the transaction that inserts the run. A hook that throws rolls the run back and nothing launches, so a caller's own row commits with the run or not at all.

### Patch Changes

- e651365: Hydrate no longer reopens a gate whose row is missing. A run paused on an `assisted` or `authorize` gate that finds no row on resume goes to `recovery_required`, and its `workflow_recovery_required` event carries the `gateId`. Restoring the row lets the next hydrate resume; `cancel` ends the run.
- Updated dependencies [e54f34e]
  - @titan-design/authority@0.2.2

## 0.7.0

### Minor Changes

- 3eca440: Shepherd treats an `update-branch` HTTP 422 "merge conflict between base and head" as a conflict instead of failing the run: it wakes the fixer, and opens `approve-merge` only if the conflict survives one wake. A run that reads a new head cancels its own pending `approve-merge` and `sh-sent-back` gates for an older head. `WorkflowContext` gains `expireGates(reason, isStale)`, and the fake GitHub gains `updateBranchConflict`.

## 0.6.1

### Patch Changes

- fe11f1b: Each `ctx.authorize` result carries `titan.trace.gates` with one F3 policy gate-decision record per decision, and `TRACE_GATES_KEY` is exported. `policyRule.version` is the table version's semver major; a rule-less deny records row id `no-rule`.
- Updated dependencies [fe11f1b]
  - @titan-design/agent-protocol@0.4.0
  - @titan-design/agent@0.4.4

## 0.6.0

### Minor Changes

- 46b2880: `ctx.authorize(stepId, request, options?)` asks the authority table before a governed action, in one durable step. `allow` returns `{ verdict: "allow", ruleId }`. `deny` records the decision and throws `AuthorityDeniedError` without opening a gate. `gate` opens a hitl gate bound to the rule (`rule: { table: "F5", version, ruleId, resolvers }`) whose answer must be `{ decision: "approve" | "refuse", subject }` echoing the request's subject; an owner approval returns `{ verdict: "approved", ruleId, gateId, resolvedBy }`. A refusal, a resolver outside the recorded rule, or a gate resolved with no resolver throws `AuthorityRefusedError`. A restarted run resumes onto the same gate and judges the answer by the rule recorded on it, so a table edit during the pause does not flip the decision. Replay returns or throws the recorded outcome without consulting the table. The runtime takes `authority: { table?, actor }`; the table defaults to `DEFAULT_TABLE`. `StepOperation` gains `"authorize"`. The factory's step guard (`guardedContext`, `StepKind`) passes `authorize` through its declaration check.
- 9c0aa55: BREAKING: `WorkflowRuntime.signal(runId, stepId, payload, resolvedBy)` requires the resolver and drops the `{}` default on the payload, following hitl's required resolver. The gate store needs `gateResolverMigration` in the migration list, or its constructor throws `GateStoreSchemaOutdated`.

### Patch Changes

- 101119f: `ctx.authorize` refuses at once a gate at its id that carries no rule or was recorded under another table than F5, instead of pausing on a pending rule-less gate that could only refuse. Tests now cover a resolved rule-less gate.
- 9f49074: `ctx.authorize` now refuses a gate already recorded at the step's id under a different rule than the request's action maps to, instead of resuming it. The resolution is still judged against the recorded rule.
- Updated dependencies [6e848b7]
- Updated dependencies [9bef02d]
- Updated dependencies [9ac05b5]
- Updated dependencies [9c0aa55]
- Updated dependencies [8b0e7ed]
- Updated dependencies [50a7550]
  - @titan-design/authority@0.2.1
  - @titan-design/hitl@0.4.0

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
