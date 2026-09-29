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
`file_checkpoint`, `pr`, `pr_merge`, `pr_create`, `review_verdict` (below), `branch`, `file`,
`task`, `subagent`, `subagent_transcript`, `artifact`, and `edge` (`session:… touched
file:…` and friends; vocabulary in `RELATIONS`).

## Review verdicts

`parseReviewVerdicts(text)` reads a `chat_send` message for approve / changes-requested
verdicts, without storing any of the message. A verdict line either contains the word
`verdict` followed (after up to three punctuation characters and any whitespace) by a token,
or begins, after optional markdown, with `APPROVE`, `APPROVED`, `CHANGES REQUESTED` or
`REQUEST CHANGES`. Tokens are case-insensitive and their words may be joined by a space,
underscore or hyphen: `APPROVE`, `APPROVED` and `LGTM` mean approve; `CHANGES REQUESTED`,
`REQUEST CHANGES`, `REQUESTED CHANGES`, `NEEDS CHANGES`, `BLOCKED` and `BLOCKING` mean
changes requested.

PR references come from the verdict line, or the message's first line when the verdict line
names none, in precedence order: a `github.com/<owner>/<repo>/pull/<n>` URL or an
`<owner>/<repo>#<n>` pair give an exact `repo`; `<repo> #<n>` or `<repo> PR #<n>` keep the
word before the number as a `repoHint`, but only when that word is not a verdict token
(`approve`, `blocked`, …) or a common filler (`pr`, `see`, `on`, `the`, …) — a rejected
candidate yields no hint, and the search never looks further left; `PR #<n>`, `PR <n>`,
`pull request #<n>` and a bare `#<n>` carry neither. One line can name several PRs, each
becoming its own match. Verdicts dedupe on the pair `(repo ?? repoHint?.toLowerCase() ?? "",
number)`: two references to the same number in different repos are two verdicts, but when a
later verdict line names the same pair, it replaces the earlier one.

Every scan is a single bounded pass over the line, so a pathological single-line message
still parses in linear time.

```ts
import { parseReviewVerdicts } from "@titan-design/session-read";

parseReviewVerdicts("Verdict: CHANGES REQUESTED on acme/widgets#248");
// [{ verdict: "changes_requested", repo: "acme/widgets", repoHint: null, number: 248 }]
```

`readToolUse` emits one `review_verdict` event per match for a tool whose name ends in
`__chat_send`, adding `toolUseId`, `ordinal` (the verdict's index in that message's parsed list) and `cwdRepo`
(`repoForCwd` of the call's `cwd`). The event
carries only the parsed fields, never the message text. Resolving `repo`/`repoHint` against
known PRs and filtering by the sender's profile happen downstream, in `session-graph`.

## Verdict block

`parseVerdictBlock(text)` reads the strict block a reviewer sends when a merge hangs on it:

```text
Verdict: MERGE
PR: octo/demo#12
Head: 0123456789abcdef0123456789abcdef01234567
```

It returns `{ ok: true, verdict: "MERGE" | "FIX_FIRST", repo, pr, head, lineOffset }` or
`{ ok: false, reason }`, where `lineOffset` is the zero-based line of the `Verdict:` line.
It fails closed. The three lines must be consecutive and exact: `Verdict:` is `MERGE` or
`FIX_FIRST` in upper case, `PR:` is `owner/name#n` (GitHub's `[A-Za-z0-9._-]`, no `.git`
suffix, no URL, `n` a positive integer without leading zeros), and `Head:` is exactly 40
lowercase hex characters with nothing after it. Each line is trimmed on both sides, so
indentation and CRLF are harmless, but a quoted line (`> Verdict: MERGE`) is not a block and
lines inside a ``` or ~~~ fence are skipped. A `Status:` line is ignored. Any second line
starting `Verdict:` outside a fence is a second block and refuses the message, even when
identical. Refusal reasons are `no_block`, `multiple_blocks`, `bad_verdict`, `missing_pr_line`,
`bad_pr`, `missing_head_line` and `bad_head`. It shares no grammar with `parseReviewVerdicts`.

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

## Assigned task of a spawned session

`assignedTaskIds({ agentName, brief, isKnown })` reads which task a spawned session was
given, from the agent name and the full spawn brief. `isKnown` is the caller's task store:
an id counts only if it returns true. The result is `{ taskIds, source }`, with up to three
ids in order.

```ts
import { assignedTaskIds } from "@titan-design/session-read";

assignedTaskIds({ agentName: "factory-tp422", brief, isKnown });
// { taskIds: ["TP-422"], source: "name" }
```

`source` says which rule found the ids. The name wins over the brief. `name-over-brief`
marks a name whose ids the brief does not repeat. `brief-anchor` is a line that begins with
`TASK`, `ASSIGNMENT`, `YOUR TASK`, `IMPLEMENT` or `GOAL`; ids in parentheses on it are
references, not assignments. `brief-paragraph` is the first known id near the start of the
assignment. `none` is a definite answer that nothing links. More than three ids in one
source is a list, and that source yields nothing.

**The orientation block is skipped.** agent-chat prepends an orientation that lists every
open task. `orientationEnd(brief)` returns where the assignment starts: 0 when there is no
orientation, null when there is one whose end cannot be found. Such a brief links nothing
rather than guess. The block's format is owned by agent-chat, and the tests pin today's
headings and truncation marker. Every search reads a bounded window, so a 100 KB brief costs
the same as a short one.

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

For a readback of what an agent said, pass `projection: "text"`. It keeps only user and
assistant text and applies `maxTurns` after tool traffic is dropped.
`claudeSourceFromPath(path, namespace)` builds the descriptor when the caller already
holds a transcript path. The package README has the recipe and measured window sizes.

`SessionSummaryAccumulator` and `summarizeSession` expose observed spans, tools and
usage without a database. `SessionUsageAccumulator` is shared with graph queries. It
selects measurements with agent-protocol's `foldUsage`, then groups them by model; a
null token count in a group makes that group's sum null.

**Session identity mismatches throw `SessionIdentityError`.** A Claude transcript record
that belongs to a different native session, or a sidechain window that names more than one
parent session, throws `SessionIdentityError` — a `TypeError` subclass with a stable
`code` field (`"foreign_native_session"` or `"multiple_parent_sessions"`). Existing
`instanceof TypeError` catches and message-prefix matches keep working; a consumer that
wants to tell this apart from option-validation `TypeError`s (which stay plain) can now
check `instanceof SessionIdentityError` and read `.code`.
