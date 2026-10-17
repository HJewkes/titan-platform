# @titan-design/agent-protocol

Dependency-free identity and usage contracts shared by agent execution and session
readers (TP-44). The `./trace` and `./worker-facts` subpaths add zod schemas and need `zod` as an optional peer. This package neither launches a harness nor reads its logs.

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

`foldUsage(measurements)` picks the measurements that describe distinct spend and
returns them with their `basis`. Deltas count once per `responseId`, the last report
winning. Any delta supersedes every snapshot. Without deltas it keeps the
highest-sequence snapshot per scope, scope ID and epoch (a tie goes to the later one),
and a conversation snapshot supersedes the other scopes in its epoch. It returns the
measurements unchanged; summing them, and what a null count means in a sum, stays
with the caller. An empty list folds to no measurements on a `snapshot` basis.

The lifecycle protocol records one invocation from durable preparation through terminal
evidence. Every transition carries an event ID and expected revision, while owner
generations and leases fence stale supervisors. `cancel_requested` records intent,
and a recovery keeps a requested cancellation, so an observed run after it stays
`cancel_requested`; `cancelled` requires observed terminal evidence, and `cancellation_unknown` remains an
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
reuse it only for exports meant to join. An empty key is an error. Exports made with the
old unkeyed `sha256:` digests do not join new keyed `hmac-sha256:` ones. Correlation keys
survive redaction and their values do not.

Fixtures for a synthetic documentation run ship in the package under
`fixtures/trace/v1/`: `doc-run.jsonl` holds all 17 records in order, and one JSON file per
kind holds the same records split by kind.

## Worker facts

The `@titan-design/agent-protocol/worker-facts` subpath (TP-1712) exports `WorkerFactsSchema` and
the `WorkerFacts` type: what a spawned worker's completion carries. It holds the agent name,
profile, spawner and exit facts (`code`, `signal`, `inferred`), plus, when known, the task id,
the last Status or Verdict (`report`: message id, kind, text of at most 2,000 characters), the
PR (`{ repo: "owner/name", number }`), `tokens` and `costUsd`. A no-report exit is valid and
carries the exit facts only. The producer truncates the report; the schema rejects one over the
cap. It is a subpath, like `./trace`, so the root entry stays free of zod.

## Harness execution contracts

Import @titan-design/agent-protocol/harness for SDK-free execution targets,
capability and limit assessments, bounded-run progress, results and failures.
Harness IDs are open strings; BoundedRunBase<H> carries the same harness type
through its progress callback. Conversation identity retains its harness,
namespace and native ID. Unsupported and unverified assessments remain explicit.

Native request options and execution stay in agent. Its existing exports keep
the legacy Claude/Codex defaults through compatibility aliases. This is the
execution-contract checkpoint of TP-3426 (TP-3372 S01); account, transcript,
pricing, policy and bus ports remain unfinished. TP-643 wire schemas are separate.

The same subpath now exports the existing transcript source, semantic observation,
locator, decoder and continuation DTOs. These declarations moved from session-read;
its old import paths remain compatible. Parsing, discovery, text reads and identity
helpers still run in session-read. Shared source DTOs do not register a new decoder
or imply that a native format is supported.

### Source port contracts

The harness subpath also exports HarnessSourcePort, HarnessSourceCapabilities,
HarnessSourceQuery and HarnessSourceLookup. Roots and account selection belong
to the injected adapter; callers supply scoped conversation identity and an
optional cwd hint. Found lookups contain one or more physical sources.
Not-written lookups retain one or more expected paths; unavailable lookups carry
a reason. An empty discovery result does not establish not-written evidence.

Read operations keep the existing observation continuation callback and semantic
text locator signatures. Null text stays unavailable, and unknown observations
remain unknown. Required unsupported/unverified operations must refuse before
invocation. Semantic finality remains unverified until decoder semantics are
qualified: this port adds no classifier, adapter or claim that EOF, a native turn
completion or the last assistant message proves session completion.

This is another partial TP-3426 S01 checkpoint. It changes no existing source
discovery, default account, billing, native execution, policy or bus behavior.

### Execution service port

`HarnessExecutionPort<H>` accepts a bounded `HarnessExecutionRequest<H, T>` and
returns the existing run result. Its harness parameter is open: a third adapter
can implement the port without extending a core vendor union. `HARNESS_CONTRACT_VERSION`
is the interface version, independent of any native executable version.

`HarnessExecutionBinding` carries the selected profile, host/account/billing-pool
references, model intent and policy revision. Producers persist that binding for
resume; fallback selects a new execution. These are structural TypeScript metadata
and intent, without runtime validation, authenticated identity or permission grants.
Keep native homes, credentials and SDK options inside the adapter. For structured
output, the adapter validates the returned unknown value with the supplied parser;
its JSON schema is an optional native constraint, not proof of valid output.

`HarnessDispatchReceipt` distinguishes accepted, running and refused dispatches.
Accepted or running receipts cannot stand in for completed results. Neither receipt
nor an adapter capability assessment establishes broker delivery, cancellation,
process reattachment or other native runtime evidence.

The fixture adapter only demonstrates observable in-process work, scoped resume and
output parsing. No native runtime is qualified by this port. Account/quota, pricing,
policy and bus service ports remain unfinished; policy and bus capabilities stay
unavailable pending their enforcement and identity gates. Existing provider SDK
compatibility types and execution functions are unchanged by these declarations.
