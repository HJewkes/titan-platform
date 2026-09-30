# @titan-design/factory

Code-driven software-factory workflows. Private; never published. Bin: `titan-factory`.

Code owns every workflow transition, retry and evidence record here; a model supplies judgment
only where a step is routed to one. The product composes `@titan-design/workflow`, `hitl`,
`store-sqlite`, `github`, `authority`, `registry`, `daemon`, `session-read` and
`agent-dispatch`. It starts one kind of agent: the Shepherd reviewer, through agent-chat, and
only when `shepherd.review` is configured (see [Shepherd reviewer config](#shepherd-reviewer-config)).
Relay and agent-chat keep every other dispatch.

Usage guides, with every command, where state lives and how each one fails:
[Running the factory](https://hjewkes.github.io/titan-platform/guides/factory) and [Shepherd](https://hjewkes.github.io/titan-platform/guides/shepherd). This README is the design
and file map.

**Run `pnpm build` before any test or live run.** Tests and the bin load sibling packages from
their `dist`, and a stale `dist` behaves like a different release (the `agent` build once
lacked the `claude-print` harness its source had).

Slice S0 (TP-410) added the host, the step router and the two seams. Slices S1 and S2 (TP-411)
added the GitHub port and the land core. Two workflows are registered in `src/workflows.ts`:
`land-pr` and `shepherd-pr`.

## Commands

```sh
titan-factory serve [--port <n>]                              # own the database; /health, /rpc and /mcp on loopback 7410
titan-factory land owner/repo#N [--task <t>]                  # start land-pr on serve, or drive it here when none answers
titan-factory resume                                          # drive every unfinished run, then list open gates
titan-factory gate resolve <runId> <stepId> --json '<payload>'  # answer a gate; its stored schema checks the payload
titan-factory service install [--port <n>] [--mcp]            # write the LaunchAgent plist, load it, wait for /health
titan-factory service status|restart|uninstall                # macOS only, like install
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

```sh
pnpm factory:install                  # pnpm install, build factory and its workspace deps, link the bin
titan-factory service install --mcp   # write the plist, load it, wait for /health, register the MCP endpoint
```

`pnpm factory:install` links `~/.local/bin/titan-factory` to `products/factory/dist/bin.js` in
this checkout (`scripts/factory-link-bin.mjs`). The link is a path, so a rebuild needs no
relink, and it needs neither sudo nor `pnpm setup`. A link that already points at another
checkout is left alone unless you pass `--force`; `--bin-dir <dir>` picks another directory. The
script says so when the directory is not on `PATH`.

`service install [--port <n>] [--node <path>] [--mcp]` does these in order:

1. Boots out `dev.hjewkes.titan-factory` when launchd already holds it, and waits until the
   label is gone.
2. Creates the log directory and writes `~/Library/LaunchAgents/dev.hjewkes.titan-factory.plist`,
   with the `PATH` described below.
3. Runs `launchctl bootstrap gui/<uid> <plist>`.
4. Polls `/health`. The answer must come from the pid launchd reports for the job, so
   a `titan-factory serve` left running in a shell fails the install instead of passing for it.
   On a timeout the verb prints the last 20 lines of `serve.err.log` and exits 1. The wait
   is 30 s and covers serve's first GitHub check: a `github` field other than `ok` exits 1
   with one line that carries the field.
5. With `--mcp`, runs `claude mcp add --transport http --scope user titan-factory http://127.0.0.1:<port>/mcp`.
   A server that is already registered counts as success. With no `claude` on `PATH`, or when
   the command fails, the verb prints the command to run by hand and still exits 0.

The plist points at the `dist/bin.js` of the checkout the verb ran from, so install from the
checkout that should serve, not from a worktree that will be removed.

| Verb | What it does | Exit 0 when |
| --- | --- | --- |
| `service status [--port <n>]` | Prints loaded or not, the pid, and a `/health` summary | `/health` answers and its `github` field is `ok` |
| `service restart [--port <n>]` | `launchctl kickstart -k`, then the same `/health` wait as install | the new process answers with `github` `ok` |
| `service uninstall` | Boots the job out when loaded, then removes the plist | the job is unloaded |
| `service plist [--port <n>] [--node <path>]` | Prints the plist and touches nothing | always |

Every verb except `plist` needs launchd and fails with one line on another platform. A server
installed with `--port` needs the same `--port` on `status` and `restart`.

The plist names `dev.hjewkes.titan-factory`: the absolute node path, the built `dist/bin.js`
and `serve`, `RunAtLoad` and `KeepAlive` true, and logs at
`$XDG_STATE_HOME/titan-factory/serve.{out,err}.log`. `ProcessType` is `Interactive`; a
`Background` job is throttled by macOS.

launchd starts a job with `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, and serve runs `gh`,
`agent-chat` and `claude` by bare name. So the plist sets `EnvironmentVariables` to one
variable, `PATH`: the directory each of those three is found in when the verb runs, then the
directory of the plist's node (`agent-chat` starts with `#!/usr/bin/env node`), then launchd's
four, each once. Nothing else is copied from the shell. A directory with a `:` in its name is
refused, `--node` included, because it would split into other entries. A binary that is not found is left out
and named in a `warning:` line on stderr; `service install` refuses to run without `gh`. After
moving one of these binaries, re-run `service install`.

The node path is the running node, except that a Homebrew Cellar path (`.../Cellar/node/22.1.0/bin/node`)
becomes the prefix symlink (`<prefix>/bin/node`, or `<prefix>/opt/node@20/bin/node` for a versioned
formula) when that symlink resolves to the same binary, so `brew upgrade` does not break the job.
Pass `--node <absolute path>` to choose another node. After changing node (an upgrade to a different
major, a version manager switch), re-run `service install`.

`/health` reports `github`: `ok` when `gh api rate_limit` succeeds under the job's
environment, else the redacted gh error (a LaunchAgent may not reach gh's keychain token).
`checking` shows until the first probe lands. The probe runs in the background, at most once
a minute, with a 10 s timeout, so a health request never waits on gh.

## Files

| File | Role |
| --- | --- |
| `src/host.ts` | Opens one SQLite file (gates plus runs, the codewatch triage migrations), builds the runtime, registers workflows, implements `resume` |
| `src/definition.ts` | `defineWorkflow`: a workflow declares each step id with one kind (`dispatch`, `seed`, `assisted`). Registration rejects an id with two kinds, and a guarded context fails a run whose code calls an undeclared id or kind. This is the guard for TP-255, where `seed(x)` and `assisted(x)` share a memo key |
| `src/evidence.ts` | **The F3 seam** (see below) |
| `src/gate-policy.ts` | **The F5 seam** (see below) |
| `src/service.ts`, `src/github-health.ts` | The LaunchAgent plist renderer, and the cached `gh api rate_limit` probe behind health's `github` field |
| `src/service-control.ts`, `src/service-ports.ts` | `service install`, `uninstall`, `status` and `restart` over a `ServicePorts` value, and the real ports (`launchctl`, `claude`, `/health`, the filesystem). Tests pass fake ports, so none reaches launchd |
| `src/config.ts` | zod-validated local config and database path resolution |
| `src/shepherd/seats.ts`, `src/shepherd/policy.ts` | Shepherd seat book (autonomy-seat/v1 files plus charter hard stops) and the per-PR effective policy (see below) |
| `src/cli.ts`, `src/bin.ts` | commander wiring for `resume`, `gate resolve`, `serve`, `land`, `shepherd` and `service` |
| `src/shepherd/commands.ts`, `src/shepherd/view.ts` | The `shepherd.*` registry commands, and the watch-row and timeline read model they return |
| `src/workflows/land.ts` | The land core (see below) |
| `src/test-support/crash.ts` | Crash harness: host A with a frozen clock hangs in a step and never releases its lease; host B, clocked past that lease, takes the run over |

## Shepherd reviewer config

Two keys under `shepherd` in the config file turn the review phase on. Both are optional.

```json
{
  "shepherd": {
    "seatsDir": "/srv/autonomy/seats",
    "agentChatBin": "/usr/local/bin/agent-chat",
    "review": { "profile": "rv-readonly", "configDir": "<agent-home>/.claude-profiles/rv", "verdictTimeoutMs": 1800000, "sessionStartTimeoutMs": 300000 }
  }
}
```

| Key | Meaning |
| --- | --- |
| `shepherd.agentChatBin` | Absolute path of the `agent-chat` executable. Required when `review` is set |
| `shepherd.review.profile` | The one agent-chat profile a reviewer is spawned with. The profile is the reviewer's tool grant |
| `shepherd.review.configDir` | Optional. The Claude config directory of the reviewer; absent means agent-chat's default. Must be an absolute path under the agent's home, which agent-chat refuses to spawn outside of |
| `shepherd.review.verdictTimeoutMs` | Optional, default 30 minutes. How long `sh-await-verdict` waits for the reviewer's verdict before it answers `none` |
| `shepherd.review.sessionStartTimeoutMs` | Optional, default 5 minutes. How long `sh-review` waits for the spawned reviewer's session to show on the roster before it answers `none` |

The load fails, with `invalid config <path>: <reason>`, on any of these:

- `agentChatBin` is not an absolute path, or `review` is set without `agentChatBin`.
- `configDir` is not an absolute path (`~` and relative paths are refused), or `profile` holds a
  slash or `..`.
- `profile` or `configDir` is empty, starts with a dash, or holds whitespace or a NUL byte.
  Each reaches the `agent-chat` argv as one literal argument, so a value that reads as a flag
  is refused.
- `review` holds an unknown key, or a timeout is not a positive integer.

With `review` set, `configuredRoutes` (`src/workflows.ts`) builds one
`agentChatReviewerDispatch` and hands its roster to `transcriptReviewerReader`, so the verdict
is read from the transcript of the agent that was started. The reviewer starts in the checkout
that the seat book binds to the PR's repo: `repos[].path` of the seat that lists the remote. When two
seat files bind the same repo, the later seat file's path wins. A repo with no such path, or
one on a deny list, gets no reviewer, and `sh-review` records
`none` with the reason.

With no `review` key nothing is built: no `agent-chat` process is started, `sh-review`
answers `none`, and the owner gate decides every merge.

The config file is read when the routes are first built, so restart `serve` after a change to
these keys. The seat book is read again on every spawn.

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

`GatePolicy.decide(action, target?)` returns `{ outcome, rule: { table, rowId, version }, reason }`.
`gateEverything` sends every action to a human, and `land-pr` uses it. `shepherdGatePolicy`
(`src/shepherd/policy.ts`) decides from the seat policy and, under `auto`, from authority's
MRG-AU-RV row on the merge facts collected at the exact head. `policyTraceGate(decision, ref)` renders a decision as a policy gate entry
with the F3 id `<spanId>#policy:<table>:<rowId>`.
