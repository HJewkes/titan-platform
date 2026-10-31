# @titan-design/session-read

## 0.17.0

### Minor Changes

- f896485: `readFirstRequest(path)` rebuilds the first API request a Claude Code transcript recorded: tools, system and message blocks in API order (messages in the request's `tail` order, not file order), the cache breakpoints it carried, the model, agent name and the usage of its response.
- cfdfb64: `extractTranscript` and `readTranscriptEvents` take a `spanTextCap` read option, the chars kept per span. The default stays `SPAN_TEXT_CAP` (16 KiB), which bounds the search index; a caller that parses a span, such as an agent's final JSON answer, passes `Infinity` to read it whole.
- ff6fb95: `distinctRequests` and the `TranscriptRequest` type move into session-read, next to the transcript readers; factory's step-usage and autoresearch import them from there instead of from autoresearch internals.
- f77d79d: `ciPolicyLabelledLines(text)` lists every labelled line a MERGE block's `ciPolicy` folds, each with its own reading, through the same reader `parseVerdictBlock` uses. The factory adds the read-only `gate.ownerEvidence` command (TP-4489, the first slice of TP-4404): the console card for an owner-at-head approve-merge gate is projected from the merge evidence the gate was opened on. Its facts are recomputed with land's own functions and must equal the gate's marker, unknown names included; a CI-policy section heads with the stored reading and shows the verdict text only when the shared reader still reads the same. A gate whose facts need file sections reads `missing` until they land.
- 52dc7f3: A reviewer verdict correction now quotes the line that made the verdict malformed (TP-3798). `session-read` exports `refusedLines(text, refusal)`, which returns the non-canonical `Verdict:` lines (for `multiple_blocks`) or labelled CI-policy lines (for `ci_policy_malformed`); the reading itself is unchanged and still fails closed. `review-panel` records them as `malformed.quotes`, and `correctionPrompt` takes `quotes`, shows up to three of them cut to 120 characters inside `MAX_CORRECTION_PROMPT_CHARS`, and asks the reviewer to reword or remove them. `CI_POLICY_RULE` now says no other line may start with "CI policy" or "Verdict", markdown headings such as `**CI policy:**` included.
- 78ae7d9: Stop writing tool spans, context blocks and unchanged state echoes by default (TP-880).

  session-read: `ReadOptions` gains `toolSpans` and `contextBlocks` (default true), passed to `LineReader` as an optional `EmitPolicy`. A fact from an echo line (`ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`) carries `state: { key, value }`; `atis-latch`, `bridge-session` and `last-prompt` emit no fact. `EXTRACT_VERSION` is 9.

  session-graph: `IndexOptions` gains `indexToolSpans` and `contextBlocks` (default false); `refreshCorpus` forwards `contextBlocks` to `backfillFacets`. Migration 14 replaces `session_state` with `echo_state`, keyed per transcript, and an echo fact is stored only when its value changed. `turn.thinking_ms` now counts the gap from a tool result past a skipped echo.

  session-miner and active-work keep storing tool spans and context blocks; active-work does so on both its full and delta passes.

### Patch Changes

- 5a67a0b: `findClaudeSessionSource` no longer reports a transcript unavailable when the cwd's project-directory name is longer than the filesystem allows for one name. It treats that exact path as absent and scans the project directories by session id, as it does for any other cwd whose directory Claude named differently.
- 6525ba7: The verdict parser no longer reads a line naming a ci-policy identifier (`ci-policy-changes.ts`, `ciPolicyAt`) as a CI-policy line, so such a review parses MERGE; a weakened reading still fails closed wherever it sits. Shepherd's correction now quotes the blamed line, and the failed-round list and ops notice name a correction that did not parse `malformed`, not `timeout` (TP-3237).
- 9b42150: Use the shared `isRecord`, `isObjectLike` and `errorCode` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- cd8a1ce: Typed-lint burn-down: replaced type assertions with narrowing and dropped conditions the types already settle. No behaviour change.
- 5f2b39f: Flatten the Claude transcript lookup's internal result protocol into status unions and keep one `messageOf` in the package. No behavior change.
- Updated dependencies [211db45]
- Updated dependencies [1fe77c3]
- Updated dependencies [7813c1f]
- Updated dependencies [5edd38d]
- Updated dependencies [5edd38d]
- Updated dependencies [646f4d7]
- Updated dependencies [6c3fb4b]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/anthropic-account@0.3.1
  - @titan-design/locator@0.2.2
  - @titan-design/rpc-protocol@0.4.0

## 0.16.1

### Patch Changes

- 9914239: Move the existing pure transcript source, observation and continuation declarations into agent-protocol/harness, preserving session-read compatibility exports and all decoder/read behavior. This is a further partial TP-3426 S01 checkpoint; account, pricing, policy and bus ports remain unfinished.
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
- Updated dependencies [9914239]
  - @titan-design/agent-protocol@0.9.0

## 0.16.0

### Minor Changes

- 41fce70: Check a recommendation's cite against its transcript when the deposit is filed.

  - `@titan-design/evidence`: `quoteInText(text, quote)` matches a quote against any text. It normalises whitespace and line wrapping the same way `quoteInRange` does, and `quoteInRange` now calls it.
  - `@titan-design/owner-queue`: `recommended.cite` takes legacy free text or a strict `{session, event, quote}`, where `event` is `<byteOffset>:<byteLength>` of one transcript line (`locatorCiteSchema`, `LocatorCite`). A consumer that read `cite` as a string must now handle the object form too. `writeDeposit(dir, deposit, { events })` throws `DepositCiteError` and writes nothing for a locator cite whose quote does not match the event text, an event that cannot be read, an empty quote, or a call with no `events` source. Free text is never checked.
  - `@titan-design/session-read`: `readSessionEventText({session, byteOffset, byteLength}, { roots })` returns the message text of one whole Claude transcript line. It returns null when the session is not in exactly one transcript or the span is not one whole line.
  - `titan-console`: `inbox.deposit` checks locator cites through session-read and answers 400 when the check fails.

## 0.15.0

### Minor Changes

- adfec4b: `parseVerdictBlock` reads an optional `CI-policy: unchanged | weakened <keys>` line directly after `Head:` on a MERGE block and returns it as `ciPolicy`. Keys come from the closed set `CI_POLICY_KEYS`; a malformed, duplicated, misplaced, fenced or quoted line reads as missing.
- c2d805b: `parseVerdictBlock` reads the `CI-policy:` label on every raw line, fenced, indented or commented out, once each line is NFKC-folded, lower-cased and stripped of every non-alphanumeric character and any leading list number (TP-2407 b). A labelled `weakened` line with known keys reads weakened wherever it sits, `unchanged` counts only as the one exact visible line directly after `Head:`, and any other labelled line reads `{ kind: "malformed" }`. Across lines the strictest reading wins: weakened (keys merged) over malformed over unchanged. Only a message with no labelled line leaves `ciPolicy` undefined.
- ba8f25e: Export `visibleLines`, the verdict parser's visibility pass, so other reviewer-message parsers skip the same fenced, commented and indented lines (TP-2498 b).

### Patch Changes

- Updated dependencies [a79cffd]
  - @titan-design/agent-protocol@0.8.0

## 0.14.0

### Minor Changes

- 7b9335c: session-read keeps an agent-chat channel tag's `broadcast="true"` attribute as `Inbound.broadcast` (false for a direct message, null without a channel tag) and bumps `EXTRACT_VERSION` to 8, so `backfillFacets` re-extracts stored inbound rows. session-graph adds `inbound.broadcast` in migration 12 and writes it. session-analytics wake episodes read the flag for the `broadcast` sender kind, so a direct message a forked session copied is no longer a broadcast; msg_id fan-out remains the fallback for rows extracted before version 8.

## 0.13.2

### Patch Changes

- Updated dependencies [ea3d34c]
  - @titan-design/agent-protocol@0.7.0

## 0.13.1

### Patch Changes

- 662f42b: Add an agent-chat consumer contract test that pins activity rendering, the truncation marker, the synthetic model skip and the observed branch.

## 0.13.0

### Minor Changes

- 7c73654: `orientationEnd(brief, briefingChars?)` and `assignedTaskIds({ ..., briefingChars? })` accept the recorded orientation length (agent-chat's `agent_spawned` meta `briefing_chars`) and use it in place of the heading text, so a heading rename no longer stops task linking.

## 0.12.2

### Patch Changes

- 3d3cc58: Keep a Claude record's `isApiErrorMessage`, `error`, `apiErrorStatus` and `quotaLimits` fields as native metadata entries, so a reader can tell a record the client wrote (such as the usage-limit notice) from one the model wrote.

## 0.12.1

### Patch Changes

- 15ede18: Add `decodeClaudeToolLines`, a sync, descriptor-free decode of Claude transcript lines into tool call and tool result records. It skips malformed lines, ignores session identity and leaves joining and dedup to the caller.

## 0.12.0

### Minor Changes

- 3bf2ac3: Index transcripts mirrored from another host as children of the same session. session-read's `claudeTranscriptRoots` adds a root for each `<dir>/<account>/projects` named by `CLAUDE_TRANSCRIPT_MIRRORS` (`<host>=<dir>` entries), and `TranscriptRoot` and `DiscoveredTranscript` gain an optional `host`. When a session has facts in more than one transcript, session-graph's rollup recounts `turn_count`, `commit_count` and `push_count` without counting any copy twice. `purgeTranscript` on one copy keeps the shared session row, moves rows the other copy also holds to its lines, recounts the session and returns the ids it handed off, and the new `SIGNAL_COPY_RANK` export ranks the copies of a `session_signal` row. session-analytics episodes read each signal once.

### Patch Changes

- Updated dependencies [37550f4]
- Updated dependencies [0fb5cf6]
- Updated dependencies [6eea59d]
- Updated dependencies [167611d]
  - @titan-design/anthropic-account@0.3.0

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
