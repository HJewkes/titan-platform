# @titan-design/workflow

Durable imperative workflows backed by SQLite. A workflow is an ordinary async
function that calls `dispatch`, `seed`, and `assisted`. Completed calls are
memoized, so replay starts at the function entry without repeating committed
work. Human gates and in-flight execution identities survive process restarts.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `agent`, `hitl`, and `authority`.

```ts
import {
  WorkflowRuntime,
  agentRunner,
  workflowMigration,
  workflowOwnershipMigration,
} from "@titan-design/workflow";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [
  gateMigration(1),
  workflowMigration(2),
  workflowOwnershipMigration(3),
  gateResolverMigration(4),
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
runtime.signal(runId, "approve", { signal: "approved" }, {
  class: "owner-terminal",
  id: "alice",
  channel: "cli",
});
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
  gateResolverMigration(4),      // records who resolved each gate
]);
```

The ownership migration is idempotent at the schema level, so using the same
sequence for new and upgraded databases is supported. A custom run table name
must be passed to both migration helpers and to `WorkflowRuntime.runTable`.

`gateResolverMigration` adds hitl's `resolved_by` column and a trigger that
refuses a resolution naming no resolver. Once it has run, pass a resolver to
every `runtime.signal`. A run paused before the migration resumes normally when
it is signalled with a resolver afterwards. Gates resolved before it keep
`resolvedBy` undefined.

## Step kinds

- `dispatch(stepId, template, { model?, vars? })` renders a prompt, asks the
  runner to execute it, and parses a signal from the output. Results use the key
  `stepId:iteration`. Retry attempts persist their attempt number and get a new
  execution ID and request key. `StepResult.usage` sums every attempt the
  runner reported cost for, so a step that fails once and then succeeds
  reports both attempts. The active step persists the earlier attempts' cost as
  `priorUsage`, so a run resumed after a crash counts each attempt once.
- `seed(stepId, fn)` runs deterministic work once per call and merges its data
  into the workflow parameters.
- `assisted(stepId, prompt)` opens a durable gate and waits for
  `runtime.signal` to resolve it. Like `dispatch`, it counts calls per `stepId`
  and advances `ctx.iteration(stepId)`, so calling it in a loop opens a new gate
  each time. The first call uses the key `stepId` and the gate
  `<runId>/<stepId>`, as earlier releases did. Iteration `n` of a repeated call
  uses the key `stepId:n` and the gate `<runId>/<stepId>:n`.
  `runtime.signal(runId, stepId, payload, resolvedBy)` resolves the gate of the
  call that is waiting and records `resolvedBy` on the gate. The gate store
  checks the resolver first: an agent or automation class, or a refusal from
  the store's `authorize`, throws `GateResolverRefused` and the run stays paused. Replay returns the recorded answers in call order and opens no gate
  for them.

All three methods share one call counter per `stepId`, and each result records
the method that wrote it as `StepResult.operation`. `seed("x")` followed by
`assisted("x")` therefore gates on `<runId>/x:1`, and `dispatch("x")` followed
by `assisted("x")` does the same. A replay that reaches a recorded call through
a different method, because the workflow was edited under a live run, fails the
run with `WorkflowNonDeterminismError` instead of returning the stale answer.

Runs stored by releases before 0.5 hold results without `operation`. They keep
that release's keys until they finish: seeds key by the bare `stepId` outside
the call count, and replay does not check the method. A run that such a release
paused inside `assisted("x")` after a `dispatch("x")` is still waiting on
`<runId>/x`, so `assisted` adopts a gate that is still pending there when the
bare key holds no result.

## Authority steps

`authorize(stepId, request, { prompt?, expiresAt? })` asks the authority table
before a governed action. The runtime needs `authority: { actor, table? }`; the
actor is who this runtime acts as, and the table defaults to `DEFAULT_TABLE`
from `@titan-design/authority`. A run without that option fails at its first
`authorize`, before any gate. The request is an `AuthorityRequest` without the
actor; `tainted` defaults to `false`.

- `allow` returns `{ verdict: "allow", ruleId }`.
- `deny` records the decision and throws `AuthorityDeniedError`, a
  non-retryable `StepFailedError` with `ruleId`. No gate is opened.
