# agent-lifecycle

**Tier 1 · infrastructure.** Depends on [`agent-protocol`](/reference/agent-protocol)
and [`store-sqlite`](/reference/store-sqlite).

Authoritative execution state for agent supervisors. The ledger stores lifecycle
snapshots and event receipts in one SQLite transaction, independently of transcript
indexing and search. It does not launch processes or attach to native conversations.

## Create a ledger

```ts
import { SqliteExecutionLedger, executionLedgerMigration } from "@titan-design/agent-lifecycle";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";

const db = openDatabase("supervisor.sqlite3");
runMigrations(db, [executionLedgerMigration(1)]);
const ledger = new SqliteExecutionLedger(db);
```

Choose a migration version from the product's shared migration sequence. For a
custom table name, pass it to both the migration and constructor. Keep this database
outside any disposable session-index reset path.

## Transitions and ownership

`apply(transition)` checks the expected revision and captured owner generation,
reduces the transition, and commits the snapshot and event receipt atomically.
Request keys are unique across executions. Replaying an identical event ID returns
its original receipt with `applied: false`, even after the execution has advanced.
Reusing the event ID with different data returns a conflict.

Leases are checked against the ledger's own clock as well as the event timestamp.
A stale callback cannot revive an expired lease by backdating its event or borrowing
a newer supervisor's generation. Terminal snapshots are immutable and release their
owner. Values must be JSON-safe; native SDK objects, errors, and process handles
belong in a normalized result or an external evidence artifact.

`get`, `findByRequestKey`, `events`, and `listRecoverable` support recovery without
consulting a graph. A ledger record does not prove a process is alive or authorize
reattachment by PID.

## Connect a harness

[`createDurableHarnessDispatcher`](/reference/agent#durable-dispatch) commits
preparation before invoking the adapter and persists terminal outcomes before its
completion resolves. [`durableHarnessRunner`](/reference/workflow#execution-recovery)
connects that dispatcher to workflow intent, acknowledgment, and memoization.

Unknown native state blocks automatic resubmission. A prepared record can justify a
safe retry only after the supervisor claims it and durably closes the prior attempt,
because every native launch must follow `begin_dispatch`. Cancellation intent and
unconfirmed cancellation remain distinct from observed terminal cancellation.
