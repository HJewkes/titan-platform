# @titan-design/hitl

Pause work on a human, and let a different process resume it. The primitive is
"the same work, paused": `openGate()` from inside a task hands back something to
await, and `resolveGate()` from anywhere else lets it continue.

Tier 1 of the titan-platform DAG (TP-11). Depends on
`@titan-design/store-sqlite`; `zod` is a peer (v4).

## A gate is a row, not a promise

The promise `wait()` returns is a local convenience. The gate itself is a
database row, and that is what makes the primitive worth having: the process that
opened the gate can crash, redeploy, or exit, and the pending gate is still there
to be answered. A gate is addressable by id from any process, which is the whole
point. The waiter polls, because the resolver may be a different process writing
the same SQLite file.

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { SqliteGateStore, openGate } from "@titan-design/hitl";
import { z } from "zod";

const store = new SqliteGateStore(openDatabase("~/.local/state/thing/gates.sqlite3"));

const gate = openGate(store, {
  id: "deploy-approval",
  prompt: "Ship 1.4.0 to production?",
  schema: z.object({ approved: z.boolean(), note: z.string().optional() }),
  expiresAt: new Date(Date.now() + 3_600_000),
});

const answer = await gate.wait(); // { approved: true }
```

Somewhere else entirely, in a CLI, an MCP tool, or a dashboard route:

```ts
import { resolveGate, cancelGate } from "@titan-design/hitl";

resolveGate(store, "deploy-approval", { approved: true });
```

After a restart, re-attach by id instead of re-opening:

```ts
import { waitForGate } from "@titan-design/hitl";

for (const pending of store.listPending()) {
  void waitForGate(store, pending.id, { schema: approvalSchema });
}
```

## Two schema checks, on purpose

The resolving process does not have your zod schema; by definition it is
somewhere else. So `openGate` stores the schema as JSON Schema
(`z.toJSONSchema`) on the row, and `resolveGate` runs `checkAgainstJsonSchema`
against it. That is the boundary check: a bad payload is rejected where it is
submitted, with a `GatePayloadInvalid` listing the offending paths.

The waiter then re-validates with the real zod schema before `wait()` resolves.
That is the type guarantee. The checker covers only the subset zod emits
(`type`, `required`, `properties`, `items`, `enum`, `const`, `anyOf`,
`additionalProperties: false`) and is not a general JSON Schema validator.

## Stores

Both implementations extend `BaseGateStore`, which owns every settle rule, and
both pass the same behaviour suite.

| Store | Use when |
|---|---|
| `MemoryGateStore` | tests, and single-process work that needs the pause but not the durability |
| `SqliteGateStore` | anything that must survive a restart or be answered by another process |

`SqliteGateStore` installs a `hitl_gate` table through store-sqlite's
`runMigrations` on construction. Pass `migrate: false` and put `gateMigration(n)`
in the product's own migration list when hitl shares a database with domain
tables. `table` renames the table so one database can host several gate spaces.
Timestamps are ISO-8601 strings, the shape store-sqlite writes and any surface
can send on as-is.

The row carries a `reason` column beyond the minimum, so a cancelled gate can
tell its waiter why.

## Settling

A gate is `pending`, then exactly one of `resolved`, `cancelled`, or `expired`.
A second `resolve` or `cancel` throws `GateAlreadySettled` and leaves the first
answer intact.

Expiry is **lazy**: nothing sweeps the table, so a read is what notices the
deadline passed and flips the row to `expired`. The instant named by `expiresAt`
counts as expired. Both stores take an injectable `now` so expiry is testable
without waiting.

`wait` rejects with `GateCancelled`, `GateExpired`, `GateNotFound`,
`GatePayloadInvalid`, or `GateAborted` (when the caller's `AbortSignal` fires).
Every one of them extends `GateError` and carries `gateId`. Aborting a wait does
not touch the gate; the row stays pending for whoever picks it up next.
