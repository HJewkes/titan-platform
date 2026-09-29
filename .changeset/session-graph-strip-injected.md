---
"@titan-design/session-graph": minor
---

Prompt spans no longer index injected context (TP-108). A user line that session-read classifies as not typed by a human (hook and bootstrap output, peer channel messages, task notifications, compaction summaries) indexes no prompt span. A line whose `promptSource` is `sdk` (spawned agents, and `claude -p` runs) indexes no prompt span unless the caller passes `indexSdkPrompts: true`. Typed prompts lose system reminders, channel and hook blocks, command framing and output echoes when those blocks sit on their own lines, and framed agent-chat spawn briefs are dropped whole. `readIndexedText` strips prompt excerpts the same way. `stripInjected`, `isInjectedCause` and `isUntypedPrompt` are exported. Structural rows are unchanged; run `resetIndex` to rebuild an existing index under the new rule.
