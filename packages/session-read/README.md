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

## What stayed behind

active-work's writer, rollups, PR reconciliation, quarantine, and scheduler are storage
concerns and belong to session-graph. Brain's session analytics (segmentation, friction,
classification) consume a whole session at once and can be built over this event stream.
