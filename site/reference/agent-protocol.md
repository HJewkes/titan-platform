# agent-protocol

**Tier 0 · contracts.** No runtime dependencies. The `./trace` subpath needs `zod` as an optional peer.

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

`foldUsage(measurements)` picks the measurements that describe distinct spend and
returns them with their `basis`. Deltas count once per `responseId`, the last report
winning. Any delta supersedes every snapshot. Without deltas it keeps the
highest-sequence snapshot per scope, scope ID and epoch (a tie goes to the later one),
and a conversation snapshot supersedes the other scopes in its epoch. It returns the
measurements unchanged; summing them, and what a null count means in a sum, stays
with the caller. An empty list folds to no measurements on a `snapshot` basis.

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

## Trace schemas

The `@titan-design/agent-protocol/trace` subpath (TP-390) defines `titan.trace/v1`, one
record set for a factory run. It needs `zod` 4 as a peer, which is optional for root-entry
consumers. The root entry never imports it, and it has no `node:` import, so it runs in
Workers.

A trace is a projection of state that is already durable (workflow runs, hitl gates, the
execution ledger, transcripts), not a new store. Every id is a pure function of source ids,
so re-projecting a run yields the same records and a consumer can upsert by `id`.

| Kind | One record per | Id |
|---|---|---|
| `run` | workflow run | `WorkflowRun.id` |
| `attempt` | step, iteration and attempt | `workflowStepRequestKey`, matched by `ATTEMPT_ID_PATTERN` |
| `call` | model response or tool call in a transcript | `conversationItemRef` of the call or response |
| `gate` | human gate (`gateKind: "human"`) or policy decision (`"policy"`) | `gateIdFor` / `assistedKey`, or `policyGateId(attemptId, table, rowId)` |
| `artifact` | commit, pull request or file version (`artifactKind`) | `commitRef(repo, sha)`, `pr:<repo>#<n>`, `file:<repo>/<path>@<sha>` |
| `cost` | usage measurement | `costId(conversation, measurement)` |

Every record carries `schema`, `kind`, `id`, `runId` and `at`; the four step-level kinds add
an optional `attemptId`. Enums derive from the existing tuples (`phase` is
`EXECUTION_PHASES`), `cost.measurement` is a `UsageMeasurement` unchanged, and
`TranscriptSpan` (`sourceId`, `byteOffset`, `byteLength`, `contentHash`) accepts
session-read's `SourceLineEvidence` as is. Prompts, outputs and payloads appear only as
SHA-256 digests.

`parseTraceRecord` is the producer parse and rejects unknown keys. `parseTraceRecordLoose`
is the consumer parse: it keeps unknown keys and returns an unknown `kind` or
`artifactKind` as `{ kind: "unknown", value }`. A known kind must still be valid in both.

`TRACE_FIELD_PRIVACY` classifies every leaf field of every kind as `export`, `digest`,
`public` (kept only for repos listed as public), `local` (dropped), `mcp-local` (tool names
of MCP servers) or `actor` (`agent:` actors digested). `redactTraceRecord(record, {
publicRepos, key })` applies it and resolves to a plain object. Digests are
`hmac-sha256:<hex>`, an HMAC-SHA-256 via Web Crypto keyed by the required per-export `key`:
equal values join within an export, and without the key a low-entropy value such as a line
number or PR number can't be recovered by hashing guesses. Keep the key out of the export;
reuse it only for exports meant to join. An empty key is an error. Correlation keys survive
redaction and their values do not.

Fixtures for a synthetic documentation run ship in the package under
`fixtures/trace/v1/`: `doc-run.jsonl` holds all 17 records in order, and one JSON file per
kind holds the same records split by kind.