- `gate` opens a hitl gate at `<runId>/<stepId>`, keyed like `assisted`, bound
  to the rule: `rule: { table: "F5", version, ruleId, resolvers }`. The store
  refuses a resolver class outside `resolvers` and the run stays paused. The
  answer must be `{ decision: "approve" | "refuse", subject, reason? }`, and
  `subject` must repeat the request's subject exactly, so an approval cannot
  land on a different head or version. An approval returns
  `{ verdict: "approved", ruleId, gateId, resolvedBy }`. A refusal, or a gate
  that reads back resolved with no resolver or one the recorded rule does not
  name, throws `AuthorityRefusedError`. So does a gate already at that id
  that carries no rule or was recorded under a table other than `F5`, pending or
  resolved: it is refused at once and never awaited.

A restarted run resumes onto the gate that is already open and judges the
answer by the rule recorded on it, never by a fresh evaluation, so a table
edit during the pause does not flip the decision. Replay returns or throws the
recorded outcome without consulting the table. The resolver's taint is not yet
known, so the read-side check passes `tainted: false`. On SQLite, a
rule-bound gate needs both `gateResolverMigration` and `gateRuleMigration`.

## Fan-out

`mapItems(ctx, stepId, items, fn, { key, concurrency?, budgetUsd?, maxFailures? })` runs `fn`
over a list with a concurrency cap (default 1). Each item runs as step
`${stepId}/${key}`, and `fn` receives that id to pass to `ctx.dispatch`, so each
item memoizes on its own. After a restart, replay reuses the finished items and
runs only the rest. Matching is by key, not position, so the input may be
reordered between runs. Duplicate keys throw before anything launches.

`budgetUsd` is checked before each launch against the cost that items reported
in `StepResult.usage` or on their failure. An item that succeeds on retry
counts its failed attempts once, through its result. Items still in flight are not
counted, so a run can overshoot by up to `concurrency - 1` items.

An item whose step throws `StepFailedError` lands in `failed` with its `error`,
`retryable` flag and, when the runner reported it, the `usage` of its failed
attempts, and the remaining items keep launching. A non-retryable failure (auth,
budget, refusal, schema) stops new launches at once, because the next item would
fail the same way. Retryable failures stop launches once there are more than
`maxFailures` of them (default 3). `spentUsd` includes failed-call cost. The
result reports `results` in input order, plus `failed`, `skipped`, `spentUsd`
and `stoppedBy` (`"budget"`, `"failure"` or `null`). Any other error is
rethrown once the items in flight settle.

`agentRunner` reports `usage` (`costUsd`, `inputTokens`, `outputTokens`) on
every successful step, and on a failed step whenever the agent run reported it.
The `durableHarnessRunner` reports `usage` on a successful step when the
harness returned measurements. It selects them with agent-protocol's
`foldUsage`, the fold session-read uses: response deltas count once each and
supersede snapshots; otherwise it keeps the highest-sequence snapshot per scope,
and a conversation snapshot supersedes turn snapshots in its epoch. It counts an
unpriced measurement's tokens with no cost and skips a null token count. Its failed steps report no usage, because the durable failure record
carries none, so they add nothing to `spentUsd`. A run with an `outputSchema` stores its output as JSON
text. Wrap it in `idempotentRunner` when its steps are safe to repeat, such as
read-only judgements. Then a step that was in flight at a crash is dispatched
again on `hydrate` instead of parking the run as `recovery_required`. With that
wrapper, a step's `agentId` is its request key, not the agent session id.

## Routing steps to runners

`routedRunner(routes)` is one runner for the runtime that sends each dispatch
step to its own runner. That lets a workflow mix code steps and model steps.
A route names a step id in `match`, which also covers the `<id>:<suffix>`
family; the longest matching route wins. It also names a restart rule.
`onRestart: "repeat"` dispatches a step that was in flight at a crash again on
`hydrate`. `onRestart: "park"` leaves the run `recovery_required` for a human,
for steps whose effect may already have happened. A step no route covers also
parks.

```ts
const runner = routedRunner([
  { match: "draft", onRestart: "repeat", runner: agentRunner({ cwd, maxTurns: 20, maxBudgetUsd: 1 }) },
  { match: "open-pr", onRestart: "park", runner: openPrRunner },
]);
runner.assertRoutes("ship", ["draft", "open-pr"]);
runtime.register("ship", ship);
```

Call `runner.assertRoutes(workflowName, stepIds)` when registering a workflow.
It throws naming every dispatch step id that no route covers. Two routes with
the same `match` throw when the runner is built. Route runners receive the
step's `attempt` and `requestKey` with the usual input, and a step's `agentId`
is its request key.

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
`@titan-design/agent` to this handshake. `idempotentRunner` adapts a live
runner whose steps are safe to repeat (see Fan-out). `agentRunner` and
`inlineRunner` remain legacy live runners. The deprecated optional `LegacyStepRunner.attach` can
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
