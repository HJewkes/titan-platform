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
delta.sessions, delta.requests, delta.edges, delta.lastByteOffset, delta.prefixHash
```

## The event model

`SessionEvent` is a discriminated union on `kind`: `fact` (one per line, typed by event),
`span` (search text for prompt / assistant_response / tool_input / tool_result), `session`
(descriptive fields and turn/commit/push deltas), `turn`, `phase`, `human_edit`,
`file_checkpoint`, `pr`, `pr_merge`, `pr_create`, `review_verdict`, `branch`, `file`, `task`, `subagent`, `subagent_transcript`, `artifact`, and
`edge` (`session:… touched file:…` and friends; vocabulary in `RELATIONS`).

Every rule in `LineReader` is stateless across lines except the last-seen timestamp: a
record such as `cost-state` carries none of its own and takes the enclosing line's. A
caller resuming mid-file with `LineReader` directly must pass `initialTs`, the last
timestamp before its start offset. `readTranscriptEvents` does this for you, recovering it
with a backward lookback from the start offset. With that, reading incrementally from a
watermark and rebuilding the whole file produce the same events, so an index can resume
without ever re-deriving history.

## Verdict block

`parseVerdictBlock(text)` reads a reviewer's three-line `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`,
`Head: <40 lowercase hex>` block and returns `{ ok: true, verdict, repo, pr, head, lineOffset }` or
`{ ok: false, reason }`. It fails closed: two blocks, quoted or fenced blocks, `APPROVE`, `CHANGES` and
any short, upper-case or over-long head are refused. A `FIX_FIRST` block may add a fourth line,
`Closer: yes|no`, directly after `Head`; it is returned as `closer` and is otherwise ignored. Rules and reasons are in
`site/reference/session-read.md`.

## Review verdicts and assigned tasks

`parseReviewVerdicts(text)` reads a `chat_send` message for approve / changes-requested
verdicts. `assignedTaskIds({ agentName, brief, isKnown })` reads which task a spawned
session was given, and `orientationEnd(brief)` returns where the assignment starts in the
brief. Signatures and examples are in the
[reference page](https://hjewkes.github.io/titan-platform/reference/session-read.html).

## Audit events

Eight more kinds feed cost and context audits. Each extends the event base with
`blockIndex`: the position of the block within the line's content, or 0 for a whole-line
event. They fold into their own `TranscriptDelta` lists. `EXTRACT_VERSION` (now 7) is bumped
whenever a classification rule changes, so a store can tell stale rows apart and re-index.

| kind | list | emitted for |
|---|---|---|
| `request` | `requests` | every assistant line with usage, keyed by `requestId` or else `message.id`. A response split over two lines repeats its usage, so the store dedupes on the key. Cache creation is split into 5m and 1h. Thinking tokens are an estimated share of output. |
| `tool_call` | `toolCalls` | each `tool_use` block, with `family` and `mcpServer` from `toolFamily`, and `inputChars` |
| `inbound` | `inbound` | each delivering record: every `user` line, and each `queued_command` attachment (a message delivered mid-loop). `cause` is a `WakeCause` from `classifyInbound`. `delivery` is `turn_start`, `mid_loop` or `tool_result`. A channel message carries `originServer`, `fromName` and `msgId`. A tool result carries the `toolUseId` of its first `tool_result` block; rollup joins it to the `tool_call` for the tool name. `contentHash` is the sha-1 of the first 512 characters. `promptSource` is the record's own `promptSource` (`typed`, `system`, `sdk` for a headless turn), null when absent. |
| `context_block` | `contextBlocks` | the characters that entered context, by `ContextSource`. A user record gives one row for its text, labelled by its wake cause (`human`, `channel`, `compaction_summary`, or `system_reminder` for other injected text). It also gives one `tool_result` row per `tool_result` block, and one `image` row per image block. An assistant line gives one row per `text`, `thinking` and `tool_use` block. An attachment gives one row (`skill_listing`, or `attachment` with `attachmentType`) only when its string content is 256 characters or more (`MIN_ATTACHMENT_CHARS`). `isMedia` marks base64 images, whose `chars` is the encoded length. |
| `compaction` | `compactions` | a `compact_boundary` system line: trigger, tokens before and after, dropped tokens, duration |
| `queue_op` | `queueOps` | a `queue-operation` line. `enqueue` is when a message arrived during a busy turn; rollup pairs it with the matching `inbound` by `contentHash`. |
| `signal` | `signals` | a recognisable act in one `tool_use` block (provisional vocabulary, below) |
| `cost_state` | `costStates` | a `cost-state` line: `totalCostUsd` and the raw model usage |

`SignalKind` values, each read from a single block:

- `chat_send` is an agent-chat `chat_send`, with the recipient as `detail`.
- `status_report` is a `chat_send` whose text has `Status: DONE`, `DONE_WITH_CONCERNS`, `BLOCKED` or `NEEDS_*`, with the status word as `detail`.
- `commit`, `push` and `pr_merge` come from a Bash command, via `parseGitIntent`. `pr_merge` carries the PR number.
- `pr_create` is a Bash simple command that matches `gh pr create`, not a `parseGitIntent` result.
- `task_wrap` is `active-work wrap` or `record` in Bash, or a `Skill` call whose skill is `active-work`.
- `task_done` is `active-work task done`, with the task id as `detail`.
- `doc_written` is a `Write` to a `.md` path.
- `agent_spawn` is an `Agent` or `Task` call, or an agent-chat `agent_spawn`.
- `file_read` is a `Read` call and `file_write` is a write-tool call (including notebook edits). Both carry the repo-relative path as `detail`; build trees matched by `IGNORED_PATH` emit nothing.
- `command_heads` is the program and up to two subcommand words of each simple command in a Bash call, joined with `;` (`gh pr checks;git log`), plus `>dir/name` (the last parent directory and the basename) for each file it writes; a bare filename stays `>name`. `cd` is dropped, and `builtin`, `command`, `timeout N`, `nice`, `nohup` and `env A=1` are looked through to the program they run.
  Two program shapes keep a path operand's signal:
  - `gh api` gives the HTTP method (from `-X`/`--method`; otherwise POST when `-f`, `-F` or `--input` adds a body, else GET) and the endpoint's resource words, with owner, repo and item ids dropped: `gh api -X PUT repos/o/r/pulls/5/merge` gives `gh api PUT pulls/merge`. Flag values such as `-f`, `-H` and `--jq` never enter the head.
  - An interpreter (`python`, `python3`, `node`, `bash`, `sh`, `zsh`, `deno`, `bun`, `ruby`, `perl`) gives the script's basename when its first operand has an extension or a slash: `python3 /x/score.py --seat a` gives `python3 score.py`. `python3 -c …`, `python3 -m …` and `python3 -` stay `python3`, and other operands fall back to subcommand words (`bun test`).

`command_heads` is not secret-free. After a program that is not on the operand-only list, up to two bare
all-lowercase positionals are kept, so `mycli login hunter2` yields the head `mycli login hunter2`. Collection
stops at the first flag, path, number-led, uppercase, dotted or quoted word. Treat the signal as
low-sensitivity, never as redacted.

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

A missing projects or subagents directory, or a stray file beside the project
directories, reads as no transcripts. Any other I/O error, such as `EACCES` on an
unreadable directory, rejects the discovery call rather than returning a short corpus.

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
`archived_sessions/`. `codexHome` defaults to `codexHome()`: `$CODEX_HOME` when it is set
and non-empty, as the Codex CLI resolves it, otherwise `~/.codex`. A missing directory
reads as no sources and a file whose first line is not JSON is skipped; any other I/O
error, such as an unreadable rollout directory, rejects. It reads conversation identity from `session_meta`; a filename stem
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

`readCodexText(locator, { sources })` and `readClaudeText` resolve a moved source by one
identity rule. Exactly one fresh source must match the locator's source ID, harness, format,
namespace, conversation and provenance; only the path may differ. The reader then checks
the exact source-line hash before returning the selected value. It returns `null` only for
a stale locator: the file is gone or shorter than the span, or the bytes there no longer
match the hash, decode as UTF-8 or parse as JSON. Any other I/O error rejects, and
`readSessionSourceText` behaves the same for Claude locators. `readSessionText({ path,
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
The fold is agent-protocol's `foldUsage`; `SessionUsageAccumulator` applies it for
graph-backed consumers.
Consumer-specific cost estimates, friction heuristics and presentation remain in
the consumer. Native extensions retain provider fields without making them portable.

Copied-history metrics are excluded when `historyOrigin` is explicitly populated.
Current Claude/Codex decoders preserve lineage but do not yet identify copied
records reliably; fork-copy accounting therefore remains unsupported until native
fixtures establish that mapping. Do not treat a child transcript's totals as proof
of newly executed work. Repeated deltas for one response use the latest observed
native values, allowing a provider to revise a response's usage as it completes.

### Recovering a session that ended with no wrap

`recoverSession(source, { root })` reads one transcript after a reboot, crash or closed
window and returns facts only: no model call, no network, no write. It folds the whole source
with `SessionSummaryAccumulator` for the start and end times and reads tool calls for the
`chat_register` name, files written under `root` (relative to it), `active-work` and git/gh
calls as `commandHeads` heads with counts, and `chat_send` / `agent_spawn` targets with the
first line of their text or brief. A bounded `readRecentSessionTurns` text window gives the
last `RECOVERY_OWNER_MESSAGES` owner messages (tool results and injected blocks excluded) and
the last assistant message, each capped at `RECOVERY_MESSAGE_CHARS`. Lists stop at
`RECOVERY_LIST_CAP` and report `dropped`; `messageWindowTruncated` says older messages were
outside the window. Argument text never reaches the result, so tokens and URL queries stay out
of a session record.
