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
