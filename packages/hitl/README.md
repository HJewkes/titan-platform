# @titan-design/hitl

Pause work on a human, and let a different process resume it. The primitive is
"the same work, paused": `openGate()` from inside a task hands back something to
await, and `resolveGate()` from anywhere else lets it continue.

Tier 1 of the titan-platform DAG (TP-11). `zod` is a peer (v4).

## Two entries

The root entry (`@titan-design/hitl`) is runtime-neutral: the gate state machine,
`GateStore`, and `MemoryGateStore`, with no `node:*` import and no native addon, so it
loads in a Cloudflare Workers isolate. `SqliteGateStore` and its migration helpers moved to
a subpath, `@titan-design/hitl/sqlite`, which is the only part of the package that pulls in
`better-sqlite3` (via `@titan-design/store-sqlite`).

**Migrating from before 0.2.0:** change `import { SqliteGateStore, gateMigration } from
"@titan-design/hitl"` to `import { SqliteGateStore, gateMigration } from
"@titan-design/hitl/sqlite"`. Everything else (`openGate`, `resolveGate`, `GateStore`,
`MemoryGateStore`, the error classes) still comes from the root.

## A gate is a row, not a promise

The promise `wait()` returns is a local convenience. The gate itself is a
database row, and that is what makes the primitive worth having: the process that
opened the gate can crash, redeploy, or exit, and the pending gate is still there
to be answered. A gate is addressable by id from any process, which is the whole
point. The waiter polls, because the resolver may be a different process writing
the same SQLite file.

```ts
import { openDatabase } from "@titan-design/store-sqlite";
import { SqliteGateStore } from "@titan-design/hitl/sqlite";
import { openGate } from "@titan-design/hitl";
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

resolveGate(store, "deploy-approval", { approved: true }, {
  class: "owner-terminal",
  id: "owner",
  channel: "cli",
});
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
and `gateResolverMigration(m)` in the product's own migration list when hitl shares a database with domain
tables. `table` renames the table so one database can host several gate spaces.
Timestamps are ISO-8601 strings, the shape store-sqlite writes and any surface
can send on as-is.

The row carries a `reason` column beyond the minimum, so a cancelled gate can
tell its waiter why.

## Who resolved it

`resolve` and `resolveGate` require a third argument, a `GateResolver`:
`{ class, id, channel, confirmEvent? }`. `class` is an actor class from
`@titan-design/authority`. The store records it as `resolvedBy`.

```ts
resolveGate(store, "deploy-approval", { approved: true }, {
  class: "owner-terminal",
  id: "owner",
  channel: "cli",
});
```

Every store refuses a resolver whose class is not in authority's `RESOLVER_CLASSES`, so an
agent or automation never answers a gate. It throws `GateResolverRefused` and the gate stays
pending. The store reads each declared resolver field once into a frozen copy, and checks and stores
only that copy. A store's `authorize` option runs after the class check and can refuse more,
never fewer. It must return `{ allowed }` synchronously, or the store throws
`GateAuthorizeInvalid`.
Refusals name the gate id and the actor class, never the resolver's other fields.

hitl records a claim about the resolver; it cannot prove one. Any process that can write
the database can claim any class.

On SQLite the resolver lives in a `resolved_by` column that `gateResolverMigration(n)` adds,
along with a trigger that refuses any resolve naming no resolver. `migrate: true` runs it as
version 2; with `migrate: false`, add it to your own migration list after `gateMigration`. It
is idempotent and does not backfill: gates resolved before it read back with `resolvedBy`
undefined. `SqliteGateStore` checks for the column when it is constructed and throws
`GateStoreSchemaOutdated` naming `gateResolverMigration` when it is missing, or naming
`gateMigration` when the table does not exist. That error carries an empty `gateId`,
because no gate is involved yet.

After the migration, a writer built on hitl 0.2.x fails when it resolves: SQLite aborts the
statement with a raw error whose message is `hitl: resolvedBy required`. The same trigger
refuses a direct insert of a resolved row with no resolver. Cancels from an old writer still
work. The fix is to upgrade that writer so it passes a resolver. A caller on this release
never reaches the trigger: every store refuses a resolve with no resolver first.

## Upgrading to 0.4

0.4 makes the resolver required. It is a breaking release; a `^0.3` range does not pick it up.

1. Pass a `GateResolver` to every `store.resolve`, `resolveGate` and workflow
   `runtime.signal` call. The compiler finds each one. Name the class honestly: a human at
   a terminal is `owner-terminal`, a human on a phone is `owner-remote`. An agent or an
   automation cannot resolve a gate, by design.
2. Add `gateResolverMigration(n)` to your migration list, after `gateMigration`, with the
   next free version in your own list. `migrate: true` stores run it for you as version 2.
3. Expect `GateStoreSchemaOutdated` naming `gateResolverMigration` from the
   `SqliteGateStore` constructor if step 2 is missing. The store no longer opens over such a
   table.
4. Upgrade every process that writes the gate table at once. A writer still on 0.2 fails
   each resolve with SQLite's `hitl: resolvedBy required` once the migration has run.

A caller that bypasses the type and resolves with no resolver gets `GateResolverRefused`
with the reason `a resolver is required` from every store, memory or SQLite, and the gate
stays pending.

## Rule-bound gates

A gate can carry the authority rule that opened it. Pass `rule` to `create`:
`{ table, version, ruleId, resolvers }`, where `resolvers` lists the resolver classes the
rule admits, as `evaluate` from `@titan-design/authority` returns them.

```ts
store.create({
  id: "release-approval",
  prompt: "Publish the release?",
  rule: { table: "F5", version: "1.0.0", ruleId: "REL-CO", resolvers: ["owner-terminal"] },
});
```

The store reads the rule once into a frozen copy, so the caller cannot widen it after
`create`. A rule that is not a non-empty list of resolver classes throws `GateRuleInvalid`
and creates nothing. A rule-bound gate refuses a resolver whose class the rule does not
name, and refuses a resolve that names no resolver. Both throw `GateResolverRefused` and
leave the gate pending. The check runs after the default class check and before
`authorize`, so it only narrows. A gate without a rule behaves as before.

On SQLite the rule lives in a `rule` column that `gateRuleMigration(n)` adds, along with a
trigger that aborts any update resolving a rule-bound row by a class outside its rule, or
changing the rule, with `hitl: resolver outside the gate rule`. That stops a writer built on
hitl 0.3.x, which knows nothing of rules, from widening who may answer. The migration is
idempotent and does not backfill. `migrate: true` runs it as version 3. A store whose table
lacks the column throws `GateStoreSchemaOutdated` naming `gateRuleMigration` when handed a
rule, rather than dropping it.

The trigger needs `resolved_by` to know who answered. On a table that has run
`gateRuleMigration` but not `gateResolverMigration`, the trigger aborts every raw resolve of
a rule-bound row, and no store opens over the table. Run both migrations in either order;
the second one installs the class-aware trigger.

The insert guard fires before SQLite's conflict handling. A raw insert with no rule onto a
pending rule-bound id therefore aborts with `hitl: a pending rule-bound gate cannot be
replaced`, whether it is a plain duplicate, `ON CONFLICT DO UPDATE`, `ON CONFLICT DO NOTHING`
or `INSERT OR IGNORE`; a duplicate plain insert reports that message, not `UNIQUE`. The guard
covers only pending rows. A raw `REPLACE` of a cancelled or resolved rule-bound row succeeds
and can leave a pending rule-less row. That is outside the store API: `create` is a plain
insert and throws on an existing id, and no store method replaces a row.

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
