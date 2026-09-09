# @titan-design/workflow

Durable, imperative workflows. You write an ordinary async function that calls
`dispatch`, `seed`, and `assisted`; every call is memoized in SQLite, so after a crash
or restart the function re-runs from the top and resumes exactly where it stopped.
Human-in-the-loop pauses are durable gates, resolvable from any process.

Tier 2 of the titan-platform DAG. Depends on `store-sqlite`, `agent`, and `hitl`.
Ported from brain's bespoke SQLite runtime (TP-12) with its PM, template, and
process-polling couplings turned into injectable seams.

```ts
import { WorkflowRuntime, agentRunner, workflowMigration } from "@titan-design/workflow";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [gateMigration(1), workflowMigration(2)]);

const runtime = new WorkflowRuntime({
  db,
  gates: new SqliteGateStore(db, { migrate: false }),
  runner: agentRunner({ cwd: repo, maxTurns: 40, maxBudgetUsd: 5 }),
  onEvent: (e) => console.log(e.type, e),
});

runtime.register("review", async (ctx) => {
  const plan = await ctx.dispatch("plan", "Plan {{brief}}.");
  if (plan.signal === "needs_revision") await ctx.dispatch("plan", "Revise: {{STEP_OUTPUT_PLAN}}");
  const ok = await ctx.assisted("approve", "Ship it?");
  if (ok.signal === "approved") await ctx.dispatch("ship", "Ship {{STEP_OUTPUT_PLAN}}");
});

const runId = runtime.start("review", { brief: "the thing" });
await runtime.hydrate(); // after a restart: resumes every running or paused run
runtime.signal(runId, "approve", { signal: "approved" }); // from a CLI, MCP tool, dashboard
```

## The three step kinds

- `dispatch(stepId, template, { model?, vars? })` renders the template (`{{VAR}}` over the
  run's params, `STEP_OUTPUT_<STEP>`, `PREVIOUS_STEP_OUTPUTS`, `WORKFLOW_NAME`, …), hands
  the prompt to the `StepRunner`, and parses a signal from the output. Results are keyed
  `stepId:iteration`, so calling the same step again in a loop is a new iteration and
  `ctx.iteration(stepId)` is the loop guard. A retryable runner failure is re-dispatched
  once (`maxRetries`); anything else fails the run.
- `seed(stepId, fn)` runs a deterministic function once; its `data` merges into the
  params for later prompts.
- `assisted(stepId, prompt)` opens a gate with id `<runId>/<stepId>` and waits. The row
  survives restarts; `runtime.signal(runId, stepId, payload)` resolves it from anywhere.
  A `signal` field in the payload becomes the step's signal.

## Runners

`agentRunner({ cwd, maxTurns, maxBudgetUsd })` runs each step as one headless Claude Code
session via `@titan-design/agent`. Rate limits, runtime errors, and inactivity are
retryable; budget, auth, refusal, and schema failures are not. `inlineRunner(fn)` is for
tests and for steps that are not agents. Implement `StepRunner` yourself for a queue or a
subprocess; add `attach(step)` if your runner can re-join work started before a restart,
otherwise `hydrate()` re-dispatches it.

## Signals

`<!-- signal: needs_revision -->` in the output is authoritative. Without a marker, the
default patterns recognize the verdict conventions brain's prompts use (`Verdict: PASS`,
`NEEDS REVISION`, `Risk Score: 5`, …). Pass `parseSignal: createSignalParser(patterns)` to
use your own.

## Lifecycle

`start` persists the run and launches it; `wait` resolves when it finishes; `status` and
`list` read state; `cancel` aborts the runner through its `AbortSignal`, cancels the run's
pending gates, and marks the row `cancelled`. Events (`step_started`, `step_complete`,
`step_retry`, `step_failed`, `gate_opened`, `workflow_*`) go to `onEvent`; brain pushed
these over an MCP channel, and that adapter belongs to the product.

## What stayed in brain

PM task claiming and release on failure, prompt rendering from PM notes, model routing by
turn complexity, `.plans/` output files, and the agent-process reconciler. Each maps onto a
seam here: `onEvent`, `render`, `DispatchOptions.model`, and `StepRunner.attach`.
