# @titan-design/workflow

Durable imperative workflows backed by SQLite. A workflow is an ordinary async
function that calls `dispatch`, `seed`, and `assisted`. Completed calls are
memoized, so replay starts at the function entry without repeating committed
work. Human gates and in-flight execution identities survive process restarts.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `agent`, and `hitl`.

```ts
import {
  WorkflowRuntime,
  agentRunner,
  workflowMigration,
  workflowOwnershipMigration,
} from "@titan-design/workflow";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [
  gateMigration(1),
  workflowMigration(2),
  workflowOwnershipMigration(3),
]);

const runtime = new WorkflowRuntime({
  db,
  gates: new SqliteGateStore(db, { migrate: false }),
  runner: agentRunner({ cwd: repo, maxTurns: 40, maxBudgetUsd: 5 }),
  onEvent: (event) => console.log(event.type, event),
});

runtime.register("review", async (ctx) => {
  const plan = await ctx.dispatch("plan", "Plan {{brief}}.");
  if (plan.signal === "needs_revision") {
    await ctx.dispatch("plan", "Revise: {{STEP_OUTPUT_PLAN}}");
  }
  const approval = await ctx.assisted("approve", "Ship it?");
  if (approval.signal === "approved") {
    await ctx.dispatch("ship", "Ship {{STEP_OUTPUT_PLAN}}");
  }
});

const runId = runtime.start("review", { brief: "the thing" });
await runtime.hydrate();
runtime.signal(runId, "approve", { signal: "approved" });
```

## Database upgrade

`workflowMigration` creates new tables with revision and ownership columns.
Applications that already ran an earlier `workflowMigration` must append
`workflowOwnershipMigration` at the next unused database migration version.
Keep the original migration in the list; do not replace or renumber it.

```ts
runMigrations(db, [
  gateMigration(1),
  workflowMigration(2),          // may already be recorded
  workflowOwnershipMigration(3), // additive upgrade for existing tables
]);
```

The ownership migration is idempotent at the schema level, so using the same
sequence for new and upgraded databases is supported. A custom run table name
must be passed to both migration helpers and to `WorkflowRuntime.runTable`.

## Step kinds

- `dispatch(stepId, template, { model?, vars? })` renders a prompt, asks the
  runner to execute it, and parses a signal from the output. Results use the key
  `stepId:iteration`. Retry attempts persist their attempt number and get a new
  execution ID and request key.
- `seed(stepId, fn)` runs deterministic work once and merges its data into the
  workflow parameters.
- `assisted(stepId, prompt)` opens the durable gate `<runId>/<stepId>` and waits
  for `runtime.signal` to resolve it.

## Signals

`parseSignals(output)` returns every signal an output carries, highest
precedence first. `parseSignal(output)` returns the first entry of that list, or
`null` when it is empty; `dispatch` records it as `StepResult.signal`. Read the
full set with `parseSignals(result.output)`.

Precedence, highest first:

1. Empty or whitespace-only output yields only `EMPTY_OUTPUT_SIGNAL`
   (`"empty_output"`). Treat it as a reason to ask a human: a reviewer that
   produced nothing has not approved anything.
2. A canonical marker such as `<!-- signal: needs_revision -->` is
   authoritative. When the output carries markers that name known signals, the
   result is those markers and the prose is ignored. Unknown marker names fall
   through to the prose.
3. Otherwise every matching verdict pattern is reported, in the key order of
   `DEFAULT_SIGNAL_PATTERNS`: `high_risk`, `needs_revision`,
   `has_open_questions`, `approved`, `needs_fixes`, `changes_requested`,
   `needs_clarification`, `needs_changes`. A risk score of 4 or more therefore
   wins over a PASS verdict.

`createSignalSetParser(patterns)` and `createSignalParser(patterns)` build
parsers over a custom pattern record; its key order is the precedence. Pass a
custom `parseSignal` to the runtime to change the conventions `dispatch` uses.

`unfilledVariables(template, vars)` lists the `{{NAME}}` placeholders in a
template that `vars` does not supply, sorted. It reads the template before
substitution, so a `{{NAME}}` inside a substituted step output is not reported.
The renderer itself still leaves unknown placeholders in place.

## Execution recovery

`RecoverableStepRunner` is the durable runner contract. `dispatch` receives a
persisted `executionId`, deterministic `requestKey`, and attempt number. It must
return an acknowledgment containing the same IDs, a `runnerRef`, and a terminal
completion promise. The runtime persists the intent before dispatch and the
acknowledgment before it awaits completion.

After restart, `hydrate` claims each workflow row and calls `reconcile` for every
active recoverable step. A terminal or running result resumes replay. A
`not_found` result permits a new attempt only when `retrySafe` is true.
`unknown`, `ownership_lost`, unsafe absence, rejection, and timeout persist
`recovery_required` with the active intent intact. Calling `hydrate` later tries
reconciliation again, which allows a temporarily unavailable ledger to recover
without redispatching unknown work.

`durableHarnessRunner` adapts a durable harness dispatcher from
`@titan-design/agent` to this handshake. `agentRunner` and `inlineRunner` remain
legacy live runners. The deprecated optional `LegacyStepRunner.attach` can
return a confirmed terminal result after restart; missing or failed attachment
requires recovery. Legacy work is never automatically redispatched after an
unsafe restart.

## Ownership and cancellation

Each live runtime claims a workflow with a leased owner generation and advances
the row revision on every write. Saves, renewals, and release use both values as
a fence, so a stale callback cannot overwrite a newer owner. Configure
`runtimeId`, `leaseMs`, and `reconcileTimeoutMs` when the defaults do not fit the
host. Lease and timeout values must be positive safe integer milliseconds.

`cancel` first persists `cancelling`, then aborts live work and pending gates. A
confirmed cancellation becomes `cancelled`. A success that wins the race is
memoized before the workflow is finalized as cancelled. If the runner cannot
confirm cancellation, the row becomes `recovery_required` and retains its
active execution evidence.

`start` creates and claims a run; `wait` observes a live completion; `status`
and `list` read durable state. `shutdown` aborts callbacks and releases leases.
Events include step starts, completions, retries, failures, gate activity,
terminal workflow states, and `workflow_recovery_required`.
