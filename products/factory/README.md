# @titan-design/factory

Code-driven software-factory workflows. Private; never published. Bin: `titan-factory`.

Code owns every workflow transition, retry and evidence record here; a model supplies judgment
only where a step is routed to one. The product composes `@titan-design/workflow`, `hitl` and
`store-sqlite`. It never dispatches an agent. Relay and agent-chat keep dispatch.

**Run `pnpm build` before any test or live run.** Tests and the bin load sibling packages from
their `dist`, and a stale `dist` behaves like a different release (the `agent` build once
lacked the `claude-print` harness its source had).

This is slice S0 (TP-410): the host, the step router and the two seams. It registers no
workflow yet; the pilots land in later slices and register in `src/workflows.ts`.

## Commands

```sh
titan-factory resume                                          # drive every unfinished run, then list open gates
titan-factory gate resolve <runId> <stepId> --json '<payload>'  # answer a gate; its stored schema checks the payload
```

`--db <path>` picks the database. Otherwise `TITAN_FACTORY_DB`, then `dbPath` in
`$XDG_CONFIG_HOME/titan-factory/config.json`, then `$XDG_STATE_HOME/titan-factory/factory.sqlite3`.
Owner-specific bindings live in that config file, never in this repo.

`resume` hydrates every unfinished run, drives each until it completes, fails, parks as
`recovery_required`, or waits on a pending gate, then releases the runs and exits. A run
killed with `kill -9` keeps its lease for 30 s. `resume` inside that window prints the run as
`held ... leased by <runtime> until <time>` and leaves it alone.

## Files

| File | Role |
| --- | --- |
| `src/host.ts` | Opens one SQLite file (gates plus runs, the codewatch triage migrations), builds the runtime, registers workflows, implements `resume` |
| `src/definition.ts` | `defineWorkflow`: a workflow declares each step id with one kind (`dispatch`, `seed`, `assisted`). Registration rejects an id with two kinds, and a guarded context fails a run whose code calls an undeclared id or kind. This is the guard for TP-255, where `seed(x)` and `assisted(x)` share a memo key |
| `src/routed-runner.ts` | Product-side step router, **deleted when `@titan-design/workflow` exports `routedRunner` (TP-416)**. Each route is `{ match, runner, onRestart }`. `repeat` re-dispatches a step a crash interrupted; `park` leaves the run `recovery_required`. A dispatch step with no route fails registration |
| `src/evidence.ts` | **The F3 seam** (see below) |
| `src/gate-policy.ts` | **The F5 seam** (see below) |
| `src/config.ts` | zod-validated local config and database path resolution |
| `src/cli.ts`, `src/bin.ts` | commander wiring for `resume` and `gate resolve` |
| `src/test-support/crash.ts` | Crash harness: host A with a frozen clock hangs in a step and never releases its lease; host B, clocked past that lease, takes the run over |

## F3 seam: `traceRef()` in `src/evidence.ts`

`traceRef({ runId, stepId, iteration, attempt })` returns `{ traceId, spanId }`. The trace id is
the run id. The span id is `workflowStepRequestKey(...)`, the attempt grammar of the F3 trace
schema: `workflow:<runId>:<stepId>:<iteration>:<attempt>`. The routed runner passes the attempt to
each route, so a step builds its own span. `evidenceRecord(kind, step, at, body)` stamps
`v`, `kind`, `at`, `traceId` and `spanId` onto a body; the body cannot override them.

F3 projects artifacts and policy decisions from `StepResult.data` under the keys in
`TRACE_DATA_KEYS` (`titan.trace.artifacts`, `titan.trace.gates`). This product does not import
the F3 schema until it is released.

Known gap: only a gate's resolution can put structured values on `StepResult.data` today. A
dispatch result carries `output` text and no `data`. A seed's `data` is `Record<string, string>`
and merges into the run's params. So a code step cannot yet write a `TraceArtifact[]` under
those keys without a workflow change.

## F5 seam: `GatePolicy` in `src/gate-policy.ts`

`GatePolicy.decide(action)` returns `{ outcome, rule: { table, rowId, version }, reason }`. The
only implementation, `gateEverything`, sends every action to a human, because the F5 authority
table is not approved. `policyTraceGate(decision, ref)` renders a decision as a policy gate entry
with the F3 id `<spanId>#policy:<table>:<rowId>`.
