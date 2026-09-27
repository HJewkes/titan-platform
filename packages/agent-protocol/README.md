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

`ended` is the terminal outcome for a process a supervisor saw exit without a harness
result. It carries nonempty `evidence` and an optional `exit` (`code` and `signal`, each
nullable). It never implies success. `TERMINAL_EXECUTION_PHASES` is the single list of
terminal phases; consumers derive from it rather than copying it.
`observe_launched` records the `runnerRef` and `surface` of a launch before the harness
confirms it is running. It is allowed only from `dispatching`, and it leaves the phase
unchanged. A later `observe_running` must agree with both values.

A target is one of four kinds. `fresh` may carry `pinnedNativeId`, in which case `prepare`
records the conversation up front and any other observed ID is refused. `resume` continues
a known conversation. `fork` names a `parent`; the new conversation must fall in the fork's
`namespace` and differ from the parent. `handoff` carries a `HandoffIdentity` (`handoffId`,
`lineageId`, a `generation` of at least 2, the `predecessor`, and the brief as a `ref`,
lowercase `sha256` and `bytes`, never the text). The successor's agent must differ from the
predecessor's, and its conversation from the predecessor's. The predecessor conversation is
checked for shape only, so a handoff may cross harnesses.

`prepare` may carry `correlations`, a map of namespaced keys to strings that no later
transition can change. The record stores a frozen copy.

| Aspect | Rule |
|---|---|
| Key form | `<prefix>.<name>` matching `CORRELATION_KEY_PATTERN`; an unprefixed key is invalid |
| Limits | at most 32 keys; each value a nonempty string of at most 512 characters |
| `broker.*` | reserved for broker facts (requester, callerClass, depth, config_dir, backfilled) |
| `agent-thread.*` | reserved; `agent-thread.thread` holds the thread ID |
| Caller data | any other prefix names its system, for example `relay.run`, `relay.item`, `health.item` |
| Lookup | exact `(key, value)` match, done by the ledger |

`RESERVED_CORRELATION_PREFIXES` lists the reserved prefixes. The reducer cannot know who
wrote a key, so each reserved prefix's producer enforces that only it writes there.
`correlationKey(prefix, name)` builds and checks a key.

`reduceExecutionTransition(current, transition, options)` takes an optional
`fencing` mode. The default, `{ kind: "execution" }`, fences each row by its own owner
lease. `{ kind: "supervisor", lease }` fences by one supervisor-wide lease that the ledger
reads inside its atomic operation. A fenced transition then needs its fence to equal the
lease, the lease to outlive `occurredAt`, the row to belong to the same supervisor, and the
row's generation to be no newer than the lease's. Each accepted write stamps the lease onto
the row, so a restarted supervisor adopts its rows without per-row events. `prepare` must
name the lease as owner, and `claim_owner`, `renew_owner` and `release_owner` are refused.

`reduceExecutionTransition()` is the dependency-free state machine used by durable
ledgers. Persistence, wall-clock enforcement, process supervision, and transcript
indexing remain outside this package.
