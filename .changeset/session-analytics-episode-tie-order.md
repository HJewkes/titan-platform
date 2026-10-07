---
"@titan-design/session-analytics": patch
---

Order coordinator episode signal ownership by timestamp, transcript id, then byte offset, so a merge or wrap signal on an exact-millisecond tie across resumed transcripts lands on the right turn. Bumps the coordinator-v1 heuristic version so stored episodes are recomputed.
