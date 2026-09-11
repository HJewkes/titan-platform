# session-read

**Tier 2 · domain.** Depends on [`locator`](/reference/locator) and [`agent-protocol`](/reference/agent-protocol).

```sh
npm install @titan-design/session-read
```

## The problem it solves

Claude Code writes every session to `~/.claude/projects/**/*.jsonl`, one JSON object per
line, in a format that is rich and undocumented. Anything that wants to learn from those
sessions starts by re-deriving the same parse: which line is a turn, which is a tool result,
what file did that Bash command touch, which repo was it in.

This turns a transcript into **typed events, each carrying the byte range of the line that
produced it**. It stores nothing. What you do with the events is
[`session-graph`](/reference/session-graph)'s job, or your own.

## When to reach for it

You want to analyse Claude Code sessions and you do not want the storage opinion that
`session-graph` brings. Session analytics, a custom aggregation, a one-off report.

## Example

Verified against 0.2.0, over a two-line transcript.

```ts
import { extractTranscript, readTranscriptEvents } from "@titan-design/session-read";

// Stream events from a watermark
for await (const event of readTranscriptEvents(path, { fromByteOffset: watermark })) {
  // event.kind: 'session' | 'branch' | 'edge' | 'fact' | 'span' | 'turn' | 'usage' | …
}

// Or fold a chunk into one delta of rows
const delta = await extractTranscript(path, { fromByteOffset: 0 });

delta.sessions;        // [{ sessionId: 's-1', gitBranch: 'main', … }]
delta.usage;           // [{ model: 'claude-opus-5', inputTokens: 120, outputTokens: 40, … }]
delta.lastByteOffset;  // 542
delta.prefixHash;      // hash of the bytes consumed, for rewrite detection
```

Discovery, including subagent sidechains:

```ts
import { discoverTranscripts } from "@titan-design/session-read";

const found = await discoverTranscripts();  // defaults to ~/.claude/projects
// [{ projectDir, absolutePath, displayPath, subagentId? }, …]
```

## The event model

`SessionEvent` is a discriminated union on `kind`:

`fact` (one per line, typed by event), `span` (search text for prompt / assistant_response /
tool_input / tool_result), `session` (descriptive fields and turn/commit/push deltas),
`turn`, `usage` (per-model tokens with an estimated thinking share), `phase`, `human_edit`,
`file_checkpoint`, `pr`, `pr_merge`, `pr_create`, `branch`, `file`, `task`, `subagent`,
`subagent_transcript`, `artifact`, and `edge` (`session:… touched file:…` and friends;
vocabulary in `RELATIONS`).

## Why incremental reading is safe

**Every rule in `LineReader` is stateless across lines.** That is what makes reading
incrementally from a watermark and rebuilding the whole file produce the same events, so an
index can resume without ever re-deriving history.

`EventFolder` then merges a chunk's events into a `TranscriptDelta` with rules chosen so
chunk boundaries cannot change the answer: timestamps min/max, counters sum, `gitBranch` and
`seedPrompt` first-wins, `aiTitle` / `cwd` / `cliVersion` last-wins, `startType` from the
earliest line carrying an entrypoint, ref-keyed rows deduplicated.

## Gotchas

**Pass `subagentId` when reading a sidechain.** Lines in
`<session>/subagents/agent-<id>.jsonl` carry the *parent's* `sessionId`. Taking that at face
value files the child's work under the parent. Given `subagentId`, the reader gives the child
its own identity and emits the `spawned` edge instead.

**Attribution is deliberately conservative.** Files and branches are attributed to the
nearest `.git` ancestor of the path or the command's effective cwd (`cd …` and `git -C …` are
honoured), named from the origin remote. Anything outside a working tree stays unattributed
rather than guessed.

**A `DiscoveredTranscript` is not just a path.** It is
`{ projectDir, absolutePath, displayPath, subagentId? }`, and `displayPath` (the
`~`-relative form) is the key the watermark table stores. Hand-building one with the wrong
shape is the fastest way to get a confusing NOT NULL failure downstream.

## Where it came from

active-work's session miner (the AW-23 line handler). The writer, rollups, PR reconciliation,
quarantine, and scheduler stayed behind as storage concerns and became
[`session-graph`](/reference/session-graph).

## Normalized decoder contracts

`SessionFormatDecoder` defines streaming observations with conversation-scoped IDs,
source bytes and semantic subrecord selectors. Stateful formats can replay prefixes
or resume validated checkpoints. Usage distinguishes response deltas from snapshots.

`discoverCodexSources({ namespace, codexHome })`, `readCodexObservations(source)` and
`readCodexText(locator)` implement the initial Codex rollout path. Source line hashes
protect readback; prefix replay preserves model, usage and projection state across
chunks. The existing Claude reader remains available. See the
[contract decision](/guides/multi-harness-contracts) for compatibility and migration.

## Graph-free consumer views

The normalized reader dispatches both Claude and Codex source descriptors through
`readSessionObservations`. `findClaudeSessionSource` supports exact conversation
lookup, while `readRecentSessionTurns` provides an independently bounded tail with
explicit truncation and unknown-field reporting. Whole-source prefix replay and
bounded tail reading have different guarantees.

`SessionSummaryAccumulator` and `summarizeSession` expose observed spans, tools and
usage without a database. `SessionUsageAccumulator` is shared with graph queries;
response deltas, reset epochs and unknown token categories retain their semantics.
