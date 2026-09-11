# @titan-design/agent-lifecycle

Durable execution snapshots, event receipts and fenced ownership. This tier-1
package depends only on agent-protocol and store-sqlite. It does not launch agents,
manage terminals or derive lifecycle from transcript data.

Apply `executionLedgerMigration(version)` to the product's authoritative database,
then construct `new SqliteExecutionLedger(db)`. A custom table name can be supplied
to both the migration and constructor. This database must remain outside disposable
session-index reset paths.

`apply(transition)` atomically reduces a lifecycle transition and stores its snapshot
and event receipt. Every new event supplies an expected revision. Exact event replay
returns `applied: false` with the original receipt even after later transitions;
reusing that event ID with different data returns an explicit conflict. Request keys
are unique across executions. JSON serialization rejects native Error/process/SDK
objects; wrappers must turn them into durable result values or artifact references.

Owner generation and lease checks protect every mutation. In addition to event-time
validation, the ledger checks leases against its own clock, so a stale callback
cannot backdate an event to revive an expired lease. Terminal snapshots have no
owner, are immutable, and are omitted by `listRecoverable`. `findByRequestKey`, `get`
and ordered `events` support reconciliation without a graph database.

A lease alone does not authorize killing a process or attaching a harness. Callers
must reconcile with the actual execution transport. Missing or uncertain native
work remains `recovery_required`; this package has no operator override or automatic
resubmission operation. Surface ownership, agent retirement and mailboxes remain
separate modules.
