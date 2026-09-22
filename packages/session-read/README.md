# @titan-design/session-read

Turn a Claude Code transcript (`~/.claude/projects/**/*.jsonl`) into typed events, each
carrying the byte range of the line that produced it. No storage: what you do with the
events is `session-graph`'s job, or your own.

Tier 2 of the titan-platform DAG. Depends on `@titan-design/locator`. Extracted from
active-work's session miner (AW-23 line handler, TP-6).

```ts
import { extractTranscript, readTranscriptEvents } from "@titan-design/session-read";

// Stream events from a watermark
for await (const event of readTranscriptEvents(path, { fromByteOffset: watermark })) { ... }

// Or fold a chunk into one delta of rows
const delta = await extractTranscript(path, { fromByteOffset: watermark, priorPrefixHash: hash });
delta.sessions, delta.usage, delta.edges, delta.lastByteOffset, delta.prefixHash
```

## The event model

`SessionEvent` is a discriminated union on `kind`: `fact` (one per line, typed by event),
`span` (search text for prompt / assistant_response / tool_input / tool_result), `session`
(descriptive fields and turn/commit/push deltas), `turn`, `usage` (per-model tokens with an
estimated thinking share), `phase`, `human_edit`, `file_checkpoint`, `pr`, `pr_merge`,
`pr_create`, `branch`, `file`, `task`, `subagent`, `subagent_transcript`, `artifact`, and
`edge` (`session:… touched file:…` and friends; vocabulary in `RELATIONS`).

Every rule in `LineReader` is stateless across lines. That is what makes reading
incrementally from a watermark and rebuilding the whole file produce the same events, so
an index can resume without ever re-deriving history.

## Audit events

Eight more kinds feed cost and context audits. Each extends the event base with
`blockIndex`: the position of the block within the line's content, or 0 for a whole-line
event. They fold into their own `TranscriptDelta` lists. `EXTRACT_VERSION` (now 2) is bumped
whenever a classification rule changes, so a store can tell stale rows apart and re-index.

| kind | list | emitted for |
|---|---|---|
| `request` | `requests` | every assistant line with usage, keyed by `requestId` or else `message.id`. A response split over two lines repeats its usage, so the store dedupes on the key. Cache creation is split into 5m and 1h. Supersedes the deprecated `usage`. |
| `tool_call` | `toolCalls` | each `tool_use` block, with `family` and `mcpServer` from `toolFamily`, and `inputChars` |
| `inbound` | `inbound` | each delivering record: every `user` line, and each `queued_command` attachment (a message delivered mid-loop). `cause` is a `WakeCause` from `classifyInbound`. `delivery` is `turn_start`, `mid_loop` or `tool_result`. A channel message carries `originServer`, `fromName` and `msgId`. A tool result carries the `toolUseId` of its first `tool_result` block; rollup joins it to the `tool_call` for the tool name. `contentHash` is the sha-1 of the first 512 characters. |
| `context_block` | `contextBlocks` | the characters that entered context, by `ContextSource`. A user record gives one row for its text, labelled by its wake cause (`human`, `channel`, `compaction_summary`, or `system_reminder` for other injected text). It also gives one `tool_result` row per `tool_result` block, and one `image` row per image block. An assistant line gives one row per `text`, `thinking` and `tool_use` block. An attachment gives one row (`skill_listing`, or `attachment` with `attachmentType`) only when its string content is 256 characters or more (`MIN_ATTACHMENT_CHARS`). `isMedia` marks base64 images, whose `chars` is the encoded length. |
| `compaction` | `compactions` | a `compact_boundary` system line: trigger, tokens before and after, dropped tokens, duration |
| `queue_op` | `queueOps` | a `queue-operation` line. `enqueue` is when a message arrived during a busy turn; rollup pairs it with the matching `inbound` by `contentHash`. |
| `signal` | `signals` | a recognisable act in one `tool_use` block (provisional vocabulary, below) |
| `cost_state` | `costStates` | a `cost-state` line: `totalCostUsd` and the raw model usage |

