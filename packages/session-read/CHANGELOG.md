# @titan-design/session-read

## 0.11.1

### Patch Changes

- Updated dependencies [d4895bf]
- Updated dependencies [2fc4fd9]
  - @titan-design/anthropic-account@0.2.0

## 0.11.0

### Minor Changes

- f34ae27: The Codex and Claude decoders and the recent Codex reader now throw `SessionIdentityError` (still a `TypeError` subclass) when a file's records belong to a different native session, so a consumer can quarantine such a file while letting real programming errors propagate.
- a8faac4: Remove the deprecated `usage` event (breaking). `SessionEvent` no longer has a `usage` kind, `TranscriptDelta.usage` and the `UsageRow` type are gone, and `EventFolder` no longer folds usage. The `usage` rows counted a response written over two lines twice. Read `delta.requests` instead and dedupe on `requestId`, as session-graph's rollup already does.

  No known consumer reads the removed API. `git grep -n -E 'delta\.usage|UsageRow'` finds 0 hits in each of these:

  | repo                                | pinned sha | current `origin/main` |
  | ----------------------------------- | ---------- | --------------------- |
  | active-work                         | 1ebd7b9: 0 | d30d956: 0            |
  | agent-chat                          | c1e47ca: 0 | 9383846: 0            |
  | relay (private)                     | pinned: 0  | current: 0            |
  | codewatch                           | 91dc543: 0 | dc9f4ef: 0            |
  | brain                               | 760ce01: 0 | 760ce01: 0            |
  | titan-platform outside session-read | n/a        | 513c0cce: 0           |

  `EXTRACT_VERSION` stays at 7. No stored row comes from the `usage` event: session-graph rebuilds `session_model_usage` from `request` rows, so a re-extract would change nothing.

- 1aed39d: session-read now exports `expandHome(file, homeDir?)`, which expands both a bare `~` and `~/…`; `toAbsolutePath` uses it, so a stored bare `~` path now resolves. session-graph drops its private copy and imports this one.
- deb35d0: Export `splitPipelines`, which groups the simple commands of a raw Bash command into the pipelines a `|` joins, plus `splitCommands` and `simpleCommandHead`, the head of one simple command without its redirect targets.
- 59ba612: `parseVerdictBlock` reads an optional `Closer: yes|no` line directly after Head on a FIX_FIRST block and returns it as `closer`; absent, on MERGE, malformed, duplicated or misplaced it stays undefined and the block parses as before. Shepherd carries `closer` on a FIX_FIRST verdict and opens approve-merge with the new `no-progress` escalation at the second consecutive FIX_FIRST that said `Closer: no`, before the `fix-first-runaway` cap. Any other round resets the streak.
- c466784: session-read now exports `parseFileRef(ref)`, the inverse of `fileRef`: it returns `{ repo, path }` from a `file:` ref, a null repo for an unattributed ref, and null for a ref of another kind. `toRepoRelative` now strips a leaked `.worktrees/<name>/` prefix, so a file touched in a worktree that has since been removed resolves to the same repo-relative path as the live worktree, and returns posix paths. New ingests of such files write `file:<repo>/<path>` instead of `file:<repo>/.worktrees/<name>/<path>`; `parseFileRef` strips the prefix from refs already stored.

### Patch Changes

- 495e6f8: `claudeTranscriptRoots` now discovers Claude config profiles through `@titan-design/anthropic-account` instead of its own copy of the scan. Two behaviour changes follow from that package: a symlinked `~/.claude-profiles` directory is skipped, and an account label drops leading dots (a `CLAUDE_CONFIG_DIRS` entry `.work` is now labelled `work`, and a name that is empty after that is labelled `default`), so stored account names for such directories change. The default `~/.claude` root is still always listed.

  Release order: `@titan-design/anthropic-account` is a new package whose first npm publish is done by the owner. Hold the "Version Packages" pull request until that package exists on npm, because this release depends on it.

