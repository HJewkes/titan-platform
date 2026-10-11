---
"@titan-design/session-read": patch
---

Add `decodeClaudeToolLines`, a sync, descriptor-free decode of Claude transcript lines into tool call and tool result records. It skips malformed lines, ignores session identity and leaves joining and dedup to the caller.