`SignalKind` values, each read from a single block:

- `chat_send` is an agent-chat `chat_send`, with the recipient as `detail`.
- `status_report` is a `chat_send` whose text has `Status: DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_*`, with the status word as `detail`.
- `commit`, `push`, `pr_create` and `pr_merge` come from a Bash command, via `parseGitIntent`. `pr_merge` carries the PR number.
- `task_wrap` is `active-work wrap` or `record` in Bash, or a `Skill` call whose skill is `active-work`.
- `task_done` is `active-work task done`, with the task id as `detail`.
- `doc_written` is a `Write` to a `.md` path.
- `agent_spawn` is an `Agent` call or an agent-chat `agent_spawn`.

The classifiers are exported for reuse: `classifyInbound`, `toolFamily`, `toolUseSignals`,
`bashSignals`, `sourceForCause`, and the shared `INJECTED_MARKERS` list.

## Folding

`EventFolder` merges a chunk's events into a `TranscriptDelta` with rules chosen so chunk
boundaries cannot change the answer: timestamps min/max, counters sum, `gitBranch` and
`seedPrompt` first-wins, `aiTitle`/`cwd`/`cliVersion` last-wins, `startType` from the
earliest line carrying an entrypoint, ref-keyed rows deduplicated. A writer applies deltas
with the matching upserts.

## Subagent sidechains

`discoverTranscripts` finds top-level transcripts and `<session>/subagents/agent-<id>.jsonl`
sidechains. Pass `subagentId` when reading a sidechain: its lines carry the parent's
`sessionId`, and taking that at face value would file the child's work under the parent.
The reader gives the child its own identity and emits the `spawned` edge instead.

## Attribution

Files and branches are attributed to the nearest `.git` ancestor of the path or the
command's effective cwd (`cd …` and `git -C …` are honored), named from the origin remote.
Anything outside a working tree stays unattributed rather than guessed.

## Multi-harness contracts

The additive normalized contracts describe transcript sources and semantic observations
without changing the existing Claude reader. `SessionSourceDescriptor` keeps the harness,
format/version, physical path, source namespace, and native `ConversationIdentity`
separate. Observations carry line plus subrecord evidence, so one JSONL line can yield
multiple messages, calls, results, usage rows, or metadata records without sharing an ID.

Native turn, call, item, and response IDs use `ScopedConversationItemId`; their stable refs
include harness, namespace, conversation, and category. Codex `sessionTreeId` remains source
provenance and never replaces the child thread's conversation ID. Usage observations retain
the protocol package's delta-versus-snapshot semantics, including response deduplication and
snapshot epoch/sequence fields.

`SessionFormatDecoder` streams observations through an emitter while supporting prefix replay
and versioned checkpoints. Reading may begin before the emission boundary to rebuild state,
while the verified boundary determines which observations are emitted. Its text resolver
accepts only a `SourceTextLocator` selecting a semantic subrecord; it does not expose a
whole-JSON-line readback path.

Legacy refs stay opt-in. `sessionRef(id)` is unchanged, and
`legacyClaudeSessionRef(source)` returns one only when the source carries explicit
`claude-code-transcript` provenance.

## Codex rollouts

`discoverCodexSources({ codexHome, namespace })` scans both `sessions/` and
`archived_sessions/`. It reads conversation identity from `session_meta`; a filename stem
never substitutes for the native thread ID. Source IDs include namespace, thread, and
rollout filename, so moving an identical rollout between active and archived storage keeps
its identity while distinct files for one thread remain separate. Divergent files that
claim the same source ID raise `CodexSourceCollisionError`.

`readCodexObservations(source, { from }, onDone)` streams normalized observations. It
replays the prefix to recover turn/model context, validates a prior boundary hash, and
restarts from zero after a rewrite. Incomplete final lines remain before the returned
boundary. Raw `response_item` messages take precedence over matching `event_msg`
projections; unmatched projections become explicit fallbacks at a turn boundary. Response
usage is emitted as idempotent deltas, while turn/thread totals remain ordered snapshots in
reset epochs.

