# hitl

**Tier 1 · engines.** Depends on [`store-sqlite`](/reference/store-sqlite). `zod` v4 is a
peer.

```sh
npm install @titan-design/hitl @titan-design/store-sqlite zod
```

## The problem it solves

Automated work needs to stop and ask a human, and the process that asked usually cannot be
the process that hears the answer. It may be a CLI run that exits, a daemon that redeploys,
a worker that crashes. A promise in memory does not survive any of that.

The primitive here is **"the same work, paused"**. `openGate()` from inside a task hands back
something to await; `resolveGate()` from anywhere else lets it continue.

## When to reach for it

Approval gates, review checkpoints, any "ask a human, then carry on" step that must survive
a restart. [`workflow`](/reference/workflow) builds its `assisted()` step on this.

## Example

Verified against 0.1.0.

```ts
import { z } from "zod";
import { SqliteGateStore, openGate, resolveGate } from "@titan-design/hitl";
import { openDatabase } from "@titan-design/store-sqlite";

const store = new SqliteGateStore(openDatabase("~/.local/state/thing/gates.sqlite3"));

const gate = openGate(store, {
  id: "deploy-approval",
  prompt: "Ship 1.4.0 to production?",
  schema: z.object({ approved: z.boolean(), note: z.string().optional() }),
  expiresAt: new Date(Date.now() + 3_600_000),
});

const answer = await gate.wait();   // { approved: true, note: 'green CI' }
```

Somewhere else entirely — a CLI, an MCP tool, a dashboard route, another process:

```ts
import { resolveGate } from "@titan-design/hitl";

resolveGate(store, "deploy-approval", { approved: true, note: "green CI" });
```

After a restart, re-attach by id instead of re-opening:

```ts
import { waitForGate } from "@titan-design/hitl";

for (const pending of store.listPending()) {
  void waitForGate(store, pending.id, { schema: approvalSchema });
}
```

## A gate is a row, not a promise

The promise `wait()` returns is a local convenience. The gate itself is a database row, and
that is what makes the primitive worth having: the process that opened the gate can crash,
redeploy, or exit, and the pending gate is still there to be answered. The waiter polls,
because the resolver may be a different process writing the same SQLite file.

## Two schema checks, on purpose

The resolving process does not have your zod schema — by definition it is somewhere else. So
`openGate` stores the schema as JSON Schema (`z.toJSONSchema`) on the row, and `resolveGate`
runs `checkAgainstJsonSchema` against it. That is the boundary check: a bad payload is
rejected where it is submitted, with a `GatePayloadInvalid` naming the offending paths.

The waiter then re-validates with the real zod schema before `wait()` resolves. That is the
type guarantee.

The checker covers only the subset zod emits — `type`, `required`, `properties`, `items`,
`enum`, `const`, `anyOf`, `additionalProperties: false` — and is not a general JSON Schema
validator.

## Stores

Both extend `BaseGateStore`, which owns every settle rule, and both pass the same behaviour
suite.

| Store | Use when |
| --- | --- |
| `MemoryGateStore` | tests, and single-process work that needs the pause but not the durability |
| `SqliteGateStore` | anything that must survive a restart or be answered by another process |

`SqliteGateStore` installs a `hitl_gate` table through `runMigrations` on construction. Pass
`migrate: false` and put `gateMigration(n)` in your own migration list when hitl shares a
database with domain tables — which is what [`workflow`](/reference/workflow) does. `table`
renames the table so one database can host several gate spaces.

## Gotchas

**`pollMs` is a `wait()` option, not an `openGate()` one.** `openGate(store, { id, prompt,
schema, expiresAt })` takes no polling knob; pass it where you wait:
`gate.wait({ pollMs: 250 })`. Passing it to `openGate` is silently ignored.

**Exactly one settle.** A gate is `pending`, then exactly one of `resolved`, `cancelled`, or
`expired`. A second `resolve` or `cancel` throws `GateAlreadySettled` and leaves the first
answer intact.

**Expiry is lazy.** Nothing sweeps the table; a *read* is what notices the deadline passed
and flips the row to `expired`. The instant named by `expiresAt` counts as expired. Both
stores take an injectable `now`, so expiry is testable without waiting.

**Aborting a wait does not touch the gate.** `wait` rejects with `GateAborted` and the row
stays pending for whoever picks it up next. Every error — `GateCancelled`, `GateExpired`,
`GateNotFound`, `GatePayloadInvalid`, `GateAborted` — extends `GateError` and carries
`gateId`.

## Where it came from

New. Human-in-the-loop was a gap in the original tier model; the brain workflow spike
identified it as a first-class primitive and this is the implementation.
