# factory

**Product.** Private, never published. Depends on [`workflow`](/reference/workflow),
[`hitl`](/reference/hitl) and [`store-sqlite`](/reference/store-sqlite).

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
agent-chat; the factory never dispatches one. For the durable-step engine alone, use
[`workflow`](/reference/workflow).

## Example

```sh
titan-factory resume
titan-factory gate resolve <runId> approve-publish --json '{"approve":true}'
```

`resume` drives every unfinished run until it ends or waits on a gate, prints each open gate
with its resolve command, and exits.

## What it deliberately does not do

It does not dispatch agents, spawn sessions or create relay items. It holds no allow rule:
until the authority table is approved, its one gate policy sends every action to a human.

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

New in TP-410, the first slice of the factory pilots. The step router is a product-side
adapter until `workflow` exports `routedRunner` (TP-416).