`readCodexText(locator, { sources })` resolves moved sources by stable source ID and checks
the exact source-line hash before returning the selected value. `readSessionText({ path,
byteOffset, byteLength, field })` provides the corresponding legacy Claude field projection
for miner consumers.

## What stayed behind

active-work's writer, rollups, PR reconciliation, quarantine, and scheduler are storage
concerns and belong to session-graph. Brain's session analytics (segmentation, friction,
classification) consume a whole session at once and can be built over this event stream.

## Storage-free session views

`findClaudeSessionSource({ cwd, conversation, configDir? })` returns an explicit
found/not-written/unavailable result. `readSessionObservations(source)` dispatches
to Claude or Codex normalization, preserving exact line evidence and native fields.
Both whole-source readers may replay the prefix to recover context and validate a
resume boundary. They do not establish execution liveness.

`readRecentSessionTurns(source, { maxBytes, maxTurns, maxCharsPerTurn })` uses a
separate bounded filesystem window. It reports byte/turn truncation, malformed
complete records, and unknown model/branch/error fields when the evidence is outside
that window. It never runs the replay-prefix reader behind a purported tail read.

### Reading back what an agent said

A voice or chat readback of a live agent needs the last few things said, not its tool
traffic. Pass `projection: "text"`: it keeps only the user and assistant text blocks. It
also applies the turn limit after dropping tool calls, tool results, thinking and system
rows, so `maxTurns: 20` means twenty spoken turns. When you already hold a transcript path,
such as one from a roster, `claudeSourceFromPath(path, namespace)` builds the descriptor
from the filename. For an `agent-<id>.jsonl` sidechain it uses the agent ID.

```ts
import { claudeSourceFromPath, readRecentSessionTurnsSync } from "@titan-design/session-read";

const result = readRecentSessionTurnsSync(claudeSourceFromPath(transcriptPath, "local"), {
  maxBytes: 4 * 1024 * 1024,
  maxTurns: 20,
  maxCharsPerTurn: 4000,
  projection: "text",
});
if (result.status === "unavailable") throw new Error(result.errors[0]?.reason);
const spoken = result.turns.map((turn) => `${turn.role}:\n${turn.text.trim()}`).join("\n\n");
```

Size `maxBytes` for spoken turns, not rows: tool results take up most of a transcript's
bytes. Across 40 real transcripts of 5 to 50 MB, 20 turns of any kind fit in the last 63 to
905 KB. Where 20 spoken turns existed at all, they needed 247 KB to 3 MB. A 256 KB window
returned 11 of 20 on a 50 MB session. Reading 4 MB and parsing it took 12 ms. Parsing that whole file took 146 ms.
A partly written final record is skipped and reported through `truncatedAfter`. `model` is
the newest assistant row's model, ignoring the `<synthetic>` placeholder Claude Code writes on
locally generated error rows.

`summarizeSession(source)` and `SessionSummaryAccumulator` derive observation spans,
message/tool counts, explicit native permission-denial evidence and usage. Generic
tool errors are separate from permission denials; missing error and token fields
remain unknown. Usage deduplicates response deltas and replaces snapshots within
scope/reset epochs. Conversation-wide snapshots are not attributed to one model.
`SessionUsageAccumulator` provides the same fold to graph-backed consumers.
Consumer-specific cost estimates, friction heuristics and presentation remain in
the consumer. Native extensions retain provider fields without making them portable.

Copied-history metrics are excluded when `historyOrigin` is explicitly populated.
Current Claude/Codex decoders preserve lineage but do not yet identify copied
records reliably; fork-copy accounting therefore remains unsupported until native
fixtures establish that mapping. Do not treat a child transcript's totals as proof
of newly executed work. Repeated deltas for one response use the latest observed
native values, allowing a provider to revise a response's usage as it completes.
