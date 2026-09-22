# @titan-design/session-read

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
