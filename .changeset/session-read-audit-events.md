---
"@titan-design/session-read": minor
---

Add the audit event kinds and the structural emitters. `src/audit-events.ts` defines all eight
kinds (`request`, `tool_call`, `inbound`, `context_block`, `compaction`, `queue_op`, `signal`,
`cost_state`) plus `EXTRACT_VERSION`, and `TranscriptDelta` gains a list per kind. Emitters are
wired for `request`, `tool_call`, `compaction`, `queue_op` and `cost_state`; the `inbound`,
`context_block` and `signal` lists stay empty for now. A `request` carries `requestId`, falling
back to `message.id`, so a response split across lines is counted once downstream. The `usage`
event is deprecated and unchanged.
