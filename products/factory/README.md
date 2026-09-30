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
titan-factory service plist                                   # print the LaunchAgent plist for titan-factory serve
titan-factory shepherd register owner/repo#N --task <t> --implementer <agent>  # or owner/repo --branch <b>
titan-factory shepherd status|list|timeline|hold|release|merge ...  # --json prints the result as JSON
```

`--db <path>` picks the database. Otherwise `TITAN_FACTORY_DB`, then `dbPath` in
`$XDG_CONFIG_HOME/titan-factory/config.json`, then `$XDG_STATE_HOME/titan-factory/factory.sqlite3`.
Owner-specific bindings live in that config file, never in this repo.

`resume` hydrates every unfinished run, drives each until it completes, fails, parks as
`recovery_required`, or waits on a pending gate, then releases the runs and exits. A run
killed with `kill -9` keeps its lease for 30 s. `resume` inside that window prints the run as
`held ... leased by <runtime> until <time>` and leaves it alone.

## Shepherd commands

`shepherd.register`, `status`, `list`, `timeline`, `hold`, `release` and `merge` are registry
commands. `titan-factory serve` exposes each as the MCP tool `shepherd__<cmd>` and as
`POST /rpc/shepherd.<cmd>`; the `titan-factory shepherd <cmd>` verb calls the server when one
answers and the database directly otherwise. The tool prefix is empty, so `factory.land` is
`factory__land`.

- `register` resolves the seat policy first, so a repo on a deny list or a charter hard stop
  is refused before anything starts. It is idempotent on `repo#pr` and on the PR's head
  branch: a repeat, or a PR registered after its branch, updates the task, implementer,
  reviewer and policy on the existing registration and returns its run. The run's policy only
  ever narrows toward the stored one.
- `list` and `timeline` return the `WatchRow` and `PrTimeline` shapes in
  `src/shepherd/view.ts`, which the factory UI reads.
- `hold` and `release` write the registration's hold, which every merge route checks.
- `merge` reports the policy decision for the current head and what the run waits on. It
  never signals the run and never resolves a gate.

Gate resolution is not a registry command, so no MCP or `/rpc` caller can answer a gate. It
stays the local `titan-factory gate resolve`.

## Install as a LaunchAgent

`service plist` prints a plist for `dev.hjewkes.titan-factory`: the absolute node path, the
built `dist/bin.js` and `serve`, `RunAtLoad` and `KeepAlive` true, and logs at
`$XDG_STATE_HOME/titan-factory/serve.{out,err}.log`. `ProcessType` is `Interactive`; a
`Background` job is throttled by macOS. The verb only prints. It never touches
`~/Library/LaunchAgents` or runs `launchctl`, so the owner installs it.

The node path is the running node, except that a Homebrew Cellar path (`.../Cellar/node/22.1.0/bin/node`)
becomes the prefix symlink (`<prefix>/bin/node`, or `<prefix>/opt/node@20/bin/node` for a versioned
formula) when that symlink resolves to the same binary, so `brew upgrade` does not break the job.
Pass `--node <absolute path>` to choose another node. After changing node (an upgrade to a different
major, a version manager switch), re-run `service plist`, rewrite the file and bootstrap it again.

```sh
pnpm build
node products/factory/dist/bin.js service plist > ~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist
curl -s http://127.0.0.1:7410/health
claude mcp add --transport http --scope user titan-factory http://127.0.0.1:7410/mcp
```

