# workflow

**Tier 2 · domain.** Depends on [`store-sqlite`](/reference/store-sqlite),
[`agent`](/reference/agent), and [`hitl`](/reference/hitl). `zod` v4 is a peer.

```sh
npm install @titan-design/workflow zod
```

## The problem it solves

A long-running agentic process — plan, review, revise, get approval, ship — has to survive
the process dying halfway through. The usual answers are a state machine you hand-maintain,
or a durable-execution engine you now have to operate.

Here you write an **ordinary async function**. Every `dispatch`, `seed`, and `assisted` call
is memoized in SQLite, so after a crash or restart the function re-runs from the top and
resumes exactly where it stopped. Human pauses are durable gates, resolvable from any
process.

## When to reach for it

Multi-step agent work with branches, loops, and approval points that must not lose progress
across a restart. For a single agent call with no memoization, use
[`agent`](/reference/agent) directly.

## Example

Verified against 0.1.0 with `inlineRunner`.

```ts
import { WorkflowRuntime, inlineRunner, workflowMigration } from "@titan-design/workflow";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("state.sqlite3");
runMigrations(db, [gateMigration(1), workflowMigration(2)]);

const runtime = new WorkflowRuntime({
  db,
  gates: new SqliteGateStore(db, { migrate: false }),
  runner: inlineRunner(({ prompt }) => `handled: ${prompt}`),   // returns a string
  onEvent: (event) => {
    // In a real product the answer comes from a human, from anywhere.
    if (event.type === "gate_opened") runtime.signal(event.runId, event.stepId, { signal: "approved" });
  },
});

runtime.register("review", async (ctx) => {
  const plan = await ctx.dispatch("plan", "Plan {{brief}}.");
  // plan.output === 'handled: Plan the docs site.'
  const approval = await ctx.assisted("approve", "Ship it?");
  // approval.signal === 'approved'
});

const runId = runtime.start("review", { brief: "the docs site" });
await runtime.wait(runId);
runtime.status(runId)?.status;   // 'completed'
```

In production, swap the runner for `agentRunner`, which runs each step as one headless Claude
Code session:

```ts
import { agentRunner } from "@titan-design/workflow";

runner: agentRunner({ cwd: repo, maxTurns: 40, maxBudgetUsd: 5 })
```

After a restart, `await runtime.hydrate()` resumes every running or paused run.

## The three step kinds

- **`dispatch(stepId, template, { model?, vars? })`** renders the template — `{{VAR}}` over
  the run's params, `STEP_OUTPUT_<STEP>`, `PREVIOUS_STEP_OUTPUTS`, `WORKFLOW_NAME`, `RUN_ID`
  — hands the prompt to the `StepRunner`, and parses a signal from the output. Results are
  keyed `stepId:iteration`, so calling the same step again in a loop is a new iteration and
  `ctx.iteration(stepId)` is the loop guard. A *retryable* runner failure is re-dispatched
  once (`maxRetries`); anything else fails the run.
- **`seed(stepId, fn)`** runs a deterministic function once; its `data` merges into the
  params for later prompts.
- **`assisted(stepId, prompt)`** opens a gate with id `<runId>/<stepId>` and waits. The row
  survives restarts; `runtime.signal(runId, stepId, payload)` resolves it from anywhere. A
  `signal` field in the payload becomes the step's signal.

## Runners

`agentRunner` classifies [`agent`](/reference/agent) failures: rate limits, runtime errors,
and inactivity are retryable; budget, auth, refusal, and schema failures are not.

`inlineRunner(fn)` is for tests and for steps that are not agents. **Its function returns a
plain string**, not a `StepRunOutcome` — the wrapper turns a thrown error into a
non-retryable failure.

Implement `StepRunner` yourself for a queue or a subprocess. Add `attach(step)` if your
runner can re-join work started before a restart; otherwise `hydrate()` re-dispatches it.

## Signals

`<!-- signal: needs_revision -->` in the output is authoritative. Without a marker, the
default patterns recognise verdict conventions like `Verdict: PASS`, `NEEDS REVISION`, and
`Risk Score: 5`. Pass `parseSignal: createSignalParser(patterns)` to use your own.

## Lifecycle

`start` persists the run and launches it. `wait` resolves when it finishes. `status` and
`list` read state. `cancel` aborts the runner through its `AbortSignal`, cancels the run's
pending gates, and marks the row `cancelled`. Events — `step_started`, `step_complete`,
`step_retry`, `step_failed`, `gate_opened`, `workflow_*` — go to `onEvent`.

## Gotchas

**You cannot signal a gate before it opens.** `runtime.start` returns immediately, and the
workflow reaches `assisted` some steps later. Calling `runtime.signal(runId, stepId, …)`
before then throws `GateNotFound`, and the run then waits forever for an answer that was
already thrown away. Drive it from the `gate_opened` event, or from a real human surface
listing `store.listPending()`.

**Your workflow function re-runs from the top on resume.** That is the mechanism, not a bug:
memoized steps return their stored result instead of re-executing. Keep side effects inside
`seed` or `dispatch`, never in the function body between them.

**Gate and workflow migrations share a database.** Pass `migrate: false` to
`SqliteGateStore` and put `gateMigration(n)` in your own migration list, or the two will
fight over the schema.

**Pushing events to a client is the product's job.** brain sent these over an MCP channel;
that adapter is deliberately not in the package.

## Where it came from

brain's bespoke SQLite runtime, ported with its PM, template, and process-polling couplings
turned into injectable seams. What stayed in brain — PM task claiming, prompt rendering from
notes, model routing by turn complexity, `.plans/` output files, the agent-process reconciler
— each maps onto one of those seams: `onEvent`, `render`, `DispatchOptions.model`, and
`StepRunner.attach`.