- 74f9f51: Docs: name the `LineReader` `initialTs` exception (and that `readTranscriptEvents` recovers it), list all 13 `SignalKind` members with the correct `pr_create` and `agent_spawn` sources, document `parseReviewVerdicts`, `assignedTaskIds` and `orientationEnd` in the README, and name Codex in the package description.
- 1fd9652: Share one observation stream between the Claude and Codex readers: the backpressure queue, resume check, locator text selection and prefix-digest decode loop now live once. Codex `readCodexText` now resolves a moved source with the same full-identity rule as Claude: a fresh source must match the locator's `sourceId`, harness, format, namespace, conversation and provenance, not `sourceId` alone.
- 295acf8: Drop a subshell closer from the last word of a git or gh command, so `(git push origin feat/q)` records branch `feat/q` rather than `feat/q)`. `EXTRACT_VERSION` is now 7, so stored intents re-extract on the next backfill.
- ff6ff86: Wrap the README event-kind list. Docs only.
- Updated dependencies [7345a13]
- Updated dependencies [f4b073d]
- Updated dependencies [ff6ff86]
- Updated dependencies [a109b70]
- Updated dependencies [906b22b]
- Updated dependencies [c85944c]
  - @titan-design/agent-protocol@0.6.0
  - @titan-design/anthropic-account@0.1.0

## 0.10.0

### Minor Changes

- 6a2c0f8: Discovery and readback now separate absence from failure. These calls can now reject on an I/O error other than a missing path (for example `EACCES` or `EMFILE`) where they used to return an empty or null result:

  - `discoverTranscripts`, `discoverAllTranscripts` and `discoverCodexSources` reject instead of returning `[]` or skipping the directory. A missing directory, or a stray file beside the project directories, still reads as no transcripts.
  - `claudeTranscriptRoots` throws when `~/.claude-profiles` or a profile's `projects` path cannot be inspected; a missing one is still skipped.
  - `readClaudeText`, `readCodexText` and `readSessionSourceText` reject instead of returning `null`. They still return `null` for a stale locator: the file is gone or shorter than the span, or the line no longer matches its hash, decodes as UTF-8 or parses as JSON.

  `codexHome()` now honors `CODEX_HOME` when it is set and non-empty, as the Codex CLI does, so `discoverCodexSources({ namespace })` without an explicit `codexHome` scans the same directory Codex writes to.

## 0.9.1

### Patch Changes

- b241223: Read git and gh intents only from unquoted simple commands. `parseGitIntent` and the `pr_create` signal no longer match text inside quotes, `echo` arguments or heredoc bodies, so `echo "gh pr merge 42"` records no merge and a commit message mentioning `git push` records no push. `EXTRACT_VERSION` is now 6, so stored intents re-extract on the next backfill.

## 0.9.0

### Minor Changes

- 18e081a: Read `Verdict: WAIT` (required checks unfinished at the reviewed head) as no verdict, never a MERGE. `parseVerdictBlock` returns `{ ok: false, reason: "wait" }` with the PR and head the block names; Shepherd's `acceptVerdict` returns `none` with reason `wait`, and a seat reviewer's WAIT at a head never reads clear for a carry or a MERGE.
- 218cbac: A Claude usage observation now carries `cacheWriteSplit` (`{ ttl5m, ttl1h }`, the new exported `CacheWriteSplit` type) when the transcript's usage has a `cache_creation` object with `ephemeral_5m_input_tokens` or `ephemeral_1h_input_tokens`. The 1h rate is higher than the 5m rate, so a price needs the split rather than the `cacheWriteInput` total. A usage line with only `cache_creation_input_tokens` leaves the field absent.
- d10a591: Add `recoverSession`, a facts-only extractor for a session that ended with no wrap. It reads one
  transcript and returns the session span, the registered agent name, files written under a root,
  active-work and git/gh command heads, chat_send and agent_spawn targets with first lines, the last
  five owner messages and the last assistant message, all capped. No model call, network or write.

### Patch Changes

- Updated dependencies [411b4f0]
  - @titan-design/agent-protocol@0.5.0

## 0.8.1

### Patch Changes

- Updated dependencies [fe11f1b]
  - @titan-design/agent-protocol@0.4.0

## 0.8.0

### Minor Changes

- 88bf9f7: Add `command_heads`, `file_read` and `file_write` signals and export `commandHeads`. A Bash call's signal carries the program and up to two subcommand words of each simple command, plus `>basename` for redirect and `tee` targets, joined by `;` within 256 characters. Read emits `file_read` and Write, Edit, MultiEdit and NotebookEdit emit `file_write`, each with the repo-relative path. `EXTRACT_VERSION` is now 3, so consumers re-extract once.
- f3f843d: `commandHeads` keeps the signal a path operand carried. `gh api` gives the method and resource shape (`gh api PUT pulls/merge`), an interpreter gives its script's basename (`python3 score.py`), and a redirect or `tee` target keeps its last parent directory (`>a/2026-01-01.md`). `timeout N`, `nice`, `nohup` and `env` are looked through like `builtin` and `command`.

  `EXTRACT_VERSION` is now 5, so stored `command_heads` re-extract on the next backfill.

  The session-analytics journal-write rule now matches a redirect head with a parent directory, such as `>state/events.jsonl`.

