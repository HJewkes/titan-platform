---
"@titan-design/agent-dispatch": minor
---

Add the worktree isolation strategy to `./isolation`: `createWorktreeStrategy` with per-spawn budget readers, the implementer and reviewer pools, and `inspectForRelease`, judged by one ignored-file policy (`unsavedWork`, `dispatchIgnoredFiles`) that keeps paid codewatch data and honours a committed `.agent-chat/generated` (TP-646 I1b).
