---
"@titan-design/code-graph": minor
---

Tell a git log that overflowed its buffer apart from a non-repo. `loadChurnResult` and `loadFirstSeenResult` return a typed `not-git | overflow | git-error` outcome; `loadChurnEntries` and `loadFileFirstSeen` keep returning null outside git but throw `GitHistoryError` on overflow or git failure; `LoadedHistory` gains `warnings`, so `loadHistoryMetrics` no longer drops churn, ownership and age metrics silently.