### Patch Changes

- c583709: `commandHeads` drops a closing subshell paren glued to the last word, looks through `builtin` and `command` so `builtin cd x` is dropped like `cd x`, and the README documents that `command_heads` can keep lowercase positionals.

  `EXTRACT_VERSION` is now 4. Existing graphs re-extract on the next backfill, which replaces the old heads such as `ls)` and the leaked `builtin cd x`.

## 0.7.0

### Minor Changes

- 661244b: `Inbound` and the `inbound` audit event carry `promptSource`: the record's own label for who submitted the line (`typed`, `system`, or `sdk` for a headless turn), or null when the record has none. No `WakeCause` value changes.
- 0bf3f20: Add `parseVerdictBlock(text)`, a fail-closed reader for the three-line `Verdict: MERGE|FIX_FIRST`, `PR: owner/name#n`, `Head: <40 lowercase hex>` block a reviewer sends. It finds the block on any line, refuses zero or two blocks, quoted or fenced blocks, `APPROVE`, `CHANGES`, and any short, upper-case or over-long head, and returns `lineOffset` on success.

## 0.6.0

### Minor Changes

- 2983591: session-read: export `SessionIdentityError`, a `TypeError` subclass with a stable `code` field (`"foreign_native_session"` or `"multiple_parent_sessions"`), thrown instead of a bare `TypeError` when a Claude transcript record belongs to a different native session or a sidechain window names multiple parent sessions. Both message texts are unchanged; consumers matching them by prefix keep working, and can now switch to `instanceof SessionIdentityError` plus `.code` (TP-422).
- b1e1c70: Add `parseReviewVerdicts`, a pure parser for approve / changes-requested verdicts in a
  `chat_send` message, and the `review_verdict` event: `readToolUse` emits one per parsed
  verdict from any tool whose name ends in `__chat_send`, carrying the verdict, the PR
  reference (an exact repo, a repo hint, or neither) and the tool call's `cwdRepo`. No message
  text or excerpt is stored on the event. Resolving the repo and filtering by sender profile
  are session-graph's job.
- d019c72: session-read: add `assignedTaskIds({ agentName, brief, isKnown })`, which reads the task ids a spawned session was assigned from its agent name and spawn brief and names the rule that found them (`name`, `name-over-brief`, `brief-anchor`, `brief-paragraph` or `none`). Also export `orientationEnd(brief)`, the offset where an agent-chat orientation block ends and the assignment starts, and `ORIENTATION_HEADER`. Pure functions, no I/O; existing exports are unchanged (TP-407).
- c7d5b1a: The `review_verdict` event carries `ordinal`, the verdict's index among those parsed from its tool use's message, so a consumer can key verdicts stably across chunk boundaries.

### Patch Changes

- 15eaffa: session-read: a `cost-state` line carries no timestamp of its own; `LineReader` now stamps it (and any other timestamp-less line) with the last preceding line's timestamp instead of an empty string (TP-346).
- d0ce38a: session-read's `SessionUsageAccumulator` and workflow's durable-harness usage now select measurements with agent-protocol's `foldUsage` and no longer carry their own copies of the fold. Results are unchanged (TP-423).
- Updated dependencies [b8a5614]
- Updated dependencies [d0ce38a]
  - @titan-design/agent-protocol@0.3.0

## 0.5.1

### Patch Changes

- Updated dependencies [ca56251]
- Updated dependencies [18527b6]
- Updated dependencies [3f935f3]
- Updated dependencies [4761f82]
  - @titan-design/agent-protocol@0.2.0

## 0.5.0

### Minor Changes

