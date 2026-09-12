# @titan-design/agent-protocol

Dependency-free identity and usage contracts shared by agent execution and session
readers (TP-44). This package neither launches a harness nor reads its logs.

`ConversationIdentity` names a native thread by harness, corpus namespace and native
ID. `conversationRef()` escapes each component into a `conversation:` reference;
`conversationItemRef()` additionally scopes a turn, call, item or response ID. Existing
`session:<id>` references are not rewritten: their compatibility mapping belongs to
session-graph's later migration.

Agent, execution, conversation and surface identities are separate. An agent may have
several conversations; an execution can begin before its conversation is known. A
surface's ownership indicates teardown authority, not liveness.

`UsageMeasurement` distinguishes idempotent per-response deltas from ordered snapshots
within a reset epoch. Null token fields and null cost mean unreported, never zero.
Input includes cache reads/writes, and output includes reasoning. Those counters are subsets. A reader must never add snapshots
to response deltas or add subset counters to input/output totals.

The lifecycle protocol records one invocation from durable preparation through terminal
evidence. Every transition carries an event ID and expected revision, while owner
generations and leases fence stale supervisors. `cancel_requested` records intent;
`cancelled` requires observed terminal evidence, and `cancellation_unknown` remains an
absorbing honest outcome. `recovery_required` blocks automatic resubmission until a
reconciler supplies positive running, terminal, or retry-safe absence evidence.
The record keeps the caller's durable execution identity separate from an adapter's
own invocation identity, even when a failure occurs before a conversation is known.

`reduceExecutionTransition()` is the dependency-free state machine used by durable
ledgers. Persistence, wall-clock enforcement, process supervision, and transcript
indexing remain outside this package.
