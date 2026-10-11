# factory

**Product.** Private, never published. Depends on [`workflow`](/reference/workflow),
[`hitl`](/reference/hitl), [`store-sqlite`](/reference/store-sqlite),
[`github`](/reference/github), [`authority`](/reference/authority),
[`registry`](/reference/registry), [`daemon`](/reference/daemon),
[`session-read`](/reference/session-read), [`agent-dispatch`](/reference/agent-dispatch),
[`rpc-client`](/reference/rpc-client) and [`worktree`](/reference/worktree).

To run it, read [Running the factory](/guides/factory) and [Shepherd](/guides/shepherd).
This page covers what it is and why.

```sh
pnpm build
node products/factory/dist/bin.js --help
```

## The problem it solves

Routine workflow state lived in coordinating agent sessions: which step ran, whether a retry
is safe, who approved what. That state died with the session and cost a model turn each time
someone checked it. The factory moves it into code. A run is a durable `workflow` row, a human
decision is an `hitl` gate, and a crash resumes from the last completed step.

The primitive it adds is a **routed step runner**: one runtime, many step runners, and a
restart rule per route. A step routed `repeat` is dispatched again after a crash. A step
routed `park` leaves the run `recovery_required` for a human, because its effect may already
have happened.

## When to reach for it

A software workflow whose transitions, retries and approvals should be owned by code, such as
landing a pull request or a documentation change. For dispatching an agent, use relay or
agent-chat. The factory requests three kinds of dispatch itself, the Shepherd reviewer, the main-red
fixer and the successor implementer, through agent-chat via `@titan-design/agent-dispatch`.
It also starts one process that is not an agent, the detached deployer. For the durable-step engine alone, use
[`workflow`](/reference/workflow).

## Example

```sh
titan-factory resume
titan-factory gate resolve <runId> approve-merge --json '{"decision":"merge","headSha":"<40 hex>"}'
```

`resume` drives every unfinished run until it ends or waits on a gate, prints each open gate
with its resolve command, and exits.

`gate resolve` records who answered: the owner at a terminal (`owner-terminal`, your OS user, channel
`factory-cli`). A shell with `AGENT_CHAT_AGENT_ID` set resolves as `coordinator`, which hitl refuses,
so the command exits 1 and the gate stays pending. `CLAUDECODE` does not count, because the owner's
`!` commands in Claude Code set it too.

To keep runs alive across shells, `titan-factory serve` runs as a LaunchAgent. On macOS two
commands install it:

```sh
pnpm factory:install                  # install, build, link titan-factory into ~/.local/bin
titan-factory service install --mcp   # write the plist, load it, wait for /health, register the MCP endpoint
```

`service install` exits 1 when `/health` never answers or its `github` field is not `ok`.
`service status`, `restart` and `uninstall` manage the job, and `service plist` only prints
the plist (`ProcessType` Interactive, `KeepAlive` and `RunAtLoad` true, a `PATH` that reaches
`gh`). The [factory guide](/guides/factory#install-as-a-service) has the steps.

## Shepherd coverage

`shepherd coverage` measures how many of the seats' merges went through Shepherd. It counts the
PRs each seat's `dispatch.jsonl` records as `merged` in the window. A PR counts as Shepherd when
a registration for it has a `completed` run that merged it.

```sh
titan-factory shepherd coverage                  # the 24 h ending now, as text
titan-factory shepherd coverage --end 2026-10-09T06:00:00Z --json
titan-factory shepherd coverage --min 0.8        # exit 1 below 80%
```

```
window 2026-10-08T06:00:00.000Z to 2026-10-09T06:00:00.000Z
titan-coord  merged 10  excluded 0  shepherd 8  share 80%
...
total  merged 40  excluded 2  shepherd 33  share 83%

misses:
  titan-coord  acme/widgets#57  merged  hold: run-failed: land rules; TP-123
```

- **Seats.** By default the four that charter 8 sends through Shepherd: `titan-coord`,
  `design-coord`, `voltras-coord` and `platform-coord`. Pass `--seat <name>` once per seat to
  count others. A seat's remotes come from the seat book serve loads (`shepherd.seatsDir`). A
  bare PR number resolves only when exactly one of the seat's remotes has a registration for
  it. Any other PR is listed as `(unresolved)` and counts as a miss.
- **Logs.** `--logs <dir>` holds `<seat>/dispatch.jsonl`. It defaults to `digest.logsDir`,
  else the `logs` directory beside `shepherd.seatsDir`. A seat with no log reads as no merges.
- **Window.** `--hours` (default 24) ending at `--end` (default now). Rows with no zone are
  read as UTC.
- **Exclusions.** Rows with `gate` `visual` or `bench` and owner-gated `visual-gate2` holds
  are left out of the share, as charter 8 excludes them.
- **Output.** Text prints one line per seat, then the total, the misses, and the untyped
  holds. An untyped hold is a held run, active in the window, whose reason fails the
  [hold-reason check](/guides/shepherd#hold-and-release). Each is flagged `serve-path` or
  `seat-path` when its text names one. `--json` prints the whole report, with
  the window in epoch milliseconds.
- **`--min <share>`** exits 1 when the total share is below it, a fraction from 0 to 1. A
  window with no counted merge also exits 1, because it cannot show the bar is met.

The ledger is opened read-only, so a running serve is never disturbed. A store that cannot
be read exits 2 and names its path. A bad flag, config or seat book also exits 2. When
charter 8 adds a hold class, add it to `HOLD_CLASSES` in `shepherd/hold-reason.ts` too, or
holds of that class are listed as untyped.

## What it deliberately does not do

It does not create relay items, and it requests no agent except the Shepherd reviewer,
the main-red fixer and the successor implementer, and starts no process except the detached
deployer. The agents are requested through agent-chat; the reviewer only when `shepherd.review`
is configured and the fixer only when `shepherd.fixer` is. `land-pr`
holds no allow rule: its gate policy sends every merge to a human. `shepherd-pr` can allow a
merge under authority's MRG-AU-RV row when the reviewer's verdict supports it. With no
`shepherd.review` key, or no checkout for the repo, the review phase answers `none` and the
owner decides every merge. See
[what is not built yet](/guides/shepherd#what-is-not-built-yet).

## Gotchas

- Run `pnpm build` first. Tests and the bin load sibling packages from their `dist`.
- A killed run keeps its lease for 30 s. `resume` inside that window reports it as held.
- Shepherd seat paths must be `~/`, `$HOME/`, `${HOME}/` or `/` then plain segments; anything
  else throws. Symlinks are not resolved (no `realpath`), so spell a deny and its repo path the
  same way.
- Declare every step id with one kind. `seed(x)` and `assisted(x)` share a memo key, so the
  host rejects a workflow that reuses an id across kinds.
- Pass `factoryRoutes` (or `factoryRoutesFor`) to the host as the same array. Its `database`
  tenant carries the shepherd migration and store binding; a copied array drops it, and every
  merge then fails closed because the hold cannot read the store.

## Where it came from

New in TP-410, the first slice of the factory pilots. The factory re-exports `routedRunner`
from `workflow` (TP-416).
