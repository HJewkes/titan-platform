# @titan-design/factory

Code-driven software-factory workflows. Private; never published. Bin: `titan-factory`.

Code owns every workflow transition, retry and evidence record here; a model supplies judgment
only where a step is routed to one. The product composes `@titan-design/workflow`, `hitl` and
`store-sqlite`. It never dispatches an agent. Relay and agent-chat keep dispatch.

**Run `pnpm build` before any test or live run.** Tests and the bin load sibling packages from
their `dist`, and a stale `dist` behaves like a different release (the `agent` build once
lacked the `claude-print` harness its source had).

Slice S0 (TP-410) added the host, the step router and the two seams. Slices S1 and S2 (TP-411)
add the GitHub port and the land core. No workflow is registered yet; the pilots land in later
slices and register in `src/workflows.ts`.

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
| `src/github/port.ts`, `gh-cli.ts`, `checks.ts`, `fake.ts` | The GitHub port (see below) |
| `src/workflows/land.ts` | The land core (see below) |
| `src/test-support/crash.ts` | Crash harness: host A with a frozen clock hangs in a step and never releases its lease; host B, clocked past that lease, takes the run over |

## GitHub port: `src/github/`

`GitHubWire` is one GitHub call per method, unconditional, the way GitHub itself behaves.
`ghCliWire()` implements it by running `gh api` with an argv array, never a shell, on the
caller's existing `gh` login; nothing here reads or passes a token. `githubPort(wire)` puts
check-then-act on top: every write reads first and reports `{ done: false, skipped }` when its
effect is already in place, so a step that repeats after a crash repeats no effect.

| Write | Reads first | Guard GitHub enforces |
| --- | --- | --- |
| `ensureBranch` | the ref | none |
| `putFile` | the file on the branch; identical content skips | `sha` = expected blob |
| `openPr` | open, then merged, PRs for the head | none |
| `updateBranch` | the PR: merged, head moved or not behind skips | `expected_head_sha` |
| `merge` | the PR: merged returns the stored merge SHA; a moved head skips | `sha` = the approved head |
| `rerunFailed` | the Actions run; not completed skips | none |

`githubPort` validates every argument before any wire call, because each one becomes part of a
`gh api` path. It checks five things. The repo is `owner/name` of `[A-Za-z0-9._-]`, and neither
part is `.` or `..`. A branch or ref follows git's ref-name rules and has no `?` or `#`. A sha is
40 lower-case hex characters. A PR number or run id is a positive safe integer. A content path is
relative, with no `.`, `..` or empty segment and no `?` or `#`. A bad value throws
`GitHubInputError` naming the field, and `gh` never runs.

`requiredChecks` reads the branch's active rulesets (`rules/branches/<base>`), never a
hardcoded list. `latestCheckRuns` keeps the newest run per check name, because one head can
carry a success and a later superseded `cancelled` run. `behind` comes from the compare API.
`src/github/fake.ts` is an in-memory `GitHubWire` with effect counters, for tests only.

## Land core: `src/workflows/land.ts`

`land(ctx, { repo, pr }, { policy })` runs these steps, all code, all routed `repeat`:

- `land-rules`: required checks and the strict flag for the PR's base, read at run start.
- `ci-wait:<n>`: one blocking step that polls every 30 s (45 min timeout) until every required
  check's latest run completed. An empty rollup is pending. `mergeable_state` `unknown` or
  `blocked` keeps it waiting; it is never treated as clean.
- `update-branch:<n>`: only when the PR is behind, under `expected_head_sha`. After
  `MAX_UPDATE_CYCLES` (3) updates the run opens gate `stuck-behind` (retry or abandon).
- `approve-merge` (gate): **every merge waits on it.** `GatePolicy` is consulted first; `deny`
  stops the run, and any other outcome, `allow` included, still opens the gate. The payload
  must name the head shown (`{ decision, headSha }`), and the gate's stored schema refuses any
  other head.
- `merge:<n>`: `sha` is the approved head, or a head this run's own update built on it
  (GitHub's merge of that head and the base). A head anyone else pushed asks again.

A failed code step stores its error through `redactForEvidence` (`src/redact.ts`). That call
replaces gh token shapes (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) and
`Authorization:` header values with a marker, and caps the text at 500 characters.

`land` returns `merged`, `ci-failed` (with the failing checks and their Actions run ids, for
pilot 2 to classify) or `stopped`. Each code step's output is one evidence record whose
`result` the workflow reads. A workflow that lands a PR spreads `LAND_STEPS` into its own step
declaration and `landRoutes({ port })` into the host's routes.

### Not covered

GitHub applies `update-branch` asynchronously, and the fake applies it at once. A kill inside
`waitForHeadChange` can therefore send a second `update-branch` with the same
`expected_head_sha` on resume. The worst case is one extra merge-of-base commit on the PR branch.
That commit cannot reach `merge` without a trusted head: it is trusted only if its first parent
is a head the approval already covers, and anything else asks the human again.

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