`/health` reports `github`: `ok` when `gh api rate_limit` succeeds under the job's
environment, else the redacted gh error (a LaunchAgent may not reach gh's keychain token).
`checking` shows until the first probe lands. The probe runs in the background, at most once
a minute, with a 10 s timeout, so a health request never waits on gh.

## Files

| File | Role |
| --- | --- |
| `src/host.ts` | Opens one SQLite file (gates plus runs, the codewatch triage migrations), builds the runtime, registers workflows, implements `resume` |
| `src/definition.ts` | `defineWorkflow`: a workflow declares each step id with one kind (`dispatch`, `seed`, `assisted`). Registration rejects an id with two kinds, and a guarded context fails a run whose code calls an undeclared id or kind. This is the guard for TP-255, where `seed(x)` and `assisted(x)` share a memo key |
| `src/routed-runner.ts` | Product-side step router, **deleted when `@titan-design/workflow` exports `routedRunner` (TP-416)**. Each route is `{ match, runner, onRestart }`. `repeat` re-dispatches a step a crash interrupted; `park` leaves the run `recovery_required`. A dispatch step with no route fails registration |
| `src/evidence.ts` | **The F3 seam** (see below) |
| `src/gate-policy.ts` | **The F5 seam** (see below) |
| `src/service.ts`, `src/github-health.ts` | The LaunchAgent plist renderer, and the cached `gh api rate_limit` probe behind health's `github` field |
| `src/config.ts` | zod-validated local config and database path resolution |
| `src/shepherd/seats.ts`, `src/shepherd/policy.ts` | Shepherd seat book (autonomy-seat/v1 files plus charter hard stops) and the per-PR effective policy (see below) |
| `src/cli.ts`, `src/bin.ts` | commander wiring for `resume`, `gate resolve`, `serve`, `land`, `shepherd` and `service plist` |
| `src/shepherd/commands.ts`, `src/shepherd/view.ts` | The `shepherd.*` registry commands, and the watch-row and timeline read model they return |
| `src/workflows/land.ts` | The land core (see below) |
| `src/test-support/crash.ts` | Crash harness: host A with a frozen clock hangs in a step and never releases its lease; host B, clocked past that lease, takes the run over |

## Shepherd seat paths

A seat path in `repos[].path` or `deny_repos` is accepted only in one of these shapes:
`~/`, `$HOME/`, `${HOME}/` or `/`, followed by one or more segments of `[A-Za-z0-9._-]`
that are not `.` or `..`. Any other spelling throws `SeatBookInvalid` naming the file, because
an unrecognised spelling could only make a deny miss. Paths compare case-insensitively, with
the home directory unified to `~`.

Symlinks are not resolved: there is no `realpath`, and nothing touches the filesystem. A deny
written through a symlinked directory does not match a repo path written through its target.
Spell both the same way.

## GitHub port

The land core talks to GitHub through `@titan-design/github` (`githubPort` over `ghCliWire`,
and `fakeGitHub` in tests). Its README documents the check-then-act writes and the argument
validation.

## Land core: `src/workflows/land.ts`

`land(ctx, { repo, pr }, { policy })` runs these steps, all code, all routed `repeat`:

- `land-rules`: required checks and the strict flag for the PR's base, read at run start.
- `ci-wait:<n>`: one blocking step that polls every 30 s (45 min timeout) until every required
  check's latest run completed. An empty rollup is pending. `mergeable_state` `unknown` or
  `blocked` keeps it waiting; it is never treated as clean.
- `update-branch:<n>`: only when the PR is behind, under `expected_head_sha`. After
  `MAX_UPDATE_CYCLES` (3) updates the run opens gate `stuck-behind` (retry or abandon).
- `merge-policy:<n>`: before any merge of an untrusted head, `GatePolicy.decide("merge", { headSha })`
  runs and this step records `{ outcome, headSha, rule, reason }`. The workflow branches on the
  recorded decision, so a replay after a crash reuses it even if the policy has changed since.
  `deny` stops the run. `allow` trusts that one head with no hitl gate and stores the caller's
  `allowEvidence`; an update never extends an allow, so each new head gets a fresh decision.
- `approve-merge` (gate): opens when the recorded decision is `gate`. The payload must name the
  head shown (`{ decision, headSha }`), and the gate's stored schema refuses any other head.
- `merge:<n>`: `sha` is the allowed or approved head, or, after a human approval only, a head
  this run's own update built on it (GitHub's merge of that head and the base). A head anyone
  else pushed asks again.

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

`GatePolicy.decide(action, target?)` returns `{ outcome, rule: { table, rowId, version }, reason }`. The
only implementation, `gateEverything`, sends every action to a human, because the F5 authority
table is not approved. `policyTraceGate(decision, ref)` renders a decision as a policy gate entry
with the F3 id `<spanId>#policy:<table>:<rowId>`.
