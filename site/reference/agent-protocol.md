# agent-protocol

**Tier 0 · contracts.** No dependencies.

Shared identity and usage types for agent execution and transcript readers. It does
not launch agents or parse logs.

## Identity

`ConversationIdentity` scopes a native ID by harness and corpus namespace.
`conversationRef()` escapes those components; `conversationItemRef()` additionally
scopes a turn, tool call, item or response ID. Identical native IDs in different
harnesses or corpora remain distinct.

`AgentIdentity`, `ExecutionIdentity` and `SurfaceIdentity` describe separate lifetimes.
An execution can exist before its conversation is known; surface ownership records
teardown authority independently of liveness.

## Usage

`UsageMeasurement` distinguishes per-response deltas from ordered snapshots within
a reset epoch. Unknown counts and costs are null. Input includes cache reads and
writes; output includes reasoning. These subsets must not be added to totals, and
snapshots must not be added to response deltas.

See the [multi-harness contract decision](/guides/multi-harness-contracts) for
execution and decoder integration, compatibility boundaries and implementation order.

## Execution lifecycle

`ExecutionRecord`, `ExecutionTransition`, and `reduceExecutionTransition` define
preparation, dispatch, observation, cancellation, recovery, terminal state, and
leased ownership. Revisions and captured owner generations fence every mutation;
terminal states are absorbing. Caller execution identity stays separate from the
adapter invocation and native conversation identities. Persistence and event replay
live in [`agent-lifecycle`](/reference/agent-lifecycle).

The terminal outcomes are `succeeded`, `failed`, `cancelled`, `cancellation_unknown` and
`ended`, exported as `TERMINAL_EXECUTION_PHASES`. `ended` records a process that exited
without a harness result, with nonempty `evidence` and an optional `exit` code and signal.
`observe_launched` records a launch's `runnerRef` and `surface` without changing the phase;
a later `observe_running` must match both.

`LifecycleExecutionTarget` has four kinds: `fresh` (optionally with `pinnedNativeId`, which
fixes the conversation at `prepare`), `resume`, `fork` (a new conversation that must differ
from `parent`) and `handoff` (a `HandoffIdentity` whose successor agent and conversation must
differ from the predecessor's, with a generation of at least 2 and the brief as a pointer and
SHA-256 digest).

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
