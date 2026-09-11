# ADR: shared harness contracts (TP-44)

Status: accepted direction; additive contracts delivered in TP-44. Decoder, executor and
store integration follow in TP-45–TP-48. Existing Claude APIs and stored rows retain
their behavior in this change.

## Context

Titan's agent package runs a bounded Claude SDK query. Session-read independently
parses Claude transcripts; session-graph and the miner consume those observations.
Agent-chat adds durable peers, terminal surfaces, isolation and communication. A
Codex conversation must fit this ecosystem without being shaped like a Claude log.

The owner approved a staged multi-harness design on 2026-09-11. Cursor is a future
compatibility constraint, not a claimed supported adapter. Research used Codex
0.154.0-alpha.6.1 help, generated protocol schemas and metadata-only rollout reads.
The execution recommendation is supervised `codex exec --json`, retaining persistence
for the end-to-end smoke. App-server recovery and interactive delivery come later.
See [noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and
[app-server](https://learn.chatgpt.com/docs/app-server) for their public interfaces.

## Decision: a minimal common vocabulary

`agent-protocol` is a dependency-free tier-0 package shared by `agent` and
`session-read`. It contains identity and usage types and deterministic reference
helpers. Neither consumer depends on the other. The parser does not import an agent
SDK; execution does not import the graph. Orchestration and terminal packages are
not created merely to hold future interfaces.

Four identities are independent:

- Agent: durable peer address, owned by orchestration.
- Conversation: native harness thread, scoped by harness and corpus namespace.
- Execution: one invocation/attachment; a conversation may become known after launch.
- Surface: host-specific process/pane handle with explicit teardown ownership.

A namespace is a stable caller-assigned host/account corpus identity, not a source
path or a transient process ID. Relocating or archiving a file must not rename its
conversation. Call, response, turn and item IDs are scoped to the conversation and
category. All reference components are escaped; delimiter-containing names cannot
collide. Consumers compare canonical keys, not object identity.

For observed Codex rollouts, `session_meta.payload.id`/`thread_id` identifies a
conversation. `session_id` may identify the entire spawned tree. Parent-thread,
fork and handoff relations remain distinct and carry evidence when known. A
transcript's latest timestamp is last activity, not authoritative process exit.

## Decision: additive execution contracts

The existing `runAgent`, `AgentRunConfig`, `AgentRunResult`, Claude permissions,
authentication policy and mandatory budgets remain unchanged. New contracts are
opt-in. TP-44 exports a checked adapter boundary, not a working Codex adapter.
Native options are discriminated by harness, so accepting a Codex request cannot
silently ignore Claude-only hooks or tool grants.

An adapter supplies capabilities for its specific version. Supported, unsupported
and unverified are distinct. Preflight rejects missing required support before
calling the adapter. A capability declaration is a contract implemented by the
adapter, not proof inferred from help text; version-specific conformance tests are
required before a real adapter may claim support.

Limits name a unit and distinguish enforced from advisory behavior. All new runs
require a positive finite local wall-time deadline. A local process deadline is
not a guarantee that upstream billing ceases instantly; cancellation with an
unknown remote outcome must remain uncertain. A user submission, model request,
agent iteration and dollar estimate are different units. Codex's initial adapter
must reject a required hard cost/request cap it cannot enforce. Existing Claude
maxBudgetUsd remains the SDK's estimate-based stop condition, not a billing receipt.

A bounded result is not a durable peer handle. Future workflow recovery must persist
a start handle before waiting; today's StepRunner only receives runnerRef after
completion. TP-50 owns that change. No shared API here claims live steering, fork,
terminal switching or durable attach for an adapter that does not implement it.

## Decision: normalized observations alongside the legacy event stream

Session-read's new contracts coexist with its existing SessionEvent and EventFolder.
They do not change the current parser or claim the graph can consume the new stream.
A source descriptor identifies format, physical location and conversation. Semantic
observations retain original line byte locators plus a subrecord selector. Multiple
observations on one line must remain independently addressable.

A decoder reconstructs metadata and in-flight tool context before emitting events
past a resume offset. Prefix replay is the initial correctness strategy. Any later
checkpoint must be versioned, bound to a prefix hash and invalidated on rewrite.
Completed malformed lines may quarantine a source; a partial final line is retried.
A format-aware read-back operation returns the selected text field or an explicit
unavailable result. It must never fall back to displaying an entire JSON record.

For the Codex adapter, prefer raw response_item messages/calls/results over duplicate
high-level event_msg projections. Preserve unmatched high-level observations without
counting both forms. Tool wrappers and nested command projections have separate ID
spaces; adjacency is not evidence of a parent call. Raw unknown kinds remain located
observations. Compaction/fork shapes not observed locally require fixtures before
claiming their exact accounting semantics.

Usage is either an idempotent response delta or an ordered snapshot within an epoch.
Keep unknown model/token/cost fields unknown. Normalize input totals consistently:
input includes cached and cache-write input when those are reported separately by a
harness; output includes reasoning output. Never add those subsets a second time.
A source lacking enough data leaves the normalized total null. Legacy UsageRow stays
unchanged. Codex token_usage_record.usage is a response delta; neighboring cumulative
snapshots are not additional usage. Model attribution comes from turn_context.

## Compatibility migration contract for TP-47

No DDL migration, reference rewrite or index reset is performed in TP-44. The next
schema version must expand additively before switching readers/writers:

1. Add canonical conversation identity columns/table and a source-format association.
   `conversation:<escaped harness>:<escaped namespace>:<escaped native ID>` is the new
   canonical key. Keep existing session IDs, physical source IDs and rows intact.
2. Backfill explicitly known Claude identities from existing rows and record an alias
   from each old `session:<id>` to the canonical conversation. Never guess that an
   arbitrary legacy record belongs to Claude because its ID resembles a UUID.
3. Preserve workspace records: `session:` plus field `body` is an active-work session
   record, whereas prompt/assistant_response/tool_input/tool_result are transcript
   fields. Existing joins and playbook provenance continue through explicit aliases.
   Search class filters must account for both reference vocabularies during cutover.
4. Keep raw-line facts with current uniqueness. Add semantic events keyed by source,
   line offset and stable selector/item ID; add scoped native turn/call keys. Native
   user-message IDs are not substituted for Codex turn IDs. One conversation can have
   multiple physical sources, including archived/restored copies.
5. Preserve rows whose original files have been pruned. A migration cannot assume a
   full replay is possible merely because the store is derived. Do not drop/rebuild
   those rows or change old byte locators; mark unresolvable excerpts unavailable.
6. Give the miner a format-aware resolver for search and Drain rather than reopening
   JSON through parsed.message. Ingest one authoritative transcript history, not both
   exec stdout and rollout copies. Snapshot and delta usage get distinct aggregation.
7. Verify old APIs and mixed data first, then opt consumers into canonical identities.
   Alias ambiguity is an error, not first-match selection. A compatibility read path
   and a backup/rollback exercise precede retirement of any legacy columns.

TP-47 acceptance includes a database with old Claude facts, workspace session bodies,
playbook refs and missing source files; all must survive. A Codex child with a shared
session-tree ID must remain a separate conversation. Tests cover native-ID collisions,
Unicode locators, multiple semantic events per line and repeated usage snapshots.

## Later migration boundaries

Agent-chat's event log remains authoritative for peers, messages and launch history;
miner reset must never erase it. Relay currently shells the CLI, parses roster prose,
consumes SSE and duplicates transcript helpers; it does not import spawn-kernel.
Preserve those real interfaces until versioned replacements are verified.

Communication delivery is not execution. Stored, transport-accepted, acknowledged,
turn-started and completed are different observations. Codex steering/turn submission
and Claude channels need distinct adapters. The temporary MCP bridge used during
planning proves cross-harness coordination can be arranged, not durable integration.