- 38903dd: Emit the `inbound`, `context_block` and `signal` audit events. User lines and `queued_command` attachments give an `inbound` with its wake cause. User text, tool results, images, assistant blocks and attachments of 256 characters or more give `context_block` rows. Tool calls give signals, including `pr_merge` and an active-work `Skill` call as `task_wrap`. `EXTRACT_VERSION` is now 2. The wake-cause, tool-family and injected-marker classifiers are exported, and the audit types now come from them rather than from duplicate copies.
- 283d7e1: Add the audit event kinds and the structural emitters. `src/audit-events.ts` defines all eight
  kinds (`request`, `tool_call`, `inbound`, `context_block`, `compaction`, `queue_op`, `signal`,
  `cost_state`) plus `EXTRACT_VERSION`, and `TranscriptDelta` gains a list per kind. Emitters are
  wired for `request`, `tool_call`, `compaction`, `queue_op` and `cost_state`; the `inbound`,
  `context_block` and `signal` lists stay empty for now. A `request` carries `requestId`, falling
  back to `message.id`, so a response split across lines is counted once downstream. The `usage`
  event is deprecated and unchanged.
- 1035eb1: Add `claudeTranscriptRoots` and `discoverAllTranscripts` for discovery across `~/.claude` and every `~/.claude-profiles/<name>` that has a `projects` dir, overridable with `CLAUDE_CONFIG_DIRS` (TP-259). `DiscoveredTranscript` gains an `account` field, `"default"` for the default root and the profile directory name otherwise, `null` when returned by `discoverTranscripts(root)` directly. `transcriptsRoot()` and `discoverTranscripts(root)` behavior is unchanged.
- a49eb2d: Add pure classifiers for the session cost audit: `toolFamily` (tool name to
  family and MCP server), `classifyInbound` (what woke the session, from one
  `user` record or a `queued_command` attachment), and the shared
  `injected-markers` list. Not exported from the package entry point yet.

## 0.4.0

### Minor Changes

- 1334f34: Add `projection: "text"` to `readRecentSessionTurns`. It keeps only user and assistant text and applies `maxTurns` after tool activity, thinking and system rows are dropped, so a readback gets the last N spoken turns.
  Add `claudeSourceFromPath(path, namespace)` for consumers that already hold a transcript path. The observed model now skips Claude Code's `<synthetic>` placeholder on locally generated error rows.

## 0.3.0

### Minor Changes

- 11b94a2: Add bounded Codex execution, rollout discovery/decoding, and opt-in mixed-harness
  session ingestion with format-aware search excerpts and error readback. Preserve
  legacy Claude rows and references through additive conversation aliases. Prevent
  orphaned contentless FTS row IDs from leaking stale terms after source replacement.
  Recognize native shell missing-file diagnostics in error clustering.
- 81b60ee: Add graph-free Claude/Codex observation dispatch, source lookup, bounded recent-turn reads and session summaries. Share usage folding with graph queries and preserve native denial evidence separately from generic tool errors.
- 3bde552: Add opt-in harness-neutral identity, usage, execution preflight and normalized session
  contracts for Claude/Codex integration. Existing Claude execution and transcript APIs
  retain their behavior. Codex execution, decoding and graph migration follow separately.

### Patch Changes

- Updated dependencies [81b60ee]
- Updated dependencies [25391fa]
- Updated dependencies [3bde552]
  - @titan-design/locator@0.2.1
  - @titan-design/agent-protocol@0.1.0

## 0.2.1

### Patch Changes

- Updated dependencies [0bdae32]
  - @titan-design/locator@0.2.0

## 0.2.0

### Minor Changes

- fc7b58e: Derive task status from transcript content. `parseTaskIntents` reads every
  `active-work`/`aw` task invocation in a compound command, not just one anchored at the
  start of the line, and reports the status the `done` and explicit `edit … status` forms
  state. Task events carry that status, the folder lets a closing mention upgrade an earlier
  read, and the graph writes it with a COALESCE that a later bare mention cannot erase.

## 0.1.0

### Minor Changes

- d33d861: Extract Claude Code transcript reading from active-work's session miner as a storage-free
  event stream: `LineReader` (stateless per line, byte-offset locators), the `SessionEvent`
  union, `EventFolder` with chunk-boundary-safe merge rules, `readTranscriptEvents` /
  `extractTranscript` with prefix-hash resume, bash intent parsing, repo attribution, and
  transcript discovery including subagent sidechains. `session-graph` is stamped as a placeholder.

### Patch Changes

- Updated dependencies [fbf473b]
  - @titan-design/locator@0.1.0
