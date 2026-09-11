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
