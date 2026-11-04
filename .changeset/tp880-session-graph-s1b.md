---
"@titan-design/session-read": minor
"@titan-design/session-graph": minor
"@titan-design/session-miner": patch
"@titan-design/active-work": patch
---

Stop writing tool spans, context blocks and unchanged state echoes by default (TP-880).

session-read: `ReadOptions` gains `toolSpans` and `contextBlocks` (default true), passed to `LineReader` as an optional `EmitPolicy`. A fact from an echo line (`ai-title`, `custom-title`, `agent-name`, `mode`, `permission-mode`, `cost-state`) carries `state: { key, value }`; `atis-latch`, `bridge-session` and `last-prompt` emit no fact. `EXTRACT_VERSION` is 9.

session-graph: `IndexOptions` gains `indexToolSpans` and `contextBlocks` (default false); `refreshCorpus` forwards `contextBlocks` to `backfillFacets`. Migration 14 replaces `session_state` with `echo_state`, keyed per transcript, and an echo fact is stored only when its value changed. `turn.thinking_ms` now counts the gap from a tool result past a skipped echo.

session-miner and active-work keep storing tool spans and context blocks; active-work does so on both its full and delta passes.
