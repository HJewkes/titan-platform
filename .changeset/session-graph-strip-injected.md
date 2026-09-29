---
"@titan-design/session-graph": minor
---

Prompt spans no longer index injected context (TP-108). A user line that session-read classifies as not typed by a human (hook and bootstrap output, peer channel messages, task notifications, compaction summaries) indexes no prompt span. Typed prompts lose system reminders, channel and hook blocks, command framing and output echoes, and agent-chat spawn briefs are dropped whole. `readIndexedText` strips prompt excerpts the same way. `stripInjected` and `isInjectedCause` are exported. Structural rows are unchanged; run `resetIndex` to rebuild an existing index under the new rule.
